/* Byte Monitor — renderer */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n, d = 0) => (n === null || n === undefined || Number.isNaN(n) ? '—' : Number(n).toFixed(d));
const gb = (b) => (b ? (b / 1073741824).toFixed(b > 1e11 ? 0 : 1) + ' GB' : '—');
const tb = (b) => (b >= 1e12 ? (b / 1e12).toFixed(2) + ' TB' : (b / 1e9).toFixed(0) + ' GB');

const state = { static: null, live: null, storage: null, meta: null, hist: { load: [], temp: [] }, stats: {} };
const HIST = 90;

// ---------- grading ----------
const tempGrade = (t, warn = 80, crit = 92) => (t == null ? 'na' : t < warn ? 'good' : t < crit ? 'fair' : 'bad');
const pctGrade = (p, good = 80, fair = 60) => (p == null ? 'na' : p >= good ? 'good' : p >= fair ? 'fair' : 'bad');
const gradeColor = (g) => ({ good: 'var(--teal)', fair: 'var(--amber)', bad: 'var(--red)', na: 'var(--dim)' }[g]);
const gradeWord = (g) => ({ good: 'Good', fair: 'Fair', bad: 'Attention', na: 'N/A' }[g]);

// ---------- SVG rings ----------
function ring({ value, max = 100, text, unit = '', grade = 'good', size = 150, stroke = 11, arc = 360, sub }) {
  const r = (size - stroke) / 2 - 4;
  const c = size / 2;
  const circ = 2 * Math.PI * r;
  const span = (arc / 360) * circ;
  const pct = value == null ? 0 : Math.max(0, Math.min(1, value / max));
  const rot = arc === 360 ? -90 : 90 + (360 - arc) / 2;
  const col = gradeColor(grade);
  const id = 'g' + Math.random().toString(36).slice(2, 8);
  const ticks = [];
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    const r1 = r + stroke / 2 + 4, r2 = r1 + (i % 4 === 0 ? 4 : 2);
    ticks.push(`<line x1="${c + Math.cos(a) * r1}" y1="${c + Math.sin(a) * r1}" x2="${c + Math.cos(a) * r2}" y2="${c + Math.sin(a) * r2}" stroke="var(--line2)" stroke-width="1"/>`);
  }
  return `<svg viewBox="0 0 ${size} ${size}" width="100%" height="100%">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${grade === 'good' ? 'var(--cyan)' : col}"/><stop offset="1" stop-color="${col}"/></linearGradient>
    <filter id="${id}f"><feGaussianBlur stdDeviation="3"/></filter></defs>
    ${arc === 360 ? ticks.join('') : ''}
    <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="var(--bg)" stroke-width="${stroke}" stroke-dasharray="${span} ${circ}" transform="rotate(${rot} ${c} ${c})" stroke-linecap="round"/>
    <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="url(#${id})" stroke-width="${stroke}" stroke-opacity=".35" filter="url(#${id}f)" stroke-dasharray="${span * pct} ${circ}" transform="rotate(${rot} ${c} ${c})" stroke-linecap="round"/>
    <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="url(#${id})" stroke-width="${stroke}" stroke-dasharray="${span * pct} ${circ}" transform="rotate(${rot} ${c} ${c})" stroke-linecap="round" style="transition:stroke-dasharray .6s"/>
    <text x="${c}" y="${c + (sub ? 2 : 8)}" text-anchor="middle" class="ring-num" font-size="${size * 0.22}">${esc(text)}<tspan class="ring-unit" font-size="${size * 0.1}" dx="2">${esc(unit)}</tspan></text>
    ${sub ? `<text x="${c}" y="${c + size * 0.17}" text-anchor="middle" class="ring-unit" font-size="${size * 0.075}" letter-spacing="1.5">${esc(sub)}</text>` : ''}
  </svg>`;
}

// ---------- min/max tracking ----------
function track(key, group, name, value, unit, max = 100) {
  if (value == null || Number.isNaN(value)) return;
  const s = state.stats[key] || (state.stats[key] = { group, name, unit, min: value, max: value, scale: max });
  s.cur = value;
  s.min = Math.min(s.min, value);
  s.max = Math.max(s.max, value);
}

