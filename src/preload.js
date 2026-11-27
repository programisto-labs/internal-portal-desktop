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

// Links opened while the portal is still starting (Lasco launched as the default
// browser) arrive before the tab strip subscribes: keep them until it does.
const openRequestSubscribers = new Set();
const pendingOpenRequests = [];
ipcRenderer.on('browser-tab-open-request', (_event, payload) => {
  if (openRequestSubscribers.size === 0) {
    if (pendingOpenRequests.length < 20) pendingOpenRequests.push(payload);
    return;
  }
  for (const callback of openRequestSubscribers) callback(payload);
});

function onBrowserTabOpenRequest(callback, options) {
  if (typeof callback !== 'function') {
    throw new TypeError('onBrowserTabOpenRequest requires a function callback.');
  }
  openRequestSubscribers.add(callback);
  for (const payload of pendingOpenRequests.splice(0, pendingOpenRequests.length)) callback(payload);
  // `adoptPopups` : le portail sait reprendre une fenêtre fille sous `adoptedTabId`.
  ipcRenderer.send('browser-tab-open-ready', {
    adoptPopups: Boolean(options && options.adoptPopups === true),
  });
  return () => openRequestSubscribers.delete(callback);
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
  /** `{ tabId, muted }` : couper ou réactiver le son de l'onglet web. */
  setMuted: (payload) => invokeBrowserTab('browser-tab-set-muted', payload),
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
  // Informations du site (docs/site-permissions.md) : sécurité et autorisations retenues.
  siteInfo: (payload) => invokeBrowserTab('browser-tab-site-info', payload),
  setSitePermission: (payload) => invokeBrowserTab('browser-tab-set-site-permission', payload),
  resetSitePermissions: (payload) => invokeBrowserTab('browser-tab-reset-site-permissions', payload),
  /** `{ tabId, enabled }` : bloqueur de pubs sur le site de l'onglet (docs/adblock.md) ; la page est rechargée. */
  setSiteAdblock: (payload) => invokeBrowserTab('browser-tab-set-site-adblock', payload),
  openSiteSettings: () => invokeBrowserTab('browser-tab-open-site-settings'),
  historySuggest: (payload) => invokeBrowserTab('browser-history-suggest', payload),
  historyList: (payload) => invokeBrowserTab('browser-history-list', payload),
  historyRemove: (payload) => invokeBrowserTab('browser-history-remove', payload),
  historyClear: () => invokeBrowserTab('browser-history-clear'),
  // Search engine of the address bar and site search shortcuts (docs/search-engines.md).
  searchEngines: {
    get: () => invokeBrowserTab('browser-search-engines-get'),
    markUsed: (payload) => invokeBrowserTab('browser-search-engines-mark-used', payload),
    manage: () => invokeBrowserTab('browser-search-engines-manage'),
    onChange: (callback) => subscribe('browser-search-engines-changed', callback),
  },
  setOverlay: (payload) => invokeBrowserTab('browser-tab-set-overlay', payload),
  showTabContextMenu: (payload) => invokeBrowserTab('browser-tab-show-context-menu', payload),
  onTabContextMenuAction: (callback) => subscribe('browser-tab-context-menu-action', callback),
  agentAction: (payload) => invokeBrowserTab('browser-tab-agent-action', payload),
  /** `{ tabId, active }` : onglet piloté par un agent en arrière-plan (docs/agent-tabs.md). */
  setAgentControl: (payload) => invokeBrowserTab('browser-tab-set-agent-control', payload),
  // Password manager of the web tabs (docs/passwords.md). Captures arrive without the password.
  passwords: {
    setEnabled: (payload) => invokeBrowserTab('browser-password-set-enabled', payload),
    setSuggestions: (payload) => invokeBrowserTab('browser-password-set-suggestions', payload),
    takeCapture: (payload) => invokeBrowserTab('browser-password-take-capture', payload),
    dismissCapture: (payload) => invokeBrowserTab('browser-password-dismiss-capture', payload),
    fill: (payload) => invokeBrowserTab('browser-password-fill', payload),
    onCapture: (callback) => subscribe('browser-tab-password-capture', callback),
    onFillRequest: (callback) => subscribe('browser-tab-password-fill-request', callback),
    onAction: (callback) => subscribe('browser-tab-password-action', callback),
  },
  // Form autofill of the web tabs (docs/form-autofill.md): names, addresses, e-mail, phone.
  autofill: {
    setProfiles: (payload) => invokeBrowserTab('browser-autofill-set-profiles', payload),
    /** Agent `browser_autofill`: fill the page's address form, on the host the tab shows now. */
    fill: (payload) => invokeBrowserTab('browser-autofill-fill', payload),
    onCapture: (callback) => subscribe('browser-tab-autofill-capture', callback),
    onUsed: (callback) => subscribe('browser-tab-autofill-used', callback),
    onAction: (callback) => subscribe('browser-tab-autofill-action', callback),
  },
  onState: onBrowserTabState,
  onOpenRequest: onBrowserTabOpenRequest,
  /** La page a fermé son onglet (`window.close()`, fenêtre de connexion OAuth) : { tabId }. */
  onClosed: (callback) => subscribe('browser-tab-closed', callback),
  onFindResult: (callback) => subscribe('browser-tab-find-result', callback),
  onShortcut: (callback) => subscribe('browser-tab-shortcut', callback),
};

