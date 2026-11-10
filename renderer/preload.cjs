// Bridge between the UI pages and the main process (no Node access in the pages).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fg', {
  startSession: (goal, minutes, phone) => ipcRenderer.invoke('start-session', { goal, minutes, phone }),
  endSession: (phrase) => ipcRenderer.invoke('end-session', { phrase }),
  goBack: (separate) => ipcRenderer.invoke('go-back', { separate: !!separate }),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', { key, value }),
  getState: () => ipcRenderer.invoke('get-state'),
  pauseChallenge: () => ipcRenderer.invoke('pause-challenge'),
  pauseSubmit: (typed) => ipcRenderer.invoke('pause-submit', typed),
  resumeSession: () => ipcRenderer.invoke('resume-session'),
  openPermission: (kind) => ipcRenderer.invoke('open-permission', kind),
  restartApp: () => ipcRenderer.invoke('restart-app'),
  onState: (cb) => {
    const handler = (_e, state) => cb(state);
    ipcRenderer.on('state', handler);
    return () => ipcRenderer.removeListener('state', handler);
  },
});
