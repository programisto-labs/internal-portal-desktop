const { app, BrowserWindow, WebContentsView, ipcMain, nativeImage, nativeTheme, dialog, shell, Menu, Notification, screen, Tray, globalShortcut, session, systemPreferences } = require('electron');
const { installPortalMediaPermissions } = require('./media-permissions');
const path = require('path');
const http = require('http');
const https = require('https');
const { autoUpdater } = require('electron-updater');
const { createBrowserTabManager } = require('./browser-tabs/manager');
const { sanitizeBrowserUrl } = require('./browser-tabs/url');
const { createSettingsStore, extractPortalTarget, buildBrowserOpenRequest, THEME_SOURCES } = require('./link-handling');
const { buildTabMenuTemplate, resolveWindowMenuActions } = require('./browser-tabs/tab-menu');
const { createHistoryStore } = require('./browser-tabs/history');
const {
  sanitizeTabDescriptor,
  encodeTabWindowArg,
  findWindowAtPoint,
  buildDetachedWindowBounds,
  createAdoptQueue,
  resolveTabDropTarget,
  followPosition,
} = require('./tab-windows');
const { APP_MENU_COMMANDS, normalizeAppMenuState, buildApplicationMenuTemplate } = require('./app-menu');
const {
  applyBadgeCount,
  showAgentNotification,
  closeDesktopNotification,
  readNotificationPermission,
  notificationSettingsTarget,
} = require('./agent-notifications');
const { createHostOpsStore, createJournal } = require('./host-ops/store');
const { createHostOpsService } = require('./host-ops/service');
const { createConfirm } = require('./host-ops/confirm');
const { isTrustedHostOpsSender } = require('./host-ops/trust');
const { createHostOpsWebSettings, buildEnableDialog } = require('./host-ops/web-settings');
const { createInlineConfirm } = require('./host-ops/inline-confirm');
const { createHarnessRunner } = require('./code-harness/runner');
const { createHarnessPermissions } = require('./code-harness/permissions');
const { buildShellPlan, shellGrantCovers, maskSecrets } = require('./host-ops/shell');
const { createRunHistory } = require('./code-harness/history');
const { HARNESSES } = require('./code-harness/harnesses');
const { getLoginEnv } = require('./code-workspace/login-env');
const { createGitRunner } = require('./code-workspace/git');
const { createProjectStore } = require('./code-workspace/projects');
const { createFileOps } = require('./code-workspace/files');
const { createTerminalManager } = require('./code-workspace/terminals');
const { createWatcherManager } = require('./code-workspace/watcher');
const { createCodeWorkspaceService } = require('./code-workspace/service');
const { createCodeAgentOps } = require('./code-workspace/agent-ops');
const { createDriveSyncStore } = require('./drive-sync/store');
const { createDriveSyncFsOps } = require('./drive-sync/fs-ops');
const { registerDriveSyncIpc, driveSyncSettingsState } = require('./drive-sync/ipc');
const { createTrayController } = require('./tray/tray');
const { normalizePortalTrayState, TRAY_PORTAL_COMMANDS } = require('./tray/tray-state');
const { SHORTCUT_IDS, DEFAULT_SHORTCUTS, formatAccelerator, updateShortcut, acceleratorFromKeyEvent } = require('./background-mode');
const { trayPlaceLabel } = require('./tray/tray-platform');
const {
  LOGIN_HIDDEN_ARG,
  linuxLaunchPath,
  windowsLaunchPath,
  autostartDir,
  createLinuxAutostart,
  launchedHidden,
} = require('./login-item');

/**
 * Linux / Wayland: global shortcuts go through the desktop portal (org.freedesktop.portal.GlobalShortcuts);
 * without it `globalShortcut` only works under X11. Must be set before the app is ready.
 */
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal');
}

// Set app name as early as possible so macOS menu bar shows "Lasco" instead of "Electron" in dev
app.setName('Lasco');

function getTargetMainWindow(browserWindow) {
  const win = browserWindow || BrowserWindow.getFocusedWindow() || mainWindowRef;
  if (!win || win.isDestroyed()) return null;
  return win;
}

/** ⌘W / Ctrl+W → close active portal tab (not the Electron window). */
function sendCloseActiveTab(browserWindow) {
  const win = getTargetMainWindow(browserWindow);
  if (!win) return;
  win.webContents.send('browser-tab-shortcut', { tabId: '', action: 'close-tab' });
}

/** Page state reported by the portal for the « Fenêtre » menu (labels, checkmarks). */
let appMenuState = null;

/** Relays a « Fenêtre » menu command to the portal page of the main window. */
function sendAppMenuCommand(command) {
  if (!APP_MENU_COMMANDS.includes(command)) return;
  const focused = BrowserWindow.getFocusedWindow();
  const win = focused && portalWindows.has(focused.id) ? focused : mainWindowRef;
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.webContents.send('app-menu-command', { command });
}

/**
 * Replace Electron's default menu so ⌘W is not bound to Close Window.
 * Without this, the macOS default accelerator closes the app before our tab handler runs.
 * Rebuilt whenever the page reports a new state (see `app-menu-set-state`).
 */
