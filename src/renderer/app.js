/* Byte Monitor — renderer */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n, d = 0) => (n === null || n === undefined || Number.isNaN(n) ? '—' : Number(n).toFixed(d));
const gb = (b) => (b ? (b / 1073741824).toFixed(b > 1e11 ? 0 : 1) + ' GB' : '—');
const tb = (b) => (b >= 1e12 ? (b / 1e12).toFixed(2) + ' TB' : (b / 1e9).toFixed(0) + ' GB');

const state = { static: null, live: null, storage: null, meta: null, stats: {} };

// ---------- grading ----------
const tempGrade = (t, warn = 80, crit = 92) => (t == null ? 'na' : t < warn ? 'good' : t < crit ? 'fair' : 'bad');
const pctGrade = (p, good = 80, fair = 60) => (p == null ? 'na' : p >= good ? 'good' : p >= fair ? 'fair' : 'bad');
const gradeColor = (g) => ({ good: 'var(--teal)', fair: 'var(--amber)', bad: 'var(--red)', na: 'var(--dim)' }[g]);
const gradeWord = (g) => ({ good: 'Good', fair: 'Fair', bad: 'Attention', na: 'N/A' }[g]);

// ---------- smooth animation engine ----------
// Sensor samples arrive a couple of times a second. Every animation frame, each
// on-screen value eases toward its latest sample, so values glide instead of
// stepping from reading to reading.
const TAU = 450; // ms smoothing time-constant (bigger = softer)
const tween = { cur: new Map(), tgt: new Map() };
function target(key, v) {
  if (v == null || Number.isNaN(v)) { tween.tgt.set(key, null); tween.cur.set(key, null); return; }
  tween.tgt.set(key, v);
  if (tween.cur.get(key) == null) tween.cur.set(key, v);
}
const val = (key) => tween.cur.get(key);
function stepTweens(dt) { // returns true while anything is still moving
  const k = 1 - Math.exp(-dt / TAU);
  let moving = false;
  for (const [key, t] of tween.tgt) {
    if (t == null) continue;
    const c = tween.cur.get(key);
    if (c === t) continue;
    const n = c + (t - c) * k;
    const done = Math.abs(t - n) <= Math.max(0.01, Math.abs(t) * 0.0005);
    tween.cur.set(key, done ? t : n);
    if (!done) moving = true;
  }
  return moving;
}
const _txt = new WeakMap();
function setText(el, s) { if (el && _txt.get(el) !== s) { el.textContent = s; _txt.set(el, s); } }

