// Bridge between the UI pages and the main process (no Node access in the pages).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fg', {
  startSession: (goal, minutes, phone, folder) => ipcRenderer.invoke('start-session', { goal, minutes, phone, folder }),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  openResource: (path) => ipcRenderer.invoke('open-resource', path),
  endSession: (phrase) => ipcRenderer.invoke('end-session', { phrase }),
  goBack: () => ipcRenderer.invoke('go-back'),
  getState: () => ipcRenderer.invoke('get-state'),
  openPermission: (kind) => ipcRenderer.invoke('open-permission', kind),
  restartApp: () => ipcRenderer.invoke('restart-app'),
  onState: (cb) => {
    const handler = (_e, state) => cb(state);
    ipcRenderer.on('state', handler);
    return () => ipcRenderer.removeListener('state', handler);
  },
});