function installApplicationMenu() {
  const template = buildApplicationMenuTemplate({
    isMac: process.platform === 'darwin',
    state: appMenuState,
    closeTab: (browserWindow) => sendCloseActiveTab(browserWindow),
    closeWindow: (browserWindow) => {
      const win = getTargetMainWindow(browserWindow);
      if (win) win.close();
    },
    openSettings: () => openSettings('general'),
    send: sendAppMenuCommand,
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const isDev = process.env.NODE_ENV === 'development';
const PORTAL_URL = isDev ? 'http://localhost:3001/' : 'https://app.lascoapp.com';
const PORTAL_ORIGIN = new URL(PORTAL_URL).origin;
/**
 * internal-portal#2373: Desktop launched without AI agents (e.g. inside a VM).
 * Host operations are then never exposed: the VM must not become a path to the physical computer.
 */
const NO_AGENTS = process.argv.includes('--no-agents') || process.env.LASCO_DESKTOP_NO_AGENTS === '1';
const PORTAL_ORIGIN_ARG_PREFIX = '--lasco-portal-origin=';
const NO_AGENTS_ARG = '--lasco-no-agents';

const AUTO_RETRY_INTERVAL_MS = 5000;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const APP_VERSION_ARG_PREFIX = '--lasco-app-version=';

const updateState = {
  status: 'idle',
  currentVersion: app.getVersion(),
  availableVersion: null,
  downloadedVersion: null,
  progressPercent: 0,
  error: null
};

let updateCheckIntervalId = null;

/** Deep link: lasco://open?target=%2Fslug%2Fworkspace%2Fadmin%2Fplan%3Fcheckout%3Dsuccess */
const LASCO_PROTOCOL = 'lasco';
let pendingInitialPortalFullUrl = null;
let mainWindowRef = null;
/**
 * Every window that shows the portal: the main one and detached tab windows (docs/tab-windows.md).
 * Each has its own native browser views (`tabManager`, created on first use).
 * @type {Map<number, { win: BrowserWindow, role: 'main' | 'detached', tabManager: ReturnType<typeof createBrowserTabManager> | null }>}
 */
const portalWindows = new Map();
/** One history file for every window. */
let browserHistoryStore = null;
/** Tabs moved into a window before its page is ready to adopt them. */
const tabAdoptQueue = createAdoptQueue({
  send: (windowId, tab) => {
    const entry = portalWindows.get(windowId);
    if (entry && !entry.win.isDestroyed()) entry.win.webContents.send('tab-window-adopt', tab);
  },
});
/** @type {ReturnType<typeof createSettingsStore> | null} */
let settingsStore = null;

function getSettingsStore() {
  if (!settingsStore) {
    settingsStore = createSettingsStore(path.join(app.getPath('userData'), 'settings.json'));
  }
  return settingsStore;
}

/** My Drive → dossier de cet ordinateur (Réglages > My Drive, docs/drive-sync.md). Désactivé par défaut. */
let driveSyncStore = null;

function getDriveSyncStore() {
  if (!driveSyncStore) driveSyncStore = createDriveSyncStore(path.join(app.getPath('userData'), 'drive-sync.json'));
  return driveSyncStore;
}

/** Host operations (agent file ops on this computer). Disabled until enabled in Desktop options. */
let hostOpsStore = null;
let hostOpsJournal = null;
let hostOpsService = null;
let hostOpsWebSettings = null;
let hostOpsInlineConfirm = null;
let harnessRunner = null;
let harnessPermissions = null;

/** Événements d'une exécution de harnais vers le portail (cadre principal, origine du portail seulement). */
function sendHarnessEvent(event) {
  scheduleTrayRefresh();
  const win = mainPortalWindow();
  if (!win || win.webContents.isDestroyed()) return;
  try {
    if (new URL(win.webContents.getURL()).origin !== PORTAL_ORIGIN) return;
  } catch (_) {
    return;
  }
  win.webContents.send('code-harness-event', event);
}

function ensureHarnessRunner() {
  if (!harnessRunner) {
    // ensureHostOps crée le store et la confirmation en carte (avec la boîte native en repli).
    ensureHostOps();
    const core = ensureCodeCore();
    harnessPermissions = createHarnessPermissions({
      confirm: async (req) => {
        const answer = await hostOpsInlineConfirm.confirm(req);
        // Journal : projet et commande masquée (ou outil), jamais de sortie.
        hostOpsJournal.add({
          requestId: req.requestId,
          agentId: req.agentId,
          agentName: req.agentName,
          operation: req.operation,
          source: req.projectRoot,
          destination: req.operation === 'code.harness_command' ? maskSecrets(req.command || '') : req.toolName,
          decision: answer,
          outcome: answer === 'once' || answer === 'always' ? 'allowed' : 'denied',
        });
        return answer;
      },
      buildPlan: (request) => buildShellPlan(require('fs').promises, request, { homeDir: app.getPath('home') }),
      findShellGrant: (ctx, plan) =>
        hostOpsStore
          .listGrants()
          .find(
            (g) =>
              g.userId === ctx.userId &&
              g.deviceId === hostOpsStore.getDeviceId() &&
              g.agentId === ctx.agentId &&
              shellGrantCovers(g, plan)
          ) || null,
      addShellGrant: (grant) =>
        hostOpsStore.addGrant({
          userId: grant.userId,
          deviceId: hostOpsStore.getDeviceId(),
          agentId: grant.agentId,
          agentName: grant.agentName,
          operation: 'shell.run',
          commandPrefix: grant.commandPrefix,
          cwdRoots: grant.cwdRoots,
        }),
    });
    harnessRunner = createHarnessRunner({
      permissions: harnessPermissions,
      isEnabled: () => hostOpsStore.isHarnessEnabled(),
      getProject: (userId, projectId) => core.projects.get(userId, projectId),
      getEnv: () => getLoginEnv(),
      emit: sendHarnessEvent,
      // Cartes « sous-agent » gardées après un redémarrage de l'app.
      history: createRunHistory(path.join(app.getPath('userData'), 'code-harness-runs.json')),
      confirm: async (req) => {
        const grant = hostOpsStore
          .listGrants()
          .find(
            (g) =>
              g.operation === 'code.delegate' &&
              g.userId === req.userId &&
              g.agentId === req.agentId &&
              g.deviceId === hostOpsStore.getDeviceId() &&
              g.harness === req.harness &&
              (g.destinationRoots || []).includes(req.projectRoot)
          );
        if (grant) return 'grant';
        const answer = await hostOpsInlineConfirm.confirm({ ...req, allowPersistent: true });
        if (answer === 'always') {
          hostOpsStore.addGrant({
            userId: req.userId,
            deviceId: hostOpsStore.getDeviceId(),
            agentId: req.agentId,
            agentName: req.agentName,
            operation: 'code.delegate',
            harness: req.harness,
            destinationRoots: [req.projectRoot],
          });
        }
        return answer;
      },
    });
  }
  return harnessRunner;
}

/** Ouvre un Terminal sur la commande de connexion du harnais (macOS) ; ailleurs, la page affiche la commande. */
function openHarnessLogin(harnessId) {
  const def = HARNESSES[harnessId];
  if (!def) return { ok: false };
  if (process.platform !== 'darwin') return { ok: true, opened: false, command: def.loginCommand };
  const script = `tell application "Terminal" to do script ${JSON.stringify(def.loginCommand)}\ntell application "Terminal" to activate`;
  require('child_process').execFile('osascript', ['-e', script], () => undefined);
  return { ok: true, opened: true, command: def.loginCommand };
}
/** Native confirmation cards: webContents id -> { id, onDecide, onSize }. */
const confirmCards = new Map();

function mainPortalWindow() {
  return mainWindowRef && !mainWindowRef.isDestroyed() ? mainWindowRef : null;
}

/** A native card view over the chat placeholder (separate `file:` web contents, no access from the portal). */
function createConfirmCardView(id, { onDecide, onSize }) {
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'host-ops', 'confirm-card-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  view.setBackgroundColor('#00000000');
  if (typeof view.setBorderRadius === 'function') view.setBorderRadius(18);
  const wc = view.webContents;
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  confirmCards.set(wc.id, { id, onDecide, onSize });
  let ready = false;
  let pendingSpec = null;
  let pendingArm = false;
  const send = (channel, payload) => {
    if (!wc.isDestroyed()) wc.send(channel, payload);
  };
  wc.once('did-finish-load', () => {
    ready = true;
    if (pendingSpec) send('confirm-card-render', pendingSpec);
    send('confirm-card-arm', pendingArm);
  });
  wc.loadFile(path.join(__dirname, 'host-ops', 'confirm-card.html'));
  let attached = false;
  const onTheme = () => send('confirm-card-theme', nativeTheme.shouldUseDarkColors);
  nativeTheme.on('updated', onTheme);
  return {
    render(spec) {
      pendingSpec = {
        title: spec.title,
        message: spec.message,
        buttons: spec.buttons,
        decisions: spec.decisions,
        dark: nativeTheme.shouldUseDarkColors,
      };
      if (ready) send('confirm-card-render', pendingSpec);
    },
    setBounds(bounds) {
      const win = mainPortalWindow();
      if (!win) return;
      // Re-adding keeps the card on top of the browser tab views.
      win.contentView.addChildView(view);
      attached = true;
      view.setBounds(bounds);
      view.setVisible(true);
    },
    hide() {
      view.setVisible(false);
    },
    arm(on) {
      pendingArm = on === true;
      if (ready) send('confirm-card-arm', pendingArm);
    },
    destroy() {
      nativeTheme.removeListener('updated', onTheme);
      confirmCards.delete(wc.id);
      const win = mainPortalWindow();
      if (attached && win) {
        try {
          win.contentView.removeChildView(view);
        } catch (_) {
          // already detached
        }
      }
      if (!wc.isDestroyed()) wc.close();
    },
  };
}

/** Confirmations as cards in the Lasco AI chat (drawn by Desktop); native dialog when the chat cannot host them. */
function ensureInlineConfirm(fallback) {
  if (!hostOpsInlineConfirm) {
    hostOpsInlineConfirm = createInlineConfirm({
      fallback,
      createCard: createConfirmCardView,
      notifyPortal: (event) => {
        scheduleTrayRefresh();
        const win = mainPortalWindow();
        if (!win || win.webContents.isDestroyed()) return false;
        let origin = null;
        try {
          origin = new URL(win.webContents.getURL()).origin;
        } catch (_) {
          origin = null;
        }
        // Only the portal hosts the card; an error page or another origin gets the native dialog.
        if (origin !== PORTAL_ORIGIN || win.isMinimized() || !win.isVisible()) return false;
        win.webContents.send('host-ops-confirm', event);
        return true;
      },
      getContentSize: () => {
        const win = mainPortalWindow();
        if (!win || win.isMinimized() || !win.isVisible()) return null;
        const [contentWidth, contentHeight] = win.getContentSize();
        return { contentWidth, contentHeight };
      },
    });
  }
  return hostOpsInlineConfirm;
}

/** Réglages vus par le portail (profil > « Cet ordinateur ») : l'activation passe par un dialogue natif. */
function ensureHostOpsWebSettings() {
  ensureHostOps();
  if (!hostOpsWebSettings) {
    hostOpsWebSettings = createHostOpsWebSettings({
      store: hostOpsStore,
      openSettings: () => openHostOpsSettings(),
      confirmEnable: async (request) => {
        const options = buildEnableDialog(request);
        const win = mainWindowRef && !mainWindowRef.isDestroyed() ? mainWindowRef : null;
        if (win) win.focus();
        const res = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
        return res.response === 1;
      },
    });
  }
  return hostOpsWebSettings;
}

/**
 * Lasco Code workspace (IDE page of the portal): local git projects, files, git, terminals.
 * Shared core (git runner, project list, file operations) used by the IDE and by agent operations.
 */
let codeCore = null;
let codeWorkspaceService = null;

function ensureCodeCore() {
  if (!codeCore) {
    const getEnv = () => getLoginEnv();
    const git = createGitRunner({ getEnv });
    codeCore = {
      getEnv,
      git,
      projects: createProjectStore(path.join(app.getPath('userData'), 'code-projects.json')),
      files: createFileOps({ git, trashItem: (p) => shell.trashItem(p) }),
      terminals: createTerminalManager({ getEnv }),
      watchers: createWatcherManager(),
    };
  }
  return codeCore;
}

function ensureCodeWorkspace() {
  if (!codeWorkspaceService) {
    const core = ensureCodeCore();
    const parent = () => (mainWindowRef && !mainWindowRef.isDestroyed() ? mainWindowRef : null);
    codeWorkspaceService = createCodeWorkspaceService({
      ...core,
      pickFolder: async ({ title, buttonLabel }) => {
        const options = { title, buttonLabel, properties: ['openDirectory', 'createDirectory'] };
        const win = parent();
        const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
        return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
      },
      confirmInitRepository: async (dir) => {
        const options = {
          type: 'question',
          title: 'Lasco',
          message: 'Ce dossier n’est pas un dépôt git',
          detail: `${dir}\n\nLasco Code travaille sur des dépôts git (modifications, diff, branches). Initialiser un dépôt git dans ce dossier ?`,
          buttons: ['Annuler', 'Initialiser un dépôt git'],
          defaultId: 1,
          cancelId: 0,
          noLink: true,
        };
        const win = parent();
        const res = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
        return res.response === 1 ? 'init' : 'cancel';
      },
      openAgentSettings: () => openHostOpsSettings(),
      getAgentAccess: () => {
        ensureHostOps();
        return {
          enabled: hostOpsStore.isCodeEnabled(),
          hostEnabled: hostOpsStore.isEnabled(),
          shellEnabled: hostOpsStore.isShellEnabled(),
        };
      },
    });
  }
  return codeWorkspaceService;
}

function ensureHostOps() {
  if (!hostOpsService) {
    const dir = app.getPath('userData');
    const core = ensureCodeCore();
    hostOpsStore = createHostOpsStore(path.join(dir, 'host-ops.json'));
    hostOpsJournal = createJournal(path.join(dir, 'host-ops-journal.json'));
    hostOpsService = createHostOpsService({
      store: hostOpsStore,
      journal: hostOpsJournal,
      codeAgent: createCodeAgentOps({ projects: core.projects, files: core.files, git: core.git }),
      confirm: ensureInlineConfirm(
        createConfirm(
          (...args) => dialog.showMessageBox(...args),
          () => {
            const win = mainPortalWindow();
            // A sheet on a hidden window (Lasco in the background) would never be seen: free-standing dialog.
            if (win && win.isVisible() && !win.isMinimized()) return win;
            if (process.platform === 'darwin' && app.dock) app.dock.bounce('informational');
            return null;
          }
        )
      ).confirm,
    });
  }
  return hostOpsService;
}

/** Profil > « Cet ordinateur », cartes de confirmation : réglages ouverts sur cette section. */
function openHostOpsSettings() {
  openSettings('computer');
}

/**
 * Réglages : modale dessinée par Desktop au-dessus de la fenêtre principale (vue `file:` séparée,
 * jamais accessible au portail ; règles et journal restent hors de la page). Sans fenêtre
 * principale : petite fenêtre dédiée avec la même page.
 */
let settingsSurface = null;

function settingsWebContents() {
  if (!settingsSurface) return null;
  const wc = settingsSurface.webContents;
  return wc && !wc.isDestroyed() ? wc : null;
}

function closeSettings() {
  resumeGlobalShortcuts();
  const surface = settingsSurface;
  if (!surface) return;
  settingsSurface = null;
  surface.dispose();
  const win = mainPortalWindow();
  if (win && !win.webContents.isDestroyed()) win.webContents.focus();
}

function openSettings(section = 'general') {
  const existing = settingsWebContents();
  if (existing) {
    existing.send('settings-modal-show', section);
    if (settingsSurface.window) settingsSurface.window.focus();
    existing.focus();
    return;
  }
  if (!NO_AGENTS) ensureHostOps();
  const webPreferences = {
    preload: path.join(__dirname, 'settings', 'settings-preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: false,
  };
  const query = { section, agents: NO_AGENTS ? '0' : '1' };
  const win = mainPortalWindow();
  if (win && !win.isMinimized() && win.isVisible()) {
    const view = new WebContentsView({ webPreferences });
    view.setBackgroundColor('#00000000');
    const fit = () => {
      if (win.isDestroyed()) return;
      const [width, height] = win.getContentSize();
      view.setBounds({ x: 0, y: 0, width, height });
    };
    win.contentView.addChildView(view);
    fit();
    win.on('resize', fit);
    const onClosed = () => closeSettings();
    win.once('closed', onClosed);
    settingsSurface = {
      webContents: view.webContents,
      window: null,
      dispose() {
        if (!win.isDestroyed()) {
          win.removeListener('resize', fit);
          win.removeListener('closed', onClosed);
          try {
            win.contentView.removeChildView(view);
          } catch (_) {
            // already detached
          }
        }
        if (!view.webContents.isDestroyed()) view.webContents.close();
      },
    };
  } else {
    const standalone = new BrowserWindow({
      width: 880,
      height: 620,
      minWidth: 640,
      minHeight: 420,
      title: 'Réglages',
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ffffff',
      webPreferences,
    });
    query.standalone = '1';
    standalone.on('closed', () => {
      resumeGlobalShortcuts();
      if (settingsSurface && settingsSurface.window === standalone) settingsSurface = null;
    });
    settingsSurface = {
      webContents: standalone.webContents,
      window: standalone,
      dispose() {
        if (!standalone.isDestroyed()) standalone.close();
      },
    };
  }
  const wc = settingsSurface.webContents;
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.once('did-finish-load', () => {
    if (!wc.isDestroyed()) wc.focus();
  });
  wc.loadFile(path.join(__dirname, 'settings', 'settings.html'), { query });
}

function refreshSettings() {
  const wc = settingsWebContents();
  if (wc) wc.send('settings-modal-refresh');
}

function getSettings() {
  return getSettingsStore().get();
}

/** Route a Lasco link (lasco:// or portal URL) to a portal tab when "open links in app" is on. */
function routePortalLinkInApp(urlString) {
  if (!getSettings().openLinksInApp) return false;
  const target = extractPortalTarget(urlString, isPortalNavigationUrl);
  const win = mainWindowRef;
  if (!target || !win || win.isDestroyed()) return false;
  win.webContents.send('open-portal-tab', target);
  return true;
}

function openExternalAsBrowserTab(urlString, targetWindow) {
  const safe = sanitizeBrowserUrl(urlString);
  if (!safe) return false;
  const win = targetWindow && portalWindows.has(targetWindow.id) ? targetWindow : mainWindowRef;
  if (!win || win.isDestroyed()) return false;
  win.webContents.send('browser-tab-open-request', buildBrowserOpenRequest(safe));
  return true;
}

function buildUpdateSnapshot() {
  return {
    ...updateState
  };
}

function setUpdateState(partialState) {
  Object.assign(updateState, partialState);
  refreshSettings();
  const snapshot = buildUpdateSnapshot();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('update-status-changed', snapshot);
    }
  }
}

async function promptRestartForUpdate(info) {
  const versionLabel = info?.version || info?.releaseName || 'a new version';
  const response = await dialog.showMessageBox({
    type: 'info',
    buttons: ['Restart now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    title: 'Lasco Update',
    message: `Version ${versionLabel} has been downloaded.`,
    detail: 'Restart the app now to install the update.'
  });

  if (response.response === 0) {
    quitAndInstallUpdate();
  }
}

/**
 * quitAndInstall closes the windows before `before-quit`: say first that Lasco really quits,
 * otherwise the main window would only hide (background mode) and the update would never install.
 */
function quitAndInstallUpdate() {
  isQuitting = true;
  autoUpdater.quitAndInstall(false, true);
}

function isUpdaterEnabled() {
  return app.isPackaged;
}

async function checkForUpdates() {
  if (!isUpdaterEnabled()) return;
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    reportUpdaterError(error, 'Update check failed.');
  }
}

/**
 * A release whose files for this platform are not published (yet) is not a failed update:
 * the jobs of a release finish one after the other, and a failed job publishes only part of it.
 * Stay on the current version without telling the user anything went wrong.
 */
function isUpdateNotPublishedError(error) {
  return error?.code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND';
}

function reportUpdaterError(error, fallbackMessage) {
  if (isUpdateNotPublishedError(error)) {
    console.warn('[auto-update] release not published for this platform yet:', error?.message);
    setUpdateState({ status: 'idle', error: null });
    return;
  }
  setUpdateState({
    status: 'error',
    error: error?.message || fallbackMessage
  });
}

function setupAutoUpdater() {
  if (!isUpdaterEnabled()) {
    setUpdateState({
      status: 'disabled'
    });
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    setUpdateState({
      status: 'checking',
      error: null
    });
  });

  autoUpdater.on('update-available', (info) => {
    setUpdateState({
      status: 'downloading',
      availableVersion: info?.version || null,
      error: null
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    setUpdateState({
      status: 'downloading',
      progressPercent: Number(progress?.percent || 0)
    });
  });

  autoUpdater.on('update-not-available', () => {
    setUpdateState({
      status: 'idle',
      availableVersion: null,
      downloadedVersion: null,
      progressPercent: 0,
      error: null
    });
  });

  autoUpdater.on('update-downloaded', async (info) => {
    setUpdateState({
      status: 'downloaded',
      downloadedVersion: info?.version || null,
      progressPercent: 100,
      error: null
    });

    try {
      await promptRestartForUpdate(info);
    } catch (error) {
      setUpdateState({
        status: 'error',
        error: error?.message || 'Could not display update prompt.'
      });
    }
  });

  autoUpdater.on('error', (error) => {
    reportUpdaterError(error, 'Auto-update failed.');
  });

  void checkForUpdates();
  updateCheckIntervalId = setInterval(() => {
    void checkForUpdates();
  }, UPDATE_CHECK_INTERVAL_MS);
}

function checkPortalReachable() {
  return new Promise((resolve) => {
    const url = new URL(PORTAL_URL);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get(PORTAL_URL, { timeout: 10000 }, (res) => {
      resolve(res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** Lasco app icon (same assets as web: lasco-favicon.png). */
const APP_ICON = path.join(__dirname, '..', 'build', 'icon.png');

function getIconPath() {
  return APP_ICON;
}

function setIconSafe(winOrDock, iconPath) {
  try {
    winOrDock.setIcon(iconPath);
  } catch (_) {
    // ignore icon errors (e.g. missing file in packaged app)
  }
}

/** URLs that should load inside the app (same logic as window open allowlist). */
function isPortalNavigationUrl(urlString) {
  try {
    const u = new URL(urlString);
    if (u.origin === new URL(PORTAL_URL).origin) {
      return true;
    }
    if (isDev && u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) {
      return true;
    }
    if (u.protocol === 'https:') {
      const host = u.hostname;
      return (
        host === 'my.programisto.fr' ||
        host === 'programisto.fr' ||
        host.endsWith('.programisto.fr') ||
        host === 'app.lascoapp.com' ||
        host.endsWith('.lascoapp.com')
      );
    }
    return false;
  } catch (_) {
    return false;
  }
}

/** Microsoft / Google OAuth must stay in-app so redirect_uri + cookies match Electron. */
function isOAuthProviderNavigationUrl(urlString) {
  try {
    const u = new URL(urlString);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return (
      host === 'login.microsoftonline.com' ||
      host.endsWith('.microsoftonline.com') ||
      host === 'login.live.com' ||
      host === 'account.live.com' ||
      host === 'accounts.google.com' ||
      host === 'oauth2.googleapis.com'
    );
  } catch (_) {
    return false;
  }
}

/** OAuth authorize redirects live on the API host (not the portal origin). */
function isApiHostNavigationUrl(urlString) {
  try {
    const u = new URL(urlString);
    const host = u.hostname.toLowerCase();
    if (host === 'api.lascoapp.com' || host === 'api.programisto.fr') return true;
    if (host.startsWith('api.') && (host.endsWith('.lascoapp.com') || host.endsWith('.programisto.fr'))) {
      return true;
    }
    if (isDev && (host === 'localhost' || host === '127.0.0.1')) return true;
    return false;
  } catch (_) {
    return false;
  }
}

function shouldNavigateInApp(urlString) {
  return (
    isPortalNavigationUrl(urlString) ||
    isOAuthProviderNavigationUrl(urlString) ||
    isApiHostNavigationUrl(urlString)
  );
}

function openUrlInDefaultBrowser(urlString) {
  try {
    const u = new URL(urlString);
    if (u.protocol === 'javascript:' || u.protocol === 'data:' || u.protocol === 'blob:') {
      return;
    }
    void shell.openExternal(urlString);
  } catch (_) {
    // ignore invalid URLs
  }
}

function buildLascoDesktopUserAgent(baseUserAgent) {
  return (
    baseUserAgent +
    ' LascoDesktop/' +
    app.getVersion() +
    ' lasco-desktop/' +
    app.getVersion() +
    (NO_AGENTS ? ' LascoNoAgents/1' : '')
  );
}

function getBrowserHistoryStore() {
  if (!browserHistoryStore) {
    browserHistoryStore = createHistoryStore({ filePath: path.join(app.getPath('userData'), 'browser-history.json') });
  }
  return browserHistoryStore;
}

function portalWindowEntry(win) {
  if (!win || win.isDestroyed()) return null;
  return portalWindows.get(win.id) || null;
}

/** Native browser views of a portal window (null for any other window, e.g. Réglages). */
function tabManagerFor(win) {
  const entry = portalWindowEntry(win);
  if (!entry) return null;
  if (!entry.tabManager) {
    entry.tabManager = createBrowserTabManager({
      getMainWindow: () => (win.isDestroyed() ? null : win),
      history: getBrowserHistoryStore(),
      interceptLink: routePortalLinkInApp,
    });
  }
  return entry.tabManager;
}

function destroyAllBrowserViews() {
  for (const entry of portalWindows.values()) {
    if (entry.tabManager) entry.tabManager.destroyAll();
  }
}

/** Portal windows, focused first (used to find the window under a dropped tab). */
function portalWindowsFrontToBack() {
  const focused = BrowserWindow.getFocusedWindow();
  const list = [...portalWindows.values()].filter((e) => !e.win.isDestroyed());
  list.sort((a, b) => (a.win === focused ? -1 : b.win === focused ? 1 : 0));
  return list;
}

/** Detached tab window, opened on `tab` (docs/tab-windows.md). */
function openDetachedTabWindow(tab, { point, sourceWindow } = {}) {
  const at = point || screen.getCursorScreenPoint();
  const workArea = screen.getDisplayNearestPoint(at).workArea;
  let size = null;
  if (sourceWindow && !sourceWindow.isDestroyed()) {
    const [width, height] = sourceWindow.getSize();
    size = { width, height };
  }
  const bounds = buildDetachedWindowBounds({ point, size, workArea });
  return createWindow({ role: 'detached', initialTab: tab, bounds });
}

/** Hand a tab to a portal window: it adopts it as soon as its page is ready. */
function deliverTabToWindow(win, tab) {
  tabAdoptQueue.deliver(win.id, tab);
  if (win.isMinimized()) win.restore();
  win.focus();
  if (process.platform === 'darwin') win.moveTop();
}

function loadMainPortalUrl(win, urlString) {
  if (win.isDestroyed()) return;
  win.loadURL(urlString, {
    userAgent: buildLascoDesktopUserAgent(win.webContents.getUserAgent())
  });
}

function parseLascoOpenTarget(urlString) {
  return extractPortalTarget(urlString, isPortalNavigationUrl);
}

function handleLascoDeepLink(urlString) {
  const target = parseLascoOpenTarget(urlString);
  if (!target) return;
  if (!getSettings().openLinksInApp) {
    // Option disabled: portal https links go to the system browser instead.
    if (/^https?:/i.test(urlString)) openUrlInDefaultBrowser(urlString);
    return;
  }
  const full = PORTAL_URL.replace(/\/$/, '') + target;
  const win = mainPortalWindow();
  if (win) {
    win.webContents.send('open-portal-tab', target);
    // The main window may be hidden (background mode).
    showMainWindow();
    if (process.platform === 'darwin') {
      win.moveTop();
    }
  } else {
    pendingInitialPortalFullUrl = full;
  }
}

function registerLascoProtocolClient() {
  try {
    if (!getSettings().openLinksInApp) {
      app.removeAsDefaultProtocolClient(LASCO_PROTOCOL);
      return;
    }
    if (process.defaultApp) {
      if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient(LASCO_PROTOCOL, process.execPath, [
          path.resolve(process.argv[1])
        ]);
      }
    } else {
      app.setAsDefaultProtocolClient(LASCO_PROTOCOL);
    }
  } catch (_) {
    // ignore registration errors (e.g. dev)
  }
}

/**
 * A portal window. `main` is the usual Lasco window; `detached` holds tabs moved out of
 * another window and opens on `initialTab` (docs/tab-windows.md).
 */
function createWindow({ role = 'main', initialTab = null, bounds = null, inactive = false, hidden = false } = {}) {
  let iconPath;
  try {
    iconPath = getIconPath();
  } catch (_) {
    iconPath = null;
  }

  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';
  /* Transparent window so macOS vibrancy / Windows mica can show through chrome. */
  const usesSystemMaterial = isMac || isWin;

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    ...(bounds || {}),
    /* Compact floor ~ Spotify desktop; sidebar auto-collapses in the web shell below ~1100px. */
    minWidth: 800,
    minHeight: 500,
    title: 'Lasco',
    frame: false,
    // A window that follows a dragged tab appears without taking focus (the drag stays in its source).
    // `hidden`: opened at login, Lasco starts in the menu bar only.
    show: !inactive && !hidden,
    backgroundColor: usesSystemMaterial ? '#00000000' : '#222222',
    /* Native close / minimize / zoom — visible even if the web preload bridge is late or missing */
    ...(isMac && {
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 16, y: 16 },
      /* Cursor-like frosted sidebar / title chrome (wallpaper tint + blur). */
      vibrancy: 'sidebar',
      visualEffectState: 'active',
    }),
    ...(isWin && {
      backgroundMaterial: 'mica',
    }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      partition: 'persist:portal',
      // Main window hidden in the background: agent turns, chat stream and tray summary keep their pace.
      backgroundThrottling: role !== 'main',
      additionalArguments: [
        `${APP_VERSION_ARG_PREFIX}${app.getVersion()}`,
        `${PORTAL_ORIGIN_ARG_PREFIX}${PORTAL_ORIGIN}`,
        encodeTabWindowArg({ role, initialTab }),
        ...(NO_AGENTS ? [NO_AGENTS_ARG] : []),
      ]
    },
    ...(iconPath && { icon: iconPath })
  });

  if (process.platform === 'darwin' && app.dock && iconPath) {
    setIconSafe(app.dock, iconPath);
  }

  if (inactive && !hidden) win.showInactive();
  win.once('ready-to-show', () => {
    if (win.isDestroyed() || inactive || hidden) return;
    win.focus();
    if (process.platform === 'darwin') {
      win.moveTop();
    }
  });

  const errorPagePath = path.join(__dirname, 'error.html');
  let autoRetryIntervalId = null;

  function stopAutoRetry() {
    if (autoRetryIntervalId) {
      clearInterval(autoRetryIntervalId);
      autoRetryIntervalId = null;
    }
  }

  function startAutoRetry() {
    if (autoRetryIntervalId) return;
    autoRetryIntervalId = setInterval(async () => {
      if (win.isDestroyed()) {
        stopAutoRetry();
        return;
      }
      const ok = await checkPortalReachable();
      if (ok) {
        stopAutoRetry();
        if (!win.isDestroyed()) {
          loadMainPortalUrl(win, PORTAL_URL);
        }
      }
    }, AUTO_RETRY_INTERVAL_MS);
  }

  const winId = win.id;
  portalWindows.set(winId, { win, role, tabManager: null });
  if (role === 'main') mainWindowRef = win;
  // A full page load (login, reload): moved tabs wait until the new page asks for them.
  win.webContents.on('did-navigate', () => tabAdoptQueue.reset(winId));
  // « Fenêtre » menu: a full page load (login, reload) drops the state until the portal reports it again.
  win.webContents.on('did-navigate', () => {
    if (win === mainWindowRef && trayPortalState !== null) {
      trayPortalState = null;
      scheduleTrayRefresh();
    }
    if (win !== mainWindowRef || appMenuState === null) return;
    appMenuState = null;
    installApplicationMenu();
  });
  // Lasco Code: a full reload of the portal (not an in-app navigation) ends its terminals and watchers.
  const webContentsRef = win.webContents;
  const releaseCodeWorkspace = () => {
    if (!codeCore) return;
    codeCore.terminals.killForWebContents(webContentsRef);
    codeCore.watchers.unwatchWebContents(webContentsRef);
  };
  win.webContents.on('did-navigate', releaseCodeWorkspace);
  win.webContents.on('render-process-gone', releaseCodeWorkspace);
  // Chat confirmation cards: hidden until the page reports their spot again.
  for (const name of ['resize', 'minimize', 'hide', 'enter-full-screen', 'leave-full-screen']) {
    win.on(name, () => hostOpsInlineConfirm && hostOpsInlineConfirm.invalidateAll());
  }
  win.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame && hostOpsInlineConfirm) hostOpsInlineConfirm.invalidateAll();
  });
  // Background mode: closing the main window hides it, the portal keeps running (docs/background.md).
  win.on('close', (event) => {
    if (win !== mainWindowRef || !backgroundModeActive()) return;
    event.preventDefault();
    hideMainWindow(win);
    showBackgroundHintOnce();
  });
  win.on('closed', () => {
    releaseCodeWorkspace();
    stopAutoRetry();
    const entry = portalWindows.get(winId);
    if (entry && entry.tabManager) entry.tabManager.destroyAll();
    portalWindows.delete(winId);
    tabAdoptQueue.forget(winId);
    if (mainWindowRef === win) {
      // The oldest detached window becomes the main one (bridges, badge, links).
      const next = [...portalWindows.values()].find((e) => !e.win.isDestroyed());
      if (next) next.role = 'main';
      mainWindowRef = next ? next.win : null;
    }
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || win.isDestroyed()) return;
    // Don't show error page for aborted navigations (e.g. user navigated away)
    if (errorCode === -3) return;
    win.loadFile(errorPagePath, {
      query: {
        code: String(errorCode),
        description: errorDescription || '',
        url: validatedURL || ''
      }
    });
    startAutoRetry();
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (url === 'retry://reload') {
      event.preventDefault();
      stopAutoRetry();
      if (!win.isDestroyed()) {
        loadMainPortalUrl(win, PORTAL_URL);
      }
      return;
    }
    // Same-window links to external sites: open in the system browser instead of leaving the app
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      return;
    }
    if (parsed.protocol === 'file:' || parsed.protocol === 'about:') {
      return;
    }
    // Keep portal + OAuth IdP + API authorize inside Electron (otherwise Microsoft
    // login opens in Chrome, callback never returns here, and /exchange hangs/401s).
    if (!shouldNavigateInApp(url)) {
      event.preventDefault();
      if (!openExternalAsBrowserTab(url, win)) {
        openUrlInDefaultBrowser(url);
      }
    }
  });

  if (role === 'detached' && initialTab) {
    loadMainPortalUrl(win, PORTAL_ORIGIN + initialTab.locationHref);
  } else {
    const initialUrl = pendingInitialPortalFullUrl || PORTAL_URL;
    pendingInitialPortalFullUrl = null;
    loadMainPortalUrl(win, initialUrl);
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isPortalNavigationUrl(url)) {
      try {
        const target = new URL(url);
        win.webContents.send(
          'open-portal-tab',
          `${target.pathname}${target.search}${target.hash}`
        );
      } catch (_) {
        // Invalid portal URLs are denied below.
      }
      return { action: 'deny' };
    }
    // OAuth / API authorize: navigate the main window instead of spawning a popup.
    if (isOAuthProviderNavigationUrl(url) || isApiHostNavigationUrl(url)) {
      if (!win.isDestroyed()) {
        loadMainPortalUrl(win, url);
      }
      return { action: 'deny' };
    }
    if (!openExternalAsBrowserTab(url, win)) {
      openUrlInDefaultBrowser(url);
    }
    return { action: 'deny' };
  });
  return win;
}