// ---------- SVG rings ----------
function ringTicks(c, r, stroke) {
  let out = '';
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    const r1 = r + stroke / 2 + 4, r2 = r1 + (i % 4 === 0 ? 4 : 2);
    out += `<line x1="${c + Math.cos(a) * r1}" y1="${c + Math.sin(a) * r1}" x2="${c + Math.cos(a) * r2}" y2="${c + Math.sin(a) * r2}" stroke="var(--line2)" stroke-width="1"/>`;
  }
  return out;
}
// Static ring (storage cards etc.)
function ring({ value, max = 100, text, unit = '', grade = 'good', size = 150, stroke = 11, arc = 360, sub }) {
  const r = (size - stroke) / 2 - 4;
  const c = size / 2;
  const circ = 2 * Math.PI * r;
  const span = (arc / 360) * circ;
  const pct = value == null ? 0 : Math.max(0, Math.min(1, value / max));
  const rot = arc === 360 ? -90 : 90 + (360 - arc) / 2;
  const col = gradeColor(grade);
  const id = 'g' + Math.random().toString(36).slice(2, 8);
  return `<svg viewBox="0 0 ${size} ${size}" width="100%" height="100%">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" style="stop-color:${grade === 'good' ? 'var(--cyan)' : col}"/><stop offset="1" style="stop-color:${col}"/></linearGradient>
    <filter id="${id}f"><feGaussianBlur stdDeviation="3"/></filter></defs>
    ${arc === 360 ? ringTicks(c, r, stroke) : ''}
    <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="var(--bg)" stroke-width="${stroke}" stroke-dasharray="${span} ${circ}" transform="rotate(${rot} ${c} ${c})" stroke-linecap="round"/>
    <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="url(#${id})" stroke-width="${stroke + 7}" stroke-opacity=".16" stroke-dasharray="${span * pct} ${circ}" transform="rotate(${rot} ${c} ${c})" stroke-linecap="round"/>
    <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="url(#${id})" stroke-width="${stroke}" stroke-dasharray="${span * pct} ${circ}" transform="rotate(${rot} ${c} ${c})" stroke-linecap="round"/>
    <text x="${c}" y="${c + (sub ? 2 : 8)}" text-anchor="middle" class="ring-num" font-size="${size * 0.22}">${esc(text)}<tspan class="ring-unit" font-size="${size * 0.1}" dx="2">${esc(unit)}</tspan></text>
    ${sub ? `<text x="${c}" y="${c + size * 0.17}" text-anchor="middle" class="ring-unit" font-size="${size * 0.075}" letter-spacing="1.5">${esc(sub)}</text>` : ''}
  </svg>`;
}
// Live ring: built once, then redrawn every frame by changing a few attributes
function makeGauge(host, { size = 150, stroke = 11, arc = 360, sub = '' } = {}) {
  const r = (size - stroke) / 2 - 4, c = size / 2, circ = 2 * Math.PI * r, span = (arc / 360) * circ;
  const rot = arc === 360 ? -90 : 90 + (360 - arc) / 2;
  const id = 'g' + Math.random().toString(36).slice(2, 8);
  const circle = (extra) => `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke-width="${stroke}" transform="rotate(${rot} ${c} ${c})" stroke-linecap="round" ${extra}/>`;
  host.innerHTML = `<svg viewBox="0 0 ${size} ${size}" width="100%" height="100%">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop class="s0" offset="0"/><stop class="s1" offset="1"/></linearGradient>
    <filter id="${id}f"><feGaussianBlur stdDeviation="3"/></filter></defs>
    ${arc === 360 ? ringTicks(c, r, stroke) : ''}
    ${circle(`stroke="var(--bg)" stroke-dasharray="${span} ${circ}"`)}
    ${circle(`class="arc glow" stroke="url(#${id})" stroke-opacity=".16" stroke-width="${stroke + 7}" stroke-dasharray="0 ${circ}"`)}
    ${circle(`class="arc" stroke="url(#${id})" stroke-dasharray="0 ${circ}"`)}
    <text x="${c}" y="${c + 2}" text-anchor="middle" class="ring-num" font-size="${size * 0.22}"><tspan class="num">—</tspan><tspan class="ring-unit unit" font-size="${size * 0.1}" dx="2"></tspan></text>
    <text x="${c}" y="${c + size * 0.17}" text-anchor="middle" class="ring-unit subt" font-size="${size * 0.075}" letter-spacing="1.5">${esc(sub)}</text>
  </svg>`;
  const arcs = [...host.querySelectorAll('.arc')];
  const num = host.querySelector('.num'), unit = host.querySelector('.unit'), subt = host.querySelector('.subt');
  const s0 = host.querySelector('.s0'), s1 = host.querySelector('.s1');
  let lastGrade = null, lastDash = '';
  return {
    draw(frac, text, u = '', grade = 'good', subText) {
      frac = Math.max(0, Math.min(1, frac || 0));
      const d = `${(span * frac).toFixed(2)} ${circ}`;
      if (d !== lastDash) { arcs.forEach((e) => e.setAttribute('stroke-dasharray', d)); lastDash = d; }
      setText(num, text); setText(unit, u);
      if (subText != null) setText(subt, subText);
      if (grade !== lastGrade) {
        const col = gradeColor(grade);
        s0.style.stopColor = grade === 'good' ? 'var(--cyan)' : col; s1.style.stopColor = col;
        lastGrade = grade;
      }
    },
  };
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
    } else if (S.disks.length) {
      const basicOk = S.disks.every((d) => d.rating === 'Status OK');
      parts.push({ name: 'Drives', val: basicOk ? 'Basic check OK' : 'No data', score: null, grade: basicOk ? 'good' : 'na' });
    }
  }
  if (L && L.battery.present) parts.push({ name: 'Battery', val: L.battery.healthPct != null ? `${fmt(L.battery.healthPct)}%` : '—', score: L.battery.healthPct, grade: pctGrade(L.battery.healthPct) });
  if (L) parts.push({ name: 'Memory', val: `${fmt(L.mem.pct)}% used`, score: L.mem.pct < 85 ? 100 : 75, grade: L.mem.pct < 85 ? 'good' : 'fair' });

  const scored = parts.filter((p) => p.score != null);
  let score = scored.length ? Math.round(scored.reduce((a, p) => a + p.score, 0) / scored.length) : null;
  if (scored.some((p) => p.grade === 'bad')) score = Math.min(score, 55);
  return { score, parts };
}