// ---------- overall score ----------
function overall() {
  const L = state.live, S = state.storage;
  const parts = [];
  if (L && L.cpu.temp != null) {
    const t = L.cpu.temp;
    parts.push({ name: 'CPU temp', val: `${fmt(t)}°C`, score: t < 75 ? 100 : t < 85 ? 80 : t < 92 ? 60 : 35, grade: tempGrade(t) });
  }
  const gpu = L && L.gpus.find((g) => g.temp != null);
  if (gpu) parts.push({ name: 'GPU temp', val: `${fmt(gpu.temp)}°C`, score: gpu.temp < 78 ? 100 : gpu.temp < 88 ? 75 : 40, grade: tempGrade(gpu.temp, 82, 92) });
  if (S && S.disks) {
    const rated = S.disks.filter((d) => d.healthPct != null);
    if (rated.length) {
      const worst = rated.reduce((a, b) => (b.healthPct < a.healthPct ? b : a));
      parts.push({ name: 'Drives', val: `${worst.healthPct}%`, score: worst.healthPct, grade: pctGrade(worst.healthPct, 80, 50) });
    } else if (S.disks.length) parts.push({ name: 'Drives', val: 'No SMART', score: null, grade: 'na' });
  }
  if (L && L.battery.present) parts.push({ name: 'Battery', val: L.battery.healthPct != null ? `${fmt(L.battery.healthPct)}%` : '—', score: L.battery.healthPct, grade: pctGrade(L.battery.healthPct) });
  if (L) parts.push({ name: 'Memory', val: `${fmt(L.mem.pct)}% used`, score: L.mem.pct < 85 ? 100 : 75, grade: L.mem.pct < 85 ? 'good' : 'fair' });

  const scored = parts.filter((p) => p.score != null);
  let score = scored.length ? Math.round(scored.reduce((a, p) => a + p.score, 0) / scored.length) : null;
  if (scored.some((p) => p.grade === 'bad')) score = Math.min(score, 55);
  return { score, parts };
}

