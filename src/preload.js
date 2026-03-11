const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('programistoDesktop', {
  platform: process.platform,
  version: '1.0.0',
  close: () => ipcRenderer.invoke('window-close'),
  minimize: () => ipcRenderer.invoke('window-minimize'),
  maximize: () => ipcRenderer.invoke('window-maximize'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized')
});
