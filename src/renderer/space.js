/* Byte Health — Space analyzer (WizTree-style) */
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
  const sep = navigator.userAgent.includes('Windows') ? '\\' : '/';

  // file-type colours (Byte palette)
  const CATS = [
    { c: '#a678ff', x: 'mp4 mkv avi mov wmv webm m4v flv ts mpg mpeg vob iso' },                        // video / images
    { c: '#22c3e6', x: 'jpg jpeg png gif bmp webp heic raw cr2 nef psd tif tiff svg ico' },               // pictures
    { c: '#ff5fa2', x: 'mp3 flac wav aac ogg m4a wma opus aiff' },                                        // audio
    { c: '#ff8a3d', x: 'zip rar 7z gz tar xz bz2 zst cab msi pkg deb rpm appimage dmg' },                 // archives / installers
    { c: '#ffc24d', x: 'exe dll sys so a lib bin o pyc jar class node wasm drv ko' },                     // programs
    { c: '#4dd68c', x: 'pdf doc docx xls xlsx ppt pptx txt md csv odt ods rtf epub log json xml html' },  // documents
    { c: '#5b8cff', x: 'vhd vhdx vmdk qcow2 vdi img pst ost db sqlite mdf edb dat pak' },                 // disks / databases / game data
  ];
  const extColor = new Map();
  CATS.forEach((cat) => cat.x.split(' ').forEach((e) => extColor.set(e, cat.c)));
  const colorFor = (name, kind) => {
    if (kind === 'rest') return '#3a5361';
    const ext = (name.includes('.') ? name.split('.').pop() : '').toLowerCase();
    return extColor.get(ext) || '#4f6a75';
  };
  const extSwatch = (e) => extColor.get(e) || '#4f6a75';

  const sp = { targets: [], target: null, segs: [], data: null, done: null, scanning: false };

  // ---------- squarified treemap ----------
  function squarify(items, x, y, w, h) {
    const total = items.reduce((a, i) => a + i.s, 0);
    if (!total || w <= 0 || h <= 0) return [];
    const scale = (w * h) / total;
    const nodes = items.map((i) => ({ item: i, area: i.s * scale }));
    const out = [];
    let row = [];
    let rx = x, ry = y, rw = w, rh = h;
    const worst = (r, side) => {
      const sum = r.reduce((a, n) => a + n.area, 0);
      let max = 0, min = Infinity;
      r.forEach((n) => { max = Math.max(max, n.area); min = Math.min(min, n.area); });
      return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
    };
    const layoutRow = (r) => {
      const sum = r.reduce((a, n) => a + n.area, 0);
      if (rw >= rh) {
        const cw = sum / rh; let cy = ry;
        r.forEach((n) => { const ch = n.area / cw; out.push({ ...n, x: rx, y: cy, w: cw, h: ch }); cy += ch; });
        rx += cw; rw -= cw;
      } else {
        const ch = sum / rw; let cx = rx;
        r.forEach((n) => { const cw = n.area / ch; out.push({ ...n, x: cx, y: ry, w: cw, h: ch }); cx += cw; });
        ry += ch; rh -= ch;
      }
    };
    for (const n of nodes) {
      const side = Math.min(rw, rh);
      if (!row.length || worst(row.concat(n), side) <= worst(row, side)) row.push(n);
      else { layoutRow(row); row = [n]; }
    }
    if (row.length) layoutRow(row);
    return out;
  }

  function tile(r, depth) {
    const it = r.item;
    const style = `left:${r.x}px;top:${r.y}px;width:${Math.max(0, r.w)}px;height:${Math.max(0, r.h)}px`;
    const tip = esc(`${it.n} — ${size(it.s)}${it.f ? ' · ' + it.f.toLocaleString() + ' files' : ''}`);
    if (it.kind === 'dir') {
      let inner = '';
      if (depth === 0 && r.w > 60 && r.h > 50 && it.preview && it.preview.length) {
        const kids = squarify(it.preview, 0, 0, r.w - 4, r.h - 21);
        inner = `<div class="inner">${kids.filter((k) => k.w > 2 && k.h > 2).map((k) => tile(k, 1)).join('')}</div>`;
      }
      const head = r.w > 46 && r.h > 18 ? `<div class="tm-h">${esc(it.n)}<b>${size(it.s)}</b></div>` : '';
      const lbl = depth > 0 && r.w > 50 && r.h > 16 ? `<div class="tm-l">${esc(it.n)}</div>` : '';
      return `<div class="tm dir" style="${style}" title="${tip}" ${depth === 0 ? `data-dir="${esc(it.n)}"` : ''}>${depth === 0 ? head + inner : lbl}</div>`;
    }
    const col = colorFor(it.n, it.kind);
    const lbl = r.w > 56 && r.h > 16 ? `<div class="tm-l">${esc(it.n)}</div>` : '';
    return `<div class="tm" style="${style};background:linear-gradient(135deg, ${col}cc, ${col}66)" title="${tip}" ${depth === 0 && it.kind === 'file' ? `data-file="${esc(it.n)}"` : ''}>${lbl}</div>`;
  }

  function drawMap() {
    const el = $('#spMap');
    if (!sp.data) { el.innerHTML = ''; return; }
    const w = el.clientWidth, h = el.clientHeight;
    const rects = squarify(sp.data.items.slice(0, 300), 0, 0, w, h);
    el.innerHTML = rects.filter((r) => r.w >= 1 && r.h >= 1).map((r) => tile(r, 0)).join('');
  }

  // ---------- render ----------
  function renderTargets() {
    $('#spTargets').innerHTML = sp.targets.map((t, i) => {
      const pct = t.size ? (t.used / t.size) * 100 : null;
      const g = pct == null ? '' : pct < 80 ? '' : pct < 92 ? 'fair' : 'bad';
      return `<button class="sp-target ${sp.target === t.path ? 'sel' : ''}" data-ti="${i}">
        <div class="tl"><b>${esc(t.label)}</b><span>${t.size ? size(t.size - t.used) + ' free' : 'folder'}</span></div>
        ${pct != null ? `<div class="bar ${g}"><i style="width:${pct}%"></i></div>` : ''}</button>`;
    }).join('');
  }

  function renderCrumbs() {
    const root = sp.done.root;
    const parts = [root, ...sp.segs];
    $('#spCrumbs').innerHTML = parts.map((p, i) => `${i ? '<i>›</i>' : ''}<button data-crumb="${i}">${esc(p)}</button>`).join('');
  }

  function renderList() {
    const total = sp.data.s || 1;
    $('#spList').innerHTML = sp.data.items.slice(0, 200).map((it, i) => {
      const pct = (it.s / total) * 100;
      const ic = it.kind === 'dir' ? '<div class="ic dir"></div>' : `<div class="ic" style="background:${colorFor(it.n, it.kind)}"></div>`;
      return `<div class="sp-item" data-li="${i}" title="${esc(it.n)}">${ic}
        <div class="nm"><div>${esc(it.n)}${it.err ? ' <span class="tiny">(no access)</span>' : ''}</div><div class="bar"><i style="width:${pct}%"></i></div></div>
        <div class="sz">${size(it.s)}<span>${pct.toFixed(1)}%${it.kind === 'dir' ? ' · ' + (it.f || 0).toLocaleString() + ' files' : ''}</span></div></div>`;
    }).join('') || '<div class="empty">This folder is empty.</div>';
    $('#spSummary').textContent = `${size(sp.data.s)} · ${(sp.data.f || 0).toLocaleString()} files`;
  }

  function renderWhole() {
    const d = sp.done;
    $('#spFiles').innerHTML = d.topFiles.slice(0, 100).map((f, i) => {
      const name = f.p.split(/[\\/]/).pop();
      const dir = f.p.slice(0, f.p.length - name.length - 1);
      return `<div class="sp-file" data-fi="${i}" title="${esc(f.p)}"><div class="dot" style="background:${colorFor(name, 'file')}"></div>
        <div class="fp"><div>${esc(name)}</div><div class="dirn">&lrm;${esc(dir)}&lrm;</div></div><div class="sz">${size(f.s)}</div></div>`;
    }).join('') || '<div class="empty">No files found.</div>';
    const max = d.exts[0] ? d.exts[0].s : 1;
    $('#spTypes').innerHTML = d.exts.slice(0, 18).map((e) => `<div class="sp-type"><div class="tn"><i style="background:${extSwatch(e.e)}"></i>${esc(e.e === '(none)' ? 'no ext' : '.' + e.e)}</div>
      <div class="tb"><i style="width:${(e.s / max) * 100}%;background:${extSwatch(e.e)}"></i></div>
      <div class="ts"><b>${size(e.s)}</b> · ${e.c.toLocaleString()}</div></div>`).join('');
  }

  async function openNode(segs) {
    const data = await window.byte.space.node(segs);
    if (!data) return;
    sp.segs = segs; sp.data = data;
    renderCrumbs(); renderList(); drawMap();
  }

  // ---------- scanning ----------
  function setScanning(on) {
    sp.scanning = on;
    $('#spScan').classList.toggle('hidden', on);
    $('#spCancel').classList.toggle('hidden', !on);
    $('#spProgress').classList.toggle('hidden', !on);
    $('#spPick').disabled = on;
  }

  async function startScan() {
    if (!sp.target || sp.scanning) return;
    setScanning(true);
    $('#spProgText').textContent = `Scanning ${sp.target}…`;
    await window.byte.space.scan(sp.target);
  }

  window.byte.space.onProgress((m) => {
    $('#spProgText').textContent = `Scanning ${sp.target} · ${m.files.toLocaleString()} files · ${m.dirs.toLocaleString()} folders · ${size(m.bytes)} · ${(m.elapsed / 1000).toFixed(1)}s`;
  });
  window.byte.space.onDone(async (d) => {
    setScanning(false);
    sp.done = d;
    $('#spEmpty').classList.add('hidden');
    $('#spResults').classList.remove('hidden');
    renderWhole();
    await openNode([]);
    const msg = `${d.cancelled ? 'Partial scan' : 'Scanned'} ${d.stats.files.toLocaleString()} files in ${(d.stats.elapsed / 1000).toFixed(1)}s${d.stats.errors ? ` · ${d.stats.errors.toLocaleString()} items skipped (no access)` : ''}`;
    $('#spProgress').classList.remove('hidden');
    $('#spProgText').textContent = msg;
    $('#spProgress .sp-spin').style.display = 'none';
  });
  window.byte.space.onError((m) => { setScanning(false); $('#spProgress').classList.remove('hidden'); $('#spProgText').textContent = 'Scan failed: ' + m; });

  // ---------- events ----------
  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-ti]');
    if (t) { sp.target = sp.targets[+t.dataset.ti].path; renderTargets(); return; }
    const c = e.target.closest('[data-crumb]');
    if (c) { openNode(sp.segs.slice(0, +c.dataset.crumb)); return; }
    const li = e.target.closest('[data-li]');
    if (li) {
      const it = sp.data.items[+li.dataset.li];
      if (it.kind === 'dir') openNode([...sp.segs, it.n]);
      else if (it.kind === 'file') window.byte.space.reveal(sp.data.path + sep + it.n);
      return;
    }
    const dir = e.target.closest('#spMap [data-dir]');
    if (dir) { openNode([...sp.segs, dir.dataset.dir]); return; }
    const file = e.target.closest('#spMap [data-file]');
    if (file) { window.byte.space.reveal(sp.data.path + sep + file.dataset.file); return; }
    const fi = e.target.closest('[data-fi]');
    if (fi) window.byte.space.reveal(sp.done.topFiles[+fi.dataset.fi].p);
  });
  $('#spMap').addEventListener('contextmenu', (e) => { e.preventDefault(); if (sp.segs.length) openNode(sp.segs.slice(0, -1)); });
  $('#spScan').onclick = () => { $('#spProgress .sp-spin').style.display = ''; startScan(); };
  $('#spCancel').onclick = () => window.byte.space.cancel();
  $('#spReveal').onclick = () => sp.data && window.byte.space.reveal(sp.data.path);
  $('#spPick').onclick = async () => {
    const p = await window.byte.space.pick();
    if (!p) return;
    if (!sp.targets.find((x) => x.path === p)) sp.targets.push({ path: p, label: p.split(/[\\/]/).filter(Boolean).pop() || p, size: null, used: null });
    sp.target = p; renderTargets();
  };
  window.addEventListener('resize', () => { if (document.querySelector('#page-space.active')) drawMap(); });

  // called by app.js when the Space page opens
  window.spaceOpen = async () => {
    if (!sp.targets.length) {
      sp.targets = await window.byte.space.targets();
      sp.target = sp.targets[0] && sp.targets[0].path;
      renderTargets();
    }
    if (sp.data) requestAnimationFrame(drawMap);
  };
  window.spaceScanNow = startScan; // used by tests
})();
