'use strict';

/**
 * Preload des service workers de la session des onglets web (docs/devtools-responsive.md).
 * Il ne pose le pont que dans le service worker d'une extension (`chrome-extension:`) : les
 * service workers des sites n'en reçoivent jamais. Desktop ne répond en plus qu'au service
 * worker de l'extension « Lasco Responsive ».
 */
const { contextBridge, ipcRenderer } = require('electron');

let href = '';
try {
  href = String(contextBridge.executeInMainWorld({ func: () => String(self.location.href) }) || '');
} catch (_) {
  href = '';
}

if (href.startsWith('chrome-extension://')) {
  contextBridge.exposeInMainWorld('lascoResponsive', {
    invoke: (message) => ipcRenderer.invoke('lasco-devtools-responsive', message),
  });
}
