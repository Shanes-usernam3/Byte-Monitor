const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('byte', {
  meta: () => ipcRenderer.invoke('meta'),
  static: () => ipcRenderer.invoke('static'),
  onStatic: (cb) => ipcRenderer.on('static:update', (_e, s) => cb(s)),
  live: () => ipcRenderer.invoke('live'),
  storage: () => ipcRenderer.invoke('storage'),
  installDriver: () => ipcRenderer.invoke('driver:install'),
  space: {
    targets: () => ipcRenderer.invoke('space:targets'),
    pick: () => ipcRenderer.invoke('space:pick'),
    scan: (root) => ipcRenderer.invoke('space:scan', root),
    cancel: () => ipcRenderer.invoke('space:cancel'),
    children: (id) => ipcRenderer.invoke('space:children', id),
    segments: (id) => ipcRenderer.invoke('space:segments', id),
    chain: (id) => ipcRenderer.invoke('space:chain', id),
    path: (id, file) => ipcRenderer.invoke('space:path', id, file),
    layout: (w, h) => ipcRenderer.invoke('space:layout', w, h),
    reveal: (p) => ipcRenderer.invoke('space:reveal', p),
    onProgress: (cb) => ipcRenderer.on('space:progress', (_e, m) => cb(m)),
    onDone: (cb) => ipcRenderer.on('space:done', (_e, m) => cb(m)),
    onError: (cb) => ipcRenderer.on('space:error', (_e, m) => cb(m)),
  },
  saveReport: (html, name) => ipcRenderer.invoke('save-report', { html, name }),
});