// ---------- overview (built once, animated every frame) ----------
const FAN_SVG = '<path fill="currentColor" d="M12 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm.5-9c4.5 0 4.6 3.6 2.3 4.8-1 .5-1.4 1.5-1.6 2.5.5.2 1 .5 1.4 1 3.7-2 7.4-1.1 7.4 3.2 0 4.5-3.5 4.6-4.8 2.3-.5-1-1.5-1.4-2.5-1.6-.2.5-.5 1-1 1.4 2 3.7 1.1 7.4-3.2 7.4-4.5 0-4.6-3.5-2.3-4.8 1-.5 1.4-1.5 1.6-2.5-.5-.2-1-.5-1.4-1-3.7 2-7.4 1.1-7.4-3.2 0-4.5 3.5-4.6 4.8-2.3.5 1 1.5 1.4 2.5 1.6.2-.5.5-1 1-1.4C7.3 5.6 8.2 2 12.5 2Z" opacity=".85"/>';
const ov = { sig: null, html: {}, fans: [] };
const overviewSig = (L) => JSON.stringify([
  Math.min(L.cpu.coreLoads.length, 16), L.cpu.temp != null,
  L.gpus.map((g) => [g.model, g.temp != null, g.load != null]),
  L.fans.map((f) => f.name), !!state.static,
]);

function buildOverview(L) {
  const S = state.static;
  ov.score = makeGauge($('#scoreRing'), { sub: 'HEALTH SCORE' });

  $('#statCpu').innerHTML = `<div class="label">Processor</div><div class="sub">${esc(S?.cpu.brand || '')}</div><div class="gauge"></div>
    <div class="row">Load <b class="k1"></b></div><div class="row">Hottest core <b class="k2"></b></div>`;
  ov.cpu = makeGauge($('#statCpu .gauge'), { size: 112, stroke: 9, arc: 270 });
  ov.cpuK1 = $('#statCpu .k1'); ov.cpuK2 = $('#statCpu .k2');

  if (L.gpus.length) {
    // two GPUs (e.g. Intel/AMD integrated + NVIDIA): start on whichever is busier, chips switch
    if (ov.gpuSel == null || ov.gpuSel >= L.gpus.length) {
      ov.gpuSel = L.gpus.reduce((best, g, i) => ((g.load ?? -1) > (L.gpus[best].load ?? -1) ? i : best), 0);
    }
    const chips = L.gpus.length > 1
      ? `<div class="gpu-chips">${L.gpus.map((g, i) => `<button data-gpu="${i}" class="${i === ov.gpuSel ? 'on' : ''}" title="${esc(g.model)}">${g.integrated ? 'iGPU' : 'dGPU'}</button>`).join('')}</div>` : '';
    const g = L.gpus[ov.gpuSel];
    $('#statGpu').innerHTML = `<div class="label-row"><div class="label">Graphics</div>${chips}</div><div class="sub" title="${esc(g.model)}">${esc(g.model || '')}${L.gpus.length === 1 && g.integrated ? ' · integrated' : ''}</div><div class="gauge"></div>
      <div class="row">Load <b class="k1"></b></div><div class="row"><span class="k3"></span> <b class="k2"></b></div>`;
    ov.gpu = makeGauge($('#statGpu .gauge'), { size: 112, stroke: 9, arc: 270 });
    ov.gpuK1 = $('#statGpu .k1'); ov.gpuK2 = $('#statGpu .k2'); ov.gpuK3 = $('#statGpu .k3');
  } else {
    ov.gpu = null;
    $('#statGpu').innerHTML = `<div class="label">Graphics</div><div class="empty">No GPU sensors found</div>`;
  }

  $('#statMem').innerHTML = `<div class="label">Memory</div><div class="sub">${gb(L.mem.total)} installed</div><div class="gauge"></div>
    <div class="row">Used <b class="k1"></b></div><div class="row">Swap <b class="k2"></b></div>`;
  ov.mem = makeGauge($('#statMem .gauge'), { size: 112, stroke: 9, arc: 270, sub: 'IN USE' });
  ov.memK1 = $('#statMem .k1'); ov.memK2 = $('#statMem .k2');

  const n = Math.min(L.cpu.coreLoads.length, 16);
  $('#cores').style.gridTemplateColumns = `repeat(${Math.max(n, 1)}, 1fr)`;
  $('#cores').innerHTML = Array.from({ length: n }, (_, i) => `<div class="core"><div class="col"><i></i></div><span>${i}</span></div>`).join('');
  ov.cores = [...document.querySelectorAll('#cores .col i')];

  $('#fans').innerHTML = L.fans.length
    ? L.fans.map((f) => `<div class="fan"><svg class="spin" viewBox="0 0 24 24">${FAN_SVG}</svg><span class="fn">${esc(f.name)}</span><span class="fr"></span></div>`).join('')
    : `<div class="empty">${state.meta?.platform === 'win32' ? 'Fan speeds need LibreHardwareMonitor running in the background.' : 'No fan sensors exposed by this hardware.'}</div>`;
  ov.fans = [...document.querySelectorAll('#fans .fan')].map((el) => ({ svg: el.querySelector('svg'), txt: el.querySelector('.fr'), angle: 0 }));

  ov.sig = overviewSig(L);
}

