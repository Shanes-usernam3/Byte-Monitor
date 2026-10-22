// Byte Monitor — hardware sensor layer (Windows + Linux)
// Uses systeminformation for the bulk of data, plus small OS-specific extras:
//   Linux:   /sys/class/hwmon fans, smartctl (via systeminformation) for SMART detail
//   Windows: LibreHardwareMonitor WMI namespace (if LHM is running) for CPU temps + fans
const si = require('systeminformation');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const isWin = process.platform === 'win32';
const isLinux = process.platform === 'linux';

// Make sure smartctl is findable even if smartmontools isn't on PATH.
(function addSmartctlToPath() {
  const extra = isWin
    ? ['C:\\Program Files\\smartmontools\\bin', process.resourcesPath ? path.join(process.resourcesPath, 'smartctl') : null]
    : ['/usr/sbin', '/usr/local/sbin'];
  const sep = isWin ? ';' : ':';
  const have = (process.env.PATH || '').split(sep);
  extra.filter(Boolean).forEach((p) => { if (!have.includes(p) && fs.existsSync(p)) process.env.PATH += sep + p; });
})();

function round(n, d = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

function run(cmd, args, timeout = 6000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

// ---------- Fans ----------
function linuxFans() {
  const out = [];
  const base = '/sys/class/hwmon';
  try {
    for (const dir of fs.readdirSync(base)) {
      const p = path.join(base, dir);
      let chip = dir;
      try { chip = fs.readFileSync(path.join(p, 'name'), 'utf8').trim(); } catch {}
      for (const f of fs.readdirSync(p)) {
        const m = f.match(/^fan(\d+)_input$/);
        if (!m) continue;
        const rpm = parseInt(fs.readFileSync(path.join(p, f), 'utf8'), 10);
        let label = `${chip} fan ${m[1]}`;
        try { label = fs.readFileSync(path.join(p, `fan${m[1]}_label`), 'utf8').trim(); } catch {}
        if (!Number.isNaN(rpm)) out.push({ name: label, rpm });
      }
    }
  } catch {}
  return out;
}

// Windows live sensors from ONE long-running PowerShell process (spawning
// PowerShell per poll costs ~1s). Every ~0.8s it prints a JSON snapshot of:
//   lhm/hw — LibreHardwareMonitor sensors + hardware (only if LHM is running)
//   eng    — GPU engine utilisation (same counters Task Manager uses; works
//            for integrated Intel/AMD GPUs with nothing installed)
//   mem    — GPU adapter memory (dedicated + shared)
// The perf classes are queried through CIM so they work on non-English Windows.
const win = { proc: null, latest: null, at: 0, retryAt: 0 };
function startWinSensors() {
  if (!isWin || win.proc || Date.now() < win.retryAt) return;
  const { spawn } = require('child_process');
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    'while ($true) {',
    '  $o = @{}',
    "  try { $o.lhm = @(Get-CimInstance -Namespace root/LibreHardwareMonitor -ClassName Sensor -ErrorAction Stop | Select-Object Name,SensorType,Value,Parent)",
    "        $o.hw = @(Get-CimInstance -Namespace root/LibreHardwareMonitor -ClassName Hardware -ErrorAction Stop | Select-Object Name,Identifier,HardwareType) } catch { $o.lhm = $null }",
    "  $o.eng = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine | Where-Object { $_.UtilizationPercentage -gt 0 } | Select-Object Name,UtilizationPercentage)",
    "  $o.mem = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory | Select-Object Name,DedicatedUsage,SharedUsage)",
    "  [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 4)); [Console]::Out.WriteLine('@@END@@'); [Console]::Out.Flush()",
    '  Start-Sleep -Milliseconds 800',
    '}',
  ].join('\n');
  const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
  win.proc = p;
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('@@END@@')) !== -1) {
      const chunk = buf.slice(0, i).trim();
      buf = buf.slice(i + 7);
      try { win.latest = JSON.parse(chunk); win.at = Date.now(); } catch {}
    }
  });
  p.on('exit', () => { win.proc = null; win.retryAt = Date.now() + 30000; });
}
function winSnapshot() {
  startWinSensors();
  return win.latest && Date.now() - win.at < 10000 ? win.latest : null;
}
function lhmSensors() { const w = winSnapshot(); return w && Array.isArray(w.lhm) && w.lhm.length ? w.lhm : null; }
function stopSensors() { if (win.proc) { try { win.proc.kill(); } catch {} } }

