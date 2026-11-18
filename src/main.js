const { app, BrowserWindow, WebContentsView, ipcMain, nativeImage, nativeTheme, dialog, shell, Menu, Notification } = require('electron');
const path = require('path');
const http = require('http');
const https = require('https');
const { autoUpdater } = require('electron-updater');
const { createBrowserTabManager } = require('./browser-tabs/manager');
const { sanitizeBrowserUrl } = require('./browser-tabs/url');
const { createSettingsStore, extractPortalTarget, buildBrowserOpenRequest } = require('./link-handling');
const { buildTabMenuTemplate } = require('./browser-tabs/tab-menu');
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
const { HARNESSES } = require('./code-harness/harnesses');
const { getLoginEnv } = require('./code-workspace/login-env');
const { createGitRunner } = require('./code-workspace/git');
const { createProjectStore } = require('./code-workspace/projects');
const { createFileOps } = require('./code-workspace/files');
const { createTerminalManager } = require('./code-workspace/terminals');
const { createWatcherManager } = require('./code-workspace/watcher');
const { createCodeWorkspaceService } = require('./code-workspace/service');
const { createCodeAgentOps } = require('./code-workspace/agent-ops');

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

/**
 * Replace Electron's default menu so ⌘W is not bound to Close Window.
 * Without this, the macOS default accelerator closes the app before our tab handler runs.
 */
function installApplicationMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac
      ? [
          {
            role: 'appMenu',
            ...(NO_AGENTS
              ? {}
              : {
                  submenu: [
                    { role: 'about', label: 'À propos de Lasco' },
                    { type: 'separator' },
                    {
                      label: 'Réglages…',
                      accelerator: 'CmdOrCtrl+,',
                      click: () => openHostOpsSettings(),
                    },
                    { type: 'separator' },
                    { role: 'services', label: 'Services' },
                    { type: 'separator' },
                    { role: 'hide', label: 'Masquer Lasco' },
                    { role: 'hideOthers', label: 'Masquer les autres' },
                    { role: 'unhide', label: 'Tout afficher' },
                    { type: 'separator' },
                    { role: 'quit', label: 'Quitter Lasco' },
                  ],
                }),
          },
        ]
      : []),
    {
      label: 'Fichier',
      submenu: [
        {
          label: "Fermer l'onglet",
          accelerator: 'CmdOrCtrl+W',
          click: (_item, browserWindow) => sendCloseActiveTab(browserWindow),
        },
        {
          label: 'Fermer la fenêtre',
          accelerator: 'CmdOrCtrl+Shift+W',
          click: (_item, browserWindow) => {
            const win = getTargetMainWindow(browserWindow);
            if (win) win.close();
          },
        },
        // macOS : Lasco > Réglages… (⌘,). Ailleurs : Fichier > Réglages… (Ctrl+,).
        ...(NO_AGENTS || isMac
          ? []
          : [
              { type: 'separator' },
              { label: 'Réglages…', accelerator: 'CmdOrCtrl+,', click: () => openHostOpsSettings() },
            ]),
        ...(isMac
          ? []
          : [
              { type: 'separator' },
              { role: 'quit', label: 'Quitter' },
            ]),
      ],
    },
    { role: 'editMenu', label: 'Édition' },
    { role: 'viewMenu', label: 'Présentation' },
    {
      label: 'Fenêtre',
      submenu: [
        { role: 'minimize', label: 'Réduire' },
        { role: 'zoom', label: 'Zoom' },
        ...(isMac
          ? [{ type: 'separator' }, { role: 'front', label: 'Tout ramener au premier plan' }]
          : []),
      ],
    },
  ];
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
/** @type {ReturnType<typeof createBrowserTabManager> | null} */
let browserTabManager = null;
/** @type {ReturnType<typeof createSettingsStore> | null} */
let settingsStore = null;

function getSettingsStore() {
  if (!settingsStore) {
    settingsStore = createSettingsStore(path.join(app.getPath('userData'), 'settings.json'));
  }
  return settingsStore;
}

/** Host operations (agent file ops on this computer). Disabled until enabled in Desktop options. */
let hostOpsStore = null;
let hostOpsJournal = null;
let hostOpsService = null;
let hostOpsSettingsWin = null;
let hostOpsWebSettings = null;
let hostOpsInlineConfirm = null;
let harnessRunner = null;

/** Événements d'une exécution de harnais vers le portail (cadre principal, origine du portail seulement). */
function sendHarnessEvent(event) {
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
    harnessRunner = createHarnessRunner({
      isEnabled: () => hostOpsStore.isHarnessEnabled(),
      getProject: (userId, projectId) => core.projects.get(userId, projectId),
      getEnv: () => getLoginEnv(),
      emit: sendHarnessEvent,
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
          () => (mainWindowRef && !mainWindowRef.isDestroyed() ? mainWindowRef : null)
        )
      ).confirm,
    });
  }
  return hostOpsService;
}