// parts that change rarely: rebuild only when their content actually changes
function setHTMLIfChanged(sel, html) { if (ov.html[sel] !== html) { ov.html[sel] = html; $(sel).innerHTML = html; } }

function renderOverviewSlow() {
  const L = state.live;
  const { score, parts } = overall();
  target('score', score);
  const g = pctGrade(score, 85, 60);
  setText($('#verdict'), score == null ? 'Gathering data…' : g === 'good' ? 'This device is healthy' : g === 'fair' ? 'Some items need a look' : 'Needs attention');
  setHTMLIfChanged('#checks', parts.map((p) => `<li><span class="pip ${p.grade}"></span>${esc(p.name)} <b>${esc(p.val)}</b></li>`).join(''));

  const b = L.battery;
  if (b.present) {
    const bg = pctGrade(b.healthPct);
    setHTMLIfChanged('#batteryMini', `<div class="card-head"><h3>Battery health</h3><span class="pill ${bg}">${esc(b.rating)}</span></div>
      <div class="bat-top"><div class="big">${fmt(b.healthPct, 1)}<small>%</small></div><div class="tiny">of original capacity left<br>${b.cycles ? b.cycles + ' cycles · ' : ''}${fmt(b.chargePct)}% charged${b.charging ? ' ⚡' : ''}</div></div>
      <div class="cap-compare">
        <div class="cap-row"><div class="cap-lbl">Designed max <b>${fmt(b.designCapacity)} ${esc(b.unit)}</b></div><div class="bar design"><i style="width:100%"></i></div></div>
        <div class="cap-row"><div class="cap-lbl">Current max <b>${fmt(b.fullCapacity)} ${esc(b.unit)}</b></div><div class="bar ${bg}"><i style="width:${b.healthPct ?? 0}%"></i></div></div>
      </div>
      <div style="margin-top:12px"><button class="link" data-goto="battery">Battery details →</button></div>`);
  } else {
    setHTMLIfChanged('#batteryMini', `<div class="card-head"><h3>Battery health</h3><span class="pill na">Desktop</span></div><div class="empty">No battery detected — this looks like a desktop or the battery is removed.</div>`);
  }
}

