const { contextBridge, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

let appVersion = '1.0.0';
try {
  appVersion = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
  ).version;
} catch (_) {
  /* keep default */
}

function onUpdateStatusChanged(callback) {
  if (typeof callback !== 'function') {
    throw new TypeError('onUpdateStatusChanged requires a function callback.');
  }

  const handler = (_event, payload) => {
    callback(payload);
  };

  ipcRenderer.on('update-status-changed', handler);
  return () => {
    ipcRenderer.removeListener('update-status-changed', handler);
  };
}

const desktopBridge = {
  platform: process.platform,
  version: appVersion,
  /** darwin: main process draws native traffic lights (see trafficLightPosition in main.js) */
  windowControlsMode: process.platform === 'darwin' ? 'native' : 'html',
  close: () => ipcRenderer.invoke('window-close'),
  minimize: () => ipcRenderer.invoke('window-minimize'),
  maximize: () => ipcRenderer.invoke('window-maximize'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  updates: {
    getStatus: () => ipcRenderer.invoke('update-get-status'),
    checkNow: () => ipcRenderer.invoke('update-check-now'),
    installNow: () => ipcRenderer.invoke('update-install-now'),
    onStatusChanged: onUpdateStatusChanged
  }
};

contextBridge.exposeInMainWorld('lascoDesktop', desktopBridge);
contextBridge.exposeInMainWorld('programistoDesktop', desktopBridge);
