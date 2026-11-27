'use strict';

/**
 * Preload de la fenêtre de navigation privée (docs/private-browsing.md). La page est la coquille de Desktop
 * (`src/vm-shell/private.html`, `file:`), jamais le portail : seul le pilotage de ses onglets web est exposé.
 * Ni opérations sur l'ordinateur, ni Lasco Code, ni mots de passe, ni saisie automatique, ni téléchargements
 * listés, ni notifications, ni agents. Le processus principal revérifie chaque appel (fenêtre privée seulement).
 */
const { contextBridge, ipcRenderer } = require('electron');

const PRIVATE_WINDOW_ARG = '--lasco-private-window';
const APP_VERSION_ARG_PREFIX = '--lasco-app-version=';

const isPrivateShell =
  process.argv.includes(PRIVATE_WINDOW_ARG) && Boolean(globalThis.location) && globalThis.location.protocol === 'file:';

function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError(`${channel} listener requires a function callback.`);
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const invoke = (channel) => (payload) => ipcRenderer.invoke(channel, payload);

// Liens reçus avant que la coquille s'abonne (fenêtre en cours de chargement) : gardés jusque-là.
const openRequestSubscribers = new Set();
const pendingOpenRequests = [];
ipcRenderer.on('browser-tab-open-request', (_event, payload) => {
  if (openRequestSubscribers.size === 0) {
    if (pendingOpenRequests.length < 20) pendingOpenRequests.push(payload);
    return;
  }
  for (const callback of openRequestSubscribers) callback(payload);
});

if (isPrivateShell) {
  const versionArg = process.argv.find((arg) => arg.startsWith(APP_VERSION_ARG_PREFIX));
  const browserTabs = {
    create: invoke('browser-tab-create'),
    navigate: invoke('browser-tab-navigate'),
    select: invoke('browser-tab-select'),
    hide: invoke('browser-tab-hide'),
    close: invoke('browser-tab-close'),
    goBack: invoke('browser-tab-go-back'),
    goForward: invoke('browser-tab-go-forward'),
    reload: invoke('browser-tab-reload'),
    setMuted: invoke('browser-tab-set-muted'),
    stop: invoke('browser-tab-stop'),
    setBounds: invoke('browser-tab-set-bounds'),
    getState: invoke('browser-tab-get-state'),
    zoom: invoke('browser-tab-zoom'),
    findInPage: invoke('browser-tab-find'),
    stopFindInPage: invoke('browser-tab-stop-find'),
    print: invoke('browser-tab-print'),
    capture: invoke('browser-tab-capture'),
    siteInfo: invoke('browser-tab-site-info'),
    setSitePermission: invoke('browser-tab-set-site-permission'),
    resetSitePermissions: invoke('browser-tab-reset-site-permissions'),
    /** Historique de cette fenêtre seulement, en mémoire. */
    historySuggest: invoke('browser-history-suggest'),
    searchEngines: { get: invoke('browser-search-engines-get') },
    setOverlay: invoke('browser-tab-set-overlay'),
    showTabContextMenu: invoke('browser-tab-show-context-menu'),
    onTabContextMenuAction: (callback) => subscribe('browser-tab-context-menu-action', callback),
    onState: (callback) => subscribe('browser-tab-state', callback),
    onOpenRequest(callback, options) {
      if (typeof callback !== 'function') throw new TypeError('onOpenRequest requires a function callback.');
      openRequestSubscribers.add(callback);
      for (const payload of pendingOpenRequests.splice(0, pendingOpenRequests.length)) callback(payload);
      ipcRenderer.send('browser-tab-open-ready', { adoptPopups: Boolean(options && options.adoptPopups === true) });
      return () => openRequestSubscribers.delete(callback);
    },
    onClosed: (callback) => subscribe('browser-tab-closed', callback),
    onFindResult: (callback) => subscribe('browser-tab-find-result', callback),
    onShortcut: (callback) => subscribe('browser-tab-shortcut', callback),
  };
  contextBridge.exposeInMainWorld('lascoDesktop', {
    platform: process.platform,
    version: versionArg ? versionArg.slice(APP_VERSION_ARG_PREFIX.length) : '',
    browserTabs,
    privateWindow: {
      getInfo: () => ipcRenderer.invoke('private-window-info'),
      /** ⌘⇧N depuis une fenêtre privée : une autre fenêtre privée, avec sa propre session. */
      openWindow: () => ipcRenderer.invoke('private-window-open'),
    },
  });
}
