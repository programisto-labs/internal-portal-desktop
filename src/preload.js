const { contextBridge, ipcRenderer } = require('electron');

const APP_VERSION_ARG_PREFIX = '--lasco-app-version=';
const versionArg = process.argv.find((arg) => arg.startsWith(APP_VERSION_ARG_PREFIX));
const appVersion = versionArg
  ? versionArg.slice(APP_VERSION_ARG_PREFIX.length)
  : process.env.npm_package_version || '1.0.0';

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

function onOpenPortalTab(callback) {
  if (typeof callback !== 'function') {
    throw new TypeError('onOpenPortalTab requires a function callback.');
  }
  const handler = (_event, target) => callback(target);
  ipcRenderer.on('open-portal-tab', handler);
  return () => ipcRenderer.removeListener('open-portal-tab', handler);
}

function onBrowserTabState(callback) {
  if (typeof callback !== 'function') {
    throw new TypeError('onBrowserTabState requires a function callback.');
  }
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on('browser-tab-state', handler);
  return () => ipcRenderer.removeListener('browser-tab-state', handler);
}

function onBrowserTabOpenRequest(callback) {
  if (typeof callback !== 'function') {
    throw new TypeError('onBrowserTabOpenRequest requires a function callback.');
  }
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on('browser-tab-open-request', handler);
  return () => ipcRenderer.removeListener('browser-tab-open-request', handler);
}

function subscribe(channel, callback) {
  if (typeof callback !== 'function') {
    throw new TypeError(`${channel} listener requires a function callback.`);
  }
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

function invokeBrowserTab(channel, payload) {
  return ipcRenderer.invoke(channel, payload);
}

const browserTabsBridge = {
  create: (payload) => invokeBrowserTab('browser-tab-create', payload),
  navigate: (payload) => invokeBrowserTab('browser-tab-navigate', payload),
  select: (payload) => invokeBrowserTab('browser-tab-select', payload),
  hide: () => invokeBrowserTab('browser-tab-hide'),
  close: (payload) => invokeBrowserTab('browser-tab-close', payload),
  goBack: (payload) => invokeBrowserTab('browser-tab-go-back', payload),
  goForward: (payload) => invokeBrowserTab('browser-tab-go-forward', payload),
  reload: (payload) => invokeBrowserTab('browser-tab-reload', payload),
  stop: (payload) => invokeBrowserTab('browser-tab-stop', payload),
  setBounds: (payload) => invokeBrowserTab('browser-tab-set-bounds', payload),
  getState: (payload) => invokeBrowserTab('browser-tab-get-state', payload),
  zoom: (payload) => invokeBrowserTab('browser-tab-zoom', payload),
  findInPage: (payload) => invokeBrowserTab('browser-tab-find', payload),
  stopFindInPage: (payload) => invokeBrowserTab('browser-tab-stop-find', payload),
  print: (payload) => invokeBrowserTab('browser-tab-print', payload),
  capture: (payload) => invokeBrowserTab('browser-tab-capture', payload),
  copyScreenshot: (payload) => invokeBrowserTab('browser-tab-copy-screenshot', payload),
  openExternal: (payload) => invokeBrowserTab('browser-tab-open-external', payload),
  openDevTools: (payload) => invokeBrowserTab('browser-tab-open-devtools', payload),
  clearBrowsingData: () => invokeBrowserTab('browser-tab-clear-data'),
  setOverlay: (payload) => invokeBrowserTab('browser-tab-set-overlay', payload),
  agentAction: (payload) => invokeBrowserTab('browser-tab-agent-action', payload),
  onState: onBrowserTabState,
  onOpenRequest: onBrowserTabOpenRequest,
  onFindResult: (callback) => subscribe('browser-tab-find-result', callback),
  onShortcut: (callback) => subscribe('browser-tab-shortcut', callback),
};

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
  },
  tabs: {
    onOpenTarget: onOpenPortalTab
  },
  browserTabs: browserTabsBridge,
};

contextBridge.exposeInMainWorld('lascoDesktop', desktopBridge);
contextBridge.exposeInMainWorld('programistoDesktop', desktopBridge);