// ---------- renderers ----------
function renderOverview() {
  const L = state.live, S = state.static;
  if (!L) return;
  const { score, parts } = overall();
  const g = pctGrade(score, 85, 60);
  $('#scoreRing').innerHTML = ring({ value: score, text: score ?? '—', unit: '', grade: g, sub: 'HEALTH SCORE' });
  $('#verdict').textContent = score == null ? 'Gathering data…' : g === 'good' ? 'This device is healthy' : g === 'fair' ? 'Some items need a look' : 'Needs attention';
  $('#checks').innerHTML = parts.map((p) => `<li><span class="pip ${p.grade}"></span>${esc(p.name)} <b>${esc(p.val)}</b></li>`).join('');

  // CPU stat
  const cg = tempGrade(L.cpu.temp, 80, 92);
  $('#statCpu').innerHTML = `<div class="label">Processor</div><div class="sub">${esc(S?.cpu.brand || '')}</div>
    <div class="gauge">${ring({ value: L.cpu.temp ?? L.cpu.load, max: L.cpu.temp != null ? 105 : 100, text: L.cpu.temp != null ? fmt(L.cpu.temp) : fmt(L.cpu.load), unit: L.cpu.temp != null ? '°C' : '%', grade: L.cpu.temp != null ? cg : 'good', size: 112, stroke: 9, arc: 270, sub: L.cpu.temp != null ? 'TEMP' : 'LOAD' })}</div>
    <div class="row">Load <b>${fmt(L.cpu.load)}%</b></div><div class="row">Hottest core <b>${L.cpu.tempMax != null ? fmt(L.cpu.tempMax) + '°C' : '—'}</b></div>`;

  // GPU stat
  const gpu = L.gpus[0];
  if (gpu) {
    const gg = tempGrade(gpu.temp, 82, 92);
    $('#statGpu').innerHTML = `<div class="label">Graphics</div><div class="sub">${esc(gpu.model || '')}</div>
      <div class="gauge">${ring({ value: gpu.temp ?? gpu.load ?? 0, max: gpu.temp != null ? 105 : 100, text: gpu.temp != null ? fmt(gpu.temp) : gpu.load != null ? fmt(gpu.load) : '—', unit: gpu.temp != null ? '°C' : gpu.load != null ? '%' : '', grade: gpu.temp != null ? gg : 'good', size: 112, stroke: 9, arc: 270, sub: gpu.temp != null ? 'TEMP' : 'LOAD' })}</div>
      <div class="row">Load <b>${gpu.load != null ? fmt(gpu.load) + '%' : '—'}</b></div><div class="row">VRAM <b>${gpu.memUsed != null ? fmt(gpu.memUsed / 1024, 1) + ' / ' + fmt(gpu.memTotal / 1024, 0) + ' GB' : gpu.memTotal ? fmt(gpu.memTotal / 1024, 0) + ' GB' : '—'}</b></div>`;
  } else {
    $('#statGpu').innerHTML = `<div class="label">Graphics</div><div class="empty">No GPU sensors found</div>`;
  }

  // Memory
  $('#statMem').innerHTML = `<div class="label">Memory</div><div class="sub">${gb(L.mem.total)} installed</div>
    <div class="gauge">${ring({ value: L.mem.pct, text: fmt(L.mem.pct), unit: '%', grade: L.mem.pct < 85 ? 'good' : 'fair', size: 112, stroke: 9, arc: 270, sub: 'IN USE' })}</div>
    <div class="row">Used <b>${gb(L.mem.used)}</b></div><div class="row">Swap <b>${gb(L.mem.swapUsed)}</b></div>`;

  // Battery mini
  const b = L.battery;
  if (b.present) {
    const bg = pctGrade(b.healthPct);
    $('#batteryMini').innerHTML = `<div class="card-head"><h3>Battery health</h3><span class="pill ${bg}">${esc(b.rating)}</span></div>
      <div class="bat-top"><div class="big">${fmt(b.healthPct, 1)}<small>%</small></div><div class="tiny">of original capacity left<br>${b.cycles ? b.cycles + ' cycles · ' : ''}${fmt(b.chargePct)}% charged${b.charging ? ' ⚡' : ''}</div></div>
      <div class="cap-compare">
        <div class="cap-row"><div class="cap-lbl">Designed max <b>${fmt(b.designCapacity)} ${esc(b.unit)}</b></div><div class="bar design"><i style="width:100%"></i></div></div>
        <div class="cap-row"><div class="cap-lbl">Current max <b>${fmt(b.fullCapacity)} ${esc(b.unit)}</b></div><div class="bar ${bg}"><i style="width:${b.healthPct ?? 0}%"></i></div></div>
      </div>
      <div style="margin-top:12px"><button class="link" data-goto="battery">Battery details →</button></div>`;
  } else {
    $('#batteryMini').innerHTML = `<div class="card-head"><h3>Battery health</h3><span class="pill na">Desktop</span></div><div class="empty">No battery detected — this looks like a desktop or the battery is removed.</div>`;
  }

  // cores
  const loads = L.cpu.coreLoads.slice(0, 16);
  $('#cores').style.gridTemplateColumns = `repeat(${Math.min(loads.length, 16)}, 1fr)`;
  $('#cores').innerHTML = loads.map((l, i) => `<div class="core"><div class="col"><i class="${l > 85 ? 'hot' : ''}" style="height:${l}%"></i></div><span>${i}</span></div>`).join('');
  $('#ghz').textContent = L.cpu.ghz ? `${fmt(L.cpu.ghz, 2)} GHz avg` : '';

  // fans
  $('#fans').innerHTML = L.fans.length
    ? L.fans.map((f) => `<div class="fan"><svg class="spin" style="animation-duration:${Math.max(0.25, 1800 / Math.max(f.rpm, 1))}s" viewBox="0 0 24 24"><path fill="currentColor" d="M12 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm.5-9c4.5 0 4.6 3.6 2.3 4.8-1 .5-1.4 1.5-1.6 2.5.5.2 1 .5 1.4 1 3.7-2 7.4-1.1 7.4 3.2 0 4.5-3.5 4.6-4.8 2.3-.5-1-1.5-1.4-2.5-1.6-.2.5-.5 1-1 1.4 2 3.7 1.1 7.4-3.2 7.4-4.5 0-4.6-3.5-2.3-4.8 1-.5 1.4-1.5 1.6-2.5-.5-.2-1-.5-1.4-1-3.7 2-7.4 1.1-7.4-3.2 0-4.5 3.5-4.6 4.8-2.3.5 1 1.5 1.4 2.5 1.6.2-.5.5-1 1-1.4C7.3 5.6 8.2 2 12.5 2Z" opacity=".85"/></svg><span class="fn">${esc(f.name)}</span><span class="fr">${f.rpm} RPM</span></div>`).join('')
    : `<div class="empty">${state.meta?.platform === 'win32' ? 'Fan speeds need LibreHardwareMonitor running in the background.' : 'No fan sensors exposed by this hardware.'}</div>`;
}