/**
 * Host operations bridge (structured file ops on the user's computer, not the VM).
 * Exposed only when the page origin is the Lasco portal; main re-validates the sender natively.
 */
const PORTAL_ORIGIN_ARG_PREFIX = '--lasco-portal-origin=';
const portalOriginArg = process.argv.find((arg) => arg.startsWith(PORTAL_ORIGIN_ARG_PREFIX));
const portalOrigin = portalOriginArg ? portalOriginArg.slice(PORTAL_ORIGIN_ARG_PREFIX.length) : null;
/** internal-portal#2373: no agents (VM) ⇒ never a host bridge. */
const noAgents = process.argv.includes('--lasco-no-agents');
/** VM mode (docs/vm-mode.md): Desktop's own browser shell, loaded from a `file:` page of the app. */
const vmMode = process.argv.includes('--lasco-vm');
const exposeVmShell = vmMode && Boolean(globalThis.location) && globalThis.location.protocol === 'file:';
const vmShellBridge = {
  /** Tabs opened by the VM's browser daemon through the control endpoint: `{ tabId, url, active }`. */
  onTabOpened: (callback) => subscribe('vm-shell-tab-opened', callback),
  /** A tab the daemon activated: `{ tabId }`. */
  onTabActivated: (callback) => subscribe('vm-shell-tab-activated', callback),
  getInfo: () => ipcRenderer.invoke('vm-shell-info'),
  /** `{ mode: 'page' | 'desktop' }`: page alone (full screen) or the whole browser (docs/vm-mode.md). */
  onViewMode: (callback) => subscribe('vm-shell-view-mode', callback),
};
const exposeHostOps =
  !vmMode && !noAgents && Boolean(portalOrigin) && Boolean(globalThis.location) && globalThis.location.origin === portalOrigin;
const hostOpsBridge = {
  getCapabilities: () => ipcRenderer.invoke('host-ops-capabilities'),
  execute: (request) => ipcRenderer.invoke('host-ops-execute', request),
  cancel: (requestId) => ipcRenderer.invoke('host-ops-cancel', requestId),
  /**
   * Confirmations in the Lasco AI chat: Desktop announces a request (`request` / `size` / `resolved`),
   * the page reserves a placeholder and reports where it is. Desktop draws the card and its buttons.
   */
  onConfirm: (callback) => {
    if (typeof callback !== 'function') return () => undefined;
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('host-ops-confirm', listener);
    return () => ipcRenderer.removeListener('host-ops-confirm', listener);
  },
  placeConfirm: (id, placement) => ipcRenderer.send('host-ops-confirm-place', { id, placement }),
  pendingConfirms: () => ipcRenderer.invoke('host-ops-confirm-pending'),
  /** Profil > « Cet ordinateur ». Activer ouvre une confirmation native ; la page ne décide jamais seule. */
  settings: {
    status: () => ipcRenderer.invoke('host-ops-web-status'),
    disable: (feature) => ipcRenderer.invoke('host-ops-web-disable', feature),
    requestEnable: (feature) => ipcRenderer.invoke('host-ops-web-request-enable', feature),
    revokeAll: () => ipcRenderer.invoke('host-ops-web-revoke-all'),
    openSettings: () => ipcRenderer.invoke('host-ops-web-open-settings'),
  },
};

/**
 * Lasco Code workspace (IDE page): local git projects chosen natively, files, git, terminals.
 * Same exposure rule as hostOps; main re-validates the sender on every call.
 */
/**
 * Harnais de code : un agent lance Claude Code, Codex, Cursor ou Vibe sur un projet de Lasco Code.
 * Lancement confirmé par Desktop ; la page ne reçoit que les étapes et le résultat.
 */