// every animation frame
function paintOverview(dt) {
  const L = state.live;
  if (!L || !ov.sig) return;

  const sc = val('score');
  ov.score.draw(sc == null ? 0 : sc / 100, sc == null ? '—' : fmt(sc), '', pctGrade(tween.tgt.get('score'), 85, 60));

  const hasT = L.cpu.temp != null;
  const cm = val(hasT ? 'cpu.temp' : 'cpu.load');
  ov.cpu.draw((cm || 0) / (hasT ? 105 : 100), fmt(cm), hasT ? '°C' : '%', hasT ? tempGrade(tween.tgt.get('cpu.temp'), 80, 92) : 'good', hasT ? 'TEMP' : 'LOAD');
  setText(ov.cpuK1, fmt(val('cpu.load')) + '%');
  setText(ov.cpuK2, val('cpu.tmax') != null ? fmt(val('cpu.tmax')) + '°C' : '—');

  if (ov.gpu && L.gpus[ov.gpuSel]) {
    const i = ov.gpuSel, g = L.gpus[i];
    const hasGT = g.temp != null;
    const gm = val(`gpu${i}.${hasGT ? 'temp' : 'load'}`);
    ov.gpu.draw((gm || 0) / (hasGT ? 105 : 100), gm != null ? fmt(gm) : '—', gm == null ? '' : hasGT ? '°C' : '%', hasGT ? tempGrade(tween.tgt.get(`gpu${i}.temp`), 82, 92) : 'good', gm == null ? 'NO DATA' : hasGT ? 'TEMP' : 'LOAD');
    setText(ov.gpuK1, val(`gpu${i}.load`) != null ? fmt(val(`gpu${i}.load`)) + '%' : '—');
    const ded = val(`gpu${i}.vram`), sh = val(`gpu${i}.shared`);
    if (!g.integrated && ded != null) { setText(ov.gpuK3, 'VRAM'); setText(ov.gpuK2, fmt(ded / 1024, 1) + (g.memTotal ? ' / ' + fmt(g.memTotal / 1024, 0) : '') + ' GB'); }
    else if (sh != null) { setText(ov.gpuK3, 'Shared memory'); setText(ov.gpuK2, fmt(sh / 1024, 1) + ' GB'); }
    else { setText(ov.gpuK3, 'Memory'); setText(ov.gpuK2, g.memTotal ? fmt(g.memTotal / 1024, 0) + ' GB' : '—'); }
  }

  const mp = val('mem.pct');
  ov.mem.draw((mp || 0) / 100, fmt(mp), '%', (tween.tgt.get('mem.pct') || 0) < 85 ? 'good' : 'fair');
  setText(ov.memK1, gb(val('mem.used')));
  setText(ov.memK2, gb(val('mem.swap')));

  ov.cores.forEach((el, i) => {
    const v = val('core' + i) || 0;
    el.style.height = v.toFixed(1) + '%';
    const hot = v > 85;
    if (el._hot !== hot) { el.classList.toggle('hot', hot); el._hot = hot; }
  });
  setText($('#ghz'), val('ghz') ? `${fmt(val('ghz'), 2)} GHz avg` : '');

  ov.fans.forEach((f, i) => {
    const rpm = val('fan' + i) || 0;
    f.angle = (f.angle + 360 * (rpm / 1800) * (dt / 1000)) % 360; // visual speed scales with RPM
    f.svg.style.transform = `rotate(${f.angle.toFixed(1)}deg)`;
    setText(f.txt, `${Math.round(rpm)} RPM`);
  });
}

// ---------- renderers ----------
function renderDiskMini() {
  const D = state.storage?.disks || [];
  $('#diskMini').innerHTML = D.length
    ? D.map((d) => {
      const basic = d.healthPct == null && d.rating === 'Status OK';
      const g = d.healthPct == null ? (basic ? 'good' : 'na') : pctGrade(d.healthPct, 80, 50);
      return `<div class="disk-row"><div><div class="dn">${esc(d.name)}</div><div class="dm">${esc(d.interface || d.type)} · ${d.sizeGB ? tb(d.sizeGB * 1e9) : ''} · SMART ${esc(d.smartStatus)}</div></div>
      <div class="dt">${d.temperature != null ? fmt(d.temperature) + '°C' : '—'}</div>
      <div><div style="display:flex;justify-content:space-between;font-size:11.5px;margin-bottom:4px"><span class="tiny">Health</span><b class="mono" style="color:${gradeColor(g)}">${d.healthPct != null ? d.healthPct + '%' : basic ? 'OK' : '—'}</b></div><div class="bar ${g}"><i style="width:${d.healthPct ?? (basic ? 100 : 0)}%;${basic ? 'opacity:.35' : ''}"></i></div></div></div>`;
    }).join('')
    : '<div class="empty">Reading drives…</div>';
}