function renderDiskMini() {
  const D = state.storage?.disks || [];
  $('#diskMini').innerHTML = D.length
    ? D.map((d) => {
      const g = d.healthPct == null ? 'na' : pctGrade(d.healthPct, 80, 50);
      return `<div class="disk-row"><div><div class="dn">${esc(d.name)}</div><div class="dm">${esc(d.interface || d.type)} · ${d.sizeGB ? tb(d.sizeGB * 1e9) : ''} · SMART ${esc(d.smartStatus)}</div></div>
      <div class="dt">${d.temperature != null ? fmt(d.temperature) + '°C' : '—'}</div>
      <div><div style="display:flex;justify-content:space-between;font-size:11.5px;margin-bottom:4px"><span class="tiny">Health</span><b class="mono" style="color:${gradeColor(g)}">${d.healthPct != null ? d.healthPct + '%' : '—'}</b></div><div class="bar ${g}"><i style="width:${d.healthPct ?? 0}%"></i></div></div></div>`;
    }).join('')
    : '<div class="empty">Reading drives…</div>';
}

function renderStorage() {
  const S = state.storage;
  if (!S) return;
  $('#diskCards').innerHTML = S.disks.map((d) => {
    const g = d.healthPct == null ? 'na' : pctGrade(d.healthPct, 80, 50);
    const a = (label, val, warn) => `<div class="attr ${warn ? 'warn' : ''}"><span>${label}</span><b>${val}</b></div>`;
    return `<div class="card disk-card">
      <div class="ring-wrap">${ring({ value: d.healthPct, text: d.healthPct ?? '—', unit: d.healthPct != null ? '%' : '', grade: g, size: 140, stroke: 10, sub: 'HEALTH' })}</div>
      <div>
        <div style="display:flex;align-items:center;gap:10px"><h2>${esc(d.name)}</h2><span class="pill ${g}">${esc(d.rating)}</span></div>
        <div class="disk-meta">${esc(d.interface || d.type)} · ${d.sizeGB ? tb(d.sizeGB * 1e9) : ''} · S/N ${esc(d.serial || '—')} · FW ${esc(d.firmware || '—')}</div>
        <div class="attrs">
          ${a('SMART status', esc(d.smartStatus), !/ok/i.test(d.smartStatus))}
          ${a('Temperature', d.temperature != null ? fmt(d.temperature) + '°C' : '—', d.temperature > 55)}
          ${a('Power-on hours', d.powerOnHours != null ? d.powerOnHours.toLocaleString() + ' h' : '—')}
          ${a('Power cycles', d.powerCycles != null ? d.powerCycles.toLocaleString() : '—')}
          ${a('Life used', d.wearUsed != null ? d.wearUsed + '%' : '—', d.wearUsed > 50)}
          ${a('Reallocated', d.reallocated != null ? d.reallocated : '—', d.reallocated > 0)}
          ${a('Pending sectors', d.pending != null ? d.pending : '—', d.pending > 0)}
          ${a('Media errors', d.mediaErrors != null ? d.mediaErrors : '—', d.mediaErrors > 0)}
        </div>
        ${d.notes.map((n) => `<div class="note">ⓘ ${esc(n)}</div>`).join('')}
      </div></div>`;
  }).join('') || '<div class="card empty">No drives found.</div>';

  $('#volumes').innerHTML = S.volumes.map((v) => {
    const g = v.pct < 80 ? 'good' : v.pct < 92 ? 'fair' : 'bad';
    return `<div class="vol"><div><div class="vm">${esc(v.mount)}</div><div class="tiny">${esc(v.fs)}</div></div><div class="bar lg ${g}"><i style="width:${v.pct}%"></i></div><div class="vs">${tb(v.used)} / ${tb(v.size)} · ${fmt(v.pct)}%</div></div>`;
  }).join('') || '<div class="empty">No volumes.</div>';
}

