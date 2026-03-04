const { app, BrowserWindow, nativeTheme } = require('electron');
const path = require('path');

const PORTAL_URL = 'https://my.programisto.fr';

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

  win.loadURL(PORTAL_URL, {
    userAgent: win.webContents.getUserAgent() + ' ProgramistoDesktop/1.0'
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://my.programisto.fr') || url.startsWith('https://programisto.fr')) {
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

app.whenReady().then(() => {
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