const codeHarnessBridge = {
  status: () => ipcRenderer.invoke('code-harness-status'),
  start: (request) => ipcRenderer.invoke('code-harness-start', request),
  stop: (runId) => ipcRenderer.invoke('code-harness-stop', runId),
  stopRequest: (requestId) => ipcRenderer.invoke('code-harness-stop-request', requestId),
  runs: () => ipcRenderer.invoke('code-harness-runs'),
  openLogin: (harness) => ipcRenderer.invoke('code-harness-open-login', harness),
  login: (harness) => ipcRenderer.invoke('code-harness-login', harness),
  retry: (runId) => ipcRenderer.invoke('code-harness-retry', runId),
  followUp: (runId, prompt) => ipcRenderer.invoke('code-harness-follow-up', runId, prompt),
  onEvent: (callback) => {
    if (typeof callback !== 'function') return () => undefined;
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('code-harness-event', listener);
    return () => ipcRenderer.removeListener('code-harness-event', listener);
  },
};

const codeWorkspaceBridge = {
  invoke: (method, payload) => ipcRenderer.invoke('code-workspace-invoke', { method, payload }),
  terminalWrite: (id, data) => ipcRenderer.send('code-terminal-input', { id, data }),
  terminalResize: (id, cols, rows) => ipcRenderer.send('code-terminal-resize', { id, cols, rows }),
  onTerminalData: (callback) => subscribe('code-terminal-data', callback),
  onTerminalExit: (callback) => subscribe('code-terminal-exit', callback),
  onFsChanged: (callback) => subscribe('code-fs-changed', callback),
};

/**
 * Detached tab windows (docs/tab-windows.md). Desktop passes the window role and, for a new
 * detached window, the tab it opens on. Decoded here without Node (sandboxed preload).
 */
const TAB_WINDOW_ARG_PREFIX = '--lasco-tab-window=';
function readTabWindowArg() {
  const arg = process.argv.find((a) => typeof a === 'string' && a.startsWith(TAB_WINDOW_ARG_PREFIX));
  if (!arg) return { role: 'main', initialTab: null };
  try {
    const binary = atob(arg.slice(TAB_WINDOW_ARG_PREFIX.length));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return {
      role: parsed && parsed.role === 'detached' ? 'detached' : 'main',
      initialTab: parsed && parsed.initialTab && typeof parsed.initialTab === 'object' ? parsed.initialTab : null,
    };
  } catch (_) {
    return { role: 'main', initialTab: null };
  }
}
const tabWindowInfo = readTabWindowArg();
const tabWindowsBridge = {
  role: tabWindowInfo.role,
  initialTab: tabWindowInfo.initialTab,
  ready: () => ipcRenderer.invoke('tab-window-ready'),
  onAdopt: (callback) => subscribe('tab-window-adopt', callback),
  detach: (payload) => ipcRenderer.invoke('tab-window-detach', payload),
  attach: (payload) => ipcRenderer.invoke('tab-window-attach', payload),
  dragOut: (payload) => ipcRenderer.invoke('tab-window-drag-out', payload),
  dragCancel: () => ipcRenderer.invoke('tab-window-drag-cancel'),
  dragEnd: (payload) => ipcRenderer.invoke('tab-window-drag-end', payload),
  onDragHover: (callback) => subscribe('tab-window-drag-hover', callback),
  closeWindow: () => ipcRenderer.invoke('tab-window-close'),
  /** Load the spare window ahead of a detach (`{ href }`: the portal's new-tab path). */
  prewarm: (payload) => ipcRenderer.invoke('tab-window-prewarm', payload),
  /** ⌘N: open a new window on the new-tab page (`{ href }`: the portal's new-tab path). */
  openWindow: (payload) => ipcRenderer.invoke('tab-window-open', payload),
};

/**
 * Synchronisation My Drive → dossier de cet ordinateur (docs/drive-sync.md). Le dossier se choisit
 * dans les Réglages de Desktop ; la page ne lit et n'écrit que dans ce dossier, une fois lié à son
 * compte. Même règle d'exposition que hostOps, sans dépendre des agents.
 */