function renderStorage() {
  const S = state.storage;
  if (!S) return;
  $('#diskCards').innerHTML = S.disks.map((d) => {
    const basic = d.healthPct == null && d.rating === 'Status OK';
    const g = d.healthPct == null ? (basic ? 'good' : 'na') : pctGrade(d.healthPct, 80, 50);
    const a = (label, val, warn) => `<div class="attr ${warn ? 'warn' : ''}"><span>${label}</span><b>${val}</b></div>`;
    return `<div class="card disk-card">
      <div class="ring-wrap">${basic ? ring({ value: 0, text: 'OK', grade: 'good', size: 140, stroke: 10, sub: 'BASIC CHECK' }) : ring({ value: d.healthPct, text: d.healthPct ?? '—', unit: d.healthPct != null ? '%' : '', grade: g, size: 140, stroke: 10, sub: 'HEALTH' })}</div>
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
    setHTMLIfChanged('#batteryFull', `<div class="card"><div class="empty">No battery detected. Battery health is only available on laptops and devices with an internal battery.</div></div>`);
    return;
  }
  const g = pctGrade(b.healthPct);
  const lost = b.designCapacity && b.fullCapacity ? b.designCapacity - b.fullCapacity : null;
  setHTMLIfChanged('#batteryFull', `<div class="bat-full">
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
    </div></div>`);
}

// Sensors table: rows are created once and their cells updated in place
const sensorUI = { sig: '', rows: new Map() };
function renderSensors() {
  const entries = Object.entries(state.stats);
  const tbody = $('#sensorTable tbody');
  const sig = entries.map(([k]) => k).join('|');
  if (sig !== sensorUI.sig) {
    sensorUI.sig = sig;
    sensorUI.rows.clear();
    const groups = {};
    entries.forEach(([k, s]) => (groups[s.group] = groups[s.group] || []).push([k, s]));
    tbody.innerHTML = Object.entries(groups).map(([g, list]) => `<tr class="group"><td colspan="5">${esc(g)}</td></tr>` +
      list.map(([k, s]) => `<tr data-key="${esc(k)}"><td>${esc(s.name)}</td><td class="cur"></td><td class="min"></td><td class="max"></td><td><div class="bar"><i></i></div></td></tr>`).join('')).join('')
      || '<tr><td colspan="5" class="empty">Waiting for sensors…</td></tr>';
    tbody.querySelectorAll('tr[data-key]').forEach((tr) => sensorUI.rows.set(tr.dataset.key, {
      cur: tr.querySelector('.cur'), min: tr.querySelector('.min'), max: tr.querySelector('.max'),
      bar: tr.querySelector('.bar'), fill: tr.querySelector('.bar i'),
    }));
  }
  for (const [k, s] of entries) {
    const r = sensorUI.rows.get(k);
    if (!r) continue;
    const u = s.unit;
    const dp = u === 'RPM' || u === '%' || u === 'MB' ? 0 : 1;
    const grade = u === '°C' ? tempGrade(s.cur, 80, 92) : 'good';
    setText(r.cur, `${fmt(s.cur, dp)} ${u}`);
    r.cur.style.color = gradeColor(grade);
    setText(r.min, `${fmt(s.min, dp)} ${u}`);
    setText(r.max, `${fmt(s.max, dp)} ${u}`);
    r.bar.className = 'bar ' + (grade === 'good' ? '' : grade);
    r.fill.style.width = Math.min(100, (s.cur / s.scale) * 100) + '%';
  }
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
      ${S.gpus.map((g) => spec(g.integrated ? 'Integrated' : 'Discrete', `${g.model}${g.vram && !g.integrated ? ' · ' + (g.vram / 1024).toFixed(0) + ' GB' : ''}`)).join('') || '<div class="empty">None</div>'}</div>
    <div class="card"><div class="card-head"><h3>Memory modules</h3></div>
      ${S.memModules.map((m, i) => spec(m.slot || 'Slot ' + (i + 1), `${gb(m.size)} ${m.type || ''} ${m.speed ? m.speed + ' MT/s' : ''}`)).join('') || '<div class="empty">Not reported</div>'}</div>`;
}

// ---------- chart (redrawn every frame, scrolls continuously) ----------
const CHART_WINDOW = 180000; // 3 minutes
const chart = { hist: [], lastPush: 0, w: 0, h: 190, colors: null };
function recordChart(now) {
  if (now - chart.lastPush < 500) return;
  chart.lastPush = now;
  chart.hist.push({ t: now, 'cpu.load': val('cpu.load'), 'cpu.temp': val('cpu.temp') });
  while (chart.hist.length && now - chart.hist[0].t > CHART_WINDOW + 5000) chart.hist.shift();
}
function drawChart(now = performance.now()) {
  const cv = $('#chart');
  const w = cv.clientWidth, h = chart.h;
  if (!w) return;
  const dpr = window.devicePixelRatio || 1;
  if (chart.w !== w || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; chart.w = w; }
  if (!chart.colors) {
    const css = getComputedStyle(document.documentElement);
    const c = (v) => css.getPropertyValue(v).trim();
    chart.colors = { mono: c('--mono'), dim: c('--dim'), line: c('--line') };
  }
  const C = chart.colors;
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const pad = { l: 30, r: 10, t: 8, b: 18 };
  const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
  ctx.font = '10px ' + C.mono;
  ctx.fillStyle = C.dim; ctx.strokeStyle = C.line; ctx.lineWidth = 1;
  ctx.setLineDash([2, 4]);
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (ph * i) / 4;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.fillText(String(100 - i * 25), 4, y + 3);
  }
  ctx.setLineDash([]);
  ctx.fillText('−3 min', pad.l, h - 4);
  ctx.textAlign = 'right'; ctx.fillText('now', w - pad.r, h - 4); ctx.textAlign = 'left';

  const xs = (t) => pad.l + pw - ((now - t) / CHART_WINDOW) * pw;
  const ys = (v) => pad.t + ph * (1 - Math.min(100, Math.max(0, v)) / 100);
  ctx.save();
  ctx.beginPath(); ctx.rect(pad.l, 0, pw + 1, h); ctx.clip();

  const series = (key, color, fill) => {
    const pts = chart.hist.filter((p) => p[key] != null).map((p) => [xs(p.t), ys(p[key])]);
    const head = val(key);
    if (head != null) pts.push([xs(now), ys(head)]);
    if (pts.length < 2) return;
    const path = () => {
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
        ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
      }
      ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    };
    if (fill) {
      path();
      ctx.lineTo(pts[pts.length - 1][0], h - pad.b); ctx.lineTo(pts[0][0], h - pad.b); ctx.closePath();
      const gr = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
      gr.addColorStop(0, color + '55'); gr.addColorStop(1, color + '00');
      ctx.fillStyle = gr; ctx.fill();
    }
    path();
    ctx.lineJoin = 'round';
    ctx.strokeStyle = color + '33'; ctx.lineWidth = 6; ctx.stroke(); // soft glow (cheap — no shadowBlur)
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
    const [lx, ly] = pts[pts.length - 1];
    ctx.beginPath(); ctx.arc(lx - 1, ly, 3.5, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
  };
  series('cpu.load', '#2ee6c9', true);
  series('cpu.temp', '#ff8a3d', false);
  ctx.restore();
}

// ---------- animation loop ----------
// ~30 fps while values are moving, nothing at all while they're settled;
// the chart (which scrolls ~3 px/s) only redraws ~12 times a second.
let lastFrame = performance.now(), lastChart = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = now - lastFrame;
  if (dt < 31) return;
  lastFrame = now;
  const moving = stepTweens(Math.min(100, dt));
  recordChart(now);
  if (!$('#page-overview').classList.contains('active')) return;
  if (moving || ov.fans.length) paintOverview(Math.min(100, dt));
  if (now - lastChart > 80) { lastChart = now; drawChart(now); }
}