function updateAllIcons() {
  try {
    const iconPath = getIconPath();
    for (const w of BrowserWindow.getAllWindows()) {
      setIconSafe(w, iconPath);
    }
    if (process.platform === 'darwin' && app.dock) {
      setIconSafe(app.dock, iconPath);
    }
  } catch (_) { }
}

/**
 * Icône Lasco de la barre des menus (macOS) : à valider, en cours, non lus (docs/tray.md).
 * Le portail envoie son résumé (`tray-set-state`), Desktop y ajoute ses confirmations et harnais.
 */
let trayController = null;
/** Résumé du portail de la fenêtre principale ; `null` tant qu'il ne l'a pas envoyé (connexion, rechargement). */
let trayPortalState = null;
let trayRefreshTimer = null;

function scheduleTrayRefresh() {
  if (!trayController || trayRefreshTimer) return;
  trayRefreshTimer = setTimeout(() => {
    trayRefreshTimer = null;
    if (trayController) trayController.refresh();
  }, 50);
}

function traySources() {
  return {
    portal: trayPortalState,
    hostConfirms: hostOpsInlineConfirm ? hostOpsInlineConfirm.list() : [],
    harnessRuns: harnessRunner ? harnessRunner.list() : [],
    hostOpsEnabled: Boolean(hostOpsStore && hostOpsStore.isEnabled()),
    noAgents: NO_AGENTS,
    askShortcut: shortcutStatus.ask === 'ok' ? formatAccelerator(getSettings().shortcuts.ask) : '',
    askAccelerator: shortcutStatus.ask === 'ok' ? getSettings().shortcuts.ask : '',
  };
}

