'use strict';

const {
  app,
  BrowserWindow,
  WebContentsView,
  nativeImage,
  session,
  clipboard,
  ClipboardItem,
  shell,
  dialog,
  Menu,
  nativeTheme,
  net,
  systemPreferences,
} = require('electron');
const { sanitizeBrowserUrl } = require('./url');
const { ensureSystemMediaAccess } = require('../media-permissions');
const {
  createSitePermissionStore,
  installSitePermissions,
  describeSitePermissions,
  permissionPolicy,
  siteOrigin,
  siteHost,
} = require('./site-permissions');
const {
  ERROR_PAGE,
  classifyLoadFailure,
  isTabCrash,
  securityStateOf,
  errorPageQuery,
} = require('./page-errors');
const { buildPageAgentScript } = require('./agent-dom');
const { createHistoryStore } = require('./history');
const { applyChromeIdentity, installClientHintHeaders } = require('./chrome-identity');
const { createPasswordController } = require('./passwords');
const { createPasswordPopover } = require('./password-popover');
const { createFormAutofillController, FORM_AUTOFILL_OWNER } = require('./form-autofill');
const { createExternalAppLauncher, createExternalAppPermissionStore } = require('./external-apps');
const { resolveRelayedShellShortcut } = require('./shell-shortcuts');
const { capturePageImage } = require('./page-capture');
const {
  BUILTIN_ENGINES,
  MAX_DESCRIPTION_BYTES,
  OPENSEARCH_LINK_SCRIPT,
  buildSearchUrl,
  discoverSiteSearchEngine,
} = require('./search-engines');
const path = require('path');
const { randomUUID } = require('crypto');

const PASSWORD_PRELOAD = path.join(__dirname, 'password-preload.js');
const PASSWORD_POPOVER_PRELOAD = path.join(__dirname, 'password-popover-preload.js');
const PASSWORD_POPOVER_PAGE = path.join(__dirname, 'password-popover.html');

const BROWSER_PARTITION = 'persist:browser-tabs';
const STATE_CHANNEL = 'browser-tab-state';
const OPEN_REQUEST_CHANNEL = 'browser-tab-open-request';
const CLOSED_CHANNEL = 'browser-tab-closed';
const FIND_RESULT_CHANNEL = 'browser-tab-find-result';
const SHORTCUT_CHANNEL = 'browser-tab-shortcut';

/** Chrome's zoom ladder. */
const ZOOM_LEVELS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const AGENT_WORLD_ID = 1001;
/** Monde isolé où Desktop lit la description OpenSearch d'une page (docs/search-engines.md). */
const SEARCH_WORLD_ID = 1003;
const SEARCH_DESCRIPTION_TIMEOUT_MS = 5000;
const FALLBACK_SEARCH_ENGINE = BUILTIN_ENGINES[0];

/** Description OpenSearch d'un site : GET sans cookies, 5 s et 64 Ko au plus. */
async function fetchSearchDescription(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_DESCRIPTION_TIMEOUT_MS);
  try {
    const res = await net.fetch(url, { signal: controller.signal, credentials: 'omit' });
    // Une redirection ne doit pas faire sortir la description du site.
    const host = (u) => new URL(u).hostname.toLowerCase().replace(/^www\./, '');
    if (!res.ok || (res.url && host(res.url) !== host(url))) return '';
    const length = Number(res.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_DESCRIPTION_BYTES) return '';
    const text = await res.text();
    return text.length > MAX_DESCRIPTION_BYTES ? '' : text;
  } catch (_) {
    return '';
  } finally {
    clearTimeout(timer);
  }
}
const AGENT_SCRIPT_TIMEOUT_MS = 10_000;
const AGENT_SETTLE_MAX_MS = 8_000;
const AGENT_MAX_WAIT_MS = 10_000;

const NAMED_KEYS = {
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  space: 'Space',
  arrowdown: 'Down',
  arrowup: 'Up',
  arrowleft: 'Left',
  arrowright: 'Right',
  down: 'Down',
  up: 'Up',
  left: 'Left',
  right: 'Right',
  pagedown: 'PageDown',
  pageup: 'PageUp',
  home: 'Home',
  end: 'End',
};

