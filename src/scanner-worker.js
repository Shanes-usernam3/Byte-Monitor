// Byte Health — disk space scanner (runs in a worker thread so the UI never freezes)
// Walks a drive or folder, totals sizes per folder, keeps the biggest files,
// and totals space by file extension. Stays on one filesystem (like WizTree
// scanning a single drive) and never follows symlinks/junctions.
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');

const ROOT = workerData.root;
const isWin = process.platform === 'win32';
const FILES_PER_DIR = 40;       // biggest files kept per folder (rest are grouped)
const TOP_FILES = 200;          // biggest files kept overall
const CONCURRENCY = 48;
const SKIP_LINUX = new Set(['/proc', '/sys', '/dev', '/run', '/snap', '/tmp/.X11-unix']);

let cancelled = false;
parentPort.on('message', (m) => { if (m === 'cancel') cancelled = true; });

const stats = { files: 0, dirs: 0, bytes: 0, errors: 0, started: Date.now() };
const extMap = new Map();
let topFiles = []; // kept sorted desc, small array

function addTop(file) {
  if (topFiles.length >= TOP_FILES && file.s <= topFiles[topFiles.length - 1].s) return;
  let i = topFiles.length;
  while (i > 0 && topFiles[i - 1].s < file.s) i--;
  topFiles.splice(i, 0, file);
  if (topFiles.length > TOP_FILES) topFiles.pop();
}

// simple semaphore
let active = 0;
const waiters = [];
const acquire = () => (active < CONCURRENCY ? (active++, Promise.resolve()) : new Promise((r) => waiters.push(r)));
const release = () => { const n = waiters.shift(); if (n) n(); else active--; };

let rootDev = null;

async function walk(dirPath, node) {
  if (cancelled) return;
  if (!isWin && SKIP_LINUX.has(dirPath) && dirPath !== ROOT) return;
  await acquire();
  let entries;
  try {
    entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch {
    stats.errors++;
    release();
    node.err = true;
    return;
  }
  release();

  const subdirs = [];
  const files = [];
  await Promise.all(entries.map(async (e) => {
    if (cancelled) return;
    const full = path.join(dirPath, e.name);
    if (e.isSymbolicLink()) return;
    if (e.isDirectory()) {
      if (!isWin) {
        try {
          const st = await fs.promises.lstat(full);
          if (st.dev !== rootDev) return; // different mount — don't cross filesystems
        } catch { stats.errors++; return; }
      }
      subdirs.push(e.name);
      return;
    }
    if (!e.isFile()) return;
    try {
      const st = await fs.promises.lstat(full);
      // allocated size on Linux (sparse files), logical size on Windows
      const size = !isWin && st.blocks != null ? Math.min(st.size, st.blocks * 512) || st.size : st.size;
      files.push({ n: e.name, s: size });
      stats.files++;
      stats.bytes += size;
      const rawExt = path.extname(e.name).slice(1).toLowerCase();
      const ext = /^[a-z][a-z0-9]{0,6}$/.test(rawExt) ? rawExt : '(none)';
      const x = extMap.get(ext) || { s: 0, c: 0 };
      x.s += size; x.c++;
      extMap.set(ext, x);
      addTop({ p: full, s: size, m: st.mtimeMs });
    } catch { stats.errors++; }
  }));

  files.sort((a, b) => b.s - a.s);
  node.f = files.length;
  node.s += files.reduce((a, f) => a + f.s, 0);
  node.files = files.slice(0, FILES_PER_DIR);
  if (files.length > FILES_PER_DIR) {
    const rest = files.slice(FILES_PER_DIR);
    node.rest = { c: rest.length, s: rest.reduce((a, f) => a + f.s, 0) };
  }

  node.d = subdirs.map((n) => ({ n, s: 0, f: 0, d: [] }));
  stats.dirs += subdirs.length;
  await Promise.all(node.d.map((child) => walk(path.join(dirPath, child.n), child)));
  for (const c of node.d) { node.s += c.s; node.f += c.f; }
  node.d.sort((a, b) => b.s - a.s);
}

(async () => {
  const timer = setInterval(() => parentPort.postMessage({ type: 'progress', ...stats, elapsed: Date.now() - stats.started }), 250);
  try {
    rootDev = isWin ? null : (await fs.promises.lstat(ROOT)).dev;
    const root = { n: ROOT, s: 0, f: 0, d: [] };
    await walk(ROOT, root);
    clearInterval(timer);
    const exts = [...extMap.entries()].map(([e, v]) => ({ e, s: v.s, c: v.c })).sort((a, b) => b.s - a.s);
    parentPort.postMessage({ type: 'done', cancelled, root, topFiles, exts, stats: { ...stats, elapsed: Date.now() - stats.started } });
  } catch (err) {
    clearInterval(timer);
    parentPort.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
})();