// ---------- GPUs ----------
const VIRTUAL_GPU = /basic render|basic display|remote display|parsec|citrix|hyper-v|virtual|vmware|virtualbox|spacedesk|idd|indirect/i;
function isIntegrated(g) {
  const m = `${g.vendor || ''} ${g.model || ''}`;
  if (/intel/i.test(m)) return !/\barc\b/i.test(m) || /graphics$/i.test(g.model || '');
  if (/amd|ati|radeon/i.test(m)) return !/\b(rx|pro w|vega 56|vega 64|radeon vii)\b/i.test(m) && (!g.vram || g.vram <= 2048);
  return false;
}

// Task Manager style: per adapter (luid), sum each engine type across
// processes, then the adapter's load is the busiest engine type.
function perfGpus(snap) {
  const out = new Map();
  const luidOf = (name) => { const m = /luid_(0x[0-9a-f]+_0x[0-9a-f]+)/i.exec(name || ''); return m ? m[1].toLowerCase() : null; };
  const get = (l) => out.get(l) || (out.set(l, { luid: l, types: {}, dedicated: 0, shared: 0 }), out.get(l));
  for (const e of (snap && snap.eng) || []) {
    const l = luidOf(e.Name); if (!l) continue;
    const t = (/engtype_(.+)$/i.exec(e.Name) || [])[1] || 'other';
    const g = get(l); g.types[t] = (g.types[t] || 0) + (e.UtilizationPercentage || 0);
  }
  for (const m of (snap && snap.mem) || []) {
    const l = luidOf(m.Name); if (!l) continue;
    const g = get(l); g.dedicated += m.DedicatedUsage || 0; g.shared += m.SharedUsage || 0;
  }
  return [...out.values()].map((g) => ({ ...g, load: Math.min(100, Math.max(0, ...Object.values(g.types), 0)) }));
}

function lhmGpus(snap) {
  if (!snap || !Array.isArray(snap.hw) || !Array.isArray(snap.lhm)) return [];
  return snap.hw.filter((h) => /gpu/i.test(h.HardwareType || '') || /^\/gpu/i.test(h.Identifier || '')).map((h) => {
    const s = snap.lhm.filter((x) => x.Parent === h.Identifier);
    const pick = (type, re) => { const x = s.find((v) => v.SensorType === type && re.test(v.Name)); return x ? x.Value : null; };
    const loads = s.filter((v) => v.SensorType === 'Load' && /gpu core|d3d 3d|d3d video|d3d copy/i.test(v.Name)).map((v) => v.Value);
    return {
      name: h.Name,
      temp: pick('Temperature', /gpu core|gpu$|edge|package/i) ?? pick('Temperature', /./),
      load: pick('Load', /gpu core/i) ?? (loads.length ? Math.max(...loads) : null),
      memUsed: pick('SmallData', /gpu memory used|d3d dedicated memory used/i), // MB
      shared: pick('SmallData', /d3d shared memory used/i),                   // MB
      power: pick('Power', /gpu package|gpu power|gpu core/i),
    };
  });
}

function linuxGpuExtras() { // AMD (incl. integrated Radeon) via amdgpu sysfs
  const out = [];
  try {
    for (const card of fs.readdirSync('/sys/class/drm').filter((c) => /^card\d+$/.test(c))) {
      const dev = `/sys/class/drm/${card}/device`;
      const rd = (f) => { try { return fs.readFileSync(path.join(dev, f), 'utf8').trim(); } catch { return null; } };
      const busy = rd('gpu_busy_percent');
      if (busy == null) continue;
      let temp = null;
      try {
        const hw = fs.readdirSync(path.join(dev, 'hwmon'))[0];
        const t = fs.readFileSync(path.join(dev, 'hwmon', hw, 'temp1_input'), 'utf8');
        temp = parseInt(t, 10) / 1000;
      } catch {}
      const used = rd('mem_info_vram_used'), gtt = rd('mem_info_gtt_used');
      out.push({ vendor: 'AMD', load: parseInt(busy, 10), temp, memUsed: used ? parseInt(used, 10) / 1048576 : null, shared: gtt ? parseInt(gtt, 10) / 1048576 : null });
    }
  } catch {}
  return out;
}

