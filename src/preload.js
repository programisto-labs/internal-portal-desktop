const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('programistoDesktop', {
  platform: process.platform,
  version: '1.0.0'
});
