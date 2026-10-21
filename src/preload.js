const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('byte', {
  meta: () => ipcRenderer.invoke('meta'),
  static: () => ipcRenderer.invoke('static'),
  live: () => ipcRenderer.invoke('live'),
  storage: () => ipcRenderer.invoke('storage'),
  space: {
    targets: () => ipcRenderer.invoke('space:targets'),
    pick: () => ipcRenderer.invoke('space:pick'),
    scan: (root) => ipcRenderer.invoke('space:scan', root),
    cancel: () => ipcRenderer.invoke('space:cancel'),
    node: (segs) => ipcRenderer.invoke('space:node', segs),
    reveal: (p) => ipcRenderer.invoke('space:reveal', p),
    onProgress: (cb) => ipcRenderer.on('space:progress', (_e, m) => cb(m)),
    onDone: (cb) => ipcRenderer.on('space:done', (_e, m) => cb(m)),
    onError: (cb) => ipcRenderer.on('space:error', (_e, m) => cb(m)),
  },
  saveReport: (html, name) => ipcRenderer.invoke('save-report', { html, name }),
});