const similar = (a, b) => {
  const t = (x) => String(x || '').toLowerCase().replace(/\(r\)|\(tm\)|graphics|gpu|laptop|corporation|nvidia|amd|intel/g, ' ').split(/\W+/).filter((w) => w.length > 1);
  const A = new Set(t(a)); return t(b).filter((w) => A.has(w)).length;
};

function buildGpus(controllers) {
  const list = (controllers || [])
    .filter((g) => !VIRTUAL_GPU.test(`${g.model} ${g.vendor}`))
    .map((g) => ({
      model: g.model || g.name || 'GPU', vendor: g.vendor || '', integrated: isIntegrated(g),
      temp: g.temperatureGpu ?? null, load: g.utilizationGpu ?? null,
      memUsed: g.memoryUsed ?? null, memTotal: g.memoryTotal ?? g.vram ?? null, shared: null,
      fan: g.fanSpeed ?? null, power: g.powerDraw ?? null,
    }));
  if (isWin) {
    const snap = winSnapshot();
    // 1) LibreHardwareMonitor — names its hardware, so match by name
    for (const l of lhmGpus(snap)) {
      const best = list.map((g) => [g, similar(g.model, l.name)]).sort((a, b) => b[1] - a[1])[0];
      if (!best || best[1] === 0) continue;
      const g = best[0];
      g.temp = g.temp ?? l.temp; g.load = g.load ?? l.load; g.memUsed = g.memUsed ?? l.memUsed;
      g.shared = g.shared ?? l.shared; g.power = g.power ?? l.power;
    }
    // 2) Windows GPU counters — fill load / memory for anything still blank
    const perf = perfGpus(snap).filter((p) => p.dedicated + p.shared > 0 || p.load > 0);
    const need = list.filter((g) => g.load == null || g.shared == null);
    if (perf.length && need.length) {
      const remaining = perf.slice();
      // a GPU we already know (e.g. NVIDIA via nvidia-smi) claims the adapter whose dedicated memory matches
      for (const g of list.filter((x) => x.memUsed != null && !x.integrated)) {
        const i = remaining.map((p, k) => [k, Math.abs(p.dedicated / 1048576 - g.memUsed)]).sort((a, b) => a[1] - b[1])[0];
        if (i && remaining.length > 1) { const p = remaining.splice(i[0], 1)[0]; if (g.load == null) g.load = p.load; if (g.shared == null) g.shared = p.shared / 1048576; }
      }
      // integrated GPU = adapter that mostly uses shared memory; discrete = mostly dedicated
      remaining.sort((a, b) => (a.dedicated - a.shared) - (b.dedicated - b.shared));
      for (const g of need.filter((x) => x.load == null).sort((a, b) => (b.integrated ? 1 : 0) - (a.integrated ? 1 : 0))) {
        const p = g.integrated ? remaining.shift() : remaining.pop();
        if (!p) break;
        g.load = p.load;
        g.shared = p.shared / 1048576;
        if (g.memUsed == null && !g.integrated) g.memUsed = p.dedicated / 1048576;
      }
    }
  } else if (isLinux) {
    const extras = linuxGpuExtras();
    for (const e of extras) {
      const g = list.find((x) => /amd|ati|radeon/i.test(`${x.vendor} ${x.model}`) && x.load == null);
      if (!g) continue;
      g.load = e.load; g.temp = g.temp ?? e.temp; g.memUsed = g.memUsed ?? e.memUsed; g.shared = e.shared;
    }
  }
  for (const g of list) {
    if (g.load != null) g.load = round(g.load, 0);
    if (g.temp != null) g.temp = round(g.temp, 0);
    if (g.shared != null) g.shared = round(g.shared, 0);
    if (g.memUsed != null) g.memUsed = round(g.memUsed, 0);
  }
  // discrete first, then integrated
  return list.sort((a, b) => (a.integrated ? 1 : 0) - (b.integrated ? 1 : 0));
}

