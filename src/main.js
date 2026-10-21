const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Worker } = require('worker_threads');
const si = require('systeminformation');

const DEMO = process.argv.includes('--demo') || process.env.BYTE_HEALTH_DEMO === '1';
const sensors = DEMO ? require('./demo') : require('./sensors');

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#070d12',
    title: 'Byte Health',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

const safe = (fn) => async () => { try { return await fn(); } catch (e) { return { error: String(e && e.message || e) }; } };

ipcMain.handle('static', safe(() => sensors.getStatic()));
ipcMain.handle('live', safe(() => sensors.getLive()));
ipcMain.handle('storage', safe(() => sensors.getStorage()));
ipcMain.handle('meta', () => ({ demo: DEMO, platform: process.platform, version: app.getVersion() }));

ipcMain.handle('save-report', async (_e, { html, name }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Save health report',
    defaultPath: path.join(app.getPath('documents'), name),
    filters: [{ name: 'HTML report', extensions: ['html'] }],
  });
  if (canceled || !filePath) return { saved: false };
  fs.writeFileSync(filePath, html, 'utf8');
  shell.showItemInFolder(filePath);
  return { saved: true, filePath };
});

// ---------- Space analyzer (WizTree-style) ----------
let scan = { worker: null, result: null, root: null };

ipcMain.handle('space:targets', async () => {
  const vols = await si.fsSize().catch(() => []);
  const seen = new Set();
  const list = vols
    .filter((v) => v.size > 1e9 && !/^(\/snap|\/boot\/efi|\/run|\/opt\/claude)/.test(v.mount))
    .filter((v) => (seen.has(v.mount) ? false : seen.add(v.mount)))
    .map((v) => ({ path: process.platform === 'win32' && /^[A-Z]:$/i.test(v.mount) ? v.mount + '\\' : v.mount, label: v.mount, size: v.size, used: v.used }));
  list.push({ path: os.homedir(), label: 'Home folder', size: null, used: null });
  return list;
});

ipcMain.handle('space:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose a folder to analyze', properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('space:scan', (_e, root) => {
  if (scan.worker) scan.worker.terminate();
  scan = { worker: null, result: null, root };
  const w = new Worker(path.join(__dirname, 'scanner-worker.js'), { workerData: { root } });
  scan.worker = w;
  w.on('message', (m) => {
    if (m.type === 'progress') win.webContents.send('space:progress', m);
    else if (m.type === 'done') {
      scan.result = m; scan.worker = null;
      win.webContents.send('space:done', { root, cancelled: m.cancelled, stats: m.stats, topFiles: m.topFiles, exts: m.exts.slice(0, 40), total: m.root.s });
    } else if (m.type === 'error') { scan.worker = null; win.webContents.send('space:error', m.message); }
  });
  w.on('error', (err) => win.webContents.send('space:error', String(err.message || err)));
  return true;
});

ipcMain.handle('space:cancel', () => { if (scan.worker) scan.worker.postMessage('cancel'); });

// Return one folder's contents (folders + biggest files), each with a preview of its own children for the nested treemap
ipcMain.handle('space:node', (_e, segs) => {
  if (!scan.result) return null;
  let node = scan.result.root;
  for (const s of segs) { node = (node.d || []).find((c) => c.n === s); if (!node) return null; }
  const kids = (n) => [
    ...(n.d || []).map((c) => ({ kind: 'dir', n: c.n, s: c.s, f: c.f, err: !!c.err })),
    ...(n.files || []).map((f) => ({ kind: 'file', n: f.n, s: f.s })),
    ...(n.rest ? [{ kind: 'rest', n: `${n.rest.c.toLocaleString()} smaller files`, s: n.rest.s }] : []),
  ].filter((k) => k.s > 0).sort((a, b) => b.s - a.s);
  const items = kids(node).map((k) => {
    if (k.kind === 'dir') {
      const child = node.d.find((c) => c.n === k.n);
      k.preview = kids(child).slice(0, 24);
    }
    return k;
  });
  const fullPath = path.join(scan.root, ...segs);
  return { name: segs.length ? segs[segs.length - 1] : scan.root, path: fullPath, s: node.s, f: node.f, items };
});

ipcMain.handle('space:reveal', (_e, p) => { if (typeof p === 'string' && fs.existsSync(p)) shell.showItemInFolder(p); });

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