function renderBattery() {
  const b = state.live?.battery;
  if (!b) return;
  if (!b.present) {
    $('#batteryFull').innerHTML = `<div class="card"><div class="empty">No battery detected. Battery health is only available on laptops and devices with an internal battery.</div></div>`;
    return;
  }
  const g = pctGrade(b.healthPct);
  const lost = b.designCapacity && b.fullCapacity ? b.designCapacity - b.fullCapacity : null;
  $('#batteryFull').innerHTML = `<div class="bat-full">
    <div class="card bat-visual">
      <div class="eyebrow">Capacity left</div>
      <div class="battery-shape"><i class="${g}" style="width:${b.healthPct ?? 0}%"></i></div>
      <div class="big">${fmt(b.healthPct, 1)}<small>%</small></div>
      <span class="pill ${g}">${esc(b.rating)}</span>
    </div>
    <div class="card">
      <div class="card-head"><h3>${esc(b.model)}</h3><span class="tiny">${b.acConnected ? 'On AC power' : 'On battery'}${b.charging ? ' · charging' : ''}</span></div>
      <div class="cap-compare">
        <div class="cap-row"><div class="cap-lbl">Designed max capacity (new) <b>${fmt(b.designCapacity)} ${esc(b.unit)}</b></div><div class="bar lg design"><i style="width:100%"></i></div></div>
        <div class="cap-row"><div class="cap-lbl">Current max capacity (full charge) <b>${fmt(b.fullCapacity)} ${esc(b.unit)}</b></div><div class="bar lg ${g}"><i style="width:${b.healthPct ?? 0}%"></i></div></div>
        <div class="cap-row"><div class="cap-lbl">Charge right now <b>${fmt(b.currentCapacity)} ${esc(b.unit)} · ${fmt(b.chargePct)}%</b></div><div class="bar lg"><i style="width:${b.chargePct ?? 0}%"></i></div></div>
      </div>
      <div class="kv">
        <div><span>Health</span><b>${fmt(b.healthPct, 1)}%</b></div>
        <div><span>Wear</span><b>${fmt(b.wearPct, 1)}%${lost ? ' (−' + fmt(lost) + ' ' + esc(b.unit) + ')' : ''}</b></div>
        <div><span>Charge cycles</span><b>${b.cycles ?? '—'}</b></div>
        <div><span>Voltage</span><b>${b.voltage ? fmt(b.voltage, 2) + ' V' : '—'}</b></div>
        <div><span>Time remaining</span><b>${b.timeRemaining ? Math.floor(b.timeRemaining / 60) + 'h ' + (b.timeRemaining % 60) + 'm' : '—'}</b></div>
        <div><span>Rating</span><b>${esc(b.rating)}</b></div>
      </div>
      <div class="explain">Health compares what the battery can hold when fully charged today against what it was designed to hold when new. 80%+ is healthy; 60–80% is normal wear but expect shorter runtime; under 60% is usually worth replacing.</div>
    </div></div>`;
}

