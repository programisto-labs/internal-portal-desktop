'use strict';

/**
 * Panneau « Responsive » des DevTools des onglets web (docs/devtools-responsive.md).
 *
 * - L'extension `devtools-extension/` ajoute l'onglet « Responsive » aux DevTools des onglets
 *   web (session `persist:browser-tabs` seulement : jamais les pages du portail). Pas de
 *   service worker ni de script injecté : rien ne tourne tant que les DevTools sont fermés.
 * - Le panneau envoie ses réglages dans un seul sens, en console (`MESSAGE_PREFIX`). Desktop ne
 *   lit que la console des DevTools de l'onglet, et seulement les messages du cadre de
 *   l'extension (origine `chrome-extension://<id>`) : une page web ne peut pas en écrire.
 *   L'onglet visé est celui de ces DevTools : le panneau ne le nomme pas.
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
} = require('./responsive');

const MESSAGE_PREFIX = '__lasco_responsive__';
/** Taille maximale d'un message du panneau (caractères). */
const MAX_MESSAGE_LENGTH = 2000;

/** Fichiers lus par Chromium (extension) : hors de l'archive asar une fois empaquetés. */
function unpackedPath(file) {
  const unpacked = file.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  return unpacked !== file && fs.existsSync(unpacked) ? unpacked : file;
}

const EXTENSION_DIR = unpackedPath(path.join(__dirname, 'devtools-extension'));

/** Extension déjà chargée dans cette session (l'objet `Session` d'un webContents peut différer). */
function loadedExtension(browserSession) {
  const extensions = browserSession.extensions.getAllExtensions();
  return extensions.find((extension) => extension.path === EXTENSION_DIR) || null;
}

const loading = new WeakMap();

/** `new URL('chrome-extension://…').origin` vaut « null » dans Node : origine construite à la main. */
function extensionOrigin(extension) {
  return `chrome-extension://${extension.id}`;
}

/**
 * Charge l'extension dans la session des onglets web, une fois, et renvoie son origine
 * (null si elle n'a pas pu être chargée). Erreurs avalées : sans extension, les DevTools
 * restent ceux d'Electron, sans l'onglet « Responsive ».
 */
async function installDevtoolsResponsive(browserSession) {
  if (!browserSession) return null;
  const loaded = loadedExtension(browserSession);
  if (loaded) return extensionOrigin(loaded);
  if (!loading.has(browserSession)) {
    loading.set(
      browserSession,
      browserSession.extensions.loadExtension(EXTENSION_DIR).catch((error) => {
        const again = loadedExtension(browserSession);
        if (again) return again;
        console.warn('[browser-tabs] responsive devtools panel unavailable:', error && error.message);
        return null;
      }),
    );
  }
  const extension = await loading.get(browserSession);
  return extension ? extensionOrigin(extension) : null;
}

/** Message de console → réglages du panneau, ou null (autre message, illisible, trop long). */
function parsePanelMessage(text) {
  const raw = String(text || '');
  if (!raw.startsWith(MESSAGE_PREFIX) || raw.length > MAX_MESSAGE_LENGTH) return null;
  try {
    const message = JSON.parse(raw.slice(MESSAGE_PREFIX.length));
    if (!message || typeof message !== 'object') return null;
    if (message.op === 'off') return { op: 'off' };
    if (message.op === 'set' && message.settings && typeof message.settings === 'object') {
      return { op: 'set', settings: message.settings };
    }
  } catch (_) {
    // ignoré
  }
  return null;
}

/**
 * Écoute le panneau dans les DevTools de `wc` pendant qu'ils sont ouverts. `onMessage` reçoit
 * `{ op: 'set', settings }` ou `{ op: 'off' }`, dans l'ordre d'envoi.
 */
function watchDevtoolsResponsive(wc, onMessage) {
  wc.on('devtools-opened', async () => {
    const devtools = wc.devToolsWebContents;
    if (!devtools || devtools.isDestroyed()) return;
    const origin = await installDevtoolsResponsive(wc.session);
    if (!origin || devtools.isDestroyed()) return;
    let queue = Promise.resolve();
    devtools.on('console-message', (event) => {
      const frame = event.frame;
      if (!frame || frame.origin !== origin) return;
      const message = parsePanelMessage(event.message);
      if (!message) return;
      queue = queue.then(() => onMessage(message)).catch((error) => {
        console.warn('[browser-tabs] responsive message failed:', error && error.message);
      });
    });
  });
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
  MESSAGE_PREFIX,
  installDevtoolsResponsive,
  parsePanelMessage,
  watchDevtoolsResponsive,
  createTabResponsive,
};