function showMainWindow() {
  let win = mainPortalWindow();
  if (!win) {
    createWindow();
    win = mainPortalWindow();
  }
  if (!win) return null;
  // Lasco hidden by app.hide() (background mode): unhide before showing the window.
  if (process.platform === 'darwin') app.show();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (process.platform === 'darwin') app.focus({ steal: true });
  return win;
}

/**
 * Background mode and global shortcuts (docs/background.md).
 * `isQuitting`: a real quit (⌘Q, « Quitter Lasco », update): the main window then closes for good.
 */
let isQuitting = false;
/** Last registration result per shortcut: 'ok' | 'off' | 'unavailable'. */
const shortcutStatus = Object.fromEntries(SHORTCUT_IDS.map((id) => [id, 'off']));
/** Shortcuts released while the Réglages record a new one (the keys must reach the page). */
let shortcutsSuspended = false;

/** Closing hides only with the Lasco icon (menu bar, notification area, system tray): otherwise nothing would bring Lasco back. */
function backgroundModeActive() {
  return !isQuitting && Boolean(trayController) && getSettings().keepInBackground;
}

function hideMainWindow(win = mainPortalWindow()) {
  if (!win || win.isDestroyed()) return;
  // Without the menu bar icon, a hidden window could not be found again: minimize.
  if (!trayController) {
    win.minimize();
    return;
  }
  if (win.isFullScreen()) {
    // Hiding a full-screen window leaves an empty Space: leave full screen first.
    win.once('leave-full-screen', () => {
      if (!win.isDestroyed()) hideMainWindow(win);
    });
    win.setFullScreen(false);
    return;
  }
  win.hide();
  // No other Lasco window on screen: give focus back to the previous app.
  const othersVisible = [...portalWindows.values()].some(
    (e) => e.win !== win && !e.win.isDestroyed() && e.win.isVisible()
  );
  if (process.platform === 'darwin' && !othersVisible) app.hide();
}