function renderSensors() {
  const rows = Object.entries(state.stats);
  const groups = {};
  rows.forEach(([k, s]) => (groups[s.group] = groups[s.group] || []).push(s));
  const tbody = $('#sensorTable tbody');
  tbody.innerHTML = Object.entries(groups).map(([g, list]) => `<tr class="group"><td colspan="5">${esc(g)}</td></tr>` + list.map((s) => {
    const u = s.unit;
    const dp = u === 'RPM' || u === '%' ? 0 : 1;
    const grade = u === '°C' ? tempGrade(s.cur, 80, 92) : 'good';
    const pct = Math.min(100, (s.cur / s.scale) * 100);
    return `<tr><td>${esc(s.name)}</td><td style="color:${gradeColor(grade)}">${fmt(s.cur, dp)} ${u}</td><td class="min">${fmt(s.min, dp)} ${u}</td><td class="max">${fmt(s.max, dp)} ${u}</td><td><div class="bar ${grade === 'good' ? '' : grade}"><i style="width:${pct}%"></i></div></td></tr>`;
  }).join('')).join('') || '<tr><td colspan="5" class="empty">Waiting for sensors…</td></tr>';
}

function renderSystem() {
  const S = state.static, L = state.live;
  if (!S) return;
  const spec = (k, v) => `<div class="spec"><span>${k}</span><b>${esc(v ?? '—')}</b></div>`;
  $('#sysCards').innerHTML = `
    <div class="card"><div class="card-head"><h3>Device</h3></div>
      ${spec('Hostname', S.os.hostname)}${spec('Make', S.system.manufacturer)}${spec('Model', S.system.model)}${spec('Operating system', `${S.os.distro} ${S.os.release}`)}${spec('Architecture', S.os.arch)}</div>
    <div class="card"><div class="card-head"><h3>Processor</h3></div>
      ${spec('Model', S.cpu.brand)}${spec('Cores / threads', `${S.cpu.cores} / ${S.cpu.threads}`)}${spec('Max clock', S.cpu.speed ? S.cpu.speed + ' GHz' : '—')}${spec('Sensor source', L?.lhm ? 'LibreHardwareMonitor' : 'OS / ACPI')}</div>
    <div class="card"><div class="card-head"><h3>Graphics</h3></div>
      ${S.gpus.map((g) => spec(g.vendor || 'GPU', `${g.model}${g.vram ? ' · ' + (g.vram / 1024).toFixed(0) + ' GB' : ''}`)).join('') || '<div class="empty">None</div>'}</div>
    <div class="card"><div class="card-head"><h3>Memory modules</h3></div>
      ${S.memModules.map((m, i) => spec(m.slot || 'Slot ' + (i + 1), `${gb(m.size)} ${m.type || ''} ${m.speed ? m.speed + ' MT/s' : ''}`)).join('') || '<div class="empty">Not reported</div>'}</div>`;
}

// ---------- chart ----------
function drawChart() {
  const cv = $('#chart');
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = 190;
  if (!w) return;
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  const pad = { l: 30, r: 8, t: 8, b: 18 };
  const css = getComputedStyle(document.documentElement);
  const c = (v) => css.getPropertyValue(v).trim();
  ctx.font = '10px ' + c('--mono');
  ctx.fillStyle = c('--dim');
  ctx.strokeStyle = c('--line');
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + ((h - pad.t - pad.b) * i) / 4;
    ctx.beginPath(); ctx.setLineDash([2, 4]); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.fillText(String(100 - i * 25), 4, y + 3);
  }
  ctx.setLineDash([]);
  ctx.fillText('−3 min', pad.l, h - 4);
  ctx.textAlign = 'right'; ctx.fillText('now', w - pad.r, h - 4); ctx.textAlign = 'left';

  const line = (arr, color, fill) => {
    if (arr.length < 2) return;
    const xs = (i) => pad.l + ((w - pad.l - pad.r) * (i + HIST - arr.length)) / (HIST - 1);
    const ys = (v) => pad.t + (h - pad.t - pad.b) * (1 - Math.min(100, Math.max(0, v)) / 100);
    ctx.beginPath();
    arr.forEach((v, i) => (i ? ctx.lineTo(xs(i), ys(v)) : ctx.moveTo(xs(i), ys(v))));
    if (fill) {
      ctx.save();
      ctx.lineTo(xs(arr.length - 1), h - pad.b); ctx.lineTo(xs(0), h - pad.b); ctx.closePath();
      const gr = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
      gr.addColorStop(0, color + '55'); gr.addColorStop(1, color + '00');
      ctx.fillStyle = gr; ctx.fill(); ctx.restore();
      ctx.beginPath();
      arr.forEach((v, i) => (i ? ctx.lineTo(xs(i), ys(v)) : ctx.moveTo(xs(i), ys(v))));
    }
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.shadowColor = color; ctx.shadowBlur = 8; ctx.stroke(); ctx.shadowBlur = 0;
    const lx = xs(arr.length - 1), ly = ys(arr[arr.length - 1]);
    ctx.beginPath(); ctx.arc(lx, ly, 3.5, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
  };
  line(state.hist.load, '#2ee6c9', true);
  line(state.hist.temp.filter((v) => v != null), '#ff8a3d', false);
}

