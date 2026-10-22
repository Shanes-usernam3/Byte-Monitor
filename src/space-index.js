// Byte Monitor — scan index + whole-drive treemap layout (main process)
// After a scan, every folder gets a numeric id so the renderer can ask for a
// folder's children, its path, or the full treemap layout at any size.
const path = require('path');

class SpaceIndex {
  constructor(root, rootPath) {
    this.rootPath = rootPath;
    this.dirs = []; // id -> { n: node, p: parentId }
    const stack = [[root, -1]];
    while (stack.length) {
      const [n, p] = stack.pop();
      n.id = this.dirs.length;
      this.dirs.push({ n, p });
      for (const c of n.d || []) stack.push([c, n.id]);
    }
  }

  node(id) { return this.dirs[id] && this.dirs[id].n; }

  chain(id) { // ids from root down to id
    const out = [];
    for (let i = id; i >= 0 && this.dirs[i]; i = this.dirs[i].p) out.unshift(i);
    return out;
  }

  pathOf(id) {
    const names = this.chain(id).slice(1).map((i) => this.dirs[i].n.n);
    return names.length ? path.join(this.rootPath, ...names) : this.rootPath;
  }

  segments(id) { // [{id, name}] for the path bar
    return this.chain(id).map((i, k) => ({ id: i, name: k === 0 ? this.rootPath : this.dirs[i].n.n }));
  }

  kids(n) {
    return [
      ...(n.d || []).map((c) => ({ kind: 'dir', id: c.id, n: c.n, s: c.s, f: c.f, err: !!c.err, open: (c.d && c.d.length) || (c.files && c.files.length) || c.rest ? 1 : 0, ref: c })),
      ...(n.files || []).map((f, fi) => ({ kind: 'file', n: f.n, s: f.s, fi })),
      ...(n.rest ? [{ kind: 'rest', n: `${n.rest.c.toLocaleString()} smaller files`, s: n.rest.s }] : []),
    ].filter((k) => k.s > 0).sort((a, b) => b.s - a.s);
  }

  children(id, limit = 400) {
    const n = this.node(id);
    if (!n) return null;
    const items = this.kids(n).slice(0, limit).map(({ ref, ...k }) => k);
    return { id, s: n.s, f: n.f, path: this.pathOf(id), items };
  }

  // Nested squarified treemap of the WHOLE scan at a fixed scale.
  // Returns flat typed arrays (cheap to send over IPC).
  layout(W, H) {
    const geo = [], meta = [], sizes = [], exts = [], names = [];
    const push = (x, y, w, h, kind, depth, dirId, fi, size, ext, name) => {
      geo.push(x, y, w, h); meta.push(kind, depth, dirId, fi); sizes.push(size); exts.push(ext); names.push(name);
    };
    const place = (n, x, y, w, h, depth) => {
      push(x, y, w, h, 0, depth, n.id, -1, n.s, '', depth === 0 ? this.rootPath : n.n);
      const pad = depth === 0 ? 0 : 1;
      const ix = x + pad, iy = y + pad, iw = w - 2 * pad, ih = h - 2 * pad;
      if (iw < 2 || ih < 2) return;
      const kids = this.kids(n);
      for (const r of squarify(kids, ix, iy, iw, ih)) {
        if (r.w * r.h < 0.6) continue;
        const k = r.item;
        if (k.kind === 'dir') {
          if (r.w >= 4 && r.h >= 4) place(k.ref, r.x, r.y, r.w, r.h, depth + 1);
          else push(r.x, r.y, r.w, r.h, 0, depth + 1, k.id, -1, k.s, '', k.n);
        } else if (k.kind === 'file') {
          const e = path.extname(k.n).slice(1).toLowerCase();
          push(r.x, r.y, r.w, r.h, 1, depth + 1, n.id, k.fi, k.s, e, k.n);
        } else {
          push(r.x, r.y, r.w, r.h, 2, depth + 1, n.id, -1, k.s, '', k.n);
        }
      }
    };
    const root = this.node(0);
    if (root && root.s > 0) place(root, 0, 0, W, H, 0);
    return { n: sizes.length, geo: Float32Array.from(geo), meta: Int32Array.from(meta), sizes: Float64Array.from(sizes), exts, names };
  }
}

function squarify(items, x, y, w, h) {
  const total = items.reduce((a, i) => a + i.s, 0);
  if (!total || w <= 0 || h <= 0) return [];
  const scale = (w * h) / total;
  const out = [];
  let row = [], rowSum = 0;
  let rx = x, ry = y, rw = w, rh = h;
  const worst = (sum, min, max, side) => Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
  let rmin = Infinity, rmax = 0;
  const flush = () => {
    if (rw >= rh) {
      const cw = rowSum / rh; let cy = ry;
      for (const n of row) { const ch = n.area / cw; out.push({ item: n.item, x: rx, y: cy, w: cw, h: ch }); cy += ch; }
      rx += cw; rw -= cw;
    } else {
      const ch = rowSum / rw; let cx = rx;
      for (const n of row) { const cw = n.area / ch; out.push({ item: n.item, x: cx, y: ry, w: cw, h: ch }); cx += cw; }
      ry += ch; rh -= ch;
    }
    row = []; rowSum = 0; rmin = Infinity; rmax = 0;
  };
  for (const item of items) {
    const area = item.s * scale;
    const side = Math.min(rw, rh);
    if (row.length) {
      const cur = worst(rowSum, rmin, rmax, side);
      const nxt = worst(rowSum + area, Math.min(rmin, area), Math.max(rmax, area), side);
      if (nxt > cur) flush();
    }
    row.push({ item, area }); rowSum += area; rmin = Math.min(rmin, area); rmax = Math.max(rmax, area);
  }
  if (row.length) flush();
  return out;
}

module.exports = { SpaceIndex };