function openHostOpsSettings() {
  ensureHostOps();
  if (hostOpsSettingsWin && !hostOpsSettingsWin.isDestroyed()) {
    hostOpsSettingsWin.focus();
    return;
  }
  hostOpsSettingsWin = new BrowserWindow({
    width: 760,
    height: 620,
    title: 'Réglages — Cet ordinateur',
    webPreferences: {
      preload: path.join(__dirname, 'host-ops', 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  hostOpsSettingsWin.webContents.on('will-navigate', (e) => e.preventDefault());
  hostOpsSettingsWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  hostOpsSettingsWin.loadFile(path.join(__dirname, 'host-ops', 'settings.html'));
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

function openExternalAsBrowserTab(urlString) {
  const safe = sanitizeBrowserUrl(urlString);
  if (!safe) return false;
  const win = mainWindowRef;
  if (!win || win.isDestroyed() || !browserTabManager) return false;
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
    autoUpdater.quitAndInstall(false, true);
  }
}

function isUpdaterEnabled() {
  return app.isPackaged;
}

async function checkForUpdates() {
  if (!isUpdaterEnabled()) return;
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    setUpdateState({
      status: 'error',
      error: error?.message || 'Update check failed.'
    });
  }
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
    setUpdateState({
      status: 'error',
      error: error?.message || 'Auto-update failed.'
    });
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

function ensureBrowserTabManager() {
  if (!browserTabManager) {
    browserTabManager = createBrowserTabManager({
      getMainWindow: () => mainWindowRef,
      interceptLink: routePortalLinkInApp,
    });
  }
  return browserTabManager;
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
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  const win = wins[0];
  if (win) {
    win.webContents.send('open-portal-tab', target);
    win.focus();
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

function createWindow() {
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
    /* Compact floor ~ Spotify desktop; sidebar auto-collapses in the web shell below ~1100px. */
    minWidth: 800,
    minHeight: 500,
    title: 'Lasco',
    frame: false,
    show: true,
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
      additionalArguments: [
        `${APP_VERSION_ARG_PREFIX}${app.getVersion()}`,
        `${PORTAL_ORIGIN_ARG_PREFIX}${PORTAL_ORIGIN}`,
        ...(NO_AGENTS ? [NO_AGENTS_ARG] : []),
      ]
    },
    ...(iconPath && { icon: iconPath })
  });

  if (process.platform === 'darwin' && app.dock && iconPath) {
    setIconSafe(app.dock, iconPath);
  }

  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
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

  mainWindowRef = win;
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
  win.on('closed', () => {
    releaseCodeWorkspace();
    stopAutoRetry();
    if (browserTabManager) {
      browserTabManager.destroyAll();
    }
    if (mainWindowRef === win) {
      mainWindowRef = null;
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
      if (!openExternalAsBrowserTab(url)) {
        openUrlInDefaultBrowser(url);
      }
    }
  });

  const initialUrl = pendingInitialPortalFullUrl || PORTAL_URL;
  pendingInitialPortalFullUrl = null;
  loadMainPortalUrl(win, initialUrl);

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
    if (!openExternalAsBrowserTab(url)) {
      openUrlInDefaultBrowser(url);
    }
    return { action: 'deny' };
  });
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

function registerWindowIPC() {
  ensureBrowserTabManager();

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
    autoUpdater.quitAndInstall(false, true);
    return true;
  });

  const assertFromMainWindow = (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return Boolean(win && !win.isDestroyed() && win === mainWindowRef);
  };

  // --- Host operations: bridge for the web app (strictly validated natively) ---
  const trustedHostOpsSender = (event) => {
    if (NO_AGENTS) return false;
    const frame = event.senderFrame;
    return isTrustedHostOpsSender({
      isMainWindow: assertFromMainWindow(event),
      isMainFrame: Boolean(frame && frame === event.sender.mainFrame),
      frameUrl: frame ? frame.url : null,
      allowedOrigins: [PORTAL_ORIGIN],
    });
  };
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
  ipcMain.handle('code-harness-open-login', (event, harnessId) => {
    if (!trustedHostOpsSender(event) || typeof harnessId !== 'string') return unavailable;
    return openHarnessLogin(harnessId);
  });
  // --- Lasco Code workspace: same trusted sender as host operations (portal main frame) ---
  ipcMain.handle('code-workspace-invoke', (event, message) => {
    if (!trustedHostOpsSender(event)) return forbidden;
    const m = message && typeof message === 'object' ? message : {};
    return ensureCodeWorkspace().invoke(m.method, m.payload, { webContents: event.sender });
  });
  ipcMain.on('code-terminal-input', (event, message) => {
    if (!trustedHostOpsSender(event) || !codeCore || !message || typeof message !== 'object') return;
    codeCore.terminals.write(event.sender, message.id, message.data);
  });
  ipcMain.on('code-terminal-resize', (event, message) => {
    if (!trustedHostOpsSender(event) || !codeCore || !message || typeof message !== 'object') return;
    codeCore.terminals.resize(event.sender, message.id, message.cols, message.rows);
  });

  // --- Host operations: local options window only (never reachable from web pages) ---
  const fromHostOpsSettings = (event) =>
    Boolean(
      hostOpsSettingsWin &&
        !hostOpsSettingsWin.isDestroyed() &&
        event.sender === hostOpsSettingsWin.webContents &&
        event.senderFrame === event.sender.mainFrame &&
        String(event.senderFrame.url).startsWith('file:')
    );
  ipcMain.handle('host-ops-admin-state', (event) => {
    if (!fromHostOpsSettings(event)) return { enabled: false, shellEnabled: false, codeEnabled: false, grants: [], journal: [] };
    ensureHostOps();
    return {
      enabled: hostOpsStore.isEnabled(),
      shellEnabled: hostOpsStore.isShellEnabled(),
      codeEnabled: hostOpsStore.isCodeEnabled(),
      harnessEnabled: hostOpsStore.isHarnessEnabled(),
      grants: hostOpsStore.listGrants(),
      journal: hostOpsJournal.list(),
    };
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
    if (!assertFromMainWindow(event)) return { ok: false, error: 'forbidden' };
    return ensureBrowserTabManager().create(payload || {});
  });
  ipcMain.handle('browser-tab-navigate', (event, payload) => {
    if (!assertFromMainWindow(event)) return { ok: false, error: 'forbidden' };
    return ensureBrowserTabManager().navigate(payload || {});
  });
  ipcMain.handle('browser-tab-select', (event, payload) => {
    if (!assertFromMainWindow(event)) return { ok: false, error: 'forbidden' };
    return ensureBrowserTabManager().select(payload || {});
  });
  ipcMain.handle('browser-tab-hide', (event) => {
    if (!assertFromMainWindow(event)) return { ok: false, error: 'forbidden' };
    return ensureBrowserTabManager().hide();
  });
  ipcMain.handle('browser-tab-close', (event, payload) => {
    if (!assertFromMainWindow(event)) return { ok: false, error: 'forbidden' };
    return ensureBrowserTabManager().close(payload || {});
  });
  ipcMain.handle('browser-tab-go-back', (event, payload) => {
    if (!assertFromMainWindow(event)) return { ok: false, error: 'forbidden' };
    return ensureBrowserTabManager().goBack(payload || {});
  });
  ipcMain.handle('browser-tab-go-forward', (event, payload) => {
    if (!assertFromMainWindow(event)) return { ok: false, error: 'forbidden' };
    return ensureBrowserTabManager().goForward(payload || {});
  });
  ipcMain.handle('browser-tab-reload', (event, payload) => {
    if (!assertFromMainWindow(event)) return { ok: false, error: 'forbidden' };
    return ensureBrowserTabManager().reload(payload || {});
  });
  ipcMain.handle('browser-tab-stop', (event, payload) => {
    if (!assertFromMainWindow(event)) return { ok: false, error: 'forbidden' };
    return ensureBrowserTabManager().stop(payload || {});
  });
  ipcMain.handle('browser-tab-set-bounds', (event, payload) => {
    if (!assertFromMainWindow(event)) return { ok: false, error: 'forbidden' };
    return ensureBrowserTabManager().setBounds(payload || {});
  });
  ipcMain.handle('browser-tab-get-state', (event, payload) => {
    if (!assertFromMainWindow(event)) return null;
    return ensureBrowserTabManager().getState(payload || {});
  });

  ipcMain.handle('browser-tab-show-context-menu', (event, payload) => {
    if (!assertFromMainWindow(event)) return { ok: false, error: 'forbidden' };
    const win = getTargetMainWindow();
    const p = payload && typeof payload === 'object' ? payload : {};
    if (!win) return { ok: false, error: 'no-window' };
    const template = buildTabMenuTemplate({
      tabId: p.tabId,
      actions: p.actions,
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
      if (!assertFromMainWindow(event)) return { ok: false, error: 'forbidden' };
      return ensureBrowserTabManager()[method](payload || {});
    });
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const url = argv.find((s) => typeof s === 'string' && s.startsWith(`${LASCO_PROTOCOL}:`));
    if (url) handleLascoDeepLink(url);
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleLascoDeepLink(url);
  });

  app.whenReady().then(() => {
    app.setName('Lasco');
    registerLascoProtocolClient();
    installApplicationMenu();

    const coldDeepLink = process.argv.find(
      (a) => typeof a === 'string' && a.startsWith(`${LASCO_PROTOCOL}:`)
    );
    if (coldDeepLink) handleLascoDeepLink(coldDeepLink);

    registerWindowIPC();
    setupAutoUpdater();
    nativeTheme.on('updated', updateAllIcons);
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('before-quit', () => {
    if (codeCore) {
      codeCore.terminals.killAll();
      codeCore.watchers.stopAll();
    }
    if (browserTabManager) {
      browserTabManager.destroyAll();
    }
    if (updateCheckIntervalId) {
      clearInterval(updateCheckIntervalId);
      updateCheckIntervalId = null;
    }
  });
}
