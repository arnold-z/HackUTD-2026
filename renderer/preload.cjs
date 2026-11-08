// Bridge between the UI pages and the main process (no Node access in the pages).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fg', {
  startSession: (goal, minutes, phone) => ipcRenderer.invoke('start-session', { goal, minutes, phone }),
  endSession: (phrase) => ipcRenderer.invoke('end-session', { phrase }),
  goBack: () => ipcRenderer.invoke('go-back'),
  getState: () => ipcRenderer.invoke('get-state'),
  onState: (cb) => {
    const handler = (_e, state) => cb(state);
    ipcRenderer.on('state', handler);
    return () => ipcRenderer.removeListener('state', handler);
  },
});
