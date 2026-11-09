const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pet', {
  bootstrap: () => ipcRenderer.invoke('pet:bootstrap'),
  settings: value => ipcRenderer.invoke('pet:settings', value),
  observation: enabled => ipcRenderer.invoke('pet:observation', enabled),
  action: value => ipcRenderer.send('pet:action', value),
  onEvent: listener => ipcRenderer.on('pet:event', (_event, value) => listener(value))
});