// ---------- polling ----------
async function pollLive() {
  const L = await window.byte.live();
  if (!L || L.error) return;
  state.live = L;
  state.hist.load.push(L.cpu.load); if (state.hist.load.length > HIST) state.hist.load.shift();
  state.hist.temp.push(L.cpu.temp); if (state.hist.temp.length > HIST) state.hist.temp.shift();

  track('cpu.temp', 'Processor', 'CPU package', L.cpu.temp, '°C', 105);
  L.cpu.coreTemps.forEach((t, i) => track('cpu.core' + i, 'Processor', `Core #${i} temp`, t, '°C', 105));
  track('cpu.load', 'Processor', 'Total load', L.cpu.load, '%');
  track('cpu.clock', 'Processor', 'Avg clock', L.cpu.ghz, 'GHz', 6);
  L.gpus.forEach((g, i) => {
    const n = L.gpus.length > 1 ? `GPU ${i} ` : 'GPU ';
    track(`gpu${i}.t`, 'Graphics', n + 'temperature', g.temp, '°C', 105);
    track(`gpu${i}.l`, 'Graphics', n + 'load', g.load, '%');
    track(`gpu${i}.p`, 'Graphics', n + 'power', g.power, 'W', 200);
    track(`gpu${i}.f`, 'Graphics', n + 'fan', g.fan, '%');
  });
  L.extraTemps.forEach((t) => track('x.' + t.name, 'Board', t.name, t.value, '°C', 105));
  L.fans.forEach((f) => track('fan.' + f.name, 'Fans', f.name, f.rpm, 'RPM', 5000));
  track('mem', 'Memory', 'RAM in use', L.mem.pct, '%');
  if (L.battery.present) {
    track('bat.c', 'Battery', 'Charge level', L.battery.chargePct, '%');
    track('bat.v', 'Battery', 'Voltage', L.battery.voltage, 'V', 20);
  }
  (state.storage?.disks || []).forEach((d) => track('disk.' + d.device, 'Drives', d.name, d.temperature, '°C', 80));

  renderOverview();
  renderBattery();
  if ($('#page-thermals').classList.contains('active')) renderSensors();
  drawChart();
  $('#clock').textContent = 'Live · ' + new Date().toLocaleTimeString();
}

async function pollStorage() {
  const S = await window.byte.storage();
  if (!S || S.error) return;
  state.storage = S;
  renderDiskMini();
  renderStorage();
}