// Windows built-in drive health (no smartctl needed, needs admin):
// Get-StorageReliabilityCounter gives temperature, wear, power-on hours, errors.
async function winReliability() {
  if (!isWin) return [];
  const ps = "Get-PhysicalDisk | ForEach-Object { $d=$_; $r = $d | Get-StorageReliabilityCounter -ErrorAction SilentlyContinue; " +
    "[pscustomobject]@{ Serial=$d.SerialNumber; Name=$d.FriendlyName; Health=[string]$d.HealthStatus; " +
    "Temp=$r.Temperature; Wear=$r.Wear; Hours=$r.PowerOnHours; Cycles=$r.StartStopCycleCount; " +
    "ReadErr=$r.ReadErrorsUncorrected; WriteErr=$r.WriteErrorsUncorrected } } | ConvertTo-Json -Compress";
  const raw = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], 15000);
  if (!raw) return [];
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a : [a]; } catch { return []; }
}

// ---------- Disk health ----------
function diskHealth(d, rel) {
  const s = d.smartData || null;
  const info = {
    name: d.name || d.device || 'Disk',
    device: d.device,
    type: d.type || (d.interfaceType === 'NVMe' ? 'NVMe' : ''),
    interface: d.interfaceType || '',
    sizeGB: d.size ? round(d.size / 1e9, 0) : null,
    serial: d.serialNum || '',
    firmware: d.firmwareRevision || '',
    smartStatus: d.smartStatus || 'unknown',
    temperature: d.temperature ?? null,
    powerOnHours: null,
    powerCycles: null,
    wearUsed: null,          // % of rated endurance used (SSD/NVMe)
    reallocated: null,
    pending: null,
    mediaErrors: null,
    healthPct: null,
    rating: 'Unknown',
    notes: [],
  };

  if (s) {
    if (s.temperature && s.temperature.current != null) info.temperature = s.temperature.current;
    if (s.power_on_time && s.power_on_time.hours != null) info.powerOnHours = s.power_on_time.hours;
    if (s.power_cycle_count != null) info.powerCycles = s.power_cycle_count;
    if (s.smart_status && typeof s.smart_status.passed === 'boolean') {
      info.smartStatus = s.smart_status.passed ? 'Ok' : 'Failing';
    }
    const nv = s.nvme_smart_health_information_log;
    if (nv) {
      if (nv.percentage_used != null) info.wearUsed = nv.percentage_used;
      if (nv.media_errors != null) info.mediaErrors = nv.media_errors;
      if (nv.temperature != null && info.temperature == null) info.temperature = nv.temperature;
      if (nv.power_on_hours != null) info.powerOnHours = nv.power_on_hours;
    }
    const table = s.ata_smart_attributes && s.ata_smart_attributes.table;
    if (Array.isArray(table)) {
      const attr = (id) => table.find((a) => a.id === id);
      const raw = (id) => { const a = attr(id); return a ? a.raw && a.raw.value : null; };
      info.reallocated = raw(5);
      info.pending = raw(197);
      // SSD wear attributes vary by vendor; normalized "value" counts down from 100
      const wearAttr = attr(231) || attr(233) || attr(177) || attr(202) || attr(169);
      if (wearAttr && info.wearUsed == null && wearAttr.value <= 100) info.wearUsed = 100 - wearAttr.value;
    }
  } else if (rel) {
    // Windows reliability counters (built in, no smartctl)
    if (info.temperature == null && rel.Temp) info.temperature = rel.Temp;
    if (rel.Hours != null) info.powerOnHours = rel.Hours;
    if (rel.Cycles != null) info.powerCycles = rel.Cycles;
    if (rel.Wear != null) info.wearUsed = rel.Wear;
    const errs = (rel.ReadErr || 0) + (rel.WriteErr || 0);
    if (rel.ReadErr != null || rel.WriteErr != null) info.mediaErrors = errs;
    if (rel.Health) info.smartStatus = /healthy/i.test(rel.Health) ? 'Ok' : rel.Health;
  }
  const detailed = !!s || (rel && (rel.Wear != null || rel.Hours != null || rel.Temp));
  if (!detailed) {
    info.notes.push(isWin
      ? 'Only the basic pass/fail status was available. Run Byte Monitor as administrator, or install smartmontools, for full drive health.'
      : 'Only the basic pass/fail status was available. Install smartmontools and run with sudo for full drive health.');
  }

  // Health score
  let score = 100;
  if (info.wearUsed != null) score = Math.min(score, 100 - info.wearUsed);
  if (info.reallocated) score -= Math.min(40, info.reallocated * 2);
  if (info.pending) score -= Math.min(40, info.pending * 5);
  if (info.mediaErrors) score -= Math.min(30, info.mediaErrors);
  const st = String(info.smartStatus).toLowerCase();
  if (st.includes('fail') || st.includes('pred')) score = Math.min(score, 10);
  score = Math.max(0, Math.round(score));

  if (detailed || st.includes('fail') || st.includes('pred') || st.includes('warn') || st.includes('unhealthy')) {
    info.healthPct = score;
    info.rating = score >= 80 ? 'Good' : score >= 50 ? 'Fair' : 'Bad';
  } else if (st === 'ok') {
    info.rating = 'Status OK'; // passed basic check, but no wear data to give a %
  }
  return info;
}

