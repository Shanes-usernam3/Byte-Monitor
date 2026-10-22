/* Byte Monitor — Space analyzer (WizTree-style)
 * Left:  whole-drive treemap on a canvas, always at the same scale.
 * Right: expandable folder tree with the full path above it.
 * Selecting in either one highlights it in the other.
 */
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const size = (b) => {
    if (b == null) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; let v = b;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)) + ' ' + u[i];
  };
  const api = window.byte.space;

  // ---------- file-type colours ----------
  const CATS = [
    { name: 'Video', c: '#a678ff', x: 'mp4 mkv avi mov wmv webm m4v flv ts mpg mpeg vob iso' },
    { name: 'Pictures', c: '#22c3e6', x: 'jpg jpeg png gif bmp webp heic raw cr2 nef psd tif tiff svg ico' },
    { name: 'Audio', c: '#ff5fa2', x: 'mp3 flac wav aac ogg m4a wma opus aiff' },
    { name: 'Archives', c: '#ff8a3d', x: 'zip rar 7z gz tar xz bz2 zst cab msi pkg deb rpm appimage dmg' },
    { name: 'Programs', c: '#ffc24d', x: 'exe dll sys so a lib bin o pyc jar class node wasm drv ko' },
    { name: 'Documents', c: '#4dd68c', x: 'pdf doc docx xls xlsx ppt pptx txt md csv odt ods rtf epub log json xml html' },
    { name: 'Disks & data', c: '#5b8cff', x: 'vhd vhdx vmdk qcow2 vdi img pst ost db sqlite mdf edb dat pak' },
  ];
  const OTHER = '#56707c';
  const extColor = new Map();
  CATS.forEach((cat) => cat.x.split(' ').forEach((e) => extColor.set(e, cat.c)));
  const colorOfExt = (e) => extColor.get(e) || OTHER;
  const colorOfName = (n) => colorOfExt((n.includes('.') ? n.split('.').pop() : '').toLowerCase());

  const sp = {
    targets: [], target: null, scanning: false, done: null,
    // tree
    kids: new Map(),      // dirId -> children result
    open: new Set([0]),   // expanded dir ids
    rows: [],             // flattened visible rows
    sel: { dir: 0, fi: -1, kind: 'dir' },
    // map
    lay: null, layW: 0, layH: 0, hover: -1, dirRect: new Map(), selChain: [0],
  };

  // ---------- tree ----------
  async function kidsOf(id) {
    if (!sp.kids.has(id)) sp.kids.set(id, await api.children(id));
    return sp.kids.get(id);
  }

  function flatten() {
    const rows = [];
    const walk = (id, depth) => {
      const k = sp.kids.get(id);
      if (!k) return;
      for (const it of k.items) {
        rows.push({ ...it, parent: id, depth, pct: k.s ? (it.s / k.s) * 100 : 0 });
        if (it.kind === 'dir' && sp.open.has(it.id) && sp.kids.has(it.id)) walk(it.id, depth + 1);
      }
    };
    const root = sp.kids.get(0);
    if (root) {
      rows.push({ kind: 'dir', id: 0, n: sp.done.root, s: root.s, f: root.f, open: 1, parent: -1, depth: 0, pct: 100 });
      if (sp.open.has(0)) walk(0, 1);
    }
    sp.rows = rows;
  }

  const isSel = (r) => (r.kind === 'dir' ? sp.sel.kind === 'dir' && sp.sel.dir === r.id
    : r.kind === 'file' ? sp.sel.kind === 'file' && sp.sel.dir === r.parent && sp.sel.fi === r.fi
      : sp.sel.kind === 'rest' && sp.sel.dir === r.parent);

  function renderTree() {
    flatten();
    $('#spTree').innerHTML = sp.rows.map((r, i) => {
      const tw = r.kind === 'dir' && r.open ? `<span class="tw ${sp.open.has(r.id) ? 'open' : ''}" data-tw="${i}">▶</span>` : '<span class="tw"></span>';
      const ic = r.kind === 'dir' ? '<span class="ic dir"></span>' : `<span class="ic" style="background:${r.kind === 'rest' ? '#3a5361' : colorOfName(r.n)}"></span>`;
      return `<div class="tr-row ${r.kind === 'rest' ? 'rest' : ''} ${isSel(r) ? 'sel' : ''}" style="--d:${Math.min(r.depth, 14)}" data-ri="${i}" title="${esc(r.n)}">
        <div class="tr-name">${tw}${ic}<span class="nm">${esc(r.n)}${r.err ? ' <span class="tiny">(no access)</span>' : ''}</span></div>
        <div class="tr-pct"><div class="b"><i style="width:${r.pct.toFixed(1)}%"></i></div><span>${r.pct >= 10 ? r.pct.toFixed(0) : r.pct.toFixed(1)}%</span></div>
        <div class="sz r">${size(r.s)}</div>
        <div class="fc r">${r.kind === 'dir' ? (r.f || 0).toLocaleString() : r.kind === 'rest' ? '' : '1'}</div></div>`;
    }).join('');
  }

  function scrollSelIntoView() { // scroll only the tree panel, never the page
    const t = $('#spTree'), el = t.querySelector('.tr-row.sel');
    if (!el) return;
    const top = el.offsetTop, bottom = top + el.offsetHeight;
    if (top < t.scrollTop) t.scrollTop = Math.max(0, top - 40);
    else if (bottom > t.scrollTop + t.clientHeight) t.scrollTop = bottom - t.clientHeight + 40;
  }

  async function renderPath() {
    const segs = await api.segments(sp.sel.dir);
    if (!segs) return;
    let html = segs.map((g, i) => `${i ? '<i>›</i>' : ''}<button data-seg="${g.id}" class="${i === segs.length - 1 && sp.sel.kind === 'dir' ? 'last' : ''}">${esc(g.name)}</button>`).join('');
    if (sp.sel.kind !== 'dir') {
      const r = sp.rows.find((x) => isSel(x));
      if (r) html += `<i>›</i><button class="last" disabled>${esc(r.n)}</button>`;
    }
    $('#spPath').innerHTML = html;
    const k = sp.kids.get(sp.sel.dir);
    const r = sp.rows.find((x) => isSel(x));
    $('#spSummary').textContent = r ? `${size(r.s)}${r.kind === 'dir' ? ' · ' + (r.f || 0).toLocaleString() + ' files' : ''}` : k ? size(k.s) : '';
  }

  async function select(sel, { expand = false, scroll = true } = {}) {
    sp.sel = sel;
    // make sure every ancestor is loaded + open so the row is visible
    const chain = await api.chain(sel.dir);
    for (const id of chain) { await kidsOf(id); }
    chain.slice(0, sel.kind === 'dir' && !expand ? -1 : undefined).forEach((id) => sp.open.add(id));
    if (expand && sel.kind === 'dir') { await kidsOf(sel.dir); sp.open.add(sel.dir); }
    renderTree();
    if (scroll) scrollSelIntoView();
    renderPath();
    drawOverlay();
  }

  async function toggle(id) {
    if (sp.open.has(id)) sp.open.delete(id);
    else { await kidsOf(id); sp.open.add(id); }
    renderTree();
  }

  // ---------- treemap ----------
  const base = () => $('#spBase'), over = () => $('#spOver');
  const gradCache = new Map();
  function cushion(ctx, color) {
    if (gradCache.has(color)) return gradCache.get(color);
    const g = ctx.createLinearGradient(0, 0, 1, 1);
    g.addColorStop(0, shade(color, 1.35)); g.addColorStop(0.55, color); g.addColorStop(1, shade(color, 0.55));
    gradCache.set(color, g);
    return g;
  }
  function shade(hex, f) {
    const n = parseInt(hex.slice(1), 16);
    const ch = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
    return `rgb(${ch(n >> 16)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
  }

  async function layoutMap() {
    const host = $('#spMap');
    const w = Math.floor(host.clientWidth), h = Math.floor(host.clientHeight);
    if (!w || !h || !sp.done) return;
    sp.lay = await api.layout(w, h);
    sp.layW = w; sp.layH = h;
    sp.dirRect = new Map();
    for (let i = 0; i < sp.lay.n; i++) if (sp.lay.meta[i * 4] === 0) sp.dirRect.set(sp.lay.meta[i * 4 + 2], i);
    drawBase();
    drawOverlay();
  }

  function sizeCanvas(cv) {
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(sp.layW * dpr); cv.height = Math.round(sp.layH * dpr);
    const ctx = cv.getContext('2d');
    return { ctx, dpr };
  }

  function drawBase() {
    const L = sp.lay;
    if (!L) return;
    const { ctx, dpr } = sizeCanvas(base());
    gradCache.clear();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#050a0e'; ctx.fillRect(0, 0, sp.layW, sp.layH);
    const g = L.geo, m = L.meta;
    for (let i = 0; i < L.n; i++) {
      const x = g[i * 4], y = g[i * 4 + 1], w = g[i * 4 + 2], h = g[i * 4 + 3];
      const kind = m[i * 4], depth = m[i * 4 + 1];
      if (kind === 0) {
        // folder background — visible as the thin borders between its children
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = depth === 0 ? '#050a0e' : `rgba(46,230,201,${Math.max(0.05, 0.22 - depth * 0.03)})`;
        ctx.fillRect(x, y, w, h);
        if (w < 4 || h < 4) { ctx.fillStyle = '#2b4a55'; ctx.fillRect(x, y, w, h); }
      } else {
        const inset = w > 2.5 && h > 2.5 ? 0.5 : 0;
        const rx = x + inset, ry = y + inset, rw = w - inset * 2, rh = h - inset * 2;
        const color = kind === 2 ? '#3a5361' : colorOfExt(L.exts[i]);
        ctx.setTransform(dpr * rw, 0, 0, dpr * rh, dpr * rx, dpr * ry); // unit-square cushion gradient
        ctx.fillStyle = cushion(ctx, color);
        ctx.fillRect(0, 0, 1, 1);
      }
    }
    // labels on big top-level folders
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = '600 11px ' + getComputedStyle(document.documentElement).getPropertyValue('--font');
    ctx.textBaseline = 'top';
    const order = [];
    for (let i = 0; i < L.n; i++) if (m[i * 4] === 0 && (m[i * 4 + 1] === 2)) order.push(i);
    for (let i = 0; i < L.n; i++) if (m[i * 4] === 0 && (m[i * 4 + 1] === 1)) order.push(i); // top level drawn last = on top
    for (const i of order) {
      const depth = m[i * 4 + 1];
      const x = g[i * 4], y = g[i * 4 + 1], w = g[i * 4 + 2], h = g[i * 4 + 3];
      if (w < (depth === 1 ? 70 : 120) || h < (depth === 1 ? 22 : 50)) continue;
      const label = `${L.names[i]}  ${size(L.sizes[i])}`;
      ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
      const tw = Math.min(w - 4, ctx.measureText(label).width + 10);
      ctx.fillStyle = 'rgba(5,10,14,.72)'; ctx.fillRect(x + 2, y + 2, tw, 16);
      ctx.fillStyle = depth === 1 ? '#e3f2f5' : '#a9c3cc'; ctx.fillText(label, x + 7, y + 4);
      ctx.restore();
    }
  }

  // index of the box that represents the current selection (or its nearest drawn ancestor)
  function selRect() {
    const L = sp.lay;
    if (!L) return -1;
    const m = L.meta;
    if (sp.sel.kind !== 'dir') {
      for (let i = 0; i < L.n; i++) {
        if (m[i * 4 + 2] !== sp.sel.dir) continue;
        if (sp.sel.kind === 'file' && m[i * 4] === 1 && m[i * 4 + 3] === sp.sel.fi) return i;
        if (sp.sel.kind === 'rest' && m[i * 4] === 2) return i;
      }
    }
    for (let k = sp.selChain.length - 1; k >= 0; k--) {
      const i = sp.dirRect.get(sp.selChain[k]);
      if (i != null) return i;
    }
    return -1;
  }

  async function drawOverlay() {
    if (!sp.lay) return;
    sp.selChain = (await api.chain(sp.sel.dir)) || [];
    paintOverlay();
  }

  function paintOverlay() {
    const L = sp.lay;
    if (!L) return;
    const { ctx, dpr } = sizeCanvas(over());
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const g = L.geo;
    const s = selRect();
    if (s > 0) {
      const [x, y, w, h] = [g[s * 4], g[s * 4 + 1], g[s * 4 + 2], g[s * 4 + 3]];
      // dim everything outside the selection
      ctx.fillStyle = 'rgba(3,7,10,.66)';
      ctx.beginPath(); ctx.rect(0, 0, sp.layW, sp.layH); ctx.rect(x, y, w, h); ctx.fill('evenodd');
      ctx.strokeStyle = '#2ee6c9'; ctx.lineWidth = 2; ctx.shadowColor = '#2ee6c9'; ctx.shadowBlur = 10;
      ctx.strokeRect(x + 1, y + 1, Math.max(0, w - 2), Math.max(0, h - 2));
      ctx.shadowBlur = 0;
    }
    if (sp.hover >= 0 && sp.hover !== s) {
      const i = sp.hover;
      ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 1;
      ctx.strokeRect(g[i * 4] + 0.5, g[i * 4 + 1] + 0.5, Math.max(0, g[i * 4 + 2] - 1), Math.max(0, g[i * 4 + 3] - 1));
    }
  }

  function hitTest(px, py) {
    const L = sp.lay;
    if (!L) return -1;
    const g = L.geo;
    for (let i = L.n - 1; i >= 0; i--) { // children are drawn after parents → last hit is deepest
      const x = g[i * 4], y = g[i * 4 + 1];
      if (px >= x && py >= y && px < x + g[i * 4 + 2] && py < y + g[i * 4 + 3]) return i;
    }
    return -1;
  }

  let hoverToken = 0;
  async function showTip(i, ev) {
    const tip = $('#spTip');
    if (i < 0) { tip.classList.add('hidden'); $('#spHover').textContent = 'Hover a box to see what it is · click it to open it in the tree'; return; }
    const L = sp.lay, m = L.meta;
    const kind = m[i * 4], dir = m[i * 4 + 2];
    const token = ++hoverToken;
    const p = await api.path(dir, kind === 1 ? L.names[i] : null);
    if (token !== hoverToken) return;
    const label = kind === 2 ? `${L.names[i]} in ${p}` : p;
    tip.innerHTML = `<b>${esc(kind === 0 && m[i * 4 + 1] === 0 ? p : L.names[i])} — ${size(L.sizes[i])}</b><span>${esc(label)}</span>`;
    const host = $('#spMap').getBoundingClientRect();
    let x = ev.clientX - host.left + 14, y = ev.clientY - host.top + 14;
    tip.classList.remove('hidden');
    if (x + tip.offsetWidth > host.width) x = ev.clientX - host.left - tip.offsetWidth - 10;
    if (y + tip.offsetHeight > host.height) y = ev.clientY - host.top - tip.offsetHeight - 10;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
    $('#spHover').textContent = `${size(L.sizes[i])} · ${label}`;
  }

  function selFromRect(i) {
    const m = sp.lay.meta;
    const kind = m[i * 4];
    return kind === 0 ? { kind: 'dir', dir: m[i * 4 + 2], fi: -1 } : kind === 1 ? { kind: 'file', dir: m[i * 4 + 2], fi: m[i * 4 + 3] } : { kind: 'rest', dir: m[i * 4 + 2], fi: -1 };
  }

  // ---------- whole-scan lists ----------
  function renderWhole() {
    const d = sp.done;
    $('#spFiles').innerHTML = d.topFiles.slice(0, 100).map((f, i) => {
      const name = f.p.split(/[\\/]/).pop();
      const dir = f.p.slice(0, f.p.length - name.length - 1);
      return `<div class="sp-file" data-fi="${i}" title="${esc(f.p)}"><div class="dot" style="background:${colorOfName(name)}"></div>
        <div class="fp"><div>${esc(name)}</div><div class="dirn">&lrm;${esc(dir)}&lrm;</div></div><div class="sz">${size(f.s)}</div></div>`;
    }).join('') || '<div class="empty">No files found.</div>';
    const max = d.exts[0] ? d.exts[0].s : 1;
    $('#spTypes').innerHTML = d.exts.slice(0, 18).map((e) => `<div class="sp-type"><div class="tn"><i style="background:${colorOfExt(e.e)}"></i>${esc(e.e === '(none)' ? 'no ext' : '.' + e.e)}</div>
      <div class="tb"><i style="width:${(e.s / max) * 100}%;background:${colorOfExt(e.e)}"></i></div>
      <div class="ts"><b>${size(e.s)}</b> · ${e.c.toLocaleString()}</div></div>`).join('');
    $('#spLegend').innerHTML = CATS.map((c) => `<span><i style="background:${c.c}"></i>${c.name}</span>`).join('') + `<span><i style="background:${OTHER}"></i>Other</span><span><i style="background:#3a5361"></i>Many small files</span>`;
  }

  // ---------- targets & scanning ----------
  function renderTargets() {
    $('#spTargets').innerHTML = sp.targets.map((t, i) => {
      const pct = t.size ? (t.used / t.size) * 100 : null;
      const g = pct == null ? '' : pct < 80 ? '' : pct < 92 ? 'fair' : 'bad';
      return `<button class="sp-target ${sp.target === t.path ? 'sel' : ''}" data-ti="${i}">
        <div class="tl"><b>${esc(t.label)}</b><span>${t.size ? size(t.size - t.used) + ' free' : 'folder'}</span></div>
        ${pct != null ? `<div class="bar ${g}"><i style="width:${pct}%"></i></div>` : ''}</button>`;
    }).join('');
  }

  function setScanning(on) {
    sp.scanning = on;
    $('#spScan').classList.toggle('hidden', on);
    $('#spCancel').classList.toggle('hidden', !on);
    $('#spProgress').classList.toggle('hidden', !on);
    $('#spProgress .sp-spin').style.display = on ? '' : 'none';
    $('#spPick').disabled = on;
  }

  async function startScan() {
    if (!sp.target || sp.scanning) return;
    setScanning(true);
    $('#spProgText').textContent = `Scanning ${sp.target}…`;
    await api.scan(sp.target);
  }

  api.onProgress((m) => {
    $('#spProgText').textContent = `Scanning ${sp.target} · ${m.files.toLocaleString()} files · ${m.dirs.toLocaleString()} folders · ${size(m.bytes)} · ${(m.elapsed / 1000).toFixed(1)}s`;
  });
  api.onDone(async (d) => {
    setScanning(false);
    sp.done = d;
    sp.kids.clear(); sp.open = new Set([0]); sp.sel = { kind: 'dir', dir: 0, fi: -1 }; sp.hover = -1;
    $('#spEmpty').classList.add('hidden');
    $('#spResults').classList.remove('hidden');
    renderWhole();
    await kidsOf(0);
    renderTree(); renderPath();
    requestAnimationFrame(layoutMap);
    $('#spProgress').classList.remove('hidden');
    $('#spProgText').textContent = `${d.cancelled ? 'Partial scan' : 'Scanned'} ${d.stats.files.toLocaleString()} files in ${(d.stats.elapsed / 1000).toFixed(1)}s${d.stats.errors ? ` · ${d.stats.errors.toLocaleString()} items skipped (no access)` : ''}`;
  });
  api.onError((m) => { setScanning(false); $('#spProgress').classList.remove('hidden'); $('#spProgText').textContent = 'Scan failed: ' + m; });

  // ---------- events ----------
  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-ti]');
    if (t) { sp.target = sp.targets[+t.dataset.ti].path; renderTargets(); return; }
    const seg = e.target.closest('[data-seg]');
    if (seg) { select({ kind: 'dir', dir: +seg.dataset.seg, fi: -1 }); return; }
    const tw = e.target.closest('[data-tw]');
    if (tw) { const r = sp.rows[+tw.dataset.tw]; if (r) toggle(r.id); return; }
    const row = e.target.closest('#spTree [data-ri]');
    if (row) {
      const r = sp.rows[+row.dataset.ri];
      select(r.kind === 'dir' ? { kind: 'dir', dir: r.id, fi: -1 } : { kind: r.kind, dir: r.parent, fi: r.kind === 'file' ? r.fi : -1 }, { scroll: false });
      $('#spTree').focus({ preventScroll: true });
      return;
    }
    const fi = e.target.closest('[data-fi]');
    if (fi) api.reveal(sp.done.topFiles[+fi.dataset.fi].p);
  });
  document.addEventListener('dblclick', (e) => {
    const row = e.target.closest('#spTree [data-ri]');
    if (!row) return;
    const r = sp.rows[+row.dataset.ri];
    if (r.kind === 'dir' && r.open) toggle(r.id); else revealSel();
  });

  async function revealSel() {
    const r = sp.rows.find((x) => isSel(x));
    const p = await api.path(sp.sel.dir, sp.sel.kind === 'file' && r ? r.n : null);
    if (p) api.reveal(p);
  }

  // keyboard: ↑ ↓ move · → open / step in · ← close / step out · Enter reveal
  $('#spTree').addEventListener('keydown', async (e) => {
    const i = sp.rows.findIndex((x) => isSel(x));
    if (i < 0) return;
    const r = sp.rows[i];
    const selRow = (row) => select(row.kind === 'dir' ? { kind: 'dir', dir: row.id, fi: -1 } : { kind: row.kind, dir: row.parent, fi: row.kind === 'file' ? row.fi : -1 });
    if (e.key === 'ArrowDown' && sp.rows[i + 1]) { e.preventDefault(); selRow(sp.rows[i + 1]); }
    else if (e.key === 'ArrowUp' && i > 0) { e.preventDefault(); selRow(sp.rows[i - 1]); }
    else if (e.key === 'ArrowRight' && r.kind === 'dir' && r.open) {
      e.preventDefault();
      if (!sp.open.has(r.id)) await toggle(r.id); else if (sp.rows[i + 1]) selRow(sp.rows[i + 1]);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (r.kind === 'dir' && sp.open.has(r.id) && r.id !== 0) await toggle(r.id);
      else if (r.parent >= 0) select({ kind: 'dir', dir: r.parent, fi: -1 });
    } else if (e.key === 'Enter') { e.preventDefault(); revealSel(); }
  });

  // map interaction
  let moveQueued = null;
  $('#spMap').addEventListener('mousemove', (e) => {
    moveQueued = e;
    requestAnimationFrame(() => {
      if (!moveQueued) return;
      const ev = moveQueued; moveQueued = null;
      const rect = $('#spMap').getBoundingClientRect();
      const i = hitTest(ev.clientX - rect.left, ev.clientY - rect.top);
      if (i !== sp.hover) { sp.hover = i; paintOverlay(); }
      showTip(i, ev);
    });
  });
  $('#spMap').addEventListener('mouseleave', () => { sp.hover = -1; paintOverlay(); showTip(-1); });
  $('#spMap').addEventListener('click', (e) => {
    const rect = $('#spMap').getBoundingClientRect();
    const i = hitTest(e.clientX - rect.left, e.clientY - rect.top);
    if (i >= 0) select(selFromRect(i));
  });
  $('#spMap').addEventListener('dblclick', () => revealSel());
  $('#spMap').addEventListener('contextmenu', (e) => { // right-click: select the parent folder
    e.preventDefault();
    if (sp.sel.kind !== 'dir') select({ kind: 'dir', dir: sp.sel.dir, fi: -1 });
    else api.chain(sp.sel.dir).then((c) => c.length > 1 && select({ kind: 'dir', dir: c[c.length - 2], fi: -1 }));
  });

  $('#spScan').onclick = () => startScan();
  $('#spCancel').onclick = () => api.cancel();
  $('#spReveal').onclick = () => revealSel();
  $('#spPick').onclick = async () => {
    const p = await api.pick();
    if (!p) return;
    if (!sp.targets.find((x) => x.path === p)) sp.targets.push({ path: p, label: p.split(/[\\/]/).filter(Boolean).pop() || p, size: null, used: null });
    sp.target = p; renderTargets();
  };
  let resizeT = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { if ($('#page-space.active') && sp.done) layoutMap(); }, 150);
  });

  // called by app.js when the Space page opens
  window.spaceOpen = async () => {
    if (!sp.targets.length) {
      sp.targets = await api.targets();
      sp.target = sp.targets[0] && sp.targets[0].path;
      renderTargets();
    }
    if (sp.done) {
      const host = $('#spMap');
      if (host.clientWidth !== sp.layW || host.clientHeight !== sp.layH) requestAnimationFrame(layoutMap);
    }
  };
  window.spaceScanNow = startScan; // used by tests
  window.spaceSelectPath = async (names) => { // used by tests: select a folder by names under root
    let id = 0;
    for (const n of names) { const k = await kidsOf(id); const c = k.items.find((x) => x.kind === 'dir' && x.n === n); if (!c) break; id = c.id; }
    await select({ kind: 'dir', dir: id, fi: -1 }, { expand: true });
  };
})();