// ---------- report ----------
function buildReport() {
  const S = state.static, L = state.live, D = state.storage;
  const { score, parts } = overall();
  const row = (k, v) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`;
  const b = L.battery;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Health report – ${esc(S.os.hostname)}</title>
<style>body{font:14px/1.5 Segoe UI,system-ui,sans-serif;max-width:860px;margin:30px auto;color:#10202a;padding:0 20px}h1{margin:0}h2{border-bottom:2px solid #2ee6c9;padding-bottom:4px;margin-top:28px;font-size:17px}table{width:100%;border-collapse:collapse}td{padding:6px 8px;border-bottom:1px solid #e3ecef}td:first-child{color:#5b7380;width:42%}.score{font-size:42px;font-weight:700;color:#0a9e88}.muted{color:#5b7380}</style></head><body>
<div class="muted">Byte Monitor · HardPoint Networks</div><h1>Device health report</h1><div class="muted">${esc(S.os.hostname)} · ${new Date().toLocaleString()}</div>
<p><span class="score">${score ?? '—'}</span> / 100</p>
<table>${parts.map((p) => row(p.name, `${p.val} — ${gradeWord(p.grade)}`)).join('')}</table>
<h2>System</h2><table>${row('Make / model', `${S.system.manufacturer} ${S.system.model}`)}${row('OS', `${S.os.distro} ${S.os.release} (${S.os.arch})`)}${row('CPU', `${S.cpu.brand} · ${S.cpu.cores}C/${S.cpu.threads}T`)}${row('Memory', gb(L.mem.total))}${S.gpus.map((g) => row('GPU', g.model)).join('')}</table>
<h2>Battery</h2><table>${b.present ? row('Battery', b.model) + row('Designed max capacity', `${b.designCapacity} ${b.unit}`) + row('Current max capacity', `${b.fullCapacity} ${b.unit}`) + row('Capacity left', `${fmt(b.healthPct, 1)}% (${b.rating})`) + row('Charge cycles', b.cycles ?? '—') : row('Battery', 'None detected')}</table>
<h2>Drives</h2><table>${(D?.disks || []).map((d) => row(d.name, `Health ${d.healthPct ?? '—'}% (${d.rating}) · SMART ${d.smartStatus} · ${d.temperature != null ? d.temperature + '°C' : 'temp n/a'} · ${d.powerOnHours != null ? d.powerOnHours + ' h on' : ''}${d.wearUsed != null ? ' · life used ' + d.wearUsed + '%' : ''}${d.reallocated ? ' · reallocated ' + d.reallocated : ''}`)).join('')}${(D?.volumes || []).map((v) => row('Volume ' + v.mount, `${tb(v.used)} of ${tb(v.size)} used (${fmt(v.pct)}%)`)).join('')}</table>
<h2>Sensors (this session)</h2><table><tr><td><b>Sensor</b></td><td><b>Current · Min · Max</b></td></tr>${Object.values(state.stats).map((s) => row(`${s.group} – ${s.name}`, `${fmt(s.cur, 1)} · ${fmt(s.min, 1)} · ${fmt(s.max, 1)} ${s.unit}`)).join('')}</table>
</body></html>`;
}

// ---------- nav ----------
const titles = { overview: 'Device overview', thermals: 'Sensors', storage: 'Storage health', space: 'Space analyzer', battery: 'Battery health', system: 'System info' };
function go(page) {
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + page));
  $('#pageTitle').textContent = titles[page];
  if (page === 'thermals') renderSensors();
  if (page === 'overview') requestAnimationFrame(drawChart);
  if (page === 'space' && window.spaceOpen) window.spaceOpen();
}
document.addEventListener('click', (e) => {
  const n = e.target.closest('[data-page],[data-goto]');
  if (n) go(n.dataset.page || n.dataset.goto);
});
$('#btnResetMinMax').onclick = () => { state.stats = {}; renderSensors(); };
$('#btnReport').onclick = async () => {
  if (!state.live || !state.static) return;
  const name = `health-report-${state.static.os.hostname}-${new Date().toISOString().slice(0, 10)}.html`;
  const r = await window.byte.saveReport(buildReport(), name);
  if (r.saved) toast('Report saved');
};
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); setTimeout(() => t.classList.add('hidden'), 2500); }
window.addEventListener('resize', drawChart);

// ---------- boot ----------
(async () => {
  state.meta = await window.byte.meta();
  if (state.meta.demo) $('#demoBadge').classList.remove('hidden');
  $('#srcNote').textContent = `v${state.meta.version} · ${state.meta.platform === 'win32' ? 'Windows' : 'Linux'}`;
  const S = await window.byte.static();
  if (S && !S.error) {
    state.static = S;
    $('#hostLine').textContent = `${S.os.hostname} · ${S.system.manufacturer} ${S.system.model}`.trim();
    renderSystem();
  }
  pollStorage();
  await pollLive();
  setInterval(pollLive, 2000);
  setInterval(pollStorage, 30000);
})();
