'use strict';

/**
 * Panneau « Responsive » des DevTools des onglets web (docs/devtools-responsive.md).
 *
 * - L'extension `devtools-extension/` ajoute l'onglet « Responsive » aux DevTools des onglets
 *   web (session `persist:browser-tabs` seulement : jamais les pages du portail).
 * - Son service worker relaie les réglages à Desktop par `lasco-devtools-responsive`, grâce au
 *   preload de service worker `devtools-responsive-preload.js`. Desktop ne répond qu'au
 *   service worker de cette extension, et seulement pour un onglet web dont les DevTools sont
 *   ouverts.
 * - Chaque onglet émulé a un contrôleur (`createTabResponsive`) : vue réduite et centrée sur
 *   un fond gris, émulation par le protocole DevTools (taille, densité, tactile, identité).
 */

const path = require('path');
const fs = require('fs');
const { WebContentsView } = require('electron');
const {
  normalizeResponsiveSettings,
  responsiveLayout,
  deviceUserAgent,
  deviceMetrics,
  publicDevices,
  DEFAULT_SETTINGS,
  DEVICE_SCALE_FACTORS,
  ZOOMS,
} = require('./responsive');

const IPC_CHANNEL = 'lasco-devtools-responsive';

/** Fichiers lus par Chromium (extension) : hors de l'archive asar une fois empaquetés. */
function unpackedPath(file) {
  const unpacked = file.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  return unpacked !== file && fs.existsSync(unpacked) ? unpacked : file;
}

const EXTENSION_DIR = unpackedPath(path.join(__dirname, 'devtools-extension'));
const SW_PRELOAD = unpackedPath(path.join(__dirname, 'devtools-responsive-preload.js'));

/** webContents id d'un onglet web → (message) => réponse. Une route par onglet, toutes fenêtres. */
const routes = new Map();
const installedSessions = new WeakSet();

function registerResponsiveRoute(webContentsId, handler) {
  routes.set(webContentsId, handler);
}

function unregisterResponsiveRoute(webContentsId) {
  routes.delete(webContentsId);
}

async function routeMessage(message) {
  if (!message || typeof message !== 'object') return { ok: false, error: 'invalid' };
  const handler = routes.get(Number(message.tabId));
  if (!handler) return { ok: false, error: 'unknown-tab' };
  return handler(message);
}

/**
 * Charge l'extension dans la session des onglets web, une fois. Erreurs avalées : sans
 * extension, les DevTools restent ceux d'Electron, sans l'onglet « Responsive ».
 */
async function installDevtoolsResponsive(browserSession) {
  if (!browserSession || installedSessions.has(browserSession)) return;
  installedSessions.add(browserSession);
  try {
    browserSession.registerPreloadScript({ type: 'service-worker', id: 'lasco-devtools-responsive', filePath: SW_PRELOAD });
    const extension = await browserSession.extensions.loadExtension(EXTENSION_DIR);
    const workers = browserSession.serviceWorkers;
    const wire = (versionId) => {
      const worker = workers.getWorkerFromVersionID(versionId);
      if (!worker || worker.scope !== extension.url) return;
      worker.ipc.removeHandler(IPC_CHANNEL);
      worker.ipc.handle(IPC_CHANNEL, (event, message) => {
        if (!event.serviceWorker || event.serviceWorker.scope !== extension.url) return { ok: false, error: 'forbidden' };
        return routeMessage(message);
      });
    };
    workers.on('running-status-changed', ({ versionId, runningStatus }) => {
      if (runningStatus === 'starting' || runningStatus === 'running') wire(versionId);
    });
  } catch (error) {
    console.warn('[browser-tabs] responsive devtools panel unavailable:', error && error.message);
  }
}

/**
 * Fond gris autour de l'appareil. Une `View` nue ne peint pas sa couleur sur macOS : petite
 * page statique, sans JavaScript, qui suit le thème clair / sombre du système.
 */
const BACKDROP_URL = `data:text/html;charset=utf-8,${encodeURIComponent(
  '<!doctype html><style>html{background:#dadce0}@media (prefers-color-scheme:dark){html{background:#1f1f1f}}</style>',
)}`;

function createBackdropView() {
  const backdrop = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, spellcheck: false },
  });
  const wc = backdrop.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (event) => event.preventDefault());
  void wc.loadURL(BACKDROP_URL).catch(() => {});
  return backdrop;
}

/**
 * Émulation d'un onglet. `restoreIdentity()` rend l'identité Chrome de bureau de Lasco
 * (même commande qu'à la création de l'onglet).
 */
