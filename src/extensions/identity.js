'use strict';

/**
 * `chrome.identity.launchWebAuthFlow` (docs/extensions.md) : fenêtre de connexion dans la session
 * de l'extension, fermée dès que le fournisseur redirige vers `https://<id>.chromiumapp.org/…` ;
 * cette adresse est rendue à l'extension (jamais chargée).
 *
 * `getAuthToken` (compte Google connecté au navigateur) n'existe pas hors de Chrome.
 */

const AUTH_TIMEOUT_MS = 10 * 60 * 1000;

function isRedirectFor(extensionId, url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === `${extensionId}.chromiumapp.org`;
  } catch (_) {
    return false;
  }
}

function launchWebAuthFlow({ electron, session, extension, details }) {
  const { BrowserWindow } = electron;
  const extensionId = extension && extension.id;
  const url = details && details.url;
  if (!extensionId) return Promise.reject(new Error('Unknown extension.'));
  let start;
  try {
    start = new URL(String(url));
  } catch (_) {
    return Promise.reject(new Error('Authorization page could not be loaded.'));
  }
  if (start.protocol !== 'https:' && start.protocol !== 'http:') {
    return Promise.reject(new Error('Authorization page could not be loaded.'));
  }
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: 520,
      height: 720,
      show: details.interactive !== false,
      title: extension.name,
      autoHideMenuBar: true,
      webPreferences: { session, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!win.isDestroyed()) win.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Authorization timed out.')), AUTH_TIMEOUT_MS);
    const intercept = (event, target) => {
      if (!isRedirectFor(extensionId, target)) return;
      event.preventDefault();
      finish(null, target);
    };
    win.webContents.on('will-navigate', intercept);
    win.webContents.on('will-redirect', intercept);
    win.webContents.on('did-fail-load', (_event, _code, _desc, failedUrl, isMainFrame) => {
      if (isMainFrame && isRedirectFor(extensionId, failedUrl)) finish(null, failedUrl);
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.on('closed', () => finish(new Error('The user did not approve access.')));
    win.loadURL(start.toString()).catch(() => {
      if (details.interactive === false) finish(new Error('User interaction required.'));
    });
  });
}

module.exports = { launchWebAuthFlow, isRedirectFor };