// ---------- polling ----------
let polling = false;
async function pollLive() {
  if (polling) return;
  polling = true;
  try {
    const L = await window.byte.live();
    if (!L || L.error) return;
    state.live = L;

    if (overviewSig(L) !== ov.sig) buildOverview(L);
    target('cpu.load', L.cpu.load); target('cpu.temp', L.cpu.temp); target('cpu.tmax', L.cpu.tempMax); target('ghz', L.cpu.ghz);
    L.cpu.coreLoads.slice(0, 16).forEach((v, i) => target('core' + i, v));
    L.gpus.forEach((g, i) => { target(`gpu${i}.temp`, g.temp); target(`gpu${i}.load`, g.load); target(`gpu${i}.vram`, g.memUsed); target(`gpu${i}.shared`, g.shared); });
    target('mem.pct', L.mem.pct); target('mem.used', L.mem.used); target('mem.swap', L.mem.swapUsed);
    L.fans.forEach((f, i) => target('fan' + i, f.rpm));

    track('cpu.temp', 'Processor', 'CPU package', L.cpu.temp, '°C', 105);
    L.cpu.coreTemps.forEach((t, i) => track('cpu.core' + i, 'Processor', `Core #${i} temp`, t, '°C', 105));
    track('cpu.load', 'Processor', 'Total load', L.cpu.load, '%');
    track('cpu.clock', 'Processor', 'Avg clock', L.cpu.ghz, 'GHz', 6);
    L.gpus.forEach((gg, i) => {
      const n = L.gpus.length > 1 ? (gg.integrated ? 'Integrated GPU ' : 'Discrete GPU ') : 'GPU ';
      track(`gpu${i}.t`, 'Graphics', n + 'temperature', gg.temp, '°C', 105);
      track(`gpu${i}.l`, 'Graphics', n + 'load', gg.load, '%');
      track(`gpu${i}.m`, 'Graphics', n + 'memory used', gg.memUsed, 'MB', gg.memTotal || 8192);
      track(`gpu${i}.s`, 'Graphics', n + 'shared memory', gg.shared, 'MB', 8192);
      track(`gpu${i}.p`, 'Graphics', n + 'power', gg.power, 'W', 200);
      track(`gpu${i}.f`, 'Graphics', n + 'fan', gg.fan, '%');
    });
    L.extraTemps.forEach((t) => track('x.' + t.name, 'Board', t.name, t.value, '°C', 105));
    L.fans.forEach((f) => track('fan.' + f.name, 'Fans', f.name, f.rpm, 'RPM', 5000));
    track('mem', 'Memory', 'RAM in use', L.mem.pct, '%');
    if (L.battery.present) {
      track('bat.c', 'Battery', 'Charge level', L.battery.chargePct, '%');
      track('bat.v', 'Battery', 'Voltage', L.battery.voltage, 'V', 20);
    }
    (state.storage?.disks || []).forEach((d) => track('disk.' + d.device, 'Drives', d.name, d.temperature, '°C', 80));

    renderOverviewSlow();
    if ($('#page-battery').classList.contains('active')) renderBattery();
    if ($('#page-thermals').classList.contains('active')) renderSensors();
    setText($('#clock'), 'Live · ' + new Date().toLocaleTimeString());
  } finally {
    polling = false;
  }
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
  if (page === 'battery') renderBattery();
  if (page === 'space' && window.spaceOpen) window.spaceOpen();
}
document.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-gpu]');
  if (chip) { ov.gpuSel = +chip.dataset.gpu; ov.sig = null; if (state.live) buildOverview(state.live); return; }
  const n = e.target.closest('[data-page],[data-goto]');
  if (n) go(n.dataset.page || n.dataset.goto);
});
$('#btnResetMinMax').onclick = () => { state.stats = {}; sensorUI.sig = null; renderSensors(); };
$('#btnReport').onclick = async () => {
  if (!state.live || !state.static) return;
  const name = `health-report-${state.static.os.hostname}-${new Date().toISOString().slice(0, 10)}.html`;
  const r = await window.byte.saveReport(buildReport(), name);
  if (r.saved) toast('Report saved');
};
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); setTimeout(() => t.classList.add('hidden'), 2500); }

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
  requestAnimationFrame(frame);
  setInterval(pollLive, 1000);
  setInterval(pollStorage, 120000);
})();