function createTabResponsive({ view, getWindow, restoreIdentity }) {
  const wc = view.webContents;
  let settings = null;
  let scale = 1;
  let lastSentScale = null;
  let backdrop = null;
  const nativeSetVisible = view.setVisible;

  const send = (method, params) => {
    if (wc.isDestroyed()) return Promise.resolve();
    const dbg = wc.debugger;
    try {
      if (!dbg.isAttached()) dbg.attach('1.3');
    } catch (_) {
      return Promise.resolve();
    }
    return dbg.sendCommand(method, params).catch((error) => {
      console.warn(`[browser-tabs] ${method} failed:`, error && error.message);
    });
  };

  function ensureBackdrop() {
    if (backdrop) return backdrop;
    backdrop = createBackdropView();
    backdrop.setVisible(false);
    // La vue de l'onglet et son fond sont toujours visibles ensemble.
    view.setVisible = (visible) => {
      nativeSetVisible.call(view, visible);
      if (backdrop) backdrop.setVisible(Boolean(visible));
    };
    const win = getWindow();
    if (win && !win.isDestroyed() && win.contentView.children.includes(view)) {
      win.contentView.addChildView(backdrop);
      win.contentView.addChildView(view);
    }
    return backdrop;
  }

  function removeBackdrop() {
    if (!backdrop) return;
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      try {
        win.contentView.removeChildView(backdrop);
      } catch (_) {
        // already detached
      }
    }
    if (!backdrop.webContents.isDestroyed()) backdrop.webContents.close();
    backdrop = null;
    view.setVisible = nativeSetVisible;
  }

  function sendMetrics() {
    if (!settings || lastSentScale === scale) return;
    lastSentScale = scale;
    void send('Emulation.setDeviceMetricsOverride', deviceMetrics(settings, scale));
  }

  return {
    active: () => Boolean(settings),
    /** Zone de l'onglet → place de la vue. Appelé par `applyBounds` quand le mode est actif. */
    layout(area) {
      const result = responsiveLayout(area, settings);
      scale = result.scale;
      view.setBounds(result.bounds);
      if (backdrop) {
        backdrop.setBounds({
          x: Math.round(area.x),
          y: Math.round(area.y),
          width: Math.round(area.width),
          height: Math.round(area.height),
        });
      }
      sendMetrics();
      return result.bounds;
    },
    /** La vue est (re)mise dans la fenêtre : son fond passe juste dessous. */
    attachTo(win) {
      if (backdrop && win && !win.isDestroyed()) win.contentView.addChildView(backdrop);
    },
    detachFrom(win) {
      if (backdrop && win && !win.isDestroyed()) {
        try {
          win.contentView.removeChildView(backdrop);
        } catch (_) {
          // already detached
        }
      }
    },
    state() {
      return {
        ok: true,
        active: Boolean(settings),
        settings: settings || normalizeResponsiveSettings(DEFAULT_SETTINGS),
        scale,
        devices: publicDevices(),
        deviceScaleFactors: DEVICE_SCALE_FACTORS,
        zooms: ZOOMS,
      };
    },
    async set(input) {
      const previousDevice = settings ? settings.device : null;
      settings = normalizeResponsiveSettings(input);
      lastSentScale = null;
      const touch = settings.mobile;
      ensureBackdrop();
      await send('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: touch ? 5 : 1 });
      await send('Emulation.setEmitTouchEventsForMouse', { enabled: touch, configuration: touch ? 'mobile' : 'desktop' });
      if (previousDevice !== settings.device) {
        const identity = deviceUserAgent(settings.device);
        if (identity) await send('Emulation.setUserAgentOverride', identity);
        else if (previousDevice) await restoreIdentity();
      }
    },
    async off() {
      if (!settings) return;
      const hadIdentity = Boolean(deviceUserAgent(settings.device));
      settings = null;
      scale = 1;
      lastSentScale = null;
      removeBackdrop();
      await send('Emulation.clearDeviceMetricsOverride');
      await send('Emulation.setTouchEmulationEnabled', { enabled: false });
      await send('Emulation.setEmitTouchEventsForMouse', { enabled: false });
      if (hadIdentity) await restoreIdentity();
    },
    dispose() {
      settings = null;
      removeBackdrop();
    },
  };
}

module.exports = {
  IPC_CHANNEL,
  installDevtoolsResponsive,
  registerResponsiveRoute,
  unregisterResponsiveRoute,
  routeMessage,
  createTabResponsive,
};