/** First time the window hides on close: say Lasco is still there and how to quit. */
function showBackgroundHintOnce() {
  if (getSettings().backgroundHintShown) return;
  getSettingsStore().set({ backgroundHintShown: true });
  if (!Notification.isSupported()) return;
  const quit = process.platform === 'darwin' ? '⌘Q pour quitter.' : 'Pour quitter : « Quitter Lasco » dans le menu de l’icône.';
  const hint = new Notification({
    title: 'Lasco reste ouvert',
    body: `Lasco continue dans ${trayPlaceLabel(process.platform)} : agents, validations et notifications. ${quit}`,
    silent: true,
  });
  hint.on('click', () => showMainWindow());
  hint.show();
}

/** Global shortcut « Afficher / masquer Lasco ». */
function toggleMainWindow() {
  const win = mainPortalWindow();
  if (win && win.isVisible() && !win.isMinimized() && win.isFocused()) hideMainWindow(win);
  else showMainWindow();
}

/** Global shortcut « Demander à Lasco » : Lasco devant, nouvelle conversation (même commande que le popover). */
function askLasco() {
  const win = showMainWindow();
  if (NO_AGENTS || !win || win.webContents.isDestroyed()) return;
  // Page not connected yet (login, reload): just show Lasco.
  if (!trayPortalState || !trayPortalState.canAsk) return;
  win.webContents.send('tray-command', { command: 'ask' });
}

const SHORTCUT_HANDLERS = { toggleWindow: toggleMainWindow, ask: askLasco };

/** Without agents (--no-agents), « Demander à Lasco » does not exist. */
function activeShortcutIds() {
  return SHORTCUT_IDS.filter((id) => !(NO_AGENTS && id === 'ask'));
}

/** (Re)register the global shortcuts from the settings. */
function applyGlobalShortcuts() {
  globalShortcut.unregisterAll();
  if (shortcutsSuspended) return;
  const { shortcuts } = getSettings();
  const active = activeShortcutIds();
  for (const id of SHORTCUT_IDS) {
    const accelerator = active.includes(id) ? shortcuts[id] : '';
    if (!accelerator) {
      shortcutStatus[id] = 'off';
      continue;
    }
    let ok = false;
    try {
      ok = globalShortcut.register(accelerator, SHORTCUT_HANDLERS[id]);
    } catch (_) {
      ok = false;
    }
    // false: another app already holds the combination.
    shortcutStatus[id] = ok ? 'ok' : 'unavailable';
  }
  scheduleTrayRefresh();
}

function suspendGlobalShortcuts() {
  if (shortcutsSuspended) return;
  shortcutsSuspended = true;
  globalShortcut.unregisterAll();
}

function resumeGlobalShortcuts() {
  if (!shortcutsSuspended) return;
  shortcutsSuspended = false;
  applyGlobalShortcuts();
}

function shortcutsSnapshot() {
  const { shortcuts } = getSettings();
  return activeShortcutIds().map((id) => ({
    id,
    accelerator: shortcuts[id],
    label: formatAccelerator(shortcuts[id]),
    defaultLabel: formatAccelerator(DEFAULT_SHORTCUTS[id]),
    isDefault: shortcuts[id] === DEFAULT_SHORTCUTS[id],
    status: shortcutStatus[id],
  }));
}

/** Windows: the Run key entry, with `--lasco-hidden` (same path + args to read it back). */
function windowsLoginItemOptions() {
  return { path: windowsLaunchPath(), args: [LOGIN_HIDDEN_ARG] };
}

/** Linux: XDG autostart file (Electron has no login item API there). */
function linuxAutostart() {
  return createLinuxAutostart({
    fs: require('fs'),
    dir: autostartDir({ homeDir: app.getPath('home') }),
    launchPath: linuxLaunchPath(),
  });
}

/**
 * « Ouvrir Lasco à l'ouverture de session » : l'état vient du système (modifiable aussi ailleurs :
 * Réglages Système, Gestionnaire des tâches, ~/.config/autostart).
 */
function loginItemSnapshot() {
  // In development the login item would launch the bare Electron binary.
  const off = { available: false, enabled: false, requiresApproval: false };
  if (!app.isPackaged) return off;
  try {
    if (process.platform === 'darwin') {
      const s = app.getLoginItemSettings();
      return { available: true, enabled: s.openAtLogin === true, requiresApproval: s.status === 'requires-approval' };
    }
    if (process.platform === 'win32') {
      const s = app.getLoginItemSettings(windowsLoginItemOptions());
      // Disabled in the Task Manager (« Démarrage ») : the entry exists but will not run.
      return { available: true, enabled: s.executableWillLaunchAtLogin === true, requiresApproval: false };
    }
    if (process.platform === 'linux') {
      return { available: true, enabled: linuxAutostart().isEnabled(), requiresApproval: false };
    }
  } catch (err) {
    console.warn('[login-item] read failed:', err && err.message);
  }
  return off;
}

function setOpenAtLogin(enabled) {
  if (process.platform === 'darwin') app.setLoginItemSettings({ openAtLogin: enabled });
  else if (process.platform === 'win32') app.setLoginItemSettings({ openAtLogin: enabled, ...windowsLoginItemOptions() });
  else if (process.platform === 'linux') linuxAutostart().setEnabled(enabled);
}

/** Opened by the session login with background mode on: start with the Lasco icon only. */
function openedAtLoginInBackground() {
  if (!app.isPackaged || !getSettings().keepInBackground) return false;
  if (process.platform !== 'darwin') return launchedHidden(process.argv);
  try {
    return app.getLoginItemSettings().wasOpenedAtLogin === true;
  } catch (_) {
    return false;
  }
}

function setupTray() {
  if (trayController) return;
  try {
    trayController = createTrayController({
      Tray,
      BrowserWindow,
      Menu,
      nativeImage,
      nativeTheme,
      screen,
      iconDir: path.join(__dirname, '..', 'build', 'tray'),
      getSources: traySources,
      onPortalCommand: (command, payload, { focus }) => {
        if (!TRAY_PORTAL_COMMANDS.includes(command)) return;
        const win = focus ? showMainWindow() : mainPortalWindow();
        if (!win || win.webContents.isDestroyed()) return;
        win.webContents.send('tray-command', { command, ...payload });
      },
      onNativeAction: (action) => {
        if (action === 'show-main') showMainWindow();
        else if (action === 'settings') {
          showMainWindow();
          openSettings('general');
        } else if (action === 'quit') app.quit();
        else if (action === 'pause-host-ops' && hostOpsStore) {
          hostOpsStore.setEnabled(false);
          refreshSettings();
          scheduleTrayRefresh();
        }
      },
    });
    trayController.refresh();
  } catch (err) {
    // Linux without a system tray (StatusNotifier / AppIndicator): no icon, so no background mode.
    console.warn('[tray] unavailable:', err && err.message);
    trayController = null;
  }
}