const KEY_MODIFIERS = {
  shift: 'shift',
  control: 'control',
  ctrl: 'control',
  alt: 'alt',
  option: 'alt',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  mod: process.platform === 'darwin' ? 'meta' : 'control',
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CHROME_PLATFORM_TOKENS = {
  darwin: 'Macintosh; Intel Mac OS X 10_15_7',
  win32: 'Windows NT 10.0; Win64; x64',
  linux: 'X11; Linux x86_64',
};

/**
 * The exact (reduced) user agent Chrome sends for this Chromium engine. It must
 * be identical for pages, iframes and workers: Cloudflare binds its clearance
 * cookie to the UA, and any mismatch restarts the challenge in a loop.
 */
function buildChromiumUserAgent(platform = process.platform, chromeVersion = process.versions.chrome) {
  const platformToken = CHROME_PLATFORM_TOKENS[platform] || CHROME_PLATFORM_TOKENS.linux;
  const major = String(chromeVersion || '').split('.')[0] || '0';
  return `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

function buildAcceptLanguages(preferred) {
  const languages = (Array.isArray(preferred) ? preferred : []).filter(Boolean);
  return [...new Set(languages.length > 0 ? languages : ['fr-FR', 'fr', 'en-US', 'en'])].join(',');
}

function nextZoomFactor(current, direction) {
  if (direction === 'reset') return 1;
  if (direction === 'in') return ZOOM_LEVELS.find((level) => level > current + 0.001) ?? ZOOM_LEVELS.at(-1);
  return [...ZOOM_LEVELS].reverse().find((level) => level < current - 0.001) ?? ZOOM_LEVELS[0];
}

/** True while `view` is still the registered view of `tabId` (not replaced by a later `create`). */
function isCurrentTabView(tabs, tabId, view) {
  const entry = tabs.get(tabId);
  return Boolean(entry) && entry.view === view;
}

/** "Enter", "Control+a", "Mod+Shift+K" → Electron keyCode + modifiers. */
function parseKeyCombo(combo) {
  const parts = String(combo || '')
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const rawKey = parts.pop();
  const modifiers = [];
  for (const part of parts) {
    const modifier = KEY_MODIFIERS[part.toLowerCase()];
    if (!modifier) return null;
    modifiers.push(modifier);
  }
  const keyCode = NAMED_KEYS[rawKey.toLowerCase()] || (rawKey.length === 1 ? rawKey : null);
  if (!keyCode) return null;
  return { keyCode, modifiers };
}

function sendKey(wc, { keyCode, modifiers }) {
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  const plain = modifiers.every((modifier) => modifier === 'shift');
  if (plain) {
    const char = keyCode === 'Enter' ? '\r' : keyCode === 'Space' ? ' ' : keyCode.length === 1 ? keyCode : null;
    if (char) wc.sendInputEvent({ type: 'char', keyCode: char, modifiers });
  }
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
}

function sendClick(wc, x, y, clickCount = 1) {
  const position = { x: Math.round(x), y: Math.round(y) };
  wc.sendInputEvent({ type: 'mouseMove', ...position });
  for (let count = 1; count <= clickCount; count += 1) {
    wc.sendInputEvent({ type: 'mouseDown', ...position, button: 'left', clickCount: count });
    wc.sendInputEvent({ type: 'mouseUp', ...position, button: 'left', clickCount: count });
  }
}

const IDENTITY_STEP_TIMEOUT_MS = 3000;

/** Resolves with the promise's value, or `false` once `ms` have passed. */
function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

function waitForLoadStop(wc, maxMs) {
  if (!wc.isLoading()) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      wc.removeListener('did-stop-loading', done);
      resolve();
    };
    const timer = setTimeout(done, maxMs);
    wc.once('did-stop-loading', done);
  });
}

/**
 * Manages one sandboxed WebContentsView per external browser tab.
 * Views are attached to the main BrowserWindow contentView and sized by the
 * renderer via setBounds IPC.
 */
/** « Always allow » choices for app links, shared by every window (one file). */
let externalAppPermissionStore = null;
function sharedExternalAppPermissions() {
  if (!externalAppPermissionStore) {
    externalAppPermissionStore = createExternalAppPermissionStore({
      filePath: path.join(app.getPath('userData'), 'browser-external-apps.json'),
    });
  }
  return externalAppPermissionStore;
}

/** Autorisations des sites (docs/site-permissions.md), partagées par toutes les fenêtres (un fichier). */
let sitePermissionStore = null;
function sharedSitePermissions() {
  if (!sitePermissionStore) {
    sitePermissionStore = createSitePermissionStore({
      filePath: path.join(app.getPath('userData'), 'browser-site-permissions.json'),
    });
  }
  return sitePermissionStore;
}

/** webContents id d'un onglet web → fenêtre qui l'affiche (pour poser la question dans la bonne fenêtre). */
const tabWindowGetters = new Map();

async function askSitePermission({ origin, label, webContents }) {
  const getWindow = webContents ? tabWindowGetters.get(webContents.id) : null;
  const candidate = (getWindow && getWindow()) || BrowserWindow.getFocusedWindow();
  const win = candidate && !candidate.isDestroyed() ? candidate : null;
  const options = {
    type: 'question',
    message: `${siteHost(origin)} souhaite ${label}`,
    detail:
      "Votre choix est retenu pour ce site. Vous pourrez le modifier depuis l'icône à gauche de l'adresse.",
    buttons: ['Autoriser', 'Bloquer', 'Ignorer'],
    defaultId: 2,
    cancelId: 2,
    noLink: true,
  };
  const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  return ['allow', 'block', 'dismiss'][response] || 'dismiss';
}

/**
 * Onglet ouvert seulement pour un téléchargement (lien `target="_blank"` vers un fichier) :
 * aucune page affichée, rien derrière. Chrome le ferme ; on fait pareil.
 */
function isBlankDownloadTab({ url, canGoBack }) {
  if (canGoBack) return false;
  return !url || url === 'about:blank';
}

function createBrowserTabManager({ getMainWindow, history, interceptLink, searchEngines }) {
  const historyStore =
    history || createHistoryStore({ filePath: path.join(app.getPath('userData'), 'browser-history.json') });
  // Links to desktop apps (`unityhub://…`): opened after confirmation, like Chrome.
  const externalAppPermissions = sharedExternalAppPermissions();
  const externalApps = createExternalAppLauncher({
    shell,
    showMessageBox: (...args) => dialog.showMessageBox(...args),
    getApplicationNameForProtocol: (url) => app.getApplicationNameForProtocol(url),
    getParentWindow: () => getMainWindow(),
    permissions: externalAppPermissions,
  });
  const sitePermissions = sharedSitePermissions();
  const userAgent = buildChromiumUserAgent();
  let sessionConfigured = false;
  /** Plein écran demandé par une page (vidéo) : la fenêtre était-elle déjà en plein écran ? */
  let fullscreenWindowState = null;
  let windowListenersFor = null;

  /** @type {Map<string, { view: import('electron').WebContentsView, url: string }>} */
  const tabs = new Map();
  let adoptPopups = false;
  let activeTabId = null;
  /** @type {{ x: number, y: number, width: number, height: number } | null} */
  let lastBounds = null;
  let viewsVisible = false;
  /** Portal HTML overlay (menu, dialog) is open above the viewport: keep the native view hidden. */
  let overlayActive = false;
  /**
   * Onglets pilotés par un agent en arrière-plan (docs/agent-tabs.md) : leur page n'est pas ralentie quand elle
   * est cachée, et les actions de l'agent n'y prennent jamais le clavier de la personne.
   */
  const agentControlled = new Set();
  /** webContents id → tab id, to route the password messages of a page to its tab. */
  const tabIdsByWebContents = new Map();

  const passwords = createPasswordController({
    emit: (channel, payload) => emitToRenderer(channel, payload),
    getTabUrl: (tabId) => {
      const entry = tabs.get(tabId);
      if (!entry || entry.view.webContents.isDestroyed()) return '';
      return entry.view.webContents.getURL();
    },
    sendToTab: (tabId, channel, payload) => {
      const entry = tabs.get(tabId);
      if (!entry || entry.view.webContents.isDestroyed()) return false;
      entry.view.webContents.send(channel, payload);
      return true;
    },
    popover: popoverFor('password'),
  });

  /** Form autofill (docs/form-autofill.md): names, addresses, e-mail, phone. Same popover, own owner. */
  const formAutofill = createFormAutofillController({
    emit: (channel, payload) => emitToRenderer(channel, payload),
    getTabUrl: (tabId) => {
      const entry = tabs.get(tabId);
      if (!entry || entry.view.webContents.isDestroyed()) return '';
      return entry.view.webContents.getURL();
    },
    sendToTab: (tabId, channel, payload) => {
      const entry = tabs.get(tabId);
      if (!entry || entry.view.webContents.isDestroyed()) return false;
      entry.view.webContents.send(channel, payload);
      return true;
    },
    popover: popoverFor(FORM_AUTOFILL_OWNER),
  });

  /** The popover under a field, shared by the password manager and the form autofill. */
  function popoverFor(owner) {
    return {
      show: (tabId, rect, model, onChoose) => passwordPopover.show(tabId, rect, model, onChoose, owner),
      hide: () => passwordPopover.hide(owner),
      key: (name) => passwordPopover.key(name, owner),
      isFocused: () => passwordPopover.isFocused(),
    };
  }

  /** The tab view moved, was hidden or covered: no popover may float over the wrong place. */
  function hideFieldPopovers() {
    passwords.hidePopover();
    formAutofill.hidePopover();
  }

  /** Autofill popover under login fields (docs/passwords.md): Desktop's own view over the tab view. */
  const passwordPopover = createPasswordPopover({
    createView: createPasswordPopoverView,
    anchorOf: (tabId) => {
      const entry = tabs.get(tabId);
      if (!entry || activeTabId !== tabId || !viewsVisible || overlayActive || !lastBounds) return null;
      if (entry.view.webContents.isDestroyed()) return null;
      return { view: lastBounds, zoom: entry.view.webContents.getZoomFactor() || 1 };
    },
    isDark: () => nativeTheme.shouldUseDarkColors,
    focusTab: (tabId) => {
      const entry = tabs.get(tabId);
      if (entry && !entry.view.webContents.isDestroyed()) entry.view.webContents.focus();
    },
    focusPortal: () => {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.focus();
    },
  });

  function createPasswordPopoverView() {
    const view = new WebContentsView({
      webPreferences: {
        preload: PASSWORD_POPOVER_PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    view.setBackgroundColor('#00000000');
    if (typeof view.setBorderRadius === 'function') view.setBorderRadius(14);
    view.setVisible(false);
    const wc = view.webContents;
    wc.on('will-navigate', (event) => event.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    let ready = false;
    const queue = [];
    wc.once('did-finish-load', () => {
      ready = true;
      for (const [channel, payload] of queue.splice(0)) wc.send(channel, payload);
    });
    const onTheme = () => {
      if (!wc.isDestroyed() && ready) wc.send('lasco-pw-popover:theme', nativeTheme.shouldUseDarkColors);
    };
    nativeTheme.on('updated', onTheme);
    let attached = false;
    return {
      load: () => wc.loadFile(PASSWORD_POPOVER_PAGE),
      send(channel, payload) {
        if (wc.isDestroyed()) return;
        if (!ready) {
          // Only the latest render matters.
          if (channel === 'lasco-pw-popover:render') {
            const index = queue.findIndex(([queued]) => queued === channel);
            if (index >= 0) queue.splice(index, 1);
          }
          queue.push([channel, payload]);
          return;
        }
        wc.send(channel, payload);
      },
      setBounds: (bounds) => view.setBounds(bounds),
      setVisible: (on) => view.setVisible(Boolean(on)),
      raise() {
        const win = getMainWindow();
        if (!win || win.isDestroyed()) return;
        // Re-adding puts the popover above the tab views.
        win.contentView.addChildView(view);
        attached = true;
      },
      isFocused: () => !wc.isDestroyed() && wc.isFocused(),
      isSender: (id) => !wc.isDestroyed() && wc.id === id,
      destroy() {
        nativeTheme.removeListener('updated', onTheme);
        const win = getMainWindow();
        if (attached && win && !win.isDestroyed()) {
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

  function getBrowserSession() {
    const browserSession = session.fromPartition(BROWSER_PARTITION);
    if (!sessionConfigured) {
      sessionConfigured = true;
      browserSession.setUserAgent(userAgent, buildAcceptLanguages(app.getPreferredSystemLanguages()));
      // Electron sends no Sec-CH-UA headers: Google sign-in then refuses the browser.
      installClientHintHeaders(browserSession);
      // Autorisations des sites : demandées puis retenues par site, jamais le micro ni la caméra.
      installSitePermissions(browserSession, {
        store: sitePermissions,
        ask: askSitePermission,
        ensureSystemMediaAccess: (media) => ensureSystemMediaAccess(systemPreferences, media),
      });
    }
    return browserSession;
  }

  function emitToRenderer(channel, payload) {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send(channel, payload);
  }

  function buildState(tabId) {
    const entry = tabs.get(tabId);
    if (!entry) return null;
    const wc = entry.view.webContents;
    if (wc.isDestroyed()) return null;
    const url = (entry.errorPage ? entry.url : sanitizeBrowserUrl(wc.getURL()) || entry.url) || '';
    const history = wc.navigationHistory;
    return {
      tabId,
      url,
      title: (entry.errorPage && entry.errorPage.title) || wc.getTitle() || entry.title || url || 'Nouvel onglet',
      favicon: entry.favicon || null,
      canGoBack: history ? history.canGoBack() : wc.canGoBack(),
      canGoForward: history ? history.canGoForward() : wc.canGoForward(),
      isLoading: wc.isLoading(),
      zoomFactor: wc.getZoomFactor(),
      // Cadenas de la barre d'adresse : secure | insecure | dangerous | local | null.
      security: securityStateOf(url, entry.errorPage),
      // Page affichée par Lasco à la place du site : crashed | network | certificate.
      pageError: entry.errorPage ? entry.errorPage.kind : null,
      htmlFullscreen: Boolean(entry.htmlFullscreen),
      // Piloté par un agent en arrière-plan (setAgentControl).
      agentControlled: agentControlled.has(tabId),
      // Son de l'onglet (icône haut-parleur de la barre d'onglets, comme Chrome).
      audible: wc.isCurrentlyAudible(),
      muted: wc.isAudioMuted(),
    };
  }

  function pushState(tabId) {
    const state = buildState(tabId);
    if (!state) return;
    const entry = tabs.get(tabId);
    if (entry) {
      entry.url = state.url;
      entry.title = state.title;
    }
    emitToRenderer(STATE_CHANNEL, state);
  }

  function entryOfView(view) {
    for (const entry of tabs.values()) {
      if (entry.view === view) return entry;
    }
    return null;
  }

  /** Taille de la zone de contenu de la fenêtre : la vue d'une vidéo en plein écran la couvre. */
  function fullWindowBounds() {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return null;
    const [width, height] = win.getContentSize();
    return { x: 0, y: 0, width, height };
  }

  function applyBounds(view) {
    if (!view) return;
    const fullscreenEntry = entryOfView(view);
    if (fullscreenEntry && fullscreenEntry.htmlFullscreen) {
      const full = fullWindowBounds();
      if (full) {
        view.setBounds(full);
        view.setVisible(true);
        return;
      }
    }
    if (!lastBounds) return;
    const { x, y, width, height } = lastBounds;
    if (width < 1 || height < 1) {
      view.setVisible(false);
      return;
    }
    view.setBounds({
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
    });
    let abortedBlank = false;
    for (const entry of tabs.values()) {
      if (entry.view === view) {
        abortedBlank = Boolean(entry.abortedBlank);
        break;
      }
    }
    // Keep the active browser view above the portal HTML chrome, but clipped
    // strictly to the measured content viewport. Aborted first-loads stay hidden
    // so the empty shell reads like a new tab until refresh.
    view.setVisible(Boolean(viewsVisible && activeTabId && !abortedBlank && !overlayActive));
  }

  function detachView(view) {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    try {
      win.contentView.removeChildView(view);
    } catch (_) {
      // View may already be detached.
    }
  }

  function attachView(view) {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    try {
      // Re-adding moves the view to the top of the stacking order.
      win.contentView.addChildView(view);
    } catch (_) {
      // Ignore duplicate attach races.
    }
    applyBounds(view);
  }

  function destroyTab(tabId) {
    const entry = tabs.get(tabId);
    if (!entry) return;
    tabs.delete(tabId);
    agentControlled.delete(tabId);
    passwords.forgetTab(tabId);
    formAutofill.forgetTab(tabId);
    if (activeTabId === tabId) activeTabId = null;
    if (entry.htmlFullscreen) {
      entry.htmlFullscreen = false;
      restoreWindowAfterFullscreen();
    }
    if (entry.hangDialog) entry.hangDialog.abort();
    const { view } = entry;
    detachView(view);
    const wc = view.webContents;
    if (!wc.isDestroyed()) {
      try {
        wc.close();
      } catch (_) {
        // Ignore close races during quit.
      }
    }
  }

  /**
   * Un téléchargement a commencé dans `webContents`. Si c'est un onglet resté vide (ouvert
   * seulement pour ce fichier), il est fermé et le portail revient à l'onglet d'origine
   * (`CLOSED_CHANNEL`, comme un `window.close()`). Le téléchargement continue : il appartient
   * à la session, pas à la page.
   */
  function closeIfBlankAfterDownload(webContents) {
    if (!webContents || webContents.isDestroyed()) return false;
    const tabId = tabIdsByWebContents.get(webContents.id);
    if (!tabId) return false;
    const blank = () => {
      if (webContents.isDestroyed()) return false;
      const history = webContents.navigationHistory;
      return isBlankDownloadTab({
        // URL de la page affichée (validée), pas celle qui se charge : le lien du fichier
        // n'a jamais affiché de page.
        url: webContents.mainFrame ? webContents.mainFrame.url : webContents.getURL(),
        canGoBack: history && typeof history.canGoBack === 'function' ? history.canGoBack() : false,
      });
    };
    if (!blank()) return false;
    // Après la prise en charge du téléchargement par la session.
    setImmediate(() => {
      const entry = tabs.get(tabId);
      if (!entry || entry.view.webContents !== webContents || !blank()) return;
      destroyTab(tabId);
      emitToRenderer(CLOSED_CHANNEL, { tabId });
    });
    return true;
  }

  function destroyAll() {
    for (const tabId of [...tabs.keys()]) {
      destroyTab(tabId);
    }
    activeTabId = null;
    viewsVisible = false;
    passwordPopover.destroy();
    historyStore.flush();
  }

  /** Le site doit quitter son plein écran (onglet changé, fenêtre sortie du plein écran). */
  function exitPageFullscreen(entry) {
    if (!entry || !entry.htmlFullscreen) return;
    const wc = entry.view.webContents;
    if (wc.isDestroyed()) return;
    wc.executeJavaScript('document.fullscreenElement && document.exitFullscreen()', true).catch(() => {});
  }

  function restoreWindowAfterFullscreen() {
    const state = fullscreenWindowState;
    fullscreenWindowState = null;
    const win = getMainWindow();
    if (!state || !win || win.isDestroyed()) return;
    if (!state.wasFullScreen && win.isFullScreen()) win.setFullScreen(false);
  }

  function ensureWindowListeners() {
    const win = getMainWindow();
    if (!win || win.isDestroyed() || windowListenersFor === win) return;
    windowListenersFor = win;
    win.on('resize', () => {
      for (const entry of tabs.values()) {
        if (entry.htmlFullscreen) applyBounds(entry.view);
      }
    });
    // Sortie du plein écran par la fenêtre (bouton vert, ⌃⌘F) : la vidéo le quitte aussi.
    win.on('leave-full-screen', () => {
      for (const entry of tabs.values()) exitPageFullscreen(entry);
    });
  }

  function enterPageFullscreen(tabId) {
    const entry = tabs.get(tabId);
    const win = getMainWindow();
    if (!entry || !win || win.isDestroyed()) return;
    ensureWindowListeners();
    hideFieldPopovers();
    entry.htmlFullscreen = true;
    if (!fullscreenWindowState) fullscreenWindowState = { wasFullScreen: win.isFullScreen() };
    if (!win.isFullScreen()) win.setFullScreen(true);
    if (activeTabId === tabId && viewsVisible) attachView(entry.view);
    else applyBounds(entry.view);
    pushState(tabId);
  }

  function leavePageFullscreen(tabId) {
    const entry = tabs.get(tabId);
    if (!entry || !entry.htmlFullscreen) return;
    entry.htmlFullscreen = false;
    restoreWindowAfterFullscreen();
    applyBounds(entry.view);
    pushState(tabId);
  }

  /**
   * Remplace le site par la page d'erreur de Lasco (plantage, réseau, certificat). L'adresse du
   * site reste celle de l'onglet : Actualiser (⌘R) et le bouton de la page la rechargent.
   */
  function showErrorPage(tabId, errorPage) {
    const entry = tabs.get(tabId);
    if (!entry) return;
    const wc = entry.view.webContents;
    if (wc.isDestroyed()) return;
    let host = '';
    try {
      host = new URL(errorPage.url || entry.url).host;
    } catch (_) {
      host = '';
    }
    const page = {
      ...errorPage,
      url: errorPage.url || entry.url,
      title: errorPage.kind === 'crashed' ? entry.title || host : host || entry.title,
    };
    entry.errorPage = page;
    if (page.url) entry.url = page.url;
    entry.abortedBlank = false;
    if (entry.htmlFullscreen) leavePageFullscreen(tabId);
    pushState(tabId);
    setImmediate(async () => {
      if (wc.isDestroyed() || entry.errorPage !== page) return;
      try {
        await wc.loadFile(ERROR_PAGE, { query: errorPageQuery(page) });
      } catch (_) {
        // remplacé par une autre navigation
      }
      // Après un plantage, le débogueur qui porte l'identité Chrome est détaché : le rattacher
      // pour que le rechargement reste vu comme Chrome (connexion Google).
      if (page.kind === 'crashed' && !wc.isDestroyed()) {
        await withTimeout(applyChromeIdentity(wc, userAgent), IDENTITY_STEP_TIMEOUT_MS);
      }
      if (viewsVisible && activeTabId === tabId) applyBounds(entry.view);
      pushState(tabId);
    });
  }

  /** Page bloquée (« ne répond pas ») : Attendre ou Quitter la page, comme Chrome. */
  function promptUnresponsive(tabId) {
    const entry = tabs.get(tabId);
    const win = getMainWindow();
    if (!entry || entry.hangDialog || !win || win.isDestroyed()) return;
    const wc = entry.view.webContents;
    const controller = new AbortController();
    entry.hangDialog = controller;
    let host = '';
    try {
      host = new URL(entry.url).host;
    } catch (_) {
      host = entry.title || '';
    }
    dialog
      .showMessageBox(win, {
        type: 'warning',
        message: host ? `La page ${host} ne répond pas` : 'La page ne répond pas',
        detail: "Vous pouvez attendre qu'elle réponde ou la quitter.",
        buttons: ['Attendre', 'Quitter la page'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        signal: controller.signal,
      })
      .then(({ response }) => {
        // L'arrêt du processus affiche ensuite « Cet onglet a planté » (render-process-gone).
        if (response === 1 && !wc.isDestroyed()) wc.forcefullyCrashRenderer();
      })
      .catch(() => {})
      .finally(() => {
        if (entry.hangDialog === controller) entry.hangDialog = null;
      });
  }

  function wireWebContents(tabId, view) {
    const wc = view.webContents;
    const webContentsId = wc.id;
    tabIdsByWebContents.set(webContentsId, tabId);
    tabWindowGetters.set(webContentsId, getMainWindow);

    const launchExternalApp = (url) =>
      externalApps.launch({ url, pageUrl: wc.getURL(), key: `tab:${tabId}` });

    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (launchExternalApp(url)) return { action: 'deny' };
      const safe = sanitizeBrowserUrl(url);
      if (safe && typeof interceptLink === 'function' && interceptLink(safe)) {
        return { action: 'deny' };
      }
      const blankPopup = !url || url === 'about:blank';
      if (adoptPopups && (safe || blankPopup)) {
        // Vraie fenêtre fille (docs/popups.md) : `window.open` renvoie une fenêtre, `opener`,
        // `postMessage` et `window.close()` marchent (Gmail « popout », connexions OAuth).
        // Elle devient un onglet que le portail adopte sous `adoptedTabId`.
        return {
          action: 'allow',
          overrideBrowserWindowOptions: { webPreferences: browserTabWebPreferences() },
          createWindow: (options) => adoptPopup(options, {
            url: safe || 'about:blank',
            openerTabId: tabId,
            disposition,
          }),
        };
      }
      if (safe) {
        // `disposition` : `background-tab` pour un clic molette ou ⌘-clic. Le portail ouvre
        // alors l'onglet sans focus, juste à droite de `openerTabId` (comme Chrome).
        emitToRenderer(OPEN_REQUEST_CHANNEL, {
          url: safe,
          openerTabId: tabId,
          ...(typeof disposition === 'string' ? { disposition } : {}),
        });
      }
      return { action: 'deny' };
    });

    wc.on('will-navigate', (event, url) => {
      const safe = sanitizeBrowserUrl(url);
      if (!safe) {
        event.preventDefault();
        launchExternalApp(url);
      }
    });

    wc.on('will-redirect', (event, url) => {
      const safe = sanitizeBrowserUrl(url);
      if (!safe) {
        event.preventDefault();
        launchExternalApp(url);
      }
    });

    wc.on('page-title-updated', (_event, title) => {
      historyStore.updateTitle(wc.getURL(), title);
      pushState(tabId);
    });
    wc.on('page-favicon-updated', (_event, favicons) => {
      const entry = tabs.get(tabId);
      if (!entry) return;
      entry.favicon = Array.isArray(favicons) && favicons[0] ? favicons[0] : null;
      pushState(tabId);
    });
    wc.on('did-start-loading', () => pushState(tabId));
    wc.on('did-stop-loading', () => pushState(tabId));
    wc.on('did-finish-load', () => {
      if (isCurrentTabView(tabs, tabId, view)) void discoverSearchEngine(tabId, wc);
    });
    wc.on('did-navigate', (_event, url) => {
      const entry = tabs.get(tabId);
      // Un vrai site s'affiche de nouveau : la page d'erreur est terminée.
      if (entry && entry.errorPage && sanitizeBrowserUrl(url)) entry.errorPage = null;
      passwords.onNavigate(tabId, url);
      formAutofill.onNavigate(tabId, url);
      historyStore.recordVisit(url, wc.getTitle());
      pushState(tabId);
    });
    wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) historyStore.recordVisit(url, wc.getTitle());
      pushState(tabId);
    });
    wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      const failure = classifyLoadFailure({ errorCode, errorDescription, validatedURL, isMainFrame });
      if (failure && isCurrentTabView(tabs, tabId, view)) {
        showErrorPage(tabId, failure);
        return;
      }
      pushState(tabId);
    });
    wc.on('render-process-gone', (_event, details) => {
      if (!isCurrentTabView(tabs, tabId, view) || !isTabCrash(details)) return;
      const entry = tabs.get(tabId);
      const url = (entry.errorPage ? entry.url : sanitizeBrowserUrl(wc.getURL())) || entry.url;
      showErrorPage(tabId, { kind: 'crashed', url, reason: details.reason });
    });
    wc.on('unresponsive', () => {
      if (isCurrentTabView(tabs, tabId, view)) promptUnresponsive(tabId);
    });
    wc.on('responsive', () => {
      const entry = tabs.get(tabId);
      if (entry && entry.view === view && entry.hangDialog) entry.hangDialog.abort();
    });
    // Vidéo en plein écran : la page couvre toute la fenêtre, passée en plein écran.
    wc.on('enter-html-full-screen', () => {
      if (isCurrentTabView(tabs, tabId, view)) enterPageFullscreen(tabId);
    });
    wc.on('leave-html-full-screen', () => {
      if (isCurrentTabView(tabs, tabId, view)) leavePageFullscreen(tabId);
    });
    wc.on('destroyed', () => {
      tabIdsByWebContents.delete(webContentsId);
      tabWindowGetters.delete(webContentsId);
      // `create` on a live tab id (shell reloaded, e.g. workspace switch) closes the old
      // view and registers the new one at once; the old view's `destroyed` comes later
      // and must not drop the new entry (tab stuck loading, stop / reload ignored).
      if (!isCurrentTabView(tabs, tabId, view)) return;
      // Encore enregistrée : la vue n'a pas été fermée par `destroyTab`, c'est la page qui s'est
      // fermée (`window.close()`, fenêtre de connexion OAuth) ou qui a disparu. Le portail retire
      // l'onglet et revient à celui qui l'a ouvert, comme Chrome.
      passwords.forgetTab(tabId);
      formAutofill.forgetTab(tabId);
      tabs.delete(tabId);
      if (activeTabId === tabId) activeTabId = null;
      emitToRenderer(CLOSED_CHANNEL, { tabId });
    });

    // La page commence ou arrête de jouer du son : l'icône de l'onglet suit.
    wc.on('audio-state-changed', () => pushState(tabId));

    wc.on('zoom-changed', (_event, direction) => {
      applyZoom(wc, direction === 'in' ? 'in' : 'out');
      pushState(tabId);
    });

    wc.on('found-in-page', (_event, result) => {
      emitToRenderer(FIND_RESULT_CHANNEL, {
        tabId,
        activeMatchOrdinal: result.activeMatchOrdinal ?? 0,
        matches: result.matches ?? 0,
        finalUpdate: Boolean(result.finalUpdate),
      });
    });

    // Focus is inside the native view, so portal keyboard handlers never see
    // these. Handle browser shortcuts here (and keep the default app menu from
    // reloading the whole portal on ⌘R).
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      // Échap quitte le plein écran d'une vidéo, comme dans Chrome.
      if (input.key === 'Escape' && tabs.get(tabId)?.htmlFullscreen) {
        exitPageFullscreen(tabs.get(tabId));
        return;
      }
      const forward = (action) => emitToRenderer(SHORTCUT_CHANNEL, { tabId, action });
      // The find bar and the address bar live in the portal page: hand it the
      // keyboard focus first, otherwise the field is focused in the DOM but the
      // keys keep going to this view.
      const forwardToPortalField = (action) => {
        const win = getMainWindow();
        if (win && !win.isDestroyed()) win.webContents.focus();
        forward(action);
      };
      // Onglets, agents, favori, historique, liste des raccourcis : la coquille les exécute
      // (le chat d'un agent, la bulle du favori et la fenêtre d'aide prennent le focus).
      const relayed = resolveRelayedShellShortcut(input, process.platform === 'darwin');
      if (relayed) {
        event.preventDefault();
        forwardToPortalField(relayed);
        return;
      }
      if (input.alt) return;
      const mod = process.platform === 'darwin' ? input.meta : input.control;
      if (!mod) return;
      const key = String(input.key || '').toLowerCase();
      // Menu owns ⌘W (Close Tab). Don't preventDefault here or the menu item
      // never runs when focus is inside a native browser view.
      if (key === 'w' && !input.shift) return;
      // ⌘⇧R : recharger sans le cache, comme Chrome.
      if (key === 'r' && input.shift) {
        event.preventDefault();
        wc.reloadIgnoringCache();
        return;
      }
      const handlers = {
        f: () => forwardToPortalField('find'),
        g: () => forward(input.shift ? 'find-previous' : 'find-next'),
        l: () => forwardToPortalField('focus-address'),
        // Le nouvel onglet met le curseur dans la barre d'adresse : le clavier doit quitter cette vue.
        t: () => forwardToPortalField('new-tab'),
        // Téléchargements : ⌘⇧J (macOS), Ctrl+J (Windows / Linux), comme Chrome.
        j: () => forward('downloads'),
        // ⌘⇧S / Ctrl+Shift+S : capture de la page entière (docs/page-capture.md).
        s: () => captureReady && forward('capture-full-page'),
        p: () => print({ tabId }),
        r: () => reload({ tabId }),
        '=': () => zoom({ tabId, direction: 'in' }),
        '+': () => zoom({ tabId, direction: 'in' }),
        '-': () => zoom({ tabId, direction: 'out' }),
        0: () => zoom({ tabId, direction: 'reset' }),
        '[': () => goBack({ tabId }),
        ']': () => goForward({ tabId }),
      };
      const handler = handlers[key];
      if (!handler || (input.shift && !['g', 'j', 's', '=', '+'].includes(key))) return;
      // ⌘S seul reste à la page (enregistrer dans un éditeur web).
      if (key === 's' && (!input.shift || !captureReady)) return;
      event.preventDefault();
      handler();
    });

    wc.on('context-menu', (_event, params) => {
      const win = getMainWindow();
      if (!win || win.isDestroyed()) return;
      const template = [];
      const separator = { type: 'separator' };
      const openInNewTab = (url) => {
        const safe = sanitizeBrowserUrl(url);
        // « Ouvrir dans un nouvel onglet » : en arrière-plan, à droite de cet onglet (Chrome).
        if (safe) {
          emitToRenderer(OPEN_REQUEST_CHANNEL, {
            url: safe,
            openerTabId: tabId,
            disposition: 'background-tab',
          });
        }
      };

      const forwardCapture = (action) => emitToRenderer(SHORTCUT_CHANNEL, { tabId, action });

      // Téléchargement géré par Lasco (docs/downloads.md) : dossier choisi dans les Réglages.
      const download = (url) => {
        if (/^(https?|data|blob):/i.test(String(url || ''))) wc.downloadURL(url);
      };

      // Correcteur orthographique : suggestions en tête, comme Chrome.
      if (params.isEditable && params.misspelledWord) {
        const suggestions = (params.dictionarySuggestions || []).slice(0, 5);
        if (suggestions.length) {
          for (const suggestion of suggestions) {
            template.push({ label: suggestion, click: () => wc.replaceMisspelling(suggestion) });
          }
        } else {
          template.push({ label: 'Aucune suggestion', enabled: false });
        }
        template.push(
          {
            label: 'Ajouter au dictionnaire',
            click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord),
          },
          separator,
        );
      }
      if (params.linkURL && sanitizeBrowserUrl(params.linkURL)) {
        template.push(
          { label: 'Ouvrir le lien dans un nouvel onglet', click: () => openInNewTab(params.linkURL) },
          { label: "Copier l'adresse du lien", click: () => void clipboard.writeText(params.linkURL) },
          { label: 'Télécharger le fichier lié', click: () => download(params.linkURL) },
          separator,
        );
      }
      if (params.mediaType === 'image' && params.srcURL) {
        template.push(
          { label: "Ouvrir l'image dans un nouvel onglet", click: () => openInNewTab(params.srcURL) },
          { label: "Enregistrer l'image…", click: () => download(params.srcURL) },
          { label: "Copier l'image", click: () => wc.copyImageAt(params.x, params.y) },
          { label: "Copier l'adresse de l'image", click: () => void clipboard.writeText(params.srcURL) },
          separator,
        );
      }
      if ((params.mediaType === 'video' || params.mediaType === 'audio') && sanitizeBrowserUrl(params.srcURL)) {
        const video = params.mediaType === 'video';
        template.push(
          {
            label: video ? 'Ouvrir la vidéo dans un nouvel onglet' : "Ouvrir l'audio dans un nouvel onglet",
            click: () => openInNewTab(params.srcURL),
          },
          { label: video ? 'Enregistrer la vidéo…' : "Enregistrer l'audio…", click: () => download(params.srcURL) },
          {
            label: video ? "Copier l'adresse de la vidéo" : "Copier l'adresse de l'audio",
            click: () => void clipboard.writeText(params.srcURL),
          },
          separator,
        );
      }
      if (params.isEditable) {
        template.push(
          { label: 'Annuler', enabled: params.editFlags.canUndo, click: () => wc.undo() },
          { label: 'Rétablir', enabled: params.editFlags.canRedo, click: () => wc.redo() },
          separator,
          { label: 'Couper', enabled: params.editFlags.canCut, click: () => wc.cut() },
          { label: 'Copier', enabled: params.editFlags.canCopy, click: () => wc.copy() },
          { label: 'Coller', enabled: params.editFlags.canPaste, click: () => wc.paste() },
          { label: 'Tout sélectionner', click: () => wc.selectAll() },
          separator,
        );
      } else if (params.selectionText && params.selectionText.trim()) {
        const selection = params.selectionText.trim().replace(/\s+/g, ' ');
        const preview = selection.length > 32 ? `${selection.slice(0, 31)}…` : selection;
        template.push(
          { label: 'Copier', click: () => wc.copy() },
          {
            label: `Rechercher « ${preview} » sur ${defaultSearchEngine().name}`,
            click: () => {
              const target = buildSearchUrl(defaultSearchEngine(), selection);
              if (target) openInNewTab(target);
            },
          },
          separator,
        );
      }
      const history = wc.navigationHistory;
      template.push(
        {
          label: 'Précédent',
          enabled: history ? history.canGoBack() : wc.canGoBack(),
          click: () => goBack({ tabId }),
        },
        {
          label: 'Suivant',
          enabled: history ? history.canGoForward() : wc.canGoForward(),
          click: () => goForward({ tabId }),
        },
        { label: 'Actualiser', click: () => reload({ tabId }) },
        separator,
        { label: 'Imprimer…', click: () => print({ tabId }) },
        // Capture d'écran (docs/page-capture.md) : le portail enregistre et affiche la notification.
        ...(captureReady
          ? [
              { label: 'Capturer la page entière', click: () => forwardCapture('capture-full-page') },
              { label: 'Capturer la partie visible', click: () => forwardCapture('capture-visible') },
            ]
          : []),
        separator,
        {
          label: 'Inspecter',
          click: () => {
            wc.openDevTools({ mode: 'detach' });
            wc.inspectElement(params.x, params.y);
          },
        },
      );
      Menu.buildFromTemplate(template).popup({ window: win });
    });
  }

  function applyZoom(wc, direction) {
    const next = nextZoomFactor(wc.getZoomFactor(), direction);
    wc.setZoomFactor(next);
    return next;
  }

  function browserTabWebPreferences() {
    return {
      session: getBrowserSession(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // Password manager runtime (main frame only, isolated world, exposes nothing to the
      // page): untrusted web content never reaches Electron APIs.
      preload: PASSWORD_PRELOAD,
      allowRunningInsecureContent: false,
      spellcheck: true,
    };
  }

  function createView(tabId, initialUrl) {
    const view = new WebContentsView({ webPreferences: browserTabWebPreferences() });
    view.setBackgroundColor('#ffffff');
    const entry = {
      view,
      url: initialUrl,
      title: '',
      favicon: null,
      abortedBlank: false,
    };
    tabs.set(tabId, entry);
    wireWebContents(tabId, view);

    view.webContents.setUserAgent(userAgent);
    entry.identityPending = true;
    void loadWithChromeIdentity(entry);
    return entry;
  }

  /**
   * The Chrome identity (brands, window.chrome) is attached through CDP, which
   * needs a live renderer: load about:blank, attach, then open the tab's URL
   * (the latest one if `navigate` ran meanwhile).
   */
  async function loadWithChromeIdentity(entry) {
    const wc = entry.view.webContents;
    const startedAt = Date.now();
    try {
      // Never let the identity step hold the tab: past the limit, the page
      // still opens (plain Chrome user agent only).
      const blank = await withTimeout(
        wc.loadURL('about:blank').then(
          () => true,
          () => true,
        ),
        IDENTITY_STEP_TIMEOUT_MS,
      );
      if (!blank) console.warn('[browser-tabs] about:blank did not finish loading');
      if (wc.isDestroyed()) return;
      const applied = await withTimeout(applyChromeIdentity(wc, userAgent), IDENTITY_STEP_TIMEOUT_MS);
      if (!applied) console.warn(`[browser-tabs] chrome identity not applied after ${Date.now() - startedAt} ms`);
    } finally {
      entry.identityPending = false;
      if (!wc.isDestroyed() && !entry.abortedBlank) void wc.loadURL(entry.url);
    }
  }

  /**
   * Onglet pour une fenêtre ouverte par une page (`window.open`) : la vue reprend les
   * webContents créés par Chromium, reliés à leur page d'origine. Cachée jusqu'au `select`.
   */
  function adoptPopup(options, { url, openerTabId, disposition }) {
    const tabId = `popup-${randomUUID()}`;
    const emitAdopted = () =>
      emitToRenderer(OPEN_REQUEST_CHANNEL, {
        url,
        openerTabId,
        adoptedTabId: tabId,
        ...(typeof disposition === 'string' ? { disposition } : {}),
      });
    // Sans opener (clic molette, ⌘-clic, lien `_blank` en `noopener`), Chromium ne crée
    // pas de webContents : c'est à nous de le créer et d'y charger l'URL (sinon
    // « options.webContents must be a WebContents » dans le processus principal).
    if (!options || !options.webContents) {
      const entry = createView(tabId, url);
      emitAdopted();
      return entry.view.webContents;
    }
    const view = new WebContentsView({
      webContents: options.webContents,
      webPreferences: options.webPreferences,
    });
    view.setBackgroundColor('#ffffff');
    tabs.set(tabId, { view, url, title: '', favicon: null, abortedBlank: false, identityPending: false });
    wireWebContents(tabId, view);
    const wc = view.webContents;
    wc.setUserAgent(userAgent);
    void applyChromeIdentity(wc, userAgent).catch(() => {});
    emitAdopted();
    return wc;
  }

  /** Le portail sait adopter les fenêtres filles (`adoptedTabId`) : sinon, ancien comportement. */
  function setAdoptPopups(value) {
    adoptPopups = value === true;
  }

  function create({ tabId, url }) {
    if (typeof tabId !== 'string' || !tabId.trim()) {
      return { ok: false, error: 'invalid-tab-id' };
    }
    const safe = sanitizeBrowserUrl(url);
    if (!safe) return { ok: false, error: 'invalid-url' };

    if (tabs.has(tabId)) {
      destroyTab(tabId);
    }
    createView(tabId, safe);
    return { ok: true, tabId, url: safe };
  }

  function navigate({ tabId, url }) {
    const entry = tabs.get(tabId);
    const safe = sanitizeBrowserUrl(url);
    if (!safe) return { ok: false, error: 'invalid-url' };
    if (!entry) {
      return create({ tabId, url: safe });
    }
    entry.url = safe;
    entry.abortedBlank = false;
    entry.errorPage = null;
    if (!entry.identityPending) void entry.view.webContents.loadURL(safe);
    if (viewsVisible && activeTabId === tabId) {
      entry.view.setVisible(!overlayActive);
      applyBounds(entry.view);
    }
    return { ok: true, tabId, url: safe };
  }

  function select({ tabId }) {
    if (typeof tabId !== 'string' || !tabs.has(tabId)) {
      return { ok: false, error: 'unknown-tab' };
    }
    if (activeTabId !== tabId) hideFieldPopovers();
    activeTabId = tabId;
    viewsVisible = true;
    overlayActive = false;
    for (const [id, entry] of tabs) {
      const isActive = id === tabId;
      if (isActive) {
        attachView(entry.view);
        entry.view.setVisible(true);
        applyBounds(entry.view);
      } else {
        exitPageFullscreen(entry);
        entry.view.setVisible(false);
        detachView(entry.view);
      }
    }
    pushState(tabId);
    return { ok: true, tabId };
  }

  function hide() {
    hideFieldPopovers();
    viewsVisible = false;
    activeTabId = null;
    for (const entry of tabs.values()) {
      exitPageFullscreen(entry);
      entry.view.setVisible(false);
      detachView(entry.view);
    }
    return { ok: true };
  }

  function close({ tabId }) {
    if (!tabs.has(tabId)) return { ok: true, tabId };
    destroyTab(tabId);
    return { ok: true, tabId };
  }

  function goBack({ tabId }) {
    const entry = tabs.get(tabId);
    if (!entry || entry.view.webContents.isDestroyed()) {
      return { ok: false, error: 'unknown-tab' };
    }
    const history = entry.view.webContents.navigationHistory;
    if (history?.canGoBack()) {
      history.goBack();
    } else if (entry.view.webContents.canGoBack()) {
      entry.view.webContents.goBack();
    }
    return { ok: true };
  }

  function goForward({ tabId }) {
    const entry = tabs.get(tabId);
    if (!entry || entry.view.webContents.isDestroyed()) {
      return { ok: false, error: 'unknown-tab' };
    }
    const history = entry.view.webContents.navigationHistory;
    if (history?.canGoForward()) {
      history.goForward();
    } else if (entry.view.webContents.canGoForward()) {
      entry.view.webContents.goForward();
    }
    return { ok: true };
  }

  /** Couper ou réactiver le son d'un onglet (icône haut-parleur, clic droit). */
  function setMuted({ tabId, muted }) {
    const entry = tabs.get(tabId);
    if (!entry || entry.view.webContents.isDestroyed()) return { ok: false, error: 'unknown-tab' };
    entry.view.webContents.setAudioMuted(muted === true);
    pushState(tabId);
    return { ok: true, muted: entry.view.webContents.isAudioMuted() };
  }

  function reload({ tabId }) {
    const entry = tabs.get(tabId);
    if (!entry || entry.view.webContents.isDestroyed()) {
      return { ok: false, error: 'unknown-tab' };
    }
    const wc = entry.view.webContents;
    const current = wc.getURL();
    entry.abortedBlank = false;
    // Page d'erreur de Lasco : recharger le site, pas la page d'erreur.
    if (entry.errorPage && entry.url) return navigate({ tabId, url: entry.url });
    // After a stopped first load the view may sit on about:blank — re-navigate
    // to the remembered URL instead of reloading a blank document.
    if ((!current || current === 'about:blank' || !sanitizeBrowserUrl(current)) && entry.url) {
      return navigate({ tabId, url: entry.url });
    }
    wc.reload();
    if (viewsVisible && activeTabId === tabId) {
      entry.view.setVisible(!overlayActive);
      applyBounds(entry.view);
    }
    const state = buildState(tabId);
    if (state) {
      state.isLoading = true;
      emitToRenderer(STATE_CHANNEL, state);
    }
    return { ok: true };
  }

  function stop({ tabId }) {
    const entry = tabs.get(tabId);
    if (!entry || entry.view.webContents.isDestroyed()) {
      return { ok: false, error: 'unknown-tab' };
    }
    const wc = entry.view.webContents;
    const hadCommittedHttp = Boolean(sanitizeBrowserUrl(wc.getURL()));
    wc.stop();
    // Aborted before any http(s) commit → hide the native view so the empty
    // shell looks like a new tab; omnibox keeps entry.url for refresh.
    if (!hadCommittedHttp) {
      entry.abortedBlank = true;
      entry.view.setVisible(false);
    }
    const state = buildState(tabId);
    if (state) {
      state.isLoading = false;
      if (entry.url) {
        state.url = entry.url;
        if (!state.title || state.title === 'about:blank') {
          try {
            state.title = new URL(entry.url).hostname || entry.url;
          } catch (_) {
            state.title = entry.url;
          }
        }
      }
      emitToRenderer(STATE_CHANNEL, state);
    }
    return { ok: true };
  }

  function setBounds(bounds) {
    if (
      !bounds ||
      typeof bounds.x !== 'number' ||
      typeof bounds.y !== 'number' ||
      typeof bounds.width !== 'number' ||
      typeof bounds.height !== 'number' ||
      !Number.isFinite(bounds.x) ||
      !Number.isFinite(bounds.y) ||
      !Number.isFinite(bounds.width) ||
      !Number.isFinite(bounds.height)
    ) {
      return { ok: false, error: 'invalid-bounds' };
    }
    const nextBounds = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height)),
    };
    // The tab view moved or was resized: the popover would float away from its field.
    if (
      !lastBounds ||
      lastBounds.x !== nextBounds.x ||
      lastBounds.y !== nextBounds.y ||
      lastBounds.width !== nextBounds.width ||
      lastBounds.height !== nextBounds.height
    ) {
      hideFieldPopovers();
    }
    lastBounds = nextBounds;
    if (viewsVisible && activeTabId) {
      const entry = tabs.get(activeTabId);
      if (entry) applyBounds(entry.view);
    }
    return { ok: true };
  }

  function getState({ tabId }) {
    return buildState(tabId);
  }

  function liveEntry(tabId) {
    const entry = tabs.get(tabId);
    if (!entry || entry.view.webContents.isDestroyed()) return null;
    return entry;
  }

  function zoom({ tabId, direction }) {
    const entry = liveEntry(tabId);
    if (!entry) return { ok: false, error: 'unknown-tab' };
    if (!['in', 'out', 'reset'].includes(direction)) return { ok: false, error: 'invalid-direction' };
    const zoomFactor = applyZoom(entry.view.webContents, direction);
    pushState(tabId);
    return { ok: true, zoomFactor };
  }

  function findInPage({ tabId, text, forward = true, newSession = false }) {
    const entry = liveEntry(tabId);
    if (!entry) return { ok: false, error: 'unknown-tab' };
    const query = typeof text === 'string' ? text : '';
    if (!query) {
      entry.view.webContents.stopFindInPage('clearSelection');
      return { ok: true };
    }
    // Electron: findNext=true starts a new session; false moves to the next match.
    entry.view.webContents.findInPage(query, { forward: forward !== false, findNext: Boolean(newSession) });
    return { ok: true };
  }

  function stopFindInPage({ tabId }) {
    const entry = liveEntry(tabId);
    if (!entry) return { ok: false, error: 'unknown-tab' };
    entry.view.webContents.stopFindInPage('clearSelection');
    return { ok: true };
  }

  function print({ tabId }) {
    const entry = liveEntry(tabId);
    if (!entry) return { ok: false, error: 'unknown-tab' };
    entry.view.webContents.print({}, () => {});
    return { ok: true };
  }

  async function captureEntry(entry, { maxWidth, quality = 80 } = {}) {
    const image = await entry.view.webContents.capturePage(undefined, { stayHidden: true });
    if (image.isEmpty()) return { ok: false, error: 'empty-capture' };
    const output =
      maxWidth && image.getSize().width > maxWidth ? image.resize({ width: maxWidth, quality: 'good' }) : image;
    const size = output.getSize();
    const viewWidth = entry.view.getBounds().width;
    // Screenshot pixels per view DIP, used to map agent clicks back onto the page.
    entry.captureScale = viewWidth > 0 ? size.width / viewWidth : 1;
    return {
      ok: true,
      image: output,
      dataUrl: `data:image/jpeg;base64,${output.toJPEG(quality).toString('base64')}`,
      width: size.width,
      height: size.height,
    };
  }

  async function capture({ tabId, maxWidth, quality }) {
    const entry = liveEntry(tabId);
    if (!entry) return { ok: false, error: 'unknown-tab' };
    try {
      const { image: _image, ...result } = await captureEntry(entry, {
        maxWidth: Number.isFinite(maxWidth) ? maxWidth : undefined,
        quality: Number.isFinite(quality) ? Math.min(Math.max(quality, 30), 95) : undefined,
      });
      return result;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'capture-failed' };
    }
  }

  async function copyScreenshot({ tabId }) {
    const entry = liveEntry(tabId);
    if (!entry) return { ok: false, error: 'unknown-tab' };
    try {
      const image = await entry.view.webContents.capturePage(undefined, { stayHidden: true });
      if (image.isEmpty()) return { ok: false, error: 'empty-capture' };
      await clipboard.write([
        new ClipboardItem({ 'image/png': new Blob([image.toPNG()], { type: 'image/png' }) }),
      ]);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'capture-failed' };
    }
  }

  /** Le portail sait enregistrer une capture : menu contextuel et ⌘⇧S la proposent. */
  let captureReady = false;
  function setCaptureReady() {
    captureReady = true;
    return { ok: true };
  }

  /**
   * Capture d'écran en PNG (docs/page-capture.md) : `mode` 'full' (page entière, protocole
   * DevTools) ou 'visible'. Renvoie l'image au main, qui l'enregistre et la copie.
   */
  async function captureImage({ tabId, mode }) {
    const entry = liveEntry(tabId);
    if (!entry) return { ok: false, error: 'unknown-tab' };
    const wc = entry.view.webContents;
    try {
      const result = await capturePageImage(wc, { mode: mode === 'visible' ? 'visible' : 'full', nativeImage });
      if (!result.ok) return result;
      return { ...result, url: sanitizeBrowserUrl(wc.getURL()) || entry.url || '', title: wc.getTitle() || '' };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'capture-failed' };
    }
  }

  async function openExternal({ tabId }) {
    const entry = liveEntry(tabId);
    if (!entry) return { ok: false, error: 'unknown-tab' };
    const url = sanitizeBrowserUrl(entry.view.webContents.getURL()) || sanitizeBrowserUrl(entry.url);
    if (!url) return { ok: false, error: 'invalid-url' };
    await shell.openExternal(url);
    return { ok: true };
  }

  function openDevTools({ tabId }) {
    const entry = liveEntry(tabId);
    if (!entry) return { ok: false, error: 'unknown-tab' };
    entry.view.webContents.openDevTools({ mode: 'detach' });
    return { ok: true };
  }

  async function clearBrowsingData() {
    const win = getMainWindow();
    const options = {
      type: 'warning',
      buttons: ['Effacer', 'Annuler'],
      defaultId: 1,
      cancelId: 1,
      message: 'Effacer les données de navigation ?',
      detail:
        "Les cookies, le cache et les données des sites ouverts dans les onglets web seront supprimés. Vous serez déconnecté de ces sites. Votre session Lasco n'est pas concernée.",
    };
    const { response } =
      win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    if (response !== 0) return { ok: false, cancelled: true };
    const browserSession = getBrowserSession();
    await browserSession.clearStorageData();
    await browserSession.clearCache();
    historyStore.clear();
    externalAppPermissions.clear();
    sitePermissions.clear();
    return { ok: true };
  }

  /** Site affiché par l'onglet (son adresse, même derrière une page d'erreur). */
  function tabOrigin(tabId) {
    const entry = liveEntry(tabId);
    if (!entry) return null;
    const url = entry.errorPage ? entry.url : sanitizeBrowserUrl(entry.view.webContents.getURL()) || entry.url;
    return siteOrigin(url);
  }

  /** Informations du site (icône à gauche de l'adresse) : sécurité et autorisations retenues. */
  function siteInfo({ tabId } = {}) {
    const state = buildState(tabId);
    const origin = tabOrigin(tabId);
    if (!state || !origin) return { ok: false, error: 'unknown-tab' };
    return {
      ok: true,
      origin,
      host: siteHost(origin),
      security: state.security,
      permissions: describeSitePermissions(sitePermissions, origin),
    };
  }

  /** `decision` : 'allow' | 'block' | null (redemander). */
  function setSitePermission({ tabId, permission, decision } = {}) {
    const origin = tabOrigin(tabId);
    if (!origin) return { ok: false, error: 'unknown-tab' };
    if (permissionPolicy(permission) !== 'ask') return { ok: false, error: 'invalid-permission' };
    const next = decision === undefined || decision === 'ask' ? null : decision;
    if (!sitePermissions.set(origin, permission, next)) {
      return { ok: false, error: 'invalid-decision' };
    }
    return siteInfo({ tabId });
  }

  function resetSitePermissions({ tabId } = {}) {
    const origin = tabOrigin(tabId);
    if (!origin) return { ok: false, error: 'unknown-tab' };
    sitePermissions.clearOrigin(origin);
    return siteInfo({ tabId });
  }

  function defaultSearchEngine() {
    return (searchEngines && searchEngines.getDefault()) || FALLBACK_SEARCH_ENGINE;
  }

  /** Sites déjà lus pendant cette session, qu'ils aient un moteur ou non (une lecture par site). */
  const searchDiscoveryHosts = new Set();

  /** Moteur déclaré par la page (OpenSearch), ajouté aux raccourcis de la barre d'adresse. */
  async function discoverSearchEngine(tabId, wc) {
    if (!searchEngines || wc.isDestroyed()) return;
    const entry = tabs.get(tabId);
    const pageUrl = sanitizeBrowserUrl(wc.getURL());
    if (!pageUrl || (entry && entry.errorPage)) return;
    const host = new URL(pageUrl).hostname.toLowerCase();
    if (searchDiscoveryHosts.has(host)) return;
    searchDiscoveryHosts.add(host);
    try {
      await discoverSiteSearchEngine({
        store: searchEngines,
        pageUrl,
        readLink: () =>
          wc.isDestroyed()
            ? null
            : wc.executeJavaScriptInIsolatedWorld(SEARCH_WORLD_ID, [{ code: OPENSEARCH_LINK_SCRIPT }], false),
        fetchText: fetchSearchDescription,
        favicon: entry && entry.favicon ? entry.favicon : undefined,
      });
    } catch (_) {
      // Au mieux : une page qui ne répond pas n'ajoute rien.
    }
  }

  function historySuggest({ query, limit } = {}) {
    return { ok: true, items: historyStore.suggest(query, limit) };
  }

  function historyList(payload = {}) {
    return { ok: true, ...historyStore.list(payload) };
  }

  function historyRemove({ url } = {}) {
    return { ok: true, removed: historyStore.remove(url) };
  }

  function historyClear() {
    historyStore.clear();
    return { ok: true };
  }

  function setOverlay({ active }) {
    overlayActive = Boolean(active);
    if (overlayActive) hideFieldPopovers();
    if (!viewsVisible || !activeTabId) return { ok: true };
    const entry = tabs.get(activeTabId);
    if (!entry) return { ok: true };
    if (overlayActive && !entry.htmlFullscreen) {
      entry.view.setVisible(false);
    } else {
      applyBounds(entry.view);
    }
    return { ok: true };
  }

  async function runPageScript(wc, command) {
    const script = buildPageAgentScript(command);
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('page-script-timeout')), AGENT_SCRIPT_TIMEOUT_MS);
    });
    try {
      return await Promise.race([
        wc.executeJavaScriptInIsolatedWorld(AGENT_WORLD_ID, [{ code: script }], false),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Give synthetic input to the page, then hand keyboard focus back to the portal (chat composer).
   * Hidden tab driven by an agent: no focus at all (the person keeps typing elsewhere). Clicks and
   * `insertText` reach a hidden page without it (docs/agent-tabs.md).
   */
  async function withPageFocus(wc, fn, tabId) {
    if (tabId && agentControlled.has(tabId) && !(viewsVisible && activeTabId === tabId)) return fn();
    wc.focus();
    try {
      return await fn();
    } finally {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.focus();
    }
  }

  async function settleAndSnapshot(wc) {
    await delay(350);
    await waitForLoadStop(wc, AGENT_SETTLE_MAX_MS);
    try {
      return await runPageScript(wc, { op: 'snapshot', maxElements: 120, maxText: 3000 });
    } catch (_) {
      // Navigation can tear down the isolated world mid-script; retry once on the new document.
      await delay(500);
      await waitForLoadStop(wc, AGENT_SETTLE_MAX_MS);
      return runPageScript(wc, { op: 'snapshot', maxElements: 120, maxText: 3000 });
    }
  }

  async function resolvePoint(entry, payload) {
    const wc = entry.view.webContents;
    const zoomFactor = wc.getZoomFactor() || 1;
    if (typeof payload.ref === 'string' && payload.ref) {
      const located = await runPageScript(wc, { op: 'locate', ref: payload.ref });
      if (!located || !located.ok) return { ok: false, error: located?.error || 'stale-ref' };
      // CSS pixels → view DIPs.
      return { ok: true, x: located.x * zoomFactor, y: located.y * zoomFactor, covered: located.covered };
    }
    if (Number.isFinite(payload.x) && Number.isFinite(payload.y)) {
      if (payload.coordinateSpace === 'viewport') {
        return { ok: true, x: payload.x * zoomFactor, y: payload.y * zoomFactor };
      }
      const scale = entry.captureScale || 1;
      return { ok: true, x: payload.x / scale, y: payload.y / scale };
    }
    return { ok: false, error: 'missing-target' };
  }

  /**
   * AI agent browser automation on one tab. Returns a fresh page snapshot after
   * every action so the model sees the result without an extra round trip.
   */
  /**
   * Onglet piloté par un agent en arrière-plan : sa page n'est pas ralentie cachée (sinon minuteries à 1 /s,
   * captures impossibles), et elle garde la taille de la zone des onglets pour que la mise en page reste juste.
   */
  function setAgentControl({ tabId, active }) {
    const entry = liveEntry(tabId);
    if (!entry) return { ok: false, error: 'unknown-tab' };
    const wc = entry.view.webContents;
    if (active === true) {
      agentControlled.add(tabId);
      wc.setBackgroundThrottling(false);
      if (lastBounds && lastBounds.width > 0 && lastBounds.height > 0 && activeTabId !== tabId) {
        entry.view.setBounds({
          x: Math.round(lastBounds.x),
          y: Math.round(lastBounds.y),
          width: Math.round(lastBounds.width),
          height: Math.round(lastBounds.height),
        });
      }
    } else {
      agentControlled.delete(tabId);
      wc.setBackgroundThrottling(true);
    }
    pushState(tabId);
    return { ok: true, tabId, active: agentControlled.has(tabId) };
  }

  async function agentAction(payload) {
    const { tabId, action } = payload || {};
    const entry = liveEntry(tabId);
    if (!entry) return { ok: false, error: 'unknown-tab' };
    const wc = entry.view.webContents;

    try {
      switch (action) {
        case 'snapshot': {
          await waitForLoadStop(wc, AGENT_SETTLE_MAX_MS);
          const page = await runPageScript(wc, {
            op: 'snapshot',
            maxElements: payload.maxElements,
            maxText: payload.maxText,
            includeText: payload.includeText !== false,
          });
          return { ok: true, page };
        }
        case 'screenshot': {
          await waitForLoadStop(wc, AGENT_SETTLE_MAX_MS);
          const { image: _image, ...shot } = await captureEntry(entry, { maxWidth: 1280, quality: 70 });
          return shot;
        }
        case 'click': {
          const point = await resolvePoint(entry, payload);
          if (!point.ok) return point;
          await withPageFocus(wc, async () => {
            sendClick(wc, point.x, point.y, payload.doubleClick ? 2 : 1);
          }, tabId);
          return { ok: true, ...(point.covered ? { warning: 'element-covered' } : {}), page: await settleAndSnapshot(wc) };
        }
        case 'type': {
          const text = typeof payload.text === 'string' ? payload.text : '';
          await withPageFocus(wc, async () => {
            if (payload.ref) {
              const point = await resolvePoint(entry, payload);
              if (!point.ok) throw new Error(point.error);
              sendClick(wc, point.x, point.y);
              const focused = await runPageScript(wc, { op: 'focus', ref: payload.ref, clear: payload.clear !== false });
              if (!focused?.ok) throw new Error(focused?.error || 'focus-failed');
            } else if (payload.clear) {
              sendKey(wc, { keyCode: 'a', modifiers: [KEY_MODIFIERS.mod] });
            }
            if (text) await wc.insertText(text);
            if (payload.submit) sendKey(wc, { keyCode: 'Enter', modifiers: [] });
          }, tabId);
          return { ok: true, page: await settleAndSnapshot(wc) };
        }
        case 'press': {
          const combo = parseKeyCombo(payload.key);
          if (!combo) return { ok: false, error: 'invalid-key' };
          await withPageFocus(wc, async () => sendKey(wc, combo), tabId);
          return { ok: true, page: await settleAndSnapshot(wc) };
        }
        case 'scroll': {
          const result = await runPageScript(wc, {
            op: 'scroll',
            ref: payload.ref,
            direction: payload.direction,
            amount: payload.amount,
          });
          if (!result?.ok) return result;
          return { ok: true, page: await settleAndSnapshot(wc) };
        }
        case 'select_option': {
          const result = await runPageScript(wc, { op: 'select', ref: payload.ref, value: payload.value });
          if (!result?.ok) return result;
          return { ok: true, selected: result.selected, page: await settleAndSnapshot(wc) };
        }
        case 'wait': {
          await delay(Math.min(Math.max(Number(payload.ms) || 1000, 0), AGENT_MAX_WAIT_MS));
          return { ok: true, page: await settleAndSnapshot(wc) };
        }
        default:
          return { ok: false, error: 'unknown-action' };
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'agent-action-failed' };
    }
  }

  /** Message of the autofill popover page; accepted only from its own `file:` web contents. */
  function handlePasswordPopoverMessage(event, payload) {
    const sender = event && event.sender;
    if (!sender || !passwordPopover.isSender(sender.id)) return false;
    const frame = event.senderFrame;
    if (!frame || frame !== sender.mainFrame || !String(frame.url).startsWith('file:')) return true;
    passwordPopover.onMessage(payload);
    return true;
  }

  /** Message sent by password-preload.js; accepted only from the main frame of one of our tabs. */
  function handlePasswordMessage(event, channel, payload) {
    const sender = event && event.sender;
    const tabId = sender ? tabIdsByWebContents.get(sender.id) : undefined;
    if (!tabId || !tabs.has(tabId)) return false;
    const frame = event.senderFrame;
    if (!frame || frame !== sender.mainFrame) return true;
    if (channel.startsWith('lasco-af:')) formAutofill.onMessage(tabId, frame.url, channel, payload);
    else passwords.onMessage(tabId, frame.url, channel, payload);
    return true;
  }

  return {
    create,
    setAdoptPopups,
    navigate,
    select,
    hide,
    close,
    goBack,
    goForward,
    reload,
    setMuted,
    stop,
    setBounds,
    getState,
    zoom,
    findInPage,
    stopFindInPage,
    print,
    capture,
    copyScreenshot,
    captureImage,
    setCaptureReady,
    openExternal,
    openDevTools,
    clearBrowsingData,
    siteInfo,
    setSitePermission,
    resetSitePermissions,
    historySuggest,
    historyList,
    historyRemove,
    historyClear,
    setOverlay,
    agentAction,
    setAgentControl,
    passwordSetEnabled: (payload) => passwords.setEnabled(payload),
    passwordSetSuggestions: (payload) => passwords.setSuggestions(payload),
    passwordTakeCapture: (payload) => passwords.takeCapture(payload),
    passwordDismissCapture: (payload) => passwords.dismissCapture(payload),
    passwordFill: (payload) => passwords.fill(payload),
    autofillSetProfiles: (payload) => formAutofill.setProfiles(payload),
    autofillFill: (payload) => formAutofill.fill(payload),
    handlePasswordMessage,
    handlePasswordPopoverMessage,
    destroyAll,
    closeIfBlankAfterDownload,
    has(tabId) {
      return tabs.has(tabId);
    },
    /** VM mode (docs/vm-mode.md): the control endpoint lists the tabs and finds the page of one. */
    tabIds: () => [...tabs.keys()],
    activeTabId: () => activeTabId,
    webContentsOf(tabId) {
      const entry = tabs.get(tabId);
      return entry && !entry.view.webContents.isDestroyed() ? entry.view.webContents : null;
    },
    stateOf: (tabId) => buildState(tabId),
  };
}

module.exports = {
  createBrowserTabManager,
  sharedSitePermissions,
  STATE_CHANNEL,
  OPEN_REQUEST_CHANNEL,
  FIND_RESULT_CHANNEL,
  SHORTCUT_CHANNEL,
  BROWSER_PARTITION,
  parseKeyCombo,
  nextZoomFactor,
  isCurrentTabView,
  isBlankDownloadTab,
  buildChromiumUserAgent,
  buildAcceptLanguages,
};