// ---------- Battery ----------
function batteryHealth(b) {
  if (!b || !b.hasBattery) return { present: false };
  const design = b.designedCapacity || 0;
  const full = b.maxCapacity || 0;
  const healthPct = design > 0 && full > 0 ? round(Math.min(100, (full / design) * 100), 1) : null;
  return {
    present: true,
    model: [b.manufacturer, b.model].filter(Boolean).join(' ') || 'Battery',
    unit: b.capacityUnit || 'mWh',
    designCapacity: design,
    fullCapacity: full,
    currentCapacity: b.currentCapacity || 0,
    healthPct,
    wearPct: healthPct != null ? round(100 - healthPct, 1) : null,
    chargePct: b.percent,
    charging: b.isCharging,
    acConnected: b.acConnected,
    cycles: b.cycleCount || null,
    voltage: b.voltage || null,
    timeRemaining: b.timeRemaining,
    rating: healthPct == null ? 'Unknown' : healthPct >= 80 ? 'Good' : healthPct >= 60 ? 'Fair' : 'Replace soon',
  };
}

// ---------- Static info (once) ----------
async function getStatic() {
  const [system, cpu, os, graphics, mem] = await Promise.all([
    si.system(), si.cpu(), si.osInfo(), si.graphics(), si.memLayout(),
  ]);
  return {
    system: { manufacturer: system.manufacturer, model: system.model },
    cpu: { brand: `${cpu.manufacturer} ${cpu.brand}`.trim(), cores: cpu.physicalCores, threads: cpu.cores, speed: cpu.speedMax || cpu.speed },
    os: { distro: os.distro, release: os.release, arch: os.arch, hostname: os.hostname, platform: os.platform },
    gpus: (graphics.controllers || []).filter((g) => !VIRTUAL_GPU.test(`${g.model} ${g.vendor}`)).map((g) => ({ model: g.model, vendor: g.vendor, vram: g.vram, integrated: isIntegrated(g) })),
    memModules: mem.map((m) => ({ size: m.size, type: m.type, speed: m.clockSpeed, slot: m.bank })),
  };
}

// ---------- Live sampling ----------
// Two background loops fill a cache; getLive() just returns it instantly.
//   fast (every 500ms): CPU load, per-core load, clock, memory — cheap
//   slow (back-to-back, ≥1.5s apart): temps, GPU, battery, fans — slow on Windows
const cache = { fast: null, slow: null };
let loopsStarted = false;

async function sampleFast() {
  const [load, mem, speed] = await Promise.all([si.currentLoad(), si.mem(), si.cpuCurrentSpeed()]);
  cache.fast = {
    load: round(load.currentLoad),
    coreLoads: load.cpus.map((c) => round(c.load, 0)),
    ghz: speed.avg,
    mem: { total: mem.total, used: mem.active, pct: round((mem.active / mem.total) * 100), swapTotal: mem.swaptotal, swapUsed: mem.swapused },
  };
}

