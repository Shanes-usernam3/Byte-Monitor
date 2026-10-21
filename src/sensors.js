// Byte Health — hardware sensor layer (Windows + Linux)
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
// This is optional — if it's not running we just get nothing back.
async function lhmSensors() {
  if (!isWin) return null;
  const ps = "Get-CimInstance -Namespace root/LibreHardwareMonitor -ClassName Sensor -ErrorAction Stop | " +
    "Select-Object Name,SensorType,Value,Parent | ConvertTo-Json -Compress";
  const raw = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], 5000);
  if (!raw) return null;
  try {
    let arr = JSON.parse(raw);
    if (!Array.isArray(arr)) arr = [arr];
    return arr;
  } catch { return null; }
}

// ---------- Disk health ----------
function diskHealth(d) {
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
  } else {
    info.notes.push('Detailed SMART needs smartctl (smartmontools) and admin/root.');
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

  const known = s || st === 'ok' || st.includes('fail') || st.includes('pred');
  if (known) {
    info.healthPct = score;
    info.rating = score >= 80 ? 'Good' : score >= 50 ? 'Fair' : 'Bad';
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

// ---------- Fast poll (every ~2s) ----------
async function getLive() {
  const [load, temp, mem, graphics, battery, speed] = await Promise.all([
    si.currentLoad(), si.cpuTemperature(), si.mem(), si.graphics(), si.battery(), si.cpuCurrentSpeed(),
  ]);

  let cpuTemp = temp.main ?? null;
  let cpuTempMax = temp.max ?? null;
  let coreTemps = temp.cores || [];
  let fans = isLinux ? linuxFans() : [];
  const extraTemps = [];

  // Windows: prefer LibreHardwareMonitor sensors if available
  const lhm = await lhmSensors();
  if (lhm) {
    const temps = lhm.filter((x) => x.SensorType === 'Temperature');
    const pkg = temps.find((x) => /package|tctl|tdie|cpu/i.test(x.Name) && /cpu|intel|amd/i.test(x.Parent || ''))
      || temps.find((x) => /package|tctl|tdie/i.test(x.Name));
    if (pkg) cpuTemp = round(pkg.Value);
    const cores = temps.filter((x) => /^core #\d+$/i.test(x.Name)).map((x) => round(x.Value));
    if (cores.length) { coreTemps = cores; cpuTempMax = Math.max(...cores); }
    fans = lhm.filter((x) => x.SensorType === 'Fan' && x.Value > 0).map((x) => ({ name: x.Name, rpm: Math.round(x.Value) }));
    temps.filter((x) => !/core #|package|tctl|tdie/i.test(x.Name)).slice(0, 8)
      .forEach((x) => extraTemps.push({ name: x.Name, value: round(x.Value) }));
  }
  if (temp.chipset != null) extraTemps.push({ name: 'Chipset', value: temp.chipset });

  return {
    ts: Date.now(),
    cpu: {
      load: round(load.currentLoad),
      coreLoads: load.cpus.map((c) => round(c.load, 0)),
      temp: cpuTemp,
      tempMax: cpuTempMax,
      coreTemps,
      ghz: speed.avg,
    },
    mem: {
      total: mem.total, used: mem.active, pct: round((mem.active / mem.total) * 100),
      swapTotal: mem.swaptotal, swapUsed: mem.swapused,
    },
    gpus: (graphics.controllers || []).map((g) => ({
      model: g.model, temp: g.temperatureGpu ?? null, load: g.utilizationGpu ?? null,
      memUsed: g.memoryUsed ?? null, memTotal: g.memoryTotal ?? g.vram ?? null, fan: g.fanSpeed ?? null, power: g.powerDraw ?? null,
    })),
    battery: batteryHealth(battery),
    fans,
    extraTemps,
    lhm: !!lhm,
  };
}

// ---------- Slow poll (every ~30s) ----------
async function getStorage() {
  const [layout, fsSize] = await Promise.all([si.diskLayout().catch(() => []), si.fsSize()]);
  return {
    disks: layout.map(diskHealth),
    volumes: fsSize
      .filter((v) => v.size > 1e9 && !/^(\/snap|\/boot\/efi|\/run)/.test(v.mount))
      .map((v) => ({ mount: v.mount, fs: v.type, size: v.size, used: v.used, pct: round(v.use) })),
  };
}

module.exports = { getStatic, getLive, getStorage };
