const { app, BrowserWindow, ipcMain, nativeTheme, dialog } = require('electron');
const path = require('path');
const http = require('http');
const https = require('https');
const { autoUpdater } = require('electron-updater');

// Set app name as early as possible so macOS menu bar shows "Lasco" instead of "Electron" in dev
app.setName('Lasco');

const isDev = process.env.NODE_ENV === 'development';
const PORTAL_URL = isDev ? 'http://localhost:3001' : 'https://my.programisto.fr';

const AUTO_RETRY_INTERVAL_MS = 5000;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const updateState = {
  status: 'idle',
  currentVersion: app.getVersion(),
  availableVersion: null,
  downloadedVersion: null,
  progressPercent: 0,
  error: null
};

let updateCheckIntervalId = null;

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
    minWidth: 1280,
    minHeight: 720,
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
      partition: 'persist:portal'
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
          win.loadURL(PORTAL_URL, {
            userAgent:
              win.webContents.getUserAgent() +
              ' LascoDesktop/' +
              app.getVersion() +
              ' lasco-desktop/' +
              app.getVersion()
          });
        }
      }
    }, AUTO_RETRY_INTERVAL_MS);
  }

  win.on('closed', stopAutoRetry);

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
        win.loadURL(PORTAL_URL, {
          userAgent:
              win.webContents.getUserAgent() +
              ' LascoDesktop/' +
              app.getVersion() +
              ' lasco-desktop/' +
              app.getVersion()
        });
      }
    }
  });

  win.loadURL(PORTAL_URL, {
    userAgent:
              win.webContents.getUserAgent() +
              ' LascoDesktop/' +
              app.getVersion() +
              ' lasco-desktop/' +
              app.getVersion()
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://my.programisto.fr') || url.startsWith('https://programisto.fr')) {
      return { action: 'allow' };
    }
    if (isDev && (url.startsWith('http://localhost:3001') || url.startsWith('http://localhost:'))) {
      return { action: 'allow' };
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

app.whenReady().then(() => {
  // Use product name in macOS menu bar (instead of "Electron") — must be set when ready in dev
  app.setName('Lasco');
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