function registerWindowIPC() {

  ipcMain.handle('window-close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.close();
  });
  ipcMain.handle('window-minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.minimize();
  });
  ipcMain.handle('window-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      win.isMaximized() ? win.unmaximize() : win.maximize();
    }
  });
  ipcMain.handle('window-is-maximized', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win && !win.isDestroyed() && win.isMaximized();
  });
  ipcMain.handle('settings-get', () => getSettings());
  ipcMain.handle('settings-set-open-links-in-app', (event, enabled) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win !== mainWindowRef || typeof enabled !== 'boolean') return getSettings();
    const next = getSettingsStore().set({ openLinksInApp: enabled });
    registerLascoProtocolClient();
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('settings-changed', next);
    }
    return next;
  });
  ipcMain.handle('update-get-status', () => buildUpdateSnapshot());
  ipcMain.handle('update-check-now', async () => {
    await checkForUpdates();
    return buildUpdateSnapshot();
  });
  ipcMain.handle('update-install-now', () => {
    if (updateState.status !== 'downloaded') return false;
    quitAndInstallUpdate();
    return true;
  });

  const assertFromMainWindow = (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return Boolean(win && !win.isDestroyed() && win === mainWindowRef);
  };

  // « Fenêtre » menu: the portal shell (main frame of the main window) reports labels and checkmarks.
  ipcMain.on('app-menu-set-state', (event, state) => {
    const frame = event.senderFrame;
    if (!assertFromMainWindow(event) || !frame || frame !== event.sender.mainFrame) return;
    let origin = null;
    try {
      origin = new URL(frame.url).origin;
    } catch {
      return;
    }
    if (origin !== PORTAL_ORIGIN) return;
    const next = normalizeAppMenuState(state);
    if (JSON.stringify(next) === JSON.stringify(appMenuState)) return;
    appMenuState = next;
    installApplicationMenu();
  });

  // --- Host operations: bridge for the web app (strictly validated natively) ---
  /** Cadre principal de la fenêtre principale, chargé depuis l'origine exacte du portail. */
  const trustedPortalSender = (event) => {
    const frame = event.senderFrame;
    return isTrustedHostOpsSender({
      isMainWindow: assertFromMainWindow(event),
      isMainFrame: Boolean(frame && frame === event.sender.mainFrame),
      frameUrl: frame ? frame.url : null,
      allowedOrigins: [PORTAL_ORIGIN],
    });
  };
  const trustedHostOpsSender = (event) => !NO_AGENTS && trustedPortalSender(event);

  // --- My Drive → dossier de cet ordinateur (indépendant des agents) ---
  registerDriveSyncIpc({
    ipcMain,
    store: getDriveSyncStore(),
    fsOps: createDriveSyncFsOps({
      manifestDir: path.join(app.getPath('userData'), 'drive-sync'),
      // Stockage local en http en développement seulement.
      allowHttp: new URL(PORTAL_ORIGIN).protocol === 'http:',
    }),
    isTrustedPortalSender: trustedPortalSender,
    isFromSettings: (event) => fromSettings(event),
    pickFolder: async (current) => {
      const win = settingsSurface && settingsSurface.window ? settingsSurface.window : mainPortalWindow();
      const options = {
        title: 'Dossier de synchronisation My Drive',
        buttonLabel: 'Choisir',
        defaultPath: current || app.getPath('documents'),
        properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
      };
      const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      return res.canceled || !res.filePaths || !res.filePaths[0] ? null : res.filePaths[0];
    },
    openFolder: (folder) => void shell.openPath(folder),
    openSettings: () => openSettings('drive'),
    refreshSettings: () => refreshSettings(),
    notifyPortal: (config) => {
      const win = mainPortalWindow();
      if (win && !win.webContents.isDestroyed()) win.webContents.send('drive-sync-config-changed', config);
      refreshSettings();
    },
  });
  const forbidden = { ok: false, status: 'error', error: { code: 'forbidden', message: 'Origine non autorisée.' } };
  ipcMain.handle('host-ops-capabilities', (event) => {
    if (!trustedHostOpsSender(event)) return { available: false, enabled: false, operations: [] };
    return ensureHostOps().getCapabilities();
  });
  ipcMain.handle('host-ops-execute', (event, request) => {
    if (!trustedHostOpsSender(event)) return forbidden;
    return ensureHostOps().execute(request);
  });
  ipcMain.handle('host-ops-cancel', (event, requestId) => {
    if (!trustedHostOpsSender(event)) return forbidden;
    return ensureHostOps().cancel(requestId);
  });
  // Profil > « Cet ordinateur » : état, désactivation, révocation ; l'activation est décidée par un dialogue natif.
  const unavailable = { ok: false, error: { code: 'forbidden', message: 'Origine non autorisée.' } };
  ipcMain.handle('host-ops-web-status', (event) => {
    if (!trustedHostOpsSender(event)) return { available: false };
    return ensureHostOpsWebSettings().status();
  });
  ipcMain.handle('host-ops-web-disable', (event, feature) => {
    if (!trustedHostOpsSender(event)) return unavailable;
    return ensureHostOpsWebSettings().disable(feature);
  });
  ipcMain.handle('host-ops-web-request-enable', (event, feature) => {
    if (!trustedHostOpsSender(event)) return unavailable;
    return ensureHostOpsWebSettings().requestEnable(feature);
  });
  ipcMain.handle('host-ops-web-revoke-all', (event) => {
    if (!trustedHostOpsSender(event)) return unavailable;
    return ensureHostOpsWebSettings().revokeAll();
  });
  ipcMain.handle('host-ops-web-open-settings', (event) => {
    if (!trustedHostOpsSender(event)) return unavailable;
    return ensureHostOpsWebSettings().open();
  });
  // Chat confirmation cards: the page reports where its placeholder is; only the native card decides.
  ipcMain.on('host-ops-confirm-place', (event, message) => {
    if (!trustedHostOpsSender(event) || !hostOpsInlineConfirm || !message || typeof message !== 'object') return;
    const zoom = event.sender.getZoomFactor() || 1;
    const p = message.placement && typeof message.placement === 'object' ? message.placement : null;
    const placement = p
      ? { visible: p.visible === true, x: p.x * zoom, y: p.y * zoom, width: p.width * zoom, height: p.height * zoom }
      : null;
    hostOpsInlineConfirm.place(String(message.id || ''), placement);
  });
  ipcMain.handle('host-ops-confirm-pending', (event) => {
    if (!trustedHostOpsSender(event) || !hostOpsInlineConfirm) return [];
    return hostOpsInlineConfirm.list();
  });
  ipcMain.on('confirm-card-decide', (event, index) => {
    const card = confirmCards.get(event.sender.id);
    if (!card || event.senderFrame !== event.sender.mainFrame || !String(event.senderFrame.url).startsWith('file:')) return;
    card.onDecide(Number(index));
  });
  ipcMain.on('confirm-card-size', (event, height) => {
    const card = confirmCards.get(event.sender.id);
    if (!card) return;
    card.onSize(Number(height));
  });
  // --- Harnais de code (Claude Code, Codex, Cursor, Vibe) : même expéditeur de confiance ---
  ipcMain.handle('code-harness-status', async (event) => {
    if (!trustedHostOpsSender(event)) return { enabled: false, harnesses: [] };
    return ensureHarnessRunner().status();
  });
  ipcMain.handle('code-harness-start', (event, request) => {
    if (!trustedHostOpsSender(event)) return unavailable;
    return ensureHarnessRunner().start(request);
  });
  ipcMain.handle('code-harness-stop', (event, runId) => {
    if (!trustedHostOpsSender(event) || typeof runId !== 'string') return unavailable;
    return ensureHarnessRunner().stop(runId);
  });
  ipcMain.handle('code-harness-stop-request', (event, requestId) => {
    if (!trustedHostOpsSender(event) || typeof requestId !== 'string') return unavailable;
    return ensureHarnessRunner().stopByRequest(requestId);
  });
  ipcMain.handle('code-harness-runs', (event) => {
    if (!trustedHostOpsSender(event)) return [];
    return ensureHarnessRunner().list();
  });
  ipcMain.handle('code-harness-login', (event, harnessId) => {
    if (!trustedHostOpsSender(event) || typeof harnessId !== 'string') return unavailable;
    return ensureHarnessRunner().login(harnessId);
  });
  ipcMain.handle('code-harness-retry', (event, runId) => {
    if (!trustedHostOpsSender(event) || typeof runId !== 'string') return unavailable;
    return ensureHarnessRunner().retry(runId);
  });
  ipcMain.handle('code-harness-follow-up', (event, runId, prompt) => {
    if (!trustedHostOpsSender(event) || typeof runId !== 'string' || typeof prompt !== 'string') return unavailable;
    return ensureHarnessRunner().followUp(runId, prompt);
  });
  ipcMain.handle('code-harness-open-login', (event, harnessId) => {
    if (!trustedHostOpsSender(event) || typeof harnessId !== 'string') return unavailable;
    return openHarnessLogin(harnessId);
  });
  // --- Lasco Code workspace: portal main frame of any portal window (a Code tab can be detached) ---
  const trustedCodeSender = (event) => {
    if (NO_AGENTS) return false;
    const frame = event.senderFrame;
    return isTrustedHostOpsSender({
      isMainWindow: Boolean(portalWindowEntry(BrowserWindow.fromWebContents(event.sender))),
      isMainFrame: Boolean(frame && frame === event.sender.mainFrame),
      frameUrl: frame ? frame.url : null,
      allowedOrigins: [PORTAL_ORIGIN],
    });
  };
  ipcMain.handle('code-workspace-invoke', (event, message) => {
    if (!trustedCodeSender(event)) return forbidden;
    const m = message && typeof message === 'object' ? message : {};
    return ensureCodeWorkspace().invoke(m.method, m.payload, { webContents: event.sender });
  });
  ipcMain.on('code-terminal-input', (event, message) => {
    if (!trustedCodeSender(event) || !codeCore || !message || typeof message !== 'object') return;
    codeCore.terminals.write(event.sender, message.id, message.data);
  });
  ipcMain.on('code-terminal-resize', (event, message) => {
    if (!trustedCodeSender(event) || !codeCore || !message || typeof message !== 'object') return;
    codeCore.terminals.resize(event.sender, message.id, message.cols, message.rows);
  });

  // --- Detached tab windows (docs/tab-windows.md): portal main frame of a portal window ---
  const tabWindowSender = (event) => {
    const entry = portalWindowEntry(BrowserWindow.fromWebContents(event.sender));
    const frame = event.senderFrame;
    if (!entry || !frame || frame !== event.sender.mainFrame) return null;
    try {
      if (new URL(frame.url).origin !== PORTAL_ORIGIN) return null;
    } catch (_) {
      return null;
    }
    return entry;
  };
  const readTab = (payload) =>
    sanitizeTabDescriptor(payload && typeof payload === 'object' ? payload.tab : null, { sanitizeBrowserUrl });
  const readPoint = (payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    return Number.isFinite(p.screenX) && Number.isFinite(p.screenY)
      ? { x: Math.round(p.screenX), y: Math.round(p.screenY) }
      : null;
  };
  // The page subscribed to `tab-window-adopt`: hand it the tabs that arrived while it loaded.
  ipcMain.handle('tab-window-ready', (event) => {
    const entry = tabWindowSender(event);
    if (!entry) return { ok: false, tabs: [] };
    return { ok: true, role: entry.role, tabs: tabAdoptQueue.ready(entry.win.id) };
  });
  ipcMain.handle('tab-window-detach', (event, payload) => {
    const entry = tabWindowSender(event);
    if (!entry) return { ok: false, error: 'forbidden' };
    const tab = readTab(payload);
    if (!tab) return { ok: false, error: 'invalid-tab' };
    openDetachedTabWindow(tab, { point: readPoint(payload), sourceWindow: entry.win });
    return { ok: true, action: 'detached' };
  });
  ipcMain.handle('tab-window-attach', (event, payload) => {
    const entry = tabWindowSender(event);
    if (!entry) return { ok: false, error: 'forbidden' };
    if (entry.role === 'main') return { ok: false, error: 'already-main' };
    const tab = readTab(payload);
    if (!tab) return { ok: false, error: 'invalid-tab' };
    const target = mainPortalWindow();
    if (!target) return { ok: false, error: 'no-main-window' };
    deliverTabToWindow(target, tab);
    return { ok: true, action: 'attached' };
  });
  // Tab dragged out of its window (like Chrome): the window appears as soon as the tab leaves the
  // strip and follows the cursor; the page reports the release (`tab-window-drag-end`).
  // Only tab of a window: the window itself follows the cursor.
  const DRAG_FOLLOW_MS = 16;
  const DRAG_MAX_MS = 60_000;
  /** Tab offset in a new detached window (sidebar and Lasco AI hidden: first tab near the left). */
  const DETACHED_TAB_GRAB = { x: 150, y: 22 };
  let tabDrag = null;
  const portalWindowList = () =>
    portalWindowsFrontToBack().map((e) => ({
      id: e.win.id,
      win: e.win,
      bounds: e.win.getBounds(),
      minimized: e.win.isMinimized(),
      visible: e.win.isVisible(),
    }));
  const sendDragHover = (windowId, payload) => {
    const target = portalWindows.get(windowId);
    if (target && !target.win.isDestroyed()) target.win.webContents.send('tab-window-drag-hover', payload);
  };
  /** The window that moves with the cursor: the new window, or the source when it holds the only tab. */
  const movingWindow = (drag) => (drag.mode === 'move' ? portalWindows.get(drag.sourceId)?.win : drag.floating);
  // Hovering another Lasco window: it shows the tab in its strip (live preview) and the moving
  // window fades out, like Chrome snapping a tab into another strip.
  const updateDragHover = (drag, cursor) => {
    const target = resolveTabDropTarget({
      windows: portalWindowList(),
      point: cursor,
      sourceId: drag.sourceId,
      floatingId: drag.floating ? drag.floating.id : null,
    });
    const hoverId = target.kind === 'window' ? target.id : null;
    if (hoverId !== drag.hoverId) {
      if (drag.hoverId) sendDragHover(drag.hoverId, null);
      drag.hoverId = hoverId;
      const moving = movingWindow(drag);
      if (moving && !moving.isDestroyed()) moving.setOpacity(hoverId ? 0 : 1);
    }
    if (hoverId) {
      sendDragHover(hoverId, {
        tab: { id: drag.tab.id, kind: drag.tab.kind, title: drag.tab.title, favicon: drag.tab.favicon },
        screenX: cursor.x,
        screenY: cursor.y,
      });
    }
  };
  const stopTabDragFollow = () => {
    if (!tabDrag) return;
    clearInterval(tabDrag.timer);
    clearTimeout(tabDrag.expiry);
    if (tabDrag.hoverId) sendDragHover(tabDrag.hoverId, null);
    tabDrag.hoverId = null;
    const moving = movingWindow(tabDrag);
    if (moving && !moving.isDestroyed()) moving.setOpacity(1);
  };
  const endTabDrag = ({ keepFloating }) => {
    if (!tabDrag) return null;
    const drag = tabDrag;
    stopTabDragFollow();
    tabDrag = null;
    if (!keepFloating && drag.floating && !drag.floating.isDestroyed()) drag.floating.close();
    return drag;
  };
  const startFollowing = (win, offset) => {
    let last = null;
    const timer = setInterval(() => {
      if (win.isDestroyed()) return endTabDrag({ keepFloating: false });
      const cursor = screen.getCursorScreenPoint();
      if (last && last.x === cursor.x && last.y === cursor.y) return;
      last = cursor;
      const { x, y } = followPosition(cursor, offset);
      win.setPosition(x, y);
      if (tabDrag) updateDragHover(tabDrag, cursor);
    }, DRAG_FOLLOW_MS);
    // Safety net: a release the page never reported.
    const expiry = setTimeout(() => endTabDrag({ keepFloating: true }), DRAG_MAX_MS);
    return { timer, expiry };
  };
  ipcMain.handle('tab-window-drag-out', (event, payload) => {
    const entry = tabWindowSender(event);
    if (!entry) return { ok: false, error: 'forbidden' };
    const tab = readTab(payload);
    const point = readPoint(payload) || screen.getCursorScreenPoint();
    if (!tab) return { ok: false, error: 'invalid-tab' };
    endTabDrag({ keepFloating: false });
    const grab = payload.grabOffset && typeof payload.grabOffset === 'object' ? payload.grabOffset : {};
    if (payload.onlyTab === true) {
      const offset = {
        x: Number.isFinite(grab.x) ? Math.max(0, grab.x) : 200,
        y: Number.isFinite(grab.y) ? Math.max(0, grab.y) : 20,
      };
      tabDrag = { sourceId: entry.win.id, tab, floating: null, mode: 'move', ...startFollowing(entry.win, offset) };
      return { ok: true, mode: 'move' };
    }
    const [width, height] = entry.win.getSize();
    const pos = followPosition(point, DETACHED_TAB_GRAB);
    const floating = createWindow({
      role: 'detached',
      initialTab: tab,
      bounds: { width, height, x: pos.x, y: pos.y },
      inactive: true,
    });
    tabDrag = { sourceId: entry.win.id, tab, floating, mode: 'window', ...startFollowing(floating, DETACHED_TAB_GRAB) };
    return { ok: true, mode: 'window' };
  });
  // Back over the tab strip before release: no new window after all.
  ipcMain.handle('tab-window-drag-cancel', (event) => {
    const entry = tabWindowSender(event);
    if (!entry || !tabDrag || tabDrag.sourceId !== entry.win.id) return { ok: false };
    endTabDrag({ keepFloating: tabDrag.mode === 'move' });
    return { ok: true };
  });
  ipcMain.handle('tab-window-drag-end', (event, payload) => {
    const entry = tabWindowSender(event);
    if (!entry || !tabDrag || tabDrag.sourceId !== entry.win.id) return { ok: false, error: 'no-drag' };
    const point = readPoint(payload) || screen.getCursorScreenPoint();
    const drag = tabDrag;
    stopTabDragFollow();
    const windows = portalWindowList();
    const target = resolveTabDropTarget({
      windows,
      point,
      sourceId: drag.sourceId,
      floatingId: drag.floating ? drag.floating.id : null,
    });
    if (target.kind === 'window') {
      endTabDrag({ keepFloating: false });
      // Dropped where the preview stood: the page inserts the tab at that point of its strip.
      deliverTabToWindow(windows.find((w) => w.id === target.id).win, { ...drag.tab, dropScreenX: point.x });
      return { ok: true, action: 'attached' };
    }
    if (drag.mode === 'move') {
      endTabDrag({ keepFloating: true });
      return { ok: true, action: 'moved' };
    }
    if (target.kind === 'source') {
      endTabDrag({ keepFloating: false });
      return { ok: true, action: 'cancelled' };
    }
    const kept = endTabDrag({ keepFloating: true });
    if (kept.floating && !kept.floating.isDestroyed()) {
      kept.floating.focus();
      if (process.platform === 'darwin') kept.floating.moveTop();
    }
    return { ok: true, action: 'detached' };
  });
  // A detached window whose last tab left (closed, attached or dragged away).
  ipcMain.handle('tab-window-close', (event) => {
    const entry = tabWindowSender(event);
    if (!entry || entry.role !== 'detached') return { ok: false, error: 'forbidden' };
    setImmediate(() => {
      if (!entry.win.isDestroyed()) entry.win.close();
    });
    return { ok: true };
  });

  // --- Réglages (Desktop modal only, never reachable from web pages) ---
  const fromSettings = (event) => {
    const wc = settingsWebContents();
    return Boolean(
      wc &&
        event.sender === wc &&
        event.senderFrame === event.sender.mainFrame &&
        String(event.senderFrame.url).startsWith('file:')
    );
  };
  const fromHostOpsSettings = (event) => !NO_AGENTS && fromSettings(event);
  ipcMain.on('settings-modal-close', (event) => {
    if (fromSettings(event)) closeSettings();
  });
  ipcMain.handle('settings-modal-state', (event) => {
    if (!fromSettings(event)) return null;
    const settings = getSettings();
    let hostOps = null;
    if (!NO_AGENTS) {
      ensureHostOps();
      hostOps = {
        enabled: hostOpsStore.isEnabled(),
        shellEnabled: hostOpsStore.isShellEnabled(),
        codeEnabled: hostOpsStore.isCodeEnabled(),
        harnessEnabled: hostOpsStore.isHarnessEnabled(),
        grants: hostOpsStore.listGrants(),
        journal: hostOpsJournal.list(),
      };
    }
    return {
      general: {
        themeSource: settings.themeSource,
        openLinksInApp: settings.openLinksInApp,
        // Background mode needs the menu bar icon (macOS).
        backgroundAvailable: Boolean(trayController),
        keepInBackground: settings.keepInBackground,
        loginItem: loginItemSnapshot(),
        shortcuts: shortcutsSnapshot(),
      },
      update: buildUpdateSnapshot(),
      driveSync: driveSyncSettingsState(getDriveSyncStore()),
      hostOps,
    };
  });
  ipcMain.handle('settings-modal-set-theme', (event, value) => {
    if (!fromSettings(event) || !THEME_SOURCES.includes(value)) return false;
    getSettingsStore().set({ themeSource: value });
    nativeTheme.themeSource = value;
    return true;
  });
  ipcMain.handle('settings-modal-set-open-links', (event, enabled) => {
    if (!fromSettings(event) || typeof enabled !== 'boolean') return false;
    const next = getSettingsStore().set({ openLinksInApp: enabled });
    registerLascoProtocolClient();
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('settings-changed', next);
    }
    return true;
  });
  ipcMain.handle('settings-modal-set-keep-in-background', (event, enabled) => {
    if (!fromSettings(event) || typeof enabled !== 'boolean') return false;
    getSettingsStore().set({ keepInBackground: enabled });
    return true;
  });
  ipcMain.handle('settings-modal-set-open-at-login', (event, enabled) => {
    if (!fromSettings(event) || typeof enabled !== 'boolean' || !loginItemSnapshot().available) return false;
    try {
      setOpenAtLogin(enabled);
    } catch (err) {
      console.warn('[login-item] write failed:', err && err.message);
      return false;
    }
    return true;
  });
  // macOS 13+: the login item may wait for approval in Réglages Système > Général > Ouverture.
  ipcMain.handle('settings-modal-open-login-items', (event) => {
    if (!fromSettings(event) || process.platform !== 'darwin') return false;
    void shell.openExternal('x-apple.systempreferences:com.apple.LoginItems-Settings.extension');
    return true;
  });
  // Recording a shortcut: global shortcuts released so the keys reach the Réglages page.
  ipcMain.handle('settings-modal-shortcut-recording', (event, recording) => {
    if (!fromSettings(event) || typeof recording !== 'boolean') return false;
    if (recording) suspendGlobalShortcuts();
    else resumeGlobalShortcuts();
    return true;
  });
  /**
   * value: the recorded keystroke `{ code, ctrlKey, altKey, shiftKey, metaKey }`, '' to turn off,
   * null for the default. The accelerator is built and checked here, never taken from the page.
   */
  ipcMain.handle('settings-modal-set-shortcut', (event, id, value) => {
    if (!fromSettings(event)) return { ok: false, error: 'forbidden' };
    if (!activeShortcutIds().includes(id)) return { ok: false, error: 'invalid' };
    let next = value;
    if (value && typeof value === 'object') {
      const keystroke = acceleratorFromKeyEvent({
        code: value.code,
        ctrlKey: value.ctrlKey === true,
        altKey: value.altKey === true,
        shiftKey: value.shiftKey === true,
        metaKey: value.metaKey === true,
      });
      if (keystroke.error) return { ok: false, error: keystroke.error };
      next = keystroke.accelerator;
    } else if (!(value === null || value === '')) {
      return { ok: false, error: 'invalid' };
    }
    const result = updateShortcut(getSettings().shortcuts, id, next);
    if (!result.ok) return result;
    getSettingsStore().set({ shortcuts: result.shortcuts });
    shortcutsSuspended = false;
    applyGlobalShortcuts();
    if (shortcutStatus[id] === 'unavailable') return { ok: false, error: 'unavailable', saved: true };
    return { ok: true };
  });
  ipcMain.handle('settings-modal-update-check', async (event) => {
    if (!fromSettings(event)) return null;
    await checkForUpdates();
    return buildUpdateSnapshot();
  });
  ipcMain.handle('settings-modal-update-install', (event) => {
    if (!fromSettings(event) || updateState.status !== 'downloaded') return false;
    quitAndInstallUpdate();
    return true;
  });
  ipcMain.handle('host-ops-admin-set-shell-enabled', (event, value) => {
    if (!fromHostOpsSettings(event) || typeof value !== 'boolean') return false;
    ensureHostOps();
    return hostOpsStore.setShellEnabled(value);
  });
  ipcMain.handle('host-ops-admin-set-code-enabled', (event, value) => {
    if (!fromHostOpsSettings(event) || typeof value !== 'boolean') return false;
    ensureHostOps();
    return hostOpsStore.setCodeEnabled(value);
  });
  ipcMain.handle('host-ops-admin-set-harness-enabled', (event, value) => {
    if (!fromHostOpsSettings(event) || typeof value !== 'boolean') return false;
    ensureHostOps();
    return hostOpsStore.setHarnessEnabled(value);
  });
  ipcMain.handle('host-ops-admin-set-enabled', (event, value) => {
    if (!fromHostOpsSettings(event) || typeof value !== 'boolean') return false;
    ensureHostOps();
    return hostOpsStore.setEnabled(value);
  });
  ipcMain.handle('host-ops-admin-revoke', (event, id) => {
    if (!fromHostOpsSettings(event) || typeof id !== 'string') return false;
    ensureHostOps();
    return hostOpsStore.revokeGrant(id);
  });

  // Icône de la barre des menus : résumé du portail (cadre principal de la fenêtre principale, origine du portail).
  ipcMain.on('tray-set-state', (event, state) => {
    const frame = event.senderFrame;
    if (!assertFromMainWindow(event) || !frame || frame !== event.sender.mainFrame) return;
    let origin = null;
    try {
      origin = new URL(frame.url).origin;
    } catch {
      return;
    }
    if (origin !== PORTAL_ORIGIN) return;
    trayPortalState = normalizePortalTrayState(state);
    scheduleTrayRefresh();
  });
  ipcMain.on('tray-popover-ready', (event) => trayController && trayController.handleReady(event));
  ipcMain.on('tray-popover-size', (event, height) => trayController && trayController.handleSize(event, height));
  ipcMain.on('tray-popover-action', (event, action) => trayController && trayController.handleAction(event, action));

  ipcMain.handle('lasco-set-badge-count', (event, count) => {
    if (!assertFromMainWindow(event)) return { ok: false, error: 'forbidden' };
    return applyBadgeCount({
      app,
      platform: process.platform,
      getWindow: () => mainWindowRef,
      nativeImage,
      count,
    });
  });
  const openPushNotifications = new Map();
  let pushNotificationFailed = false;
  ipcMain.handle('lasco-notify', (event, payload) => {
    if (!assertFromMainWindow(event)) return { ok: false, error: 'forbidden' };
    return showAgentNotification({
      Notification,
      getWindow: () => BrowserWindow.fromWebContents(event.sender),
      payload,
      openNotifications: openPushNotifications,
      onFailed: () => {
        pushNotificationFailed = true;
      },
    });
  });
  ipcMain.handle('lasco-close-notification', (event, tag) => {
    if (!assertFromMainWindow(event)) return { ok: false, error: 'forbidden' };
    return closeDesktopNotification({ openNotifications: openPushNotifications, tag });
  });
  ipcMain.handle('lasco-notification-permission', (event) => {
    if (!assertFromMainWindow(event)) return { ok: false, state: 'denied' };
    return {
      ok: true,
      state: readNotificationPermission({ Notification, failed: pushNotificationFailed }),
    };
  });
  ipcMain.handle('lasco-open-notification-settings', async (event) => {
    if (!assertFromMainWindow(event)) return { ok: false, error: 'forbidden' };
    const target = notificationSettingsTarget(process.platform);
    if (!target) return { ok: false, error: 'unsupported' };
    await shell.openExternal(target);
    return { ok: true };
  });

  ipcMain.handle('browser-tab-create', (event, payload) => {
    const manager = tabManagerFor(BrowserWindow.fromWebContents(event.sender));
    if (!manager) return { ok: false, error: 'forbidden' };
    return manager.create(payload || {});
  });
  ipcMain.handle('browser-tab-navigate', (event, payload) => {
    const manager = tabManagerFor(BrowserWindow.fromWebContents(event.sender));
    if (!manager) return { ok: false, error: 'forbidden' };
    return manager.navigate(payload || {});
  });
  ipcMain.handle('browser-tab-select', (event, payload) => {
    const manager = tabManagerFor(BrowserWindow.fromWebContents(event.sender));
    if (!manager) return { ok: false, error: 'forbidden' };
    return manager.select(payload || {});
  });
  ipcMain.handle('browser-tab-hide', (event) => {
    const manager = tabManagerFor(BrowserWindow.fromWebContents(event.sender));
    if (!manager) return { ok: false, error: 'forbidden' };
    return manager.hide();
  });
  ipcMain.handle('browser-tab-close', (event, payload) => {
    const manager = tabManagerFor(BrowserWindow.fromWebContents(event.sender));
    if (!manager) return { ok: false, error: 'forbidden' };
    return manager.close(payload || {});
  });
  ipcMain.handle('browser-tab-go-back', (event, payload) => {
    const manager = tabManagerFor(BrowserWindow.fromWebContents(event.sender));
    if (!manager) return { ok: false, error: 'forbidden' };
    return manager.goBack(payload || {});
  });
  ipcMain.handle('browser-tab-go-forward', (event, payload) => {
    const manager = tabManagerFor(BrowserWindow.fromWebContents(event.sender));
    if (!manager) return { ok: false, error: 'forbidden' };
    return manager.goForward(payload || {});
  });
  ipcMain.handle('browser-tab-reload', (event, payload) => {
    const manager = tabManagerFor(BrowserWindow.fromWebContents(event.sender));
    if (!manager) return { ok: false, error: 'forbidden' };
    return manager.reload(payload || {});
  });
  ipcMain.handle('browser-tab-stop', (event, payload) => {
    const manager = tabManagerFor(BrowserWindow.fromWebContents(event.sender));
    if (!manager) return { ok: false, error: 'forbidden' };
    return manager.stop(payload || {});
  });
  ipcMain.handle('browser-tab-set-bounds', (event, payload) => {
    const manager = tabManagerFor(BrowserWindow.fromWebContents(event.sender));
    if (!manager) return { ok: false, error: 'forbidden' };
    return manager.setBounds(payload || {});
  });
  ipcMain.handle('browser-tab-get-state', (event, payload) => {
    const manager = tabManagerFor(BrowserWindow.fromWebContents(event.sender));
    if (!manager) return null;
    return manager.getState(payload || {});
  });

  ipcMain.handle('browser-tab-show-context-menu', (event, payload) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const entry = portalWindowEntry(win);
    if (!entry) return { ok: false, error: 'forbidden' };
    const p = payload && typeof payload === 'object' ? payload : {};
    const template = buildTabMenuTemplate({
      tabId: p.tabId,
      actions: resolveWindowMenuActions({
        actions: p.actions,
        windowActions: p.windowActions === true,
        role: entry.role,
        tabCount: p.tabCount,
      }),
      labels: p.labels,
      tabCount: p.tabCount,
      tabIndex: p.tabIndex,
      onAction: (action) => {
        if (!win.isDestroyed()) {
          win.webContents.send('browser-tab-context-menu-action', { tabId: p.tabId, action });
        }
      },
    });
    if (!template.length) return { ok: false, error: 'invalid-tab' };
    const opts = { window: win };
    if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
      opts.x = Math.round(p.x);
      opts.y = Math.round(p.y);
    }
    Menu.buildFromTemplate(template).popup(opts);
    return { ok: true };
  });

  const browserTabActions = {
    'browser-tab-zoom': 'zoom',
    'browser-tab-find': 'findInPage',
    'browser-tab-stop-find': 'stopFindInPage',
    'browser-tab-print': 'print',
    'browser-tab-capture': 'capture',
    'browser-tab-copy-screenshot': 'copyScreenshot',
    'browser-tab-open-external': 'openExternal',
    'browser-tab-open-devtools': 'openDevTools',
    'browser-tab-clear-data': 'clearBrowsingData',
    'browser-history-suggest': 'historySuggest',
    'browser-history-list': 'historyList',
    'browser-history-remove': 'historyRemove',
    'browser-history-clear': 'historyClear',
    'browser-tab-set-overlay': 'setOverlay',
    'browser-tab-agent-action': 'agentAction',
  };
  for (const [channel, method] of Object.entries(browserTabActions)) {
    ipcMain.handle(channel, (event, payload) => {
      const manager = tabManagerFor(BrowserWindow.fromWebContents(event.sender));
      if (!manager) return { ok: false, error: 'forbidden' };
      return manager[method](payload || {});
    });
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const url = argv.find((s) => typeof s === 'string' && s.startsWith(`${LASCO_PROTOCOL}:`));
    if (url) handleLascoDeepLink(url);
    else showMainWindow();
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleLascoDeepLink(url);
  });

  app.whenReady().then(() => {
    app.setName('Lasco');
    nativeTheme.themeSource = getSettings().themeSource;
    registerLascoProtocolClient();
    installApplicationMenu();

    const coldDeepLink = process.argv.find(
      (a) => typeof a === 'string' && a.startsWith(`${LASCO_PROTOCOL}:`)
    );
    if (coldDeepLink) handleLascoDeepLink(coldDeepLink);

    // Micro de la voix des agents : portail seulement, audio seulement (voir media-permissions.js).
    installPortalMediaPermissions(session.fromPartition('persist:portal'), {
      isPortalUrl: isPortalNavigationUrl,
      systemPreferences,
    });
    registerWindowIPC();
    setupAutoUpdater();
    nativeTheme.on('updated', updateAllIcons);
    const startHidden = openedAtLoginInBackground();
    createWindow({ hidden: startHidden });
    setupTray();
    // No icon after all (Linux without a system tray): a hidden window could not be reached.
    if (startHidden && !trayController) showMainWindow();
    applyGlobalShortcuts();

    // Dock icon: brings back the main window, hidden or closed (the tray popover is a window too).
    app.on('activate', (_event, hasVisibleWindows) => {
      if (!hasVisibleWindows || !mainPortalWindow()) showMainWindow();
    });
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('before-quit', () => {
    isQuitting = true;
    if (trayController) {
      trayController.destroy();
      trayController = null;
    }
    if (harnessPermissions) harnessPermissions.close();
    if (codeCore) {
      codeCore.terminals.killAll();
      codeCore.watchers.stopAll();
    }
    destroyAllBrowserViews();
    if (updateCheckIntervalId) {
      clearInterval(updateCheckIntervalId);
      updateCheckIntervalId = null;
    }
  });
}
