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

// LibreHardwareMonitor exposes sensors over WMI when it is running.
// Spawning PowerShell per poll is slow (~1s), so keep ONE PowerShell process
// alive that prints a JSON snapshot every second. Optional — if LHM isn't
// running we just get nothing and retry every 30s.
const lhm = { proc: null, latest: null, at: 0, retryAt: 0 };
function startLhm() {
  if (!isWin || lhm.proc || Date.now() < lhm.retryAt) return;
  const { spawn } = require('child_process');
  const script = "$ErrorActionPreference='Stop'; while ($true) { try { " +
    "$s = Get-CimInstance -Namespace root/LibreHardwareMonitor -ClassName Sensor | Select-Object Name,SensorType,Value,Parent; " +
    "[Console]::Out.WriteLine(($s | ConvertTo-Json -Compress)); } catch { [Console]::Out.WriteLine('NOLHM') } " +
    "[Console]::Out.WriteLine('@@END@@'); [Console]::Out.Flush(); Start-Sleep -Milliseconds 900 }";
  const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
  lhm.proc = p;
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('@@END@@')) !== -1) {
      const chunk = buf.slice(0, i).trim();
      buf = buf.slice(i + 7);
      if (!chunk || chunk.startsWith('NOLHM')) { lhm.latest = null; continue; }
      try { let arr = JSON.parse(chunk); if (!Array.isArray(arr)) arr = [arr]; lhm.latest = arr; lhm.at = Date.now(); } catch {}
    }
  });
  p.on('exit', () => { lhm.proc = null; lhm.retryAt = Date.now() + 30000; });
}
function lhmSensors() {
  startLhm();
  return lhm.latest && Date.now() - lhm.at < 10000 ? lhm.latest : null;
}
function stopSensors() { if (lhm.proc) { try { lhm.proc.kill(); } catch {} } }

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
    gpus: (graphics.controllers || []).map((g) => ({ model: g.model, vendor: g.vendor, vram: g.vram })),
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
    temps.filter((x) => !/core #|package|tctl|tdie/i.test(x.Name)).slice(0, 8)
      .forEach((x) => extraTemps.push({ name: x.Name, value: round(x.Value) }));
  }
  if (temp.chipset != null) extraTemps.push({ name: 'Chipset', value: temp.chipset });
  cache.slow = {
    temp: cpuTemp, tempMax: cpuTempMax, coreTemps,
    gpus: (graphics.controllers || []).map((g) => ({
      model: g.model, temp: g.temperatureGpu ?? null, load: g.utilizationGpu ?? null,
      memUsed: g.memoryUsed ?? null, memTotal: g.memoryTotal ?? g.vram ?? null, fan: g.fanSpeed ?? null, power: g.powerDraw ?? null,
    })),
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
    startLhm();
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
