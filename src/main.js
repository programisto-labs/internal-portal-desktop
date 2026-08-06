const { app, BrowserWindow, ipcMain, nativeTheme, dialog, shell } = require('electron');
const path = require('path');
const http = require('http');
const https = require('https');
const { autoUpdater } = require('electron-updater');

// Set app name as early as possible so macOS menu bar shows "Lasco" instead of "Electron" in dev
app.setName('Lasco');

const isDev = process.env.NODE_ENV === 'development';
const PORTAL_URL = isDev ? 'http://localhost:3001/' : 'https://app.lascoapp.com';

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
    if (isDev && u.protocol === 'http:' && u.hostname === 'localhost') {
      return true;
    }
    if (u.protocol === 'https:') {
      const host = u.hostname;
      return (
        host === 'my.programisto.fr' ||
        host === 'programisto.fr' ||
        host.endsWith('.programisto.fr')
      );
    }
    return false;
  } catch (_) {
    return false;
  }
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
    app.getVersion()
  );
}

function loadMainPortalUrl(win, urlString) {
  if (win.isDestroyed()) return;
  win.loadURL(urlString, {
    userAgent: buildLascoDesktopUserAgent(win.webContents.getUserAgent())
  });
}

function parseLascoOpenTarget(urlString) {
  try {
    const u = new URL(urlString);
    if (u.protocol !== `${LASCO_PROTOCOL}:`) return null;
    const target = u.searchParams.get('target');
    if (!target || !target.startsWith('/')) return null;
    return target;
  } catch (_) {
    return null;
  }
}

function handleLascoDeepLink(urlString) {
  const target = parseLascoOpenTarget(urlString);
  if (!target) return;
  const full = PORTAL_URL.replace(/\/$/, '') + target;
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  const win = wins[0];
  if (win) {
    loadMainPortalUrl(win, full);
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

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    /* Compact floor ~ Spotify desktop; sidebar auto-collapses in the web shell below ~1100px. */
    minWidth: 800,
    minHeight: 500,
    title: 'Lasco',
    frame: false,
    show: true,
    backgroundColor: '#000000',
    /* Native close / minimize / zoom — visible even if the web preload bridge is late or missing */
    ...(process.platform === 'darwin' && {
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 16, y: 18 },
    }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      partition: 'persist:portal',
      additionalArguments: [`${APP_VERSION_ARG_PREFIX}${app.getVersion()}`]
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
  win.on('closed', () => {
    stopAutoRetry();
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
    if (!isPortalNavigationUrl(url)) {
      event.preventDefault();
      openUrlInDefaultBrowser(url);
    }
  });

  const initialUrl = pendingInitialPortalFullUrl || PORTAL_URL;
  pendingInitialPortalFullUrl = null;
  loadMainPortalUrl(win, initialUrl);

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isPortalNavigationUrl(url)) {
      return { action: 'allow' };
    }
    openUrlInDefaultBrowser(url);
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
    if (updateCheckIntervalId) {
      clearInterval(updateCheckIntervalId);
      updateCheckIntervalId = null;
    }
  });
}
