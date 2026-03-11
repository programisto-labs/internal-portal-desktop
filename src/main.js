const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const path = require('path');
const http = require('http');
const https = require('https');

// Use product name in macOS menu bar (instead of "Electron")
app.setName('Internal Portal');

const isDev = process.env.NODE_ENV === 'development';
const PORTAL_URL = isDev ? 'http://localhost:3001' : 'https://my.programisto.fr';

const AUTO_RETRY_INTERVAL_MS = 5000;

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

const ICON_DARK = path.join(__dirname, '..', 'build', 'icon-white-blackbg.png');
const ICON_LIGHT = path.join(__dirname, '..', 'build', 'icon-black.png');

function getIconPath() {
  return nativeTheme.shouldUseDarkColors ? ICON_DARK : ICON_LIGHT;
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
    title: 'Programisto Portal',
    frame: false,
    show: true,
    backgroundColor: '#000000',
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
            userAgent: win.webContents.getUserAgent() + ' ProgramistoDesktop/1.0'
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
          userAgent: win.webContents.getUserAgent() + ' ProgramistoDesktop/1.0'
        });
      }
    }
  });

  win.loadURL(PORTAL_URL, {
    userAgent: win.webContents.getUserAgent() + ' ProgramistoDesktop/1.0'
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
}

app.whenReady().then(() => {
  registerWindowIPC();
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
