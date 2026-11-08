/* Byte Monitor — Android bridge
 * Implements the same window.byte API the desktop app's preload provides, on top of
 * the native "ByteMonitor" Capacitor plugin, so the shared UI (app.js) runs unchanged.
 *
 * Battery health on Android: the official state-of-health value is restricted to
 * system apps, so — like AccuBattery — we estimate the battery's current full
 * capacity from the charge counter (µAh in the battery right now ÷ charge %) and
 * compare it with the design capacity. The estimate is smoothed and remembered
 * across launches, and gets better over a few charges.
 */
(() => {
  document.documentElement.classList.add('platform-android');
  const Cap = window.Capacitor;
  const plugin = (name) => (Cap && Cap.registerPlugin ? Cap.registerPlugin(name) : Cap && Cap.Plugins && Cap.Plugins[name]);
  const BM = plugin('ByteMonitor');
  const FS = plugin('Filesystem');
  const Share = plugin('Share');

  const round = (n, d = 1) => (n == null || Number.isNaN(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
  const store = {
    get(k, def) { try { const v = localStorage.getItem('bm.' + k); return v == null ? def : JSON.parse(v); } catch { return def; } },
    set(k, v) { try { localStorage.setItem('bm.' + k, JSON.stringify(v)); } catch {} },
  };

  let staticInfo = null;
  let staticPromise = null;
  const getStatic = () => (staticPromise ||= BM.getStatic().then((s) => (staticInfo = s)));

  // ---------- battery capacity estimate ----------
  const HEALTH = { 1: 'Unknown', 2: 'Good', 3: 'Overheating', 4: 'Dead', 5: 'Over voltage', 6: 'Failure', 7: 'Cold' };
  let capSamples = store.get('capSamples', []); // recent full-capacity estimates (mAh)
  function estimateFullMah(b, designMah) {
    // 1) the battery driver's own learned full capacity, when the phone exposes it
    const sysFull = b.chargeFull > 0 ? b.chargeFull / 1000 : null; // µAh → mAh
    if (sysFull && (!designMah || (sysFull > designMah * 0.4 && sysFull < designMah * 1.25))) return { mah: sysFull, method: 'battery driver' };
    // 2) charge counter ÷ level (needs a sensible level; noisy near empty)
    const lvl = b.level > 0 && b.scale > 0 ? (b.level / b.scale) * 100 : null;
    if (!(b.chargeCounter > 0) || !lvl || lvl < 15) return null;
    let mah = b.chargeCounter / 1000 / (lvl / 100); // µAh
    if (designMah && (mah < designMah * 0.3 || mah > designMah * 1.5)) {
      const alt = b.chargeCounter / (lvl / 100); // some phones report mAh
      if (alt > designMah * 0.3 && alt < designMah * 1.5) mah = alt; else return null;
    }
    capSamples.push(Math.round(mah));
    if (capSamples.length > 240) capSamples = capSamples.slice(-240);
    if (capSamples.length % 10 === 0) store.set('capSamples', capSamples);
    const sorted = [...capSamples].sort((a, c) => a - c);
    return { mah: sorted[Math.floor(sorted.length / 2)], method: 'charge counter', samples: capSamples.length };
  }

  function mapBattery(b, s) {
    if (!b || b.present === false) return { present: false };
    const design = (b.chargeFullDesign > 0 ? b.chargeFullDesign / 1000 : null) || (s.designCapacityMah > 0 ? s.designCapacityMah : null);
    const est = estimateFullMah(b, design);
    const healthPct = est && design ? round(Math.min(100, (est.mah / design) * 100), 1) : null;
    const pct = b.scale > 0 ? Math.round((b.level / b.scale) * 100) : b.level;
    // current: µA by spec; some vendors report mA. Sign varies by vendor, so use charging state.
    let ma = b.currentNow != null ? b.currentNow : null;
    if (ma != null) ma = Math.abs(ma) > 20000 ? ma / 1000 : ma;
    const charging = b.status === 2 || b.status === 5;
    if (ma != null) ma = Math.abs(ma) * (charging ? 1 : -1);
    const volts = b.voltage > 0 ? (b.voltage > 100 ? b.voltage / 1000 : b.voltage) : null;
    return {
      present: true,
      model: `${b.technology || 'Li-ion'} battery`,
      unit: 'mAh',
      designCapacity: design ? Math.round(design) : null,
      fullCapacity: est ? Math.round(est.mah) : null,
      currentCapacity: est ? Math.round((est.mah * pct) / 100) : null,
      healthPct,
      wearPct: healthPct != null ? round(100 - healthPct, 1) : null,
      chargePct: pct,
      charging,
      acConnected: b.plugged > 0,
      cycles: b.cycleCount > 0 ? b.cycleCount : null,
      voltage: volts,
      timeRemaining: null,
      rating: healthPct == null ? 'Estimating…' : healthPct >= 80 ? 'Good' : healthPct >= 60 ? 'Fair' : 'Replace soon',
      // Android extras
      estimated: true,
      estimateMethod: est ? est.method : null,
      estimateSamples: est ? est.samples || null : null,
      temp: b.temperature != null ? round(b.temperature, 1) : null,
      currentMa: ma != null ? Math.round(ma) : null,
      powerW: ma != null && volts ? round((ma / 1000) * volts, 1) : null,
      androidHealth: HEALTH[b.health] || 'Unknown',
      plugType: { 1: 'AC', 2: 'USB', 4: 'Wireless', 8: 'Dock' }[b.plugged] || null,
    };
  }

  // CPU temperature from thermal zones the phone lets apps read (many hide them)
  function cpuTemps(zones) {
    const z = (zones || []).filter((t) => t.temp > 5 && t.temp < 125);
    const cpu = z.filter((t) => /cpu|soc|tsens|cluster|big|little|mtktscpu|apc/i.test(t.type) && !/gpu|batt|skin|pa_|modem|xo|pmic|usb|chg|wlan|camera|display/i.test(t.type));
    return { cpu, all: z };
  }

  async function live() {
    const s = await getStatic();
    const L = await BM.getLive();
    const cur = L.curKHz || [], max = L.maxKHz || [];
    const coreLoads = cur.map((c, i) => (c > 0 && max[i] > 0 ? Math.round((c / max[i]) * 100) : 0));
    const online = cur.filter((c) => c > 0);
    const avgGhz = online.length ? online.reduce((a, c) => a + c, 0) / online.length / 1e6 : null;
    const t = cpuTemps(L.thermal);
    const cpuTemp = t.cpu.length ? Math.max(...t.cpu.map((x) => x.temp)) : null;
    const memUsed = L.ramTotal - L.ramAvail;
    const battery = mapBattery(L.battery, s);
    const extraTemps = [];
    if (battery.temp != null) extraTemps.push({ name: 'Battery', value: battery.temp });
    t.all.filter((x) => /skin|therm|quiet|case|back/i.test(x.type)).slice(0, 4).forEach((x) => extraTemps.push({ name: x.type, value: round(x.temp, 1) }));
    return {
      ts: Date.now(),
      cpu: {
        load: coreLoads.length ? Math.round(coreLoads.reduce((a, c) => a + c, 0) / coreLoads.length) : null, // speed % of max (Android hides CPU load)
        coreLoads,
        temp: cpuTemp != null ? round(cpuTemp, 1) : null,
        tempMax: cpuTemp != null ? round(cpuTemp, 1) : null,
        coreTemps: [],
        coreNames: null,
        tempSource: cpuTemp != null ? 'sensor' : null,
        ghz: avgGhz != null ? round(avgGhz, 2) : null,
      },
      mem: { total: L.ramTotal, used: memUsed, pct: round((memUsed / L.ramTotal) * 100), swapTotal: 0, swapUsed: 0 },
      gpus: [],
      battery,
      fans: [],
      extraTemps,
      lhm: false,
      loading: false,
      sensorDriver: null,
      android: { thermalStatus: L.thermalStatus, thermalHeadroom: L.thermalHeadroom, lowMemory: L.lowMemory },
    };
  }

  // Chip model codes → the names people know
  const SOC = {
    SM8750: 'Snapdragon 8 Elite', SM8650: 'Snapdragon 8 Gen 3', SM8635: 'Snapdragon 8s Gen 3', SM8550: 'Snapdragon 8 Gen 2', SM8475: 'Snapdragon 8+ Gen 1',
    SM8450: 'Snapdragon 8 Gen 1', SM8350: 'Snapdragon 888', SM8250: 'Snapdragon 865', SM7675: 'Snapdragon 7+ Gen 3', SM7550: 'Snapdragon 7 Gen 3',
    SM7475: 'Snapdragon 7+ Gen 2', SM6450: 'Snapdragon 6 Gen 1', s5e9955: 'Exynos 2500', s5e9945: 'Exynos 2400', s5e9925: 'Exynos 2200', s5e8845: 'Exynos 1480', s5e8835: 'Exynos 1380',
    MT6991: 'Dimensity 9400', MT6989: 'Dimensity 9300', MT6985: 'Dimensity 9200',
  };
  async function staticForUi() {
    const s = await getStatic();
    const code = s.socModel && s.socModel !== 'unknown' ? s.socModel : '';
    const named = SOC[code] || SOC[code.toUpperCase()] || SOC[code.toLowerCase()];
    const soc = named ? `${named} (${code})` : [s.socManufacturer, code].filter((x) => x && x !== 'unknown').join(' ');
    const maxGhz = s.maxKHz > 0 ? round(s.maxKHz / 1e6, 2) : null;
    return {
      system: { manufacturer: cap(s.manufacturer), model: s.model },
      cpu: { brand: soc || s.hardware || 'Processor', cores: s.cores, threads: s.cores, base: null, max: maxGhz },
      os: { distro: 'Android', release: s.android, arch: s.abi, hostname: s.deviceName || s.model, platform: 'android' },
      gpus: [],
      memModules: [],
      memSlots: { total: 1, known: true, slots: [{ label: 'RAM', size: s.ramTotal, type: '', empty: false }] },
      android: { sdk: s.sdk, securityPatch: s.securityPatch, device: s.device, board: s.board },
    };
  }
  const cap = (x) => (x ? x.charAt(0).toUpperCase() + x.slice(1) : x);

  async function storage() {
    const st = await BM.getStorage();
    return {
      disks: [],
      volumes: (st.volumes || []).map((v) => ({ mount: v.name, fs: v.removable ? 'Removable' : 'Internal', size: v.total, used: v.total - v.free, pct: round(((v.total - v.free) / v.total) * 100) })),
    };
  }

  const noop = () => {};
  window.byte = {
    meta: async () => { const s = await getStatic(); return { demo: false, platform: 'android', version: s.appVersion || '' }; },
    static: () => staticForUi(),
    onStatic: noop,
    live: () => live(),
    storage: () => storage(),
    installDriver: async () => ({ ok: false, error: 'Not needed on Android' }),
    openLicenses: () => { location.href = 'licenses.html'; },
    space: { // Space analyzer arrives in a later Android update
      targets: async () => [], pick: async () => null, scan: async () => false, cancel: noop,
      children: async () => null, segments: async () => null, chain: async () => [0], path: async () => null,
      layout: async () => null, reveal: noop, onProgress: noop, onDone: noop, onError: noop,
    },
    // Health report: write to cache and open the Android share sheet (save to Files, email, Drive…)
    saveReport: async (html, name) => {
      try {
        const r = await FS.writeFile({ path: name, data: html, directory: 'CACHE', encoding: 'utf8' });
        await Share.share({ title: 'Byte Monitor health report', url: r.uri, dialogTitle: 'Save or share report' });
        return { saved: true };
      } catch (e) { return { saved: false, error: String(e && e.message || e) }; }
    },
  };
})();
