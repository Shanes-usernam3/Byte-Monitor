const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Worker } = require('worker_threads');
const si = require('systeminformation');
const { SpaceIndex } = require('./space-index');

const DEMO = process.argv.includes('--demo') || process.env.BYTE_MONITOR_DEMO === '1';
const sensors = DEMO ? require('./demo') : require('./sensors');

let win;

function createWindow() {
  // Fit the window to the screen it opens on (laptops at 125–150% scaling are small)
  const wa = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(1360, Math.round(wa.width * 0.94));
  const height = Math.min(880, Math.round(wa.height * 0.92));
  win = new BrowserWindow({
    width,
    height,
    minWidth: Math.min(900, wa.width),
    minHeight: Math.min(600, wa.height),
    backgroundColor: '#070d12',
    title: 'Byte Monitor',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  if (wa.width < 1100 || wa.height < 720) win.maximize();
  // stop sampling hard while nobody can see the window
  const vis = (on) => { if (sensors.setActive) sensors.setActive(on); };
  win.on('minimize', () => vis(false));
  win.on('hide', () => vis(false));
  win.on('restore', () => vis(true));
  win.on('show', () => vis(true));
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
      scan.index = new SpaceIndex(m.root, root);
      win.webContents.send('space:done', { root, cancelled: m.cancelled, stats: m.stats, topFiles: m.topFiles, exts: m.exts.slice(0, 40), total: m.root.s });
    } else if (m.type === 'error') { scan.worker = null; win.webContents.send('space:error', m.message); }
  });
  w.on('error', (err) => win.webContents.send('space:error', String(err.message || err)));
  return true;
});

ipcMain.handle('space:cancel', () => { if (scan.worker) scan.worker.postMessage('cancel'); });

// Folder tree + whole-drive treemap (see space-index.js)
ipcMain.handle('space:children', (_e, id) => (scan.index ? scan.index.children(id) : null));
ipcMain.handle('space:segments', (_e, id) => (scan.index ? scan.index.segments(id) : null));
ipcMain.handle('space:chain', (_e, id) => (scan.index ? scan.index.chain(id) : null));
ipcMain.handle('space:path', (_e, id, file) => {
  if (!scan.index) return null;
  const dir = scan.index.pathOf(id);
  return file ? path.join(dir, file) : dir;
});
ipcMain.handle('space:layout', (_e, w, h) => (scan.index ? scan.index.layout(w, h) : null));

ipcMain.handle('space:reveal', (_e, p) => { if (typeof p === 'string' && fs.existsSync(p)) shell.showItemInFolder(p); });

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { if (sensors.stopSensors) sensors.stopSensors(); });
