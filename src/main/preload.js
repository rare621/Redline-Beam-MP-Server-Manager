const { contextBridge, ipcRenderer, webUtils } = require('electron');

const EVENTS = new Set(['server:log', 'server:status', 'server:changed', 'server:download', 'content:progress', 'picker:open', 'remote:state', 'remote:upload', 'library:sync', 'maps:reconciled', 'server:update', 'app:update-progress']);

contextBridge.exposeInMainWorld('api', {
  async call(channel, ...args) {
    const r = await ipcRenderer.invoke(channel, ...args);
    if (!r.ok) throw new Error(r.error);
    return r.data;
  },
  on(channel, cb) {
    if (!EVENTS.has(channel)) throw new Error('Unknown event ' + channel);
    const fn = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, fn);
    return () => ipcRenderer.removeListener(channel, fn);
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
});