const exposePortalBridges = Boolean(portalOrigin) && Boolean(globalThis.location) && globalThis.location.origin === portalOrigin;
const driveSyncBridge = {
  getConfig: () => ipcRenderer.invoke('drive-sync-get-config'),
  onConfigChange: (callback) => subscribe('drive-sync-config-changed', callback),
  bind: (payload) => ipcRenderer.invoke('drive-sync-bind', payload),
  report: (payload) => ipcRenderer.invoke('drive-sync-report', payload),
  openSettings: () => ipcRenderer.invoke('drive-sync-open-settings'),
  chooseFolder: () => ipcRenderer.invoke('drive-sync-choose-folder'),
  validateFolder: (payload) => ipcRenderer.invoke('drive-sync-validate-folder', payload),
  readManifest: (payload) => ipcRenderer.invoke('drive-sync-read-manifest', payload),
  writeManifest: (payload) => ipcRenderer.invoke('drive-sync-write-manifest', payload),
  stat: (payload) => ipcRenderer.invoke('drive-sync-stat', payload),
  writeFile: (payload) => ipcRenderer.invoke('drive-sync-write-file', payload),
};

/**
 * Téléchargements des onglets web et des pages du portail (docs/downloads.md). La page agit par
 * identifiant, jamais par chemin ; le dossier se choisit dans les Réglages de Desktop.
 */
const downloadsBridge = {
  list: (payload) => ipcRenderer.invoke('downloads-list', payload),
  pause: (id) => ipcRenderer.invoke('downloads-pause', { id }),
  resume: (id) => ipcRenderer.invoke('downloads-resume', { id }),
  cancel: (id) => ipcRenderer.invoke('downloads-cancel', { id }),
  retry: (id) => ipcRenderer.invoke('downloads-retry', { id }),
  open: (id) => ipcRenderer.invoke('downloads-open', { id }),
  show: (id) => ipcRenderer.invoke('downloads-show', { id }),
  remove: (id) => ipcRenderer.invoke('downloads-remove', { id }),
  clear: () => ipcRenderer.invoke('downloads-clear'),
  openDirectory: () => ipcRenderer.invoke('downloads-open-directory'),
  openSettings: () => ipcRenderer.invoke('downloads-open-settings'),
  onChanged: (callback) => subscribe('downloads-changed', callback),
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
  settings: {
    get: () => ipcRenderer.invoke('settings-get'),
    setOpenLinksInApp: (enabled) => ipcRenderer.invoke('settings-set-open-links-in-app', enabled),
    onChanged: (callback) => subscribe('settings-changed', callback)
  },
  tabs: {
    onOpenTarget: onOpenPortalTab
  },
  browserTabs: browserTabsBridge,
  /** Coffre : vérification d'identité de l'OS avant d'afficher un mot de passe (docs/passwords.md). */
  vault: {
    verifyUser: (payload) => ipcRenderer.invoke('lasco-vault-verify-user', payload),
    resetVerification: () => ipcRenderer.invoke('lasco-vault-verify-reset'),
  },
  tabWindows: tabWindowsBridge,
  /**
   * « Fenêtre » menu of the menu bar: same options as the burger menu of the internal browser.
   * The page reports its state (labels, checkmarks) and runs the commands Desktop relays.
   */
  appMenu: {
    setState: (state) => ipcRenderer.send('app-menu-set-state', state),
    onCommand: (callback) => subscribe('app-menu-command', callback),
  },
  /**
   * Icône Lasco de la barre des menus (macOS) : la page envoie son résumé (à valider, en cours,
   * non lus ; `null` = déconnecté) et exécute les commandes choisies dans le popover. Voir docs/tray.md.
   */
  tray: {
    setState: (state) => ipcRenderer.send('tray-set-state', state),
    onCommand: (callback) => subscribe('tray-command', callback),
  },
  ...(noAgents && { noAgents: true }),
  ...(exposeVmShell && { vm: vmShellBridge }),
  ...(exposePortalBridges && tabWindowInfo.role === 'main' && { driveSync: driveSyncBridge }),
  ...(exposePortalBridges && { downloads: downloadsBridge }),
  ...(exposeHostOps && { hostOps: hostOpsBridge, codeWorkspace: codeWorkspaceBridge, codeHarness: codeHarnessBridge }),
  setBadgeCount: (count) => ipcRenderer.invoke('lasco-set-badge-count', count),
  notify: (payload) => ipcRenderer.invoke('lasco-notify', payload),
  closeNotification: (tag) => ipcRenderer.invoke('lasco-close-notification', tag),
  getNotificationPermission: () => ipcRenderer.invoke('lasco-notification-permission'),
  openNotificationSettings: () => ipcRenderer.invoke('lasco-open-notification-settings'),
  onNotificationClick: (callback) => subscribe('lasco-notification-open', callback),
};

contextBridge.exposeInMainWorld('lascoDesktop', desktopBridge);
contextBridge.exposeInMainWorld('programistoDesktop', desktopBridge);