async function sampleSlow() {
  const [temp, graphics, battery] = await Promise.all([
    si.cpuTemperature().catch(() => ({})), si.graphics().catch(() => ({})), si.battery().catch(() => ({})),
  ]);
  let cpuTemp = temp.main ?? null;
  let cpuTempMax = temp.max ?? null;
  let coreTemps = temp.cores || [];
  let fans = isLinux ? linuxFans() : [];
  const extraTemps = [];
  const l = lhmSensors();
  if (l) {
    const temps = l.filter((x) => x.SensorType === 'Temperature');
    const pkg = temps.find((x) => /package|tctl|tdie|cpu/i.test(x.Name) && /cpu|intel|amd/i.test(x.Parent || ''))
      || temps.find((x) => /package|tctl|tdie/i.test(x.Name));
    if (pkg) cpuTemp = round(pkg.Value);
    const cores = temps.filter((x) => /^core #\d+$/i.test(x.Name)).map((x) => round(x.Value));
    if (cores.length) { coreTemps = cores; cpuTempMax = Math.max(...cores); }
    fans = l.filter((x) => x.SensorType === 'Fan' && x.Value > 0).map((x) => ({ name: x.Name, rpm: Math.round(x.Value) }));
    temps.filter((x) => !/core #|package|tctl|tdie/i.test(x.Name) && !/gpu/i.test(x.Parent || '')).slice(0, 8)
      .forEach((x) => extraTemps.push({ name: x.Name, value: round(x.Value) }));
  }
  if (temp.chipset != null) extraTemps.push({ name: 'Chipset', value: temp.chipset });
  cache.slow = {
    temp: cpuTemp, tempMax: cpuTempMax, coreTemps,
    gpus: buildGpus(graphics.controllers),
    battery: batteryHealth(battery), fans, extraTemps, lhm: !!l,
  };
}

function loop(fn, minGap) {
  const tick = async () => {
    const t = Date.now();
    try { await fn(); } catch {}
    setTimeout(tick, Math.max(50, minGap - (Date.now() - t)));
  };
  tick();
}

async function getLive() {
  if (!loopsStarted) {
    loopsStarted = true;
    startWinSensors();
    loop(sampleFast, 500);
    loop(sampleSlow, 1500);
  }
  // first call: wait until both caches have something
  for (let i = 0; i < 100 && (!cache.fast || !cache.slow); i++) await new Promise((r) => setTimeout(r, 50));
  const f = cache.fast || { load: 0, coreLoads: [], ghz: null, mem: { total: 1, used: 0, pct: 0 } };
  const sl = cache.slow || { temp: null, tempMax: null, coreTemps: [], gpus: [], battery: { present: false }, fans: [], extraTemps: [], lhm: false };
  return {
    ts: Date.now(),
    cpu: { load: f.load, coreLoads: f.coreLoads, temp: sl.temp, tempMax: sl.tempMax, coreTemps: sl.coreTemps, ghz: f.ghz },
    mem: f.mem, gpus: sl.gpus, battery: sl.battery, fans: sl.fans, extraTemps: sl.extraTemps, lhm: sl.lhm,
  };
}

// ---------- Slow poll (every ~30s) ----------
async function getStorage() {
  const [layout, fsSize, rel] = await Promise.all([si.diskLayout().catch(() => []), si.fsSize(), winReliability()]);
  const norm = (x) => String(x || '').replace(/[\s_.\-]/g, '').toUpperCase();
  const relFor = (d) => rel.find((r) => (r.Serial && d.serialNum && (norm(r.Serial).includes(norm(d.serialNum)) || norm(d.serialNum).includes(norm(r.Serial))))
    || (r.Name && d.name && norm(r.Name) === norm(d.name)));
  return {
    disks: layout.map((d) => diskHealth(d, relFor(d))),
    volumes: fsSize
      .filter((v) => v.size > 1e9 && !/^(\/snap|\/boot\/efi|\/run)/.test(v.mount))
      .map((v) => ({ mount: v.mount, fs: v.type, size: v.size, used: v.used, pct: round(v.use) })),
  };
}

module.exports = { getStatic, getLive, getStorage, stopSensors };
