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
  cleanSafeBrowsingTexts,
  safeBrowsingGesture,
  safeBrowsingPageFromUrl,
} = require('./page-errors');
const { buildPageAgentScript } = require('./agent-dom');
const { createAgentCdp, AgentActionError, ERROR_HINTS: AGENT_ERROR_HINTS, MAX_UPLOAD_BYTES: AGENT_MAX_UPLOAD_BYTES } = require('./agent-cdp');
const {
  PIP_WORLD_ID,
  PAGE_MEDIA_PROBE_SCRIPT,
  VIDEO_PIP_EXIT_SCRIPT,
  CALL_CONTROLS,
  callControlScript,
  videoPipEnterScript,
  isInCall,
  autoPipKind,
  floatControlsState,
  normalizePipTexts,
} = require('./picture-in-picture');
const { createHistoryStore } = require('./history');
const { createAdblockService } = require('./adblock');
const { applyChromeIdentity, chromeUserAgentOverride, installClientHintHeaders } = require('./chrome-identity');
const {
  installDevtoolsResponsive,
  registerResponsiveRoute,
  unregisterResponsiveRoute,
  createTabResponsive,
} = require('./devtools-responsive');
const { createPasswordController } = require('./passwords');
const { createPasswordPopover } = require('./password-popover');
const { createFormAutofillController, FORM_AUTOFILL_OWNER } = require('./form-autofill');
const { createExternalAppLauncher, createExternalAppPermissionStore } = require('./external-apps');
const { resolveRelayedShellShortcut } = require('./shell-shortcuts');
const { capturePageImage } = require('./page-capture');
const { isPinnedCrossSiteNavigation, normalizePinnedUrl } = require('./pinned');
const { createSiteZoomStore, nextZoomFactor, zoomSiteOf } = require('./site-zoom');
const {
  PAGE_SLEEP_PROBE_SCRIPT,
  PRELOAD_WORLD_ID,
  isMemoryPressure,
  normalizeTabSleepSettings,
  resolveTabSleepDelayMs,
  selectTabsOverLiveBudget,
  selectTabsToSleep,
  tabSleepBlocker,
  tabSleepCheckIntervalMs,
} = require('./tab-sleep');
const {
  BUILTIN_ENGINES,
  MAX_DESCRIPTION_BYTES,
  OPENSEARCH_LINK_SCRIPT,
  buildSearchUrl,
  discoverSiteSearchEngine,
} = require('./search-engines');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const {
  assertInMemoryPartition,
  createPrivateSitePermissions,
  PRIVATE_DENIED_TAB_METHODS,
  wipePrivateSession,
} = require('../private-window/rules');

const PASSWORD_PRELOAD = path.join(__dirname, 'password-preload.js');
const PASSWORD_POPOVER_PRELOAD = path.join(__dirname, 'password-popover-preload.js');
const PASSWORD_POPOVER_PAGE = path.join(__dirname, 'password-popover.html');

const BROWSER_PARTITION = 'persist:browser-tabs';
const { UPGRADE_TIMEOUT_MS: HTTPS_UPGRADE_TIMEOUT_MS } = require('./https-first');
const ADBLOCK_PUSH_DELAY_MS = 500;
const STATE_CHANNEL = 'browser-tab-state';
const OPEN_REQUEST_CHANNEL = 'browser-tab-open-request';
const CLOSED_CHANNEL = 'browser-tab-closed';
const FIND_RESULT_CHANNEL = 'browser-tab-find-result';
const SHORTCUT_CHANNEL = 'browser-tab-shortcut';

const AGENT_WORLD_ID = 1001;
/** Monde isolé où Desktop lit la description OpenSearch d'une page (docs/search-engines.md). */
const SEARCH_WORLD_ID = 1003;
/** Monde isolé du défilement rétabli après la veille (le relevé tourne dans celui du preload). */
const SLEEP_WORLD_ID = 1004;
const SLEEP_PROBE_TIMEOUT_MS = 2000;
/**
 * webContents qui ont reçu le micro ou la caméra (session partagée par toutes les fenêtres) : une
 * page en appel, même silencieuse, n'est jamais mise en veille. Oublié à la navigation suivante.
 */
const mediaCapturingWebContents = new Set();
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
/** DOM calme : aucune mutation pendant 400 ms, 3 s d'attente au plus. */
const AGENT_QUIET_MS = 400;
const AGENT_QUIET_MAX_MS = 3_000;
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

/** Zoom retenu par site (docs/zoom-and-pdf.md), partagé par toutes les fenêtres (un fichier). */
let siteZoomStore = null;
function sharedSiteZoom() {
  if (!siteZoomStore) {
    siteZoomStore = createSiteZoomStore({ filePath: path.join(app.getPath('userData'), 'browser-site-zoom.json') });
  }
  return siteZoomStore;
}

/** Bloqueur de pubs et de traqueurs (docs/adblock.md) : un moteur et une session pour toutes les fenêtres. */
let adblockService = null;
function sharedAdblock() {
  if (!adblockService) {
    adblockService = createAdblockService({ userDataDir: app.getPath('userData'), electron: require('electron') });
  }
  return adblockService;
}

/** webContents id d'un onglet web → fenêtre qui l'affiche (pour poser la question dans la bonne fenêtre). */
const tabWindowGetters = new Map();

async function askSitePermission({ origin, label, webContents }, { privateMode = false } = {}) {
  const getWindow = webContents ? tabWindowGetters.get(webContents.id) : null;
  const candidate = (getWindow && getWindow()) || BrowserWindow.getFocusedWindow();
  const win = candidate && !candidate.isDestroyed() ? candidate : null;
  const options = {
    type: 'question',
    message: `${siteHost(origin)} souhaite ${label}`,
    detail: privateMode
      ? "Fenêtre de navigation privée : votre choix vaut jusqu'à sa fermeture, il n'est pas retenu."
      : "Votre choix est retenu pour ce site. Vous pourrez le modifier depuis l'icône à gauche de l'adresse.",
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

/** Textes de la page « Site dangereux », envoyés par le portail (communs à toutes les fenêtres). */
let safeBrowsingTexts = null;

/**
 * `partition` / `privateMode` : fenêtre de navigation privée (docs/private-browsing.md). Session en mémoire
 * propre à la fenêtre, historique, autorisations et applications externes en mémoire, ni mots de passe,
 * ni saisie automatique, ni pilotage par un agent. `onPortalUrl(url)` : une adresse de Lasco ouverte dans un
 * onglet privé part dans la fenêtre principale (`isPortalUrl` la reconnaît), jamais dans l'onglet.
 *
 * `extensions` (docs/extensions.md) : rappels du service d'extensions, appelés pour chaque onglet
 * web (`onSession(session)`, `onTabCreated(wc)`, `onTabSelected(wc)`, `onTabDestroyed(wc)`,
 * `contextMenuItems(wc, params)`). Jamais dans une fenêtre privée.
 */
function createBrowserTabManager({
  getMainWindow,
  history,
  interceptLink,
  searchEngines,
  getTabSleepSettings,
  // Incrustation automatique (docs/picture-in-picture.md) : vrai si activée dans les Réglages.
  getPictureInPictureAuto = null,
  safeBrowsing = null,
  httpsFirst = null,
  partition = BROWSER_PARTITION,
  privateMode = false,
  isPortalUrl = null,
  onPortalUrl = null,
  // Profils de navigation (docs/browser-profiles.md) : fichiers du profil, et session prête (cookies migrés).
  sitePermissions: profileSitePermissions = null,
  externalAppPermissions: profileExternalAppPermissions = null,
  sessionReady = null,
  onSessionCreated = null,
  extensions = null,
}) {
  const browserPartition = privateMode ? assertInMemoryPartition(partition) : partition;
  // Fenêtre privée : zoom par site en mémoire, jamais écrit (docs/private-browsing.md).
  const siteZoom = privateMode ? createSiteZoomStore({}) : sharedSiteZoom();
  // Extensions Chrome : jamais en navigation privée (docs/extensions.md).
  const extensionHooks = privateMode ? null : extensions;
  const notifyExtensions = (method, ...args) => {
    if (!extensionHooks || typeof extensionHooks[method] !== 'function') return undefined;
    try {
      return extensionHooks[method](...args);
    } catch (error) {
      console.warn(`[browser-tabs] extensions.${method} failed:`, error && error.message);
      return undefined;
    }
  };
  const historyStore = privateMode
    ? createHistoryStore({})
    : history || createHistoryStore({ filePath: path.join(app.getPath('userData'), 'browser-history.json') });
  /** Onglet privé : une page de Lasco s'ouvre dans la fenêtre principale. Vrai si l'adresse a été déviée. */
  const divertPortalUrl = (url) => {
    if (!privateMode || typeof isPortalUrl !== 'function' || !isPortalUrl(url)) return false;
    if (typeof onPortalUrl === 'function') onPortalUrl(url);
    return true;
  };
  // Links to desktop apps (`unityhub://…`): opened after confirmation, like Chrome.
  const externalAppPermissions = privateMode
    ? createExternalAppPermissionStore({})
    : profileExternalAppPermissions || sharedExternalAppPermissions();
  const externalApps = createExternalAppLauncher({
    shell,
    showMessageBox: (...args) => dialog.showMessageBox(...args),
    getApplicationNameForProtocol: (url) => app.getApplicationNameForProtocol(url),
    getParentWindow: () => getMainWindow(),
    permissions: externalAppPermissions,
  });
  const sitePermissions = privateMode
    ? createPrivateSitePermissions({ memory: createSitePermissionStore({}), base: sharedSitePermissions() })
    : profileSitePermissions || sharedSitePermissions();
  const adblock = sharedAdblock();
  // Interrupteur ou exception changés (Réglages, informations du site) : l'état des onglets suit.
  const stopAdblockListener = adblock.settings.onChange(() => {
    // Fenêtre fermée : plus rien à mettre à jour.
    if (!getMainWindow()) {
      stopAdblockListener();
      return;
    }
    for (const tabId of tabs.keys()) pushState(tabId);
  });
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
  /**
   * Onglets en veille (docs/tab-sleep.md) : leur vue est détruite, il reste de quoi les rouvrir à
   * l'identique. tabId → { url, title, favicon, entries, index, scroll, zoomFactor, muted, sleptAt }.
   */
  const sleepingTabs = new Map();
  /** tabId → adresse à l'épinglage (onglets web épinglés). */
  const pinnedUrls = new Map();
  let sleepTimer = null;
  /** Onglets épinglés par le portail (`setPinned`) : gardés éveillés sauf réglage contraire. Survit à la veille. */
  const pinnedTabs = new Set();

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
    const browserSession = session.fromPartition(browserPartition);
    if (!sessionConfigured) {
      sessionConfigured = true;
      browserSession.setUserAgent(userAgent, buildAcceptLanguages(app.getPreferredSystemLanguages()));
      // Electron sends no Sec-CH-UA headers: Google sign-in then refuses the browser.
      installClientHintHeaders(browserSession);
      // Autorisations des sites : demandées puis retenues par site, jamais le micro ni la caméra.
      installSitePermissions(browserSession, {
        store: sitePermissions,
        ask: (request) => askSitePermission(request, { privateMode }),
        ensureSystemMediaAccess: (media) => ensureSystemMediaAccess(systemPreferences, media),
        onMediaGranted: (webContents) => {
          if (webContents && !webContents.isDestroyed()) mediaCapturingWebContents.add(webContents.id);
        },
      });
      // Bloqueur de pubs et de traqueurs : cette session seulement, jamais persist:portal.
      adblock.install(browserSession);
      // Onglet « Responsive » des DevTools (docs/devtools-responsive.md).
      void installDevtoolsResponsive(browserSession);
      // Extensions Chrome du profil (docs/extensions.md), après le bloqueur (répartiteur webRequest).
      notifyExtensions('onSession', browserSession, { partition: browserPartition });
      // Téléchargements de cette session (docs/downloads.md), rangés sous le profil de la fenêtre.
      if (typeof onSessionCreated === 'function') onSessionCreated(browserSession);
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
      // Page affichée par Lasco à la place du site : crashed | network | certificate | safe-browsing.
      pageError: entry.errorPage ? entry.errorPage.kind : null,
      // Site signalé (docs/safe-browsing.md) : malware | phishing | unwanted.
      threat: entry.errorPage && entry.errorPage.kind === 'safe-browsing' ? entry.errorPage.threat : null,
      htmlFullscreen: Boolean(entry.htmlFullscreen),
      // Piloté par un agent en arrière-plan (setAgentControl).
      agentControlled: agentControlled.has(tabId),
      // Son de l'onglet (icône haut-parleur de la barre d'onglets, comme Chrome).
      audible: wc.isCurrentlyAudible(),
      muted: wc.isAudioMuted(),
      // Bloqueur (docs/adblock.md) : actif sur cette page, requêtes bloquées depuis son chargement.
      adblock: { active: adblock.isActiveFor(url), blocked: entry.adblockBlocked || 0 },
      // Incrustation (docs/picture-in-picture.md) : appel en cours, vidéo incrustable, incrustation ouverte.
      inCall: Boolean(entry.inCall),
      canPictureInPicture: Boolean(entry.inCall || (entry.mediaProbe && entry.mediaProbe.video)),
      pictureInPicture: pictureInPictureOf(tabId, entry),
      // Mis en veille pour libérer la mémoire (lune sur l'onglet) : voir sleepingState.
      discarded: false,
    };
  }

  /** État d'un onglet en veille : la barre d'onglets garde titre, icône et adresse. */
  function sleepingState(tabId) {
    const slept = sleepingTabs.get(tabId);
    if (!slept) return null;
    const count = Array.isArray(slept.entries) ? slept.entries.length : 0;
    return {
      tabId,
      url: slept.url,
      title: slept.title || slept.url,
      favicon: slept.favicon || null,
      canGoBack: slept.index > 0,
      canGoForward: count > 0 && slept.index < count - 1,
      isLoading: false,
      zoomFactor: slept.zoomFactor || 1,
      security: securityStateOf(slept.url, null),
      pageError: null,
      htmlFullscreen: false,
      agentControlled: false,
      audible: false,
      muted: Boolean(slept.muted),
      inCall: false,
      canPictureInPicture: false,
      pictureInPicture: null,
      discarded: true,
      sleptAt: slept.sleptAt,
      adblock: { active: adblock.isActiveFor(slept.url), blocked: 0 },
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
    if (!view || isFloatingView(view)) return;
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
    // Mode responsive : la vue prend la taille de l'appareil, centrée sur son fond.
    if (fullscreenEntry && fullscreenEntry.responsive && fullscreenEntry.responsive.active()) {
      fullscreenEntry.responsive.layout(lastBounds);
    } else {
      view.setBounds({
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height),
      });
    }
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
    const responsive = entryOfView(view)?.responsive;
    if (responsive) responsive.detachFrom(win);
    try {
      win.contentView.removeChildView(view);
    } catch (_) {
      // View may already be detached.
    }
  }

  function attachView(view) {
    const win = getMainWindow();
    if (!win || win.isDestroyed() || isFloatingView(view)) return;
    try {
      // Mode responsive : le fond gris passe juste sous la vue.
      const responsive = entryOfView(view)?.responsive;
      if (responsive) responsive.attachTo(win);
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
    if (floating && floating.tabId === tabId) {
      closeFloat({ restore: false });
      unpinView(entry.view);
    }
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
    if (!view.webContents.isDestroyed()) notifyExtensions('onTabDestroyed', view.webContents);
    if (entry.responsive) entry.responsive.dispose();
    if (!view.webContents.isDestroyed()) unregisterResponsiveRoute(view.webContents.id);
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

  // Zoom changé dans un autre onglet (ou une autre fenêtre) du même site : cette fenêtre suit,
  // et la barre d'adresse affiche le bon pourcentage. Fenêtre fermée : désabonnement.
  const unsubscribeSiteZoom = siteZoom.subscribe(({ host, factor }) => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) {
      unsubscribeSiteZoom();
      return;
    }
    for (const [tabId, entry] of tabs) {
      const wc = entry.view.webContents;
      if (wc.isDestroyed() || zoomSiteOf(wc.getURL()) !== host) continue;
      if (Math.abs((wc.getZoomFactor() || 1) - factor) > 0.001) wc.setZoomFactor(factor);
      pushState(tabId);
    }
  });

  function destroyAll() {
    if (sleepTimer) clearTimeout(sleepTimer);
    sleepTimer = null;
    sleepingTabs.clear();
    pinnedTabs.clear();
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

  // --- Protection contre les sites dangereux (docs/safe-browsing.md) ---

  /** Page rouge « Site trompeur » / « logiciels malveillants » à la place du site, qui n'est pas chargé. */
  function showSafeBrowsingWarning(tabId, url, threat) {
    const entry = tabs.get(tabId);
    if (!entry) return;
    entry.pendingSafeCheck = null;
    const wc = entry.view.webContents;
    if (!wc.isDestroyed() && wc.isLoading()) wc.stop();
    console.warn(`[safe-browsing] site signalé (${threat}) bloqué dans l'onglet`);
    showErrorPage(tabId, {
      kind: 'safe-browsing',
      url,
      threat,
      token: randomUUID(),
      texts: safeBrowsingTexts,
    });
  }

  /**
   * Navigation du cadre principal vers `url` : true si elle est retenue (site dangereux, ou préfixe à
   * vérifier). Après une vérification sans danger, `resume()` relance la navigation. Jamais
   * bloquant : serveur injoignable → la page s'ouvre.
   */
  function guardMainNavigation(tabId, url, resume) {
    if (!safeBrowsing) return false;
    const safe = sanitizeBrowserUrl(url);
    if (!safe || !/^https?:/i.test(safe)) return false;
    const decision = safeBrowsing.classify(safe);
    if (decision.verdict === 'safe') return false;
    if (decision.verdict === 'dangerous') {
      showSafeBrowsingWarning(tabId, safe, decision.threat);
      return true;
    }
    const entry = tabs.get(tabId);
    if (!entry) return false;
    const view = entry.view;
    entry.pendingSafeCheck = safe;
    entry.url = safe;
    pushState(tabId);
    void safeBrowsing.check(safe).then((result) => {
      if (!isCurrentTabView(tabs, tabId, view) || entry.pendingSafeCheck !== safe) return;
      entry.pendingSafeCheck = null;
      if (result.verdict === 'dangerous') showSafeBrowsingWarning(tabId, safe, result.threat);
      else resume();
    });
    return true;
  }

  /**
   * Sous-cadre (iframe) : bloqué dès que son adresse est connue comme dangereuse. Un préfixe à
   * vérifier ne retient pas le cadre (on ne peut pas relancer sa navigation) : la vérification
   * part en arrière-plan et vaut pour la suite.
   */
  function guardSubframeNavigation(url) {
    if (!safeBrowsing) return false;
    const safe = sanitizeBrowserUrl(url);
    if (!safe || !/^https?:/i.test(safe)) return false;
    const decision = safeBrowsing.classify(safe);
    if (decision.verdict === 'check') void safeBrowsing.check(safe);
    if (decision.verdict === 'dangerous') {
      console.warn(`[safe-browsing] cadre signalé (${decision.threat}) bloqué`);
      return true;
    }
    return false;
  }

  /** Retour en lieu sûr : page précédente du site (pas la page d'avertissement), sinon l'onglet est fermé. */
  function leaveSafeBrowsingWarning(tabId) {
    const entry = tabs.get(tabId);
    if (!entry) return;
    const wc = entry.view.webContents;
    const history = wc.navigationHistory;
    if (history && typeof history.getActiveIndex === 'function') {
      for (let index = history.getActiveIndex() - 1; index >= 0; index -= 1) {
        const item = history.getEntryAtIndex(index);
        const url = item && sanitizeBrowserUrl(item.url);
        if (!url || (safeBrowsing && safeBrowsing.classify(url).verdict === 'dangerous')) continue;
        entry.errorPage = null;
        entry.url = url;
        history.goToIndex(index);
        return;
      }
    }
    // Rien avant (onglet ouvert pour ce lien) : fermé, le portail revient à l'onglet d'origine.
    destroyTab(tabId);
    emitToRenderer(CLOSED_CHANNEL, { tabId });
  }

  /** Clic sur la page d'avertissement (`#proceed-<jeton>` / `#back-<jeton>`). */
  function handleSafeBrowsingGesture(tabId, url) {
    const entry = tabs.get(tabId);
    if (!entry) return false;
    const gesture = safeBrowsingGesture(url, entry.errorPage);
    if (!gesture) return false;
    const blocked = entry.errorPage.url;
    if (gesture === 'proceed' && safeBrowsing) {
      // « Continuer vers ce site » : retenu pour ce site jusqu'à la fin de la session.
      safeBrowsing.allowForSession(blocked);
      navigate({ tabId, url: blocked });
    } else {
      leaveSafeBrowsingWarning(tabId);
    }
    return true;
  }

  function setSafeBrowsingTexts({ texts } = {}) {
    safeBrowsingTexts = cleanSafeBrowsingTexts(texts);
    return { ok: true };
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
    notifyExtensions('onTabCreated', wc);
    tabWindowGetters.set(webContentsId, getMainWindow);
    // Requêtes bloquées par le bloqueur : comptées par page, état poussé au plus deux fois par seconde.
    adblock.trackTab(webContentsId, () => {
      const entry = tabs.get(tabId);
      if (!entry || entry.view !== view) return;
      entry.adblockBlocked = (entry.adblockBlocked || 0) + 1;
      if (entry.adblockPushTimer) return;
      entry.adblockPushTimer = setTimeout(() => {
        entry.adblockPushTimer = null;
        if (!wc.isDestroyed()) pushState(tabId);
      }, ADBLOCK_PUSH_DELAY_MS);
    });
    wc.on('did-start-navigation', (details) => {
      if (!details || !details.isMainFrame || details.isSameDocument) return;
      const entry = tabs.get(tabId);
      if (entry && entry.view === view) entry.adblockBlocked = 0;
    });
    registerResponsiveRoute(webContentsId, (message) => handleResponsiveMessage(tabId, message));
    wirePictureInPicture(tabId, view);
    wc.once('destroyed', () => unregisterResponsiveRoute(webContentsId));
    // Comme le mode appareil de Chrome : fermer les DevTools rend la page à tout l'onglet.
    wc.on('devtools-closed', () => {
      void setResponsive(tabId, null);
    });

    const launchExternalApp = (url) =>
      externalApps.launch({ url, pageUrl: wc.getURL(), key: `tab:${tabId}` });

    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (launchExternalApp(url)) return { action: 'deny' };
      if (divertPortalUrl(url)) return { action: 'deny' };
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
      if (divertPortalUrl(url)) {
        event.preventDefault();
        return;
      }
      const safe = sanitizeBrowserUrl(url);
      if (!safe) {
        event.preventDefault();
        launchExternalApp(url);
      }
    });

    wc.on('will-redirect', (event, url) => {
      if (divertPortalUrl(url)) {
        event.preventDefault();
        return;
      }
      const safe = sanitizeBrowserUrl(url);
      if (!safe) {
        event.preventDefault();
        launchExternalApp(url);
        return;
      }
      // Redirection vers http : essayée d'abord en https (docs/security.md, « HTTPS d'abord »).
      if (event.isMainFrame !== false && httpsFirst) {
        const upgraded = httpsFirst.upgrade(safe);
        if (upgraded) {
          event.preventDefault();
          loadHttpsUpgrade(upgraded);
          return;
        }
      }
      // Redirection vers un site dangereux (docs/safe-browsing.md).
      if (event.isMainFrame === false) {
        if (guardSubframeNavigation(safe)) event.preventDefault();
        return;
      }
      if (guardMainNavigation(tabId, safe, () => !wc.isDestroyed() && void wc.loadURL(safe))) {
        event.preventDefault();
      }
    });

    // Lien suivi, formulaire envoyé ou script de la page, cadre principal et sous-cadres.
    wc.on('will-frame-navigate', (event) => {
      const url = event.url;
      if (!sanitizeBrowserUrl(url)) return;
      if (!event.isMainFrame) {
        if (guardSubframeNavigation(url)) event.preventDefault();
        return;
      }
      const upgraded = httpsFirst ? httpsFirst.upgrade(url) : null;
      if (upgraded) {
        event.preventDefault();
        loadHttpsUpgrade(upgraded);
        return;
      }
      if (guardMainNavigation(tabId, url, () => !wc.isDestroyed() && void wc.loadURL(url))) {
        event.preventDefault();
      }
    });

    // HTTPS d'abord (docs/security.md) : la navigation vers une page http d'un site public est
    // arrêtée avant toute requête et relancée en https (liens, formulaires, scripts, redirections ;
    // barre d'adresse et ouverture d'onglet : `upgradeHttp` dans `create` / `navigate`). Repli en
    // http si la version sécurisée échoue (did-fail-load) ou ne répond pas en 5 s. Jamais de
    // `loadURL` pendant un événement de navigation (plantage natif) : relancé au tour suivant.
    let httpsUpgradeTimer = null;
    const loadHttpsUpgrade = (target) => {
      setImmediate(() => {
        if (!wc.isDestroyed()) void wc.loadURL(target).catch(() => undefined);
      });
    };
    wc.on('did-start-navigation', (event) => {
      if (!httpsFirst || !event.isMainFrame || event.isSameDocument || !httpsFirst.isPending(event.url)) return;
      const target = event.url;
      if (httpsUpgradeTimer) clearTimeout(httpsUpgradeTimer);
      httpsUpgradeTimer = setTimeout(() => {
        httpsUpgradeTimer = null;
        if (wc.isDestroyed() || !httpsFirst.isPending(target)) return;
        const fallback = httpsFirst.fallbackFor(target);
        if (!fallback) return;
        wc.stop();
        void wc.loadURL(fallback).catch(() => undefined);
      }, HTTPS_UPGRADE_TIMEOUT_MS);
      if (typeof httpsUpgradeTimer.unref === 'function') httpsUpgradeTimer.unref();
    });
    wc.on('did-navigate', (_event, url) => {
      if (httpsFirst) httpsFirst.committed(url);
    });

    // Précédent / Suivant / Actualiser ne passent pas par les événements ci-dessus : arrêtés ici.
    wc.on('did-start-navigation', (event) => {
      if (!safeBrowsing || !event.isMainFrame || event.isSameDocument) return;
      const url = sanitizeBrowserUrl(event.url);
      const entry = tabs.get(tabId);
      if (!url || !entry || !isCurrentTabView(tabs, tabId, view) || entry.pendingSafeCheck) return;
      const decision = safeBrowsing.classify(url);
      if (decision.verdict === 'dangerous') {
        showSafeBrowsingWarning(tabId, url, decision.threat);
      } else if (decision.verdict === 'check') {
        void safeBrowsing.check(url).then((result) => {
          if (result.verdict !== 'dangerous' || !isCurrentTabView(tabs, tabId, view)) return;
          if (sanitizeBrowserUrl(wc.getURL()) === url || wc.isLoading()) showSafeBrowsingWarning(tabId, url, result.threat);
        });
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
      // Retour (Précédent) sur une page « Site dangereux » restée dans l'historique : elle reprend
      // son site et ses boutons.
      if (entry && !entry.errorPage) {
        const restored = safeBrowsingPageFromUrl(url);
        if (restored) {
          entry.errorPage = restored;
          entry.url = restored.url;
        }
      }
      passwords.onNavigate(tabId, url);
      formAutofill.onNavigate(tabId, url);
      applySiteZoom(wc, url);
      mediaCapturingWebContents.delete(webContentsId);
      historyStore.recordVisit(url, wc.getTitle());
      pushState(tabId);
    });
    wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame && handleSafeBrowsingGesture(tabId, url)) return;
      if (isMainFrame) historyStore.recordVisit(url, wc.getTitle());
      pushState(tabId);
    });
    wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      // La version https d'un site n'a pas répondu : la page s'ouvre en http (« Non sécurisé »).
      const httpFallback = httpsFirst ? httpsFirst.fallbackFor(validatedURL) : null;
      if (httpFallback && isCurrentTabView(tabs, tabId, view)) {
        loadHttpsUpgrade(httpFallback);
        return;
      }
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
      adblock.untrackTab(webContentsId);
      const adblockEntry = tabs.get(tabId);
      if (adblockEntry && adblockEntry.view === view && adblockEntry.adblockPushTimer) {
        clearTimeout(adblockEntry.adblockPushTimer);
        adblockEntry.adblockPushTimer = null;
      }
      tabIdsByWebContents.delete(webContentsId);
      mediaCapturingWebContents.delete(webContentsId);
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
      // Image dans l'image (docs/picture-in-picture.md), même pour une vidéo `blob:` (YouTube).
      if (params.mediaType === 'video' && !(params.mediaFlags && params.mediaFlags.canShowPictureInPicture === false)) {
        const showing = Boolean(params.mediaFlags && params.mediaFlags.isShowingPictureInPicture);
        template.push(
          {
            label: showing ? "Quitter l'image dans l'image" : "Image dans l'image",
            click: () => {
              if (showing) void exitVideoPip(tabId);
              else void enterVideoPip(tabId, { point: { x: params.x, y: params.y } });
            },
          },
          ...(sanitizeBrowserUrl(params.srcURL) ? [] : [separator]),
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
        // Le portail enregistre le PDF et affiche la notification (docs/zoom-and-pdf.md).
        ...(pdfReady ? [{ label: 'Enregistrer en PDF…', click: () => forwardCapture('save-pdf') }] : []),
        // Capture d'écran (docs/page-capture.md) : le portail enregistre et affiche la notification.
        ...(captureReady
          ? [
              { label: 'Capturer la page entière', click: () => forwardCapture('capture-full-page') },
              { label: 'Capturer la partie visible', click: () => forwardCapture('capture-visible') },
            ]
          : []),
        separator,
        // Entrées des extensions (chrome.contextMenus), comme Chrome : avant « Inspecter ».
        ...(() => {
          const items = notifyExtensions('contextMenuItems', wc, params);
          return Array.isArray(items) && items.length > 0 ? [...items, separator] : [];
        })(),
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

  /**
   * ⌘+ / ⌘- / ⌘0, molette, menu : niveau suivant de l'échelle de Chrome, retenu pour le site
   * de la page (les autres onglets du site suivent par `siteZoom.subscribe`).
   */
  function applyZoom(wc, direction) {
    const next = nextZoomFactor(wc.getZoomFactor(), direction);
    wc.setZoomFactor(next);
    siteZoom.set(wc.getURL(), next);
    return next;
  }

  /** Page chargée : le zoom retenu pour son site (100 % sans réglage), comme Chrome. */
  function applySiteZoom(wc, url) {
    if (wc.isDestroyed() || !zoomSiteOf(url)) return;
    const wanted = siteZoom.get(url);
    if (Math.abs((wc.getZoomFactor() || 1) - wanted) > 0.001) wc.setZoomFactor(wanted);
  }

  function browserTabWebPreferences() {
    return {
      session: getBrowserSession(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // Password manager runtime (main frame only, isolated world, exposes nothing to the
      // page): untrusted web content never reaches Electron APIs. Never in a private window.
      ...(privateMode ? {} : { preload: PASSWORD_PRELOAD }),
      allowRunningInsecureContent: false,
      spellcheck: true,
    };
  }

  function createView(tabId, initialUrl, { restore = null } = {}) {
    const view = new WebContentsView({ webPreferences: browserTabWebPreferences() });
    view.setBackgroundColor('#ffffff');
    const entry = {
      tabId,
      view,
      url: initialUrl,
      title: restore ? restore.title || '' : '',
      favicon: restore ? restore.favicon || null : null,
      abortedBlank: false,
      // Créée cachée : elle ne compte pour la veille qu'à partir de maintenant (select l'efface).
      hiddenSince: Date.now(),
      restore,
    };
    tabs.set(tabId, entry);
    ensureSleepTimer();
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
    // Contexte d'un profil (docs/browser-profiles.md) : la page attend la copie des anciens cookies.
    if (sessionReady) {
      await sessionReady.catch(() => undefined);
      if (wc.isDestroyed()) return;
    }
    const startedAt = Date.now();
    try {
      // Never let the identity step hold the tab: past the limit, the page
      // still opens (plain Chrome user agent only).
      // Sortie de veille : `about:blank` est la première entrée de l'historique rouvert (restore
      // n'est possible que sur une vue neuve), la page est atteinte ensuite par goToIndex.
      const restore = entry.restore;
      const history = wc.navigationHistory;
      const canRestore =
        restore &&
        Array.isArray(restore.entries) &&
        restore.entries.length > 0 &&
        history &&
        typeof history.restore === 'function';
      const firstLoad = canRestore
        ? history.restore({ entries: [{ url: 'about:blank', title: '' }, ...restore.entries], index: 0 }).then(
            () => {
              restore.historyRestored = true;
              return true;
            },
            (error) => {
              console.warn('[browser-tabs] history restore after sleep failed:', error && error.message);
              return true;
            },
          )
        : wc.loadURL('about:blank').then(
            () => true,
            () => true,
          );
      const blank = await withTimeout(firstLoad, IDENTITY_STEP_TIMEOUT_MS);
      if (!blank) console.warn('[browser-tabs] about:blank did not finish loading');
      if (wc.isDestroyed()) return;
      const applied = await withTimeout(applyChromeIdentity(wc, userAgent), IDENTITY_STEP_TIMEOUT_MS);
      if (!applied) console.warn(`[browser-tabs] chrome identity not applied after ${Date.now() - startedAt} ms`);
    } finally {
      entry.identityPending = false;
      const restore = entry.restore;
      entry.restore = null;
      if (!wc.isDestroyed() && !entry.abortedBlank) {
        const load = () => {
          if (wc.isDestroyed()) return;
          if (restore && restore.url === entry.url) void restoreSleptPage(wc, restore, entry);
          else void wc.loadURL(entry.url);
        };
        if (!guardMainNavigation(entry.tabId, entry.url, load)) load();
      }
    }
  }

  /**
   * Rouvre un onglet sorti de veille : son historique (retour / avancer) et l'état de la page
   * (défilement, champs) via `navigationHistory.restore`. Sinon, l'adresse puis le défilement relevé.
   */
  async function restoreSleptPage(wc, slept, entry) {
    if (typeof slept.muted === 'boolean') wc.setAudioMuted(slept.muted);
    const history = wc.navigationHistory;
    if (slept.historyRestored && history && typeof history.goToIndex === 'function') {
      try {
        // Entrée 0 = about:blank : la page est à index + 1, avec son état (défilement, champs).
        wc.once('did-navigate', () => {
          if (!wc.isDestroyed() && typeof history.removeEntryAtIndex === 'function') {
            try {
              history.removeEntryAtIndex(0);
            } catch (_) {
              // L'entrée blanche reste en tête : sans gravité.
            }
          }
        });
        history.goToIndex(slept.index + 1);
        wc.once('did-finish-load', () => {
          if (wc.isDestroyed()) return;
          // Zoom retenu pour le site (il a pu changer pendant la veille), sinon celui de l'onglet.
          applySiteZoom(wc, wc.getURL());
          // État de page sans défilement (pas encore enregistré par Chromium) : position relevée.
          const scroll = slept.scroll;
          if (scroll && scroll.y > 0) {
            const code = `if ((window.scrollY || 0) < 1) window.scrollTo(${Number(scroll.x) || 0}, ${Number(scroll.y) || 0})`;
            setTimeout(() => {
              if (!wc.isDestroyed()) void wc.executeJavaScriptInIsolatedWorld(SLEEP_WORLD_ID, [{ code }]).catch(() => {});
            }, 300);
          }
        });
        return;
      } catch (error) {
        console.warn('[browser-tabs] history entry after sleep failed:', error && error.message);
      }
    }
    if (wc.isDestroyed()) return;
    try {
      await wc.loadURL(entry.url);
    } catch (_) {
      // Échec de chargement : la page d'erreur de Lasco prend le relais (did-fail-load).
    }
    if (wc.isDestroyed()) return;
    const scroll = slept.scroll;
    if (scroll && (scroll.x > 0 || scroll.y > 0)) {
      const code = `window.scrollTo(${Number(scroll.x) || 0}, ${Number(scroll.y) || 0})`;
      // Contenu chargé tard (images, listes) : on réessaie un peu, sans insister.
      for (const wait of [0, 300, 1200]) {
        await delay(wait);
        if (wc.isDestroyed()) return;
        void wc.executeJavaScriptInIsolatedWorld(SLEEP_WORLD_ID, [{ code }]).catch(() => {});
      }
    }
    if (!wc.isDestroyed()) applySiteZoom(wc, wc.getURL());
  }

  // --- Incrustation vidéo et fenêtre d'appel (docs/picture-in-picture.md) ---

  /** Fenêtre flottante ouverte (une à la fois) : `{ tabId, float, kind, source }`, source auto-tab | auto-app | manual. */
  let floating = null;
  let pipTexts = normalizePipTexts(null);
  let pipTimer = null;
  let pipWindowListenersFor = null;
  /** Onglets dont l'incrustation vidéo a été ouverte par Lasco (refermée au retour), et pourquoi. */
  const autoVideoPip = new Map();

  function isFloatingView(view) {
    return Boolean(floating && view && tabs.get(floating.tabId) && tabs.get(floating.tabId).view === view);
  }

  function pictureInPictureOf(tabId, entry) {
    if (floating && floating.tabId === tabId) return floating.kind;
    return entry && entry.mediaProbe && entry.mediaProbe.videoPip ? 'video' : null;
  }

  function pipAutoEnabled() {
    try {
      return typeof getPictureInPictureAuto === 'function' ? getPictureInPictureAuto() !== false : true;
    } catch (_) {
      return true;
    }
  }

  async function probeMedia(tabId) {
    const entry = tabs.get(tabId);
    if (!entry) return null;
    const wc = entry.view.webContents;
    if (wc.isDestroyed() || entry.errorPage) return null;
    let probe = null;
    try {
      probe = await withTimeout(
        wc.executeJavaScriptInIsolatedWorld(PIP_WORLD_ID, [{ code: PAGE_MEDIA_PROBE_SCRIPT }]),
        SLEEP_PROBE_TIMEOUT_MS,
      );
    } catch (_) {
      probe = null;
    }
    if (tabs.get(tabId) !== entry || wc.isDestroyed()) return null;
    const before = `${Boolean(entry.inCall)}|${Boolean(entry.mediaProbe && entry.mediaProbe.video)}|${pictureInPictureOf(tabId, entry)}`;
    entry.mediaProbe = probe && typeof probe === 'object' ? probe : null;
    entry.inCall = isInCall({ capturingMedia: mediaCapturingWebContents.has(wc.id), probe: entry.mediaProbe });
    const after = `${Boolean(entry.inCall)}|${Boolean(entry.mediaProbe && entry.mediaProbe.video)}|${pictureInPictureOf(tabId, entry)}`;
    if (!entry.mediaProbe || !entry.mediaProbe.videoPip) autoVideoPip.delete(tabId);
    if (floating && floating.tabId === tabId) {
      floating.float.update({ title: wc.getTitle() || entry.title || '', controls: floatControlsState(entry.mediaProbe) });
      // Appel terminé dans la page (raccroché ailleurs) : l'incrustation se ferme d'elle-même.
      if (floating.kind === 'call' && !entry.inCall) {
        entry.callEndedProbes = (entry.callEndedProbes || 0) + 1;
        if (entry.callEndedProbes >= 2) closeFloat({ restore: true });
      } else {
        entry.callEndedProbes = 0;
      }
    }
    if (before !== after) pushState(tabId);
    return entry.mediaProbe;
  }

  /** Relevé toutes les 2 s des onglets qui ont le micro / la caméra, une lecture en cours, ou sont incrustés. */
  function ensurePipTimer() {
    if (pipTimer) return;
    pipTimer = setInterval(() => {
      if (tabs.size === 0) {
        clearInterval(pipTimer);
        pipTimer = null;
        return;
      }
      for (const [tabId, entry] of tabs) {
        const wc = entry.view.webContents;
        if (wc.isDestroyed()) continue;
        const watched = mediaCapturingWebContents.has(wc.id) || entry.mediaPlaying || entry.inCall
          || (entry.mediaProbe && entry.mediaProbe.videoPip) || (floating && floating.tabId === tabId);
        if (watched) void probeMedia(tabId);
      }
    }, 2000);
    if (pipTimer.unref) pipTimer.unref();
  }

  function wirePictureInPicture(tabId, view) {
    const wc = view.webContents;
    const current = () => {
      const entry = tabs.get(tabId);
      return entry && entry.view === view ? entry : null;
    };
    wc.on('media-started-playing', () => {
      const entry = current();
      if (!entry) return;
      entry.mediaPlaying = true;
      setTimeout(() => void probeMedia(tabId), 400);
    });
    wc.on('media-paused', () => {
      const entry = current();
      if (!entry) return;
      entry.mediaPlaying = false;
      void probeMedia(tabId);
    });
    wc.on('did-start-navigation', (details) => {
      if (!details || !details.isMainFrame || details.isSameDocument) return;
      const entry = current();
      if (!entry) return;
      entry.mediaPlaying = false;
      entry.mediaProbe = null;
      entry.inCall = false;
      entry.pipDismissed = false;
      autoVideoPip.delete(tabId);
      if (floating && floating.tabId === tabId) closeFloat({ restore: true });
    });
    ensurePipTimer();
    ensurePipWindowListeners();
  }

  async function enterVideoPip(tabId, { point = null, auto = null } = {}) {
    const entry = liveEntry(tabId);
    if (!entry) return { ok: false, error: 'unknown-tab' };
    const wc = entry.view.webContents;
    let result = null;
    try {
      // Geste utilisateur simulé : la page n'a pas à avoir appelé `requestPictureInPicture` elle-même.
      result = await withTimeout(wc.executeJavaScript(videoPipEnterScript(point), true), SLEEP_PROBE_TIMEOUT_MS);
    } catch (_) {
      result = null;
    }
    if (result && result.ok && auto) autoVideoPip.set(tabId, auto);
    await probeMedia(tabId);
    return result && result.ok ? { ok: true, pictureInPicture: 'video' } : { ok: false, error: (result && result.error) || 'failed' };
  }

  async function exitVideoPip(tabId) {
    const entry = tabs.get(tabId);
    autoVideoPip.delete(tabId);
    if (!entry || entry.view.webContents.isDestroyed()) return { ok: false, error: 'unknown-tab' };
    try {
      await withTimeout(entry.view.webContents.executeJavaScript(VIDEO_PIP_EXIT_SCRIPT, true), SLEEP_PROBE_TIMEOUT_MS);
    } catch (_) {
      // Page occupée : Chromium ferme l'incrustation à la navigation.
    }
    await probeMedia(tabId);
    return { ok: true, pictureInPicture: null };
  }

  /** Déplace la vue de l'onglet dans la fenêtre flottante. */
  function openFloat(tabId, { source, kind = 'call' }) {
    const entry = liveEntry(tabId);
    if (!entry) return { ok: false, error: 'unknown-tab' };
    if (floating && floating.tabId === tabId) return { ok: true, pictureInPicture: floating.kind };
    if (floating) closeFloat({ restore: true });
    const { createCallFloat } = require('./call-float');
    const view = entry.view;
    exitPageFullscreen(entry);
    detachView(view);
    const record = { tabId, kind, source, float: null };
    floating = record;
    // Tant qu'elle est dans la fenêtre flottante, la vue ne suit plus la fenêtre du portail (sélection d'un
    // autre onglet, menus de la coquille, redimensionnement) : seule la fenêtre flottante la place.
    pinViewToFloat(view);
    try {
      record.float = createCallFloat({
        view,
        parentWindow: getMainWindow(),
        onAction: (action) => void handleFloatAction(tabId, action),
        onClosed: () => {
          // Fermée par le système (fin de l'app, ⌘W) : la vue revient dans la fenêtre du portail.
          if (floating === record) {
            floating = null;
            restoreViewAfterFloat(tabId);
          }
        },
      });
    } catch (error) {
      floating = null;
      restoreViewAfterFloat(tabId);
      return { ok: false, error: error instanceof Error ? error.message : 'float-failed' };
    }
    const wc = view.webContents;
    record.float.update({
      kind,
      title: wc.getTitle() || entry.title || '',
      controls: floatControlsState(entry.mediaProbe),
      texts: pipTexts,
    });
    record.float.show();
    pushState(tabId);
    void probeMedia(tabId);
    return { ok: true, pictureInPicture: kind };
  }

  function pinViewToFloat(view) {
    view.setVisible = () => {};
    view.setBounds = () => {};
  }

  function unpinView(view) {
    delete view.setVisible;
    delete view.setBounds;
  }

  /** Remet la vue dans la fenêtre du portail : affichée si c'est l'onglet sélectionné, sinon cachée. */
  function restoreViewAfterFloat(tabId) {
    const entry = tabs.get(tabId);
    if (!entry) return;
    unpinView(entry.view);
    if (entry.view.webContents.isDestroyed()) return;
    if (viewsVisible && activeTabId === tabId) {
      attachView(entry.view);
      applyBounds(entry.view);
    } else {
      entry.view.setVisible(false);
    }
    pushState(tabId);
  }

  function closeFloat({ restore = true } = {}) {
    const record = floating;
    if (!record) return;
    floating = null;
    try {
      if (record.float) record.float.close();
    } catch (_) {
      // Fenêtre déjà fermée.
    }
    if (restore) restoreViewAfterFloat(record.tabId);
  }

  function focusTabInPortal(tabId) {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    // Le portail sélectionne l'onglet (même message que la recherche dans les onglets, docs/tab-windows.md).
    win.webContents.send('tab-window-tab-action', { tabId, action: 'select' });
  }

  async function handleFloatAction(tabId, action) {
    if (action === 'back') {
      closeFloat({ restore: true });
      focusTabInPortal(tabId);
      return;
    }
    if (action === 'close') {
      const entry = tabs.get(tabId);
      // Fermée à la main : plus d'incrustation automatique pour cet onglet jusqu'à ce qu'on y revienne.
      if (entry) entry.pipDismissed = true;
      closeFloat({ restore: true });
      return;
    }
    if (!CALL_CONTROLS.includes(action)) return;
    const entry = tabs.get(tabId);
    if (!entry || entry.view.webContents.isDestroyed()) return;
    try {
      await withTimeout(
        entry.view.webContents.executeJavaScriptInIsolatedWorld(PIP_WORLD_ID, [{ code: callControlScript(action) }]),
        SLEEP_PROBE_TIMEOUT_MS,
      );
    } catch (_) {
      // Bouton absent ou page occupée : le relevé suivant remet la barre à jour.
    }
    if (action === 'hangup') {
      closeFloat({ restore: true });
      return;
    }
    setTimeout(() => void probeMedia(tabId), 300);
  }

  /**
   * Incrustation automatique d'un onglet qu'on quitte (`reason` : tab = autre onglet ou page du portail,
   * app = autre application). Appel : fenêtre flottante ; vidéo avec du son : incrustation de la vidéo.
   */
  async function autoPictureInPicture(tabId, reason) {
    const entry = tabs.get(tabId);
    if (!entry || entry.pipDismissed || entry.view.webContents.isDestroyed()) return;
    if (!pipAutoEnabled()) return;
    const probe = await probeMedia(tabId);
    if (!tabs.get(tabId)) return;
    // Revenu entre-temps (aller-retour rapide) : rien à faire.
    if (reason === 'tab' && viewsVisible && activeTabId === tabId) return;
    if (reason === 'app' && !appInBackground()) return;
    const wc = entry.view.webContents;
    const kind = autoPipKind({
      enabled: true,
      inCall: entry.inCall,
      probe,
      audible: !wc.isDestroyed() && wc.isCurrentlyAudible() && !wc.isAudioMuted(),
      alreadyFloating: Boolean(floating && floating.tabId === tabId),
    });
    if (kind === 'call') openFloat(tabId, { source: reason === 'app' ? 'auto-app' : 'auto-tab' });
    else if (kind === 'video') await enterVideoPip(tabId, { auto: reason });
  }

  /** Retour sur l'onglet (sélection) : la fenêtre flottante et l'incrustation vidéo automatiques se ferment. */
  function returnFromPictureInPicture(tabId) {
    const entry = tabs.get(tabId);
    if (entry) entry.pipDismissed = false;
    if (floating && floating.tabId === tabId) {
      closeFloat({ restore: false });
      if (entry) unpinView(entry.view);
    }
    if (autoVideoPip.has(tabId)) void exitVideoPip(tabId);
  }

  /** Aucune fenêtre de Lasco n'a le focus : la personne est dans une autre application. */
  function appInBackground() {
    const focused = BrowserWindow.getFocusedWindow();
    return !focused;
  }

  function ensurePipWindowListeners() {
    const win = getMainWindow();
    if (!win || win.isDestroyed() || pipWindowListenersFor === win) return;
    pipWindowListenersFor = win;
    const leaveApp = () => {
      // Le focus passe parfois par une autre fenêtre de Lasco (incrustation, Réglages) : on attend un peu.
      setTimeout(() => {
        const shown = shownTabId();
        if (shown && !win.isDestroyed() && appInBackground()) void autoPictureInPicture(shown, 'app');
      }, 250);
    };
    win.on('blur', leaveApp);
    win.on('minimize', () => {
      const shown = shownTabId();
      if (shown) void autoPictureInPicture(shown, 'app');
    });
    win.on('focus', () => {
      // Retour dans Lasco : ce qui a été incrusté parce qu'on était parti dans une autre app revient.
      if (floating && floating.source === 'auto-app') closeFloat({ restore: true });
      for (const [tabId, reason] of autoVideoPip) {
        if (reason === 'app' && tabId === shownTabId()) void exitVideoPip(tabId);
      }
    });
  }

  /**
   * Bouton du portail et menu : `{ tabId, action?: 'toggle' | 'enter' | 'exit', mode?: 'auto' | 'page' }`.
   * `auto` (défaut) : appel en cours → fenêtre flottante, sinon la plus grande vidéo qui lit.
   * `page` (« Incruster l'onglet ») : toute la page dans la fenêtre flottante, sans rechargement.
   */
  async function pictureInPicture({ tabId, action = 'toggle', mode = 'auto' } = {}) {
    const entry = liveEntry(tabId);
    if (!entry) return { ok: false, error: 'unknown-tab' };
    if (!['toggle', 'enter', 'exit'].includes(action)) return { ok: false, error: 'invalid-action' };
    if (!['auto', 'page'].includes(mode)) return { ok: false, error: 'invalid-mode' };
    const current = pictureInPictureOf(tabId, entry);
    if (action === 'exit' || (action === 'toggle' && current)) {
      if (current === 'call' || current === 'page') closeFloat({ restore: true });
      else if (current === 'video') await exitVideoPip(tabId);
      return { ok: true, pictureInPicture: null };
    }
    if (current === 'video' && mode === 'page') await exitVideoPip(tabId);
    else if (current) return { ok: true, pictureInPicture: current };
    await probeMedia(tabId);
    if (entry.inCall) return openFloat(tabId, { source: 'manual', kind: 'call' });
    if (mode === 'page') {
      if (!sanitizeBrowserUrl(entry.view.webContents.getURL())) return { ok: false, error: 'not-web' };
      return openFloat(tabId, { source: 'manual', kind: 'page' });
    }
    return enterVideoPip(tabId);
  }

  function setPictureInPictureTexts({ texts } = {}) {
    pipTexts = normalizePipTexts(texts);
    if (floating) floating.float.update({ texts: pipTexts });
    return { ok: true };
  }

  // --- Mise en veille des onglets (docs/tab-sleep.md) ---

  function tabSleepDelayMs() {
    let settings = null;
    try {
      settings = typeof getTabSleepSettings === 'function' ? getTabSleepSettings() : null;
    } catch (_) {
      settings = null;
    }
    // `getTabSleepSettings` renvoie null quand la veille est coupée (mode VM).
    if (settings === null && typeof getTabSleepSettings === 'function') return 0;
    return resolveTabSleepDelayMs(settings);
  }

  function neverSleepSites() {
    try {
      const settings = typeof getTabSleepSettings === 'function' ? getTabSleepSettings() : null;
      return (settings && settings.tabSleepNeverSites) || [];
    } catch (_) {
      return [];
    }
  }

  /** Budget d'onglets vivants et épinglés (docs/many-tabs-perf.md). Null : veille coupée (mode VM). */
  function liveBudgetSettings() {
    let settings = null;
    try {
      settings = typeof getTabSleepSettings === 'function' ? getTabSleepSettings() : null;
    } catch (_) {
      settings = null;
    }
    if (!settings) return null;
    const { tabSleepMaxLive, tabSleepPinned } = normalizeTabSleepSettings(settings);
    return { maxLive: tabSleepMaxLive, sleepPinned: tabSleepPinned };
  }

  function sleepPinnedSetting() {
    const budget = liveBudgetSettings();
    return Boolean(budget && budget.sleepPinned);
  }

  function memoryPressure() {
    try {
      return isMemoryPressure(process.getSystemMemoryInfo());
    } catch (_) {
      return false;
    }
  }

  /**
   * Plus de `maxLive` onglets cachés éveillés : les plus anciennement quittés dorment sans attendre
   * le délai (docs/many-tabs-perf.md). Mémoire presque pleine : budget de 3, après 30 s.
   */
  async function runLiveBudgetCheck({ minHiddenMs } = {}) {
    const budget = liveBudgetSettings();
    if (!budget) return [];
    const pressure = memoryPressure();
    if (!(budget.maxLive > 0) && !pressure) return [];
    const candidates = [];
    for (const [tabId, entry] of tabs) {
      if (!entry.view.webContents.isDestroyed()) candidates.push(sleepCandidate(tabId, entry));
    }
    const options = {
      now: Date.now(),
      maxLive: budget.maxLive,
      pressure,
      activeTabId: shownTabId(),
      neverSites: neverSleepSites(),
      sleepPinned: budget.sleepPinned,
      ...(typeof minHiddenMs === 'number' ? { minHiddenMs } : {}),
    };
    const ids = selectTabsOverLiveBudget(candidates, options);
    const effectiveMinHidden = typeof minHiddenMs === 'number' ? minHiddenMs : pressure ? 30_000 : 120_000;
    const slept = [];
    for (const tabId of ids) {
      const result = await sleepTab(tabId, { delayMs: Math.max(1, effectiveMinHidden) });
      if (result && result.ok) slept.push(tabId);
    }
    return slept;
  }

  /** Relevé : le quart du délai, au plus 15 s quand un budget d'onglets vivants s'applique. */
  function sleepCheckIntervalMs(delayMs) {
    const base = tabSleepCheckIntervalMs(delayMs > 0 ? delayMs : 60_000);
    return liveBudgetSettings() ? Math.min(base, 15_000) : base;
  }

  function ensureSleepTimer() {
    if (sleepTimer || typeof getTabSleepSettings !== 'function') return;
    const tick = () => {
      sleepTimer = null;
      const delayMs = tabSleepDelayMs();
      // Veille après délai, puis budget d'onglets vivants (indépendant du délai, « Jamais » compris).
      void (delayMs > 0 ? runSleepCheck(delayMs) : Promise.resolve()).then(() => runLiveBudgetCheck());
      if (tabs.size > 0 || delayMs > 0) {
        sleepTimer = setTimeout(tick, sleepCheckIntervalMs(delayMs));
        if (sleepTimer.unref) sleepTimer.unref();
      }
    };
    sleepTimer = setTimeout(tick, sleepCheckIntervalMs(tabSleepDelayMs()));
    if (sleepTimer.unref) sleepTimer.unref();
  }

  function sleepCandidate(tabId, entry) {
    const wc = entry.view.webContents;
    return {
      tabId,
      url: wc.isDestroyed() ? '' : sanitizeBrowserUrl(wc.getURL()) || '',
      hiddenSince: entry.hiddenSince,
      audible: !wc.isDestroyed() && wc.isCurrentlyAudible(),
      htmlFullscreen: Boolean(entry.htmlFullscreen),
      agentControlled: agentControlled.has(tabId),
      hasOpener: Boolean(entry.hasOpener),
      devToolsOpened: !wc.isDestroyed() && wc.isDevToolsOpened(),
      loading: wc.isDestroyed() || wc.isLoading() || Boolean(entry.identityPending) || Boolean(entry.errorPage),
      capturingMedia: mediaCapturingWebContents.has(wc.id) || Boolean(entry.inCall),
      // En incrustation (fenêtre flottante ou vidéo) : jamais en veille.
      pictureInPicture: Boolean(pictureInPictureOf(tabId, entry)),
      pinned: pinnedTabs.has(tabId),
      discarded: false,
    };
  }

  /** Onglet affiché : celui sélectionné, tant que les vues sont visibles (pas une page du portail). */
  function shownTabId() {
    return viewsVisible ? activeTabId : null;
  }

  async function runSleepCheck(delayMs) {
    const now = Date.now();
    const candidates = [];
    for (const [tabId, entry] of tabs) {
      if (!entry.view.webContents.isDestroyed()) candidates.push(sleepCandidate(tabId, entry));
    }
    const ids = selectTabsToSleep(candidates, {
      now,
      delayMs,
      activeTabId: shownTabId(),
      neverSites: neverSleepSites(),
      sleepPinned: sleepPinnedSetting(),
    });
    for (const tabId of ids) await sleepTab(tabId, { delayMs });
  }

  /**
   * Met un onglet en veille : relève défilement et formulaire, garde son historique, détruit sa vue.
   * Refusé (false) si une raison de le garder éveillé apparaît entre-temps.
   */
  async function sleepTab(tabId, { delayMs = tabSleepDelayMs(), force = false } = {}) {
    const entry = liveEntry(tabId);
    if (!entry || entry.sleepPending) return { ok: false, error: 'unknown-tab' };
    entry.sleepPending = true;
    try {
      const wc = entry.view.webContents;
      let probe = null;
      try {
        probe = await withTimeout(
          wc.executeJavaScriptInIsolatedWorld(PRELOAD_WORLD_ID, [{ code: PAGE_SLEEP_PROBE_SCRIPT }]),
          SLEEP_PROBE_TIMEOUT_MS,
        );
      } catch (_) {
        probe = null;
      }
      if (tabs.get(tabId) !== entry || wc.isDestroyed()) return { ok: false, error: 'unknown-tab' };
      // Saisie en cours : on attend un nouveau délai avant de réessayer.
      if (probe && probe.dirty) {
        entry.hiddenSince = Date.now();
        return { ok: false, error: 'dirty-form' };
      }
      if (!force) {
        const blocker = tabSleepBlocker(sleepCandidate(tabId, entry), {
          now: Date.now(),
          delayMs,
          activeTabId: shownTabId(),
          neverSites: neverSleepSites(),
          sleepPinned: sleepPinnedSetting(),
        });
        if (blocker) return { ok: false, error: blocker };
      } else if (tabId === shownTabId()) {
        return { ok: false, error: 'active' };
      } else {
        // Même à la demande : jamais un onglet en appel ou en incrustation (docs/picture-in-picture.md).
        const candidate = sleepCandidate(tabId, entry);
        if (candidate.capturingMedia) return { ok: false, error: 'media' };
        if (candidate.pictureInPicture) return { ok: false, error: 'picture-in-picture' };
      }
      const history = wc.navigationHistory;
      let entries = [];
      let index = 0;
      try {
        entries = history && typeof history.getAllEntries === 'function' ? history.getAllEntries() : [];
        index = history && typeof history.getActiveIndex === 'function' ? history.getActiveIndex() : entries.length - 1;
      } catch (_) {
        entries = [];
      }
      // Pas de première page `about:blank` (chargée pour l'identité Chrome) dans l'historique rouvert.
      const firstReal = entries.findIndex((item) => sanitizeBrowserUrl(item && item.url));
      if (firstReal > 0) {
        entries = entries.slice(firstReal);
        index = Math.max(0, index - firstReal);
      }
      const state = buildState(tabId);
      if (!state || !sanitizeBrowserUrl(state.url)) return { ok: false, error: 'not-web' };
      sleepingTabs.set(tabId, {
        url: state.url,
        title: state.title,
        favicon: entry.favicon,
        entries: entries.every((item) => item && typeof item.url === 'string') ? entries : [],
        index: Math.min(Math.max(0, index), Math.max(0, entries.length - 1)),
        scroll: probe ? { x: Number(probe.scrollX) || 0, y: Number(probe.scrollY) || 0 } : null,
        zoomFactor: wc.getZoomFactor(),
        muted: wc.isAudioMuted(),
        sleptAt: Date.now(),
      });
      destroyTab(tabId);
      emitToRenderer(STATE_CHANNEL, sleepingState(tabId));
      return { ok: true, tabId };
    } finally {
      entry.sleepPending = false;
    }
  }

  /** Sort un onglet de veille : nouvelle vue, page et historique rouverts. Null s'il ne dort pas. */
  function wakeTab(tabId) {
    const slept = sleepingTabs.get(tabId);
    if (!slept) return null;
    const state = sleepingState(tabId);
    sleepingTabs.delete(tabId);
    const entry = createView(tabId, slept.url, { restore: slept });
    // Le portail affiche tout de suite l'onglet en chargement, sans lune.
    emitToRenderer(STATE_CHANNEL, { ...state, isLoading: true, discarded: false });
    return entry;
  }

  /** Onglet vivant, réveillé au besoin (agent, rechargement). */
  function liveOrWokenEntry(tabId) {
    return liveEntry(tabId) || (wakeTab(tabId) && liveEntry(tabId));
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
    tabs.set(tabId, {
      view,
      url,
      title: '',
      favicon: null,
      abortedBlank: false,
      identityPending: false,
      hiddenSince: Date.now(),
      // Fenêtre fille d'une page : jamais mise en veille (la détruire couperait `opener`).
      hasOpener: true,
    });
    ensureSleepTimer();
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
    if (divertPortalUrl(url)) return { ok: false, error: 'portal-url', diverted: true };
    const safe = upgradeHttp(sanitizeBrowserUrl(url));
    if (!safe) return { ok: false, error: 'invalid-url' };

    if (tabs.has(tabId)) {
      destroyTab(tabId);
    }
    // Coquille rechargée : un onglet en veille pour la même adresse se rouvre avec son historique.
    const slept = sleepingTabs.get(tabId);
    if (slept && slept.url === safe) {
      wakeTab(tabId);
      return { ok: true, tabId, url: safe };
    }
    sleepingTabs.delete(tabId);
    createView(tabId, safe);
    return { ok: true, tabId, url: safe };
  }

  /** HTTPS d'abord (docs/security.md) : adresse tapée ou ouverte, essayée en https. */
  function upgradeHttp(url) {
    if (!url || !httpsFirst) return url;
    return httpsFirst.upgrade(url) || url;
  }

  function navigate({ tabId, url }) {
    if (divertPortalUrl(url)) return { ok: false, error: 'portal-url', diverted: true };
    const entry = tabs.get(tabId);
    const safe = upgradeHttp(sanitizeBrowserUrl(url));
    if (!safe) return { ok: false, error: 'invalid-url' };
    if (!entry) {
      sleepingTabs.delete(tabId);
      return create({ tabId, url: safe });
    }
    entry.url = safe;
    entry.abortedBlank = false;
    entry.errorPage = null;
    entry.pendingSafeCheck = null;
    if (!entry.identityPending) {
      const wc = entry.view.webContents;
      const load = () => {
        if (!wc.isDestroyed()) void wc.loadURL(safe);
      };
      if (!guardMainNavigation(tabId, safe, load)) load();
    }
    if (viewsVisible && activeTabId === tabId) {
      entry.view.setVisible(!overlayActive);
      applyBounds(entry.view);
    }
    return { ok: true, tabId, url: safe };
  }

  function select({ tabId }) {
    if (typeof tabId === 'string' && !tabs.has(tabId)) wakeTab(tabId);
    if (typeof tabId !== 'string' || !tabs.has(tabId)) {
      return { ok: false, error: 'unknown-tab' };
    }
    if (activeTabId !== tabId) hideFieldPopovers();
    const leaving = viewsVisible && activeTabId !== tabId ? activeTabId : null;
    // Retour sur l'onglet incrusté : la vue revient dans la fenêtre (avant la boucle qui l'attache).
    returnFromPictureInPicture(tabId);
    activeTabId = tabId;
    viewsVisible = true;
    overlayActive = false;
    const now = Date.now();
    for (const [id, entry] of tabs) {
      const isActive = id === tabId;
      if (isActive) entry.hiddenSince = null;
      else if (typeof entry.hiddenSince !== 'number') entry.hiddenSince = now;
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
    const shown = tabs.get(tabId);
    if (shown && !shown.view.webContents.isDestroyed()) notifyExtensions('onTabSelected', shown.view.webContents);
    if (leaving) void autoPictureInPicture(leaving, 'tab');
    return { ok: true, tabId };
  }

  /**
   * Onglet ouvert par une extension (`chrome.tabs.create`, page d'options) : vue créée ici, adoptée
   * par le portail comme une fenêtre ouverte par une page (`adoptedTabId`). Renvoie son webContents.
   */
  function openExtensionTab({ url, active = true } = {}) {
    if (typeof url !== 'string' || !url) return null;
    if (divertPortalUrl(url)) return null;
    const tabId = `ext-${randomUUID()}`;
    const entry = createView(tabId, url);
    emitToRenderer(OPEN_REQUEST_CHANNEL, {
      url,
      openerTabId: activeTabId,
      adoptedTabId: tabId,
      disposition: active ? 'foreground-tab' : 'background-tab',
    });
    return entry.view.webContents;
  }

  function hide() {
    hideFieldPopovers();
    const leaving = viewsVisible ? activeTabId : null;
    viewsVisible = false;
    activeTabId = null;
    const now = Date.now();
    for (const entry of tabs.values()) {
      if (typeof entry.hiddenSince !== 'number') entry.hiddenSince = now;
      exitPageFullscreen(entry);
      entry.view.setVisible(false);
      detachView(entry.view);
    }
    // Une page du portail prend la place de l'onglet : comme un changement d'onglet.
    if (leaving) void autoPictureInPicture(leaving, 'tab');
    return { ok: true };
  }

  function close({ tabId }) {
    sleepingTabs.delete(tabId);
    pinnedTabs.delete(tabId);
    if (!tabs.has(tabId)) return { ok: true, tabId };
    destroyTab(tabId);
    return { ok: true, tabId };
  }

  /** Retour / avancer sur un onglet en veille : il se rouvre directement sur la page voulue. */
  function wakeAtOffset(tabId, offset) {
    const slept = sleepingTabs.get(tabId);
    if (!slept || !Array.isArray(slept.entries)) return false;
    const target = slept.index + offset;
    if (target < 0 || target >= slept.entries.length) return false;
    slept.index = target;
    slept.url = sanitizeBrowserUrl(slept.entries[target].url) || slept.url;
    slept.scroll = null;
    wakeTab(tabId);
    return true;
  }

  function goBack({ tabId }) {
    if (wakeAtOffset(tabId, -1)) return { ok: true };
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
    if (wakeAtOffset(tabId, 1)) return { ok: true };
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

  /**
   * Onglet web épinglé (docs/pinned-tabs.md) : `{ tabId, pinned, pinnedUrl }`, `pinnedUrl` = adresse à
   * l'épinglage. `pinned: false` (ou `pinnedUrl: null` sans `pinned`) le détache. Gardé hors de
   * l'entrée de l'onglet : il survit à la veille et à la recréation de la vue. Même appel que la garde
   * de l'économiseur de mémoire (`pinned`, perf/many-tabs) : à fusionner dans une seule fonction.
   */
  function setPinned({ tabId, pinned, pinnedUrl } = {}) {
    if (typeof tabId !== 'string' || !tabId || tabId.length > 200) return { ok: false, error: 'invalid-tab' };
    const url = pinned === false ? null : normalizePinnedUrl(pinnedUrl);
    if (url) pinnedUrls.set(tabId, url);
    else pinnedUrls.delete(tabId);
    return { ok: true, tabId, pinned: pinned === true || Boolean(url) };
  }

  /** Couper ou réactiver le son d'un onglet (icône haut-parleur, clic droit). */
  function setMuted({ tabId, muted }) {
    const slept = sleepingTabs.get(tabId);
    if (slept) {
      slept.muted = muted === true;
      emitToRenderer(STATE_CHANNEL, sleepingState(tabId));
      return { ok: true, muted: slept.muted };
    }
    const entry = tabs.get(tabId);
    if (!entry || entry.view.webContents.isDestroyed()) return { ok: false, error: 'unknown-tab' };
    entry.view.webContents.setAudioMuted(muted === true);
    pushState(tabId);
    return { ok: true, muted: entry.view.webContents.isAudioMuted() };
  }

  function reload({ tabId }) {
    if (!tabs.has(tabId) && wakeTab(tabId)) return { ok: true };
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
    return buildState(tabId) || sleepingState(tabId);
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

  /**
   * « Enregistrer en PDF » (docs/zoom-and-pdf.md) : la page telle que l'imprimerait Chrome
   * (feuilles de style d'impression, arrière-plans), A4 sauf taille déclarée par la page.
   * Renvoie le PDF au main, qui l'enregistre dans les Téléchargements.
   */
  async function renderPdf({ tabId }) {
    const entry = liveEntry(tabId);
    if (!entry) return { ok: false, error: 'unknown-tab' };
    if (entry.errorPage) return { ok: false, error: 'not-web' };
    const wc = entry.view.webContents;
    const url = sanitizeBrowserUrl(wc.getURL()) || entry.url || '';
    if (!url) return { ok: false, error: 'not-web' };
    try {
      const data = await wc.printToPDF({ printBackground: true, preferCSSPageSize: true, pageSize: 'A4' });
      return { ok: true, data, url, title: wc.getTitle() || '' };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'pdf-failed' };
    }
  }

  /** Le portail sait enregistrer un PDF : le menu contextuel le propose. */
  let pdfReady = false;
  function setPdfReady() {
    pdfReady = true;
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

  /**
   * Message du panneau « Responsive » des DevTools (docs/devtools-responsive.md) : seulement
   * pour un onglet de cette fenêtre dont les DevTools sont ouverts.
   */
  async function handleResponsiveMessage(tabId, message) {
    const entry = tabs.get(tabId);
    if (!entry || entry.view.webContents.isDestroyed()) return { ok: false, error: 'unknown-tab' };
    const wc = entry.view.webContents;
    if (!wc.isDevToolsOpened()) return { ok: false, error: 'devtools-closed' };
    if (message.op === 'set') await setResponsive(tabId, message.settings || {});
    else if (message.op === 'off') await setResponsive(tabId, null);
    else if (message.op !== 'get') return { ok: false, error: 'invalid' };
    return responsiveOf(entry).state();
  }

  function responsiveOf(entry) {
    if (!entry.responsive) {
      const wc = entry.view.webContents;
      entry.responsive = createTabResponsive({
        view: entry.view,
        getWindow: getMainWindow,
        restoreIdentity: () =>
          wc.isDestroyed()
            ? Promise.resolve()
            : wc.debugger.sendCommand('Emulation.setUserAgentOverride', chromeUserAgentOverride(userAgent)).catch(() => {}),
      });
    }
    return entry.responsive;
  }

  async function setResponsive(tabId, settings) {
    const entry = tabs.get(tabId);
    if (!entry || entry.view.webContents.isDestroyed()) return;
    if (!settings && !entry.responsive) return;
    const responsive = responsiveOf(entry);
    if (settings) await responsive.set(settings);
    else await responsive.off();
    if (entry.view.webContents.isDestroyed()) return;
    applyBounds(entry.view);
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
      threat: state.threat,
      permissions: describeSitePermissions(sitePermissions, origin),
      adblock: describeSiteAdblock(tabId, origin, state.url),
    };
  }

  /**
   * Ligne « Bloqueur » des informations du site. `enabled` : interrupteur global ; `siteEnabled` :
   * pas d'exception pour ce site ; `available` : false pour une page Lasco (jamais filtrée).
   */
  function describeSiteAdblock(tabId, origin, url) {
    const entry = tabs.get(tabId);
    return {
      available: !adblock.isProtected(url),
      enabled: adblock.settings.isEnabled(),
      siteEnabled: !adblock.settings.isSiteAllowed(origin),
      active: adblock.isActiveFor(url),
      blocked: (entry && entry.adblockBlocked) || 0,
    };
  }

  /** `enabled` false : exception pour le site (bloqueur coupé) ; la page est rechargée, comme Brave. */
  function setSiteAdblock({ tabId, enabled } = {}) {
    const origin = tabOrigin(tabId);
    if (!origin) return { ok: false, error: 'unknown-tab' };
    if (typeof enabled !== 'boolean') return { ok: false, error: 'invalid-value' };
    const before = adblock.settings.isSiteAllowed(origin);
    if (!adblock.settings.setSiteAllowed(origin, !enabled)) return { ok: false, error: 'invalid-site' };
    const entry = liveEntry(tabId);
    if (entry && before === enabled && !entry.errorPage) entry.view.webContents.reload();
    return siteInfo({ tabId });
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
    // Fenêtre privée : aucun site visité n'est retenu, même comme raccourci de recherche.
    if (privateMode || !searchEngines || wc.isDestroyed()) return;
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

  /**
   * Après une action : chargement fini, puis DOM calme (400 ms sans mutation, 3 s au plus), au lieu d'un délai fixe.
   * Chaque onglet piloté attend pour lui-même : plusieurs onglets d'agents avancent en parallèle (docs/agent-tabs.md).
   */
  async function waitForStablePage(wc) {
    await delay(120);
    await waitForLoadStop(wc, AGENT_SETTLE_MAX_MS);
    try {
      await runPageScript(wc, { op: 'settle', quietMs: AGENT_QUIET_MS, maxMs: AGENT_QUIET_MAX_MS });
    } catch (_) {
      // Navigation pendant l'attente : le document change, la fin du chargement suffit.
      await waitForLoadStop(wc, AGENT_SETTLE_MAX_MS);
    }
  }

  async function settleAndSnapshot(wc) {
    await waitForStablePage(wc);
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
  /** Onglet épinglé par le portail : gardé éveillé (sauf réglage « mettre aussi en veille les épinglés »). */
  function setPinned({ tabId, pinned } = {}) {
    if (typeof tabId !== 'string' || !tabId) return { ok: false, error: 'invalid-tab-id' };
    if (pinned === true) pinnedTabs.add(tabId);
    else pinnedTabs.delete(tabId);
    return { ok: true, tabId, pinned: pinnedTabs.has(tabId) };
  }

  function setAgentControl({ tabId, active }) {
    // Un agent reprend un onglet en veille : il se réveille (caché) pour être piloté.
    const entry = active === true ? liveOrWokenEntry(tabId) : liveEntry(tabId);
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

  /** Moteur CDP de l'onglet (docs/agent-actuation.md), recréé quand la vue change. */
  function agentCdpOf(entry) {
    const wc = entry.view.webContents;
    if (!entry.agentCdp || entry.agentCdpWc !== wc) {
      entry.agentCdp = createAgentCdp(wc);
      entry.agentCdpWc = wc;
    }
    return entry.agentCdp;
  }

  /** Fichier Lasco à déposer : téléchargé (http(s), 25 Mo au plus) dans un dossier temporaire, effacé après 10 min. */
  async function downloadAgentUpload(url, fileName) {
    let parsed;
    try {
      parsed = new URL(String(url || ''));
    } catch (_) {
      throw new AgentActionError('upload-failed');
    }
    const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) throw new AgentActionError('upload-failed');
    const response = await net.fetch(parsed.href, { redirect: 'follow' });
    if (!response.ok) throw new AgentActionError('upload-failed');
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > AGENT_MAX_UPLOAD_BYTES) throw new AgentActionError('file-too-large');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > AGENT_MAX_UPLOAD_BYTES) throw new AgentActionError('file-too-large');
    const safeName = String(fileName || 'fichier').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'fichier';
    const dir = fs.mkdtempSync(path.join(app.getPath('temp'), 'lasco-agent-upload-'));
    const file = path.join(dir, safeName);
    fs.writeFileSync(file, buffer, { mode: 0o600 });
    setTimeout(() => fs.rm(dir, { recursive: true, force: true }, () => {}), 10 * 60_000).unref?.();
    return file;
  }

  function agentFailure(error) {
    if (error instanceof AgentActionError) {
      const hint = AGENT_ERROR_HINTS[error.code];
      return { ok: false, error: error.code, ...(hint ? { message: hint } : {}), ...error.details };
    }
    return null;
  }

  /**
   * AI agent browser automation on one tab (docs/agent-actuation.md). CDP engine: accessibility tree with
   * stable refs, real input events, wait for stability, guard on writes and sensitive fields. Returns the
   * new page state after every action. The legacy DOM engine (agent-dom.js) stays as a fallback.
   */
  async function agentAction(payload) {
    const { tabId, action } = payload || {};
    const entry = liveOrWokenEntry(tabId);
    if (!entry) return { ok: false, error: 'unknown-tab' };
    const wc = entry.view.webContents;
    // Page d'une extension (coffre d'un gestionnaire de mots de passe, réglages…) : jamais lue ni
    // pilotée par un agent (docs/extensions.md).
    if (!wc.isDestroyed() && /^chrome-extension:/i.test(wc.getURL())) return { ok: false, error: 'extension-page' };
    const guard = payload && payload.guard && typeof payload.guard === 'object' ? payload.guard : null;
    if (payload && payload.engine === 'dom') return legacyAgentAction(payload);
    const cdp = agentCdpOf(entry);
    try {
      switch (action) {
        case 'snapshot': {
          await waitForLoadStop(wc, AGENT_SETTLE_MAX_MS);
          const page = await cdp.snapshot({
            maxElements: payload.maxElements,
            maxText: payload.maxText,
            includeText: payload.includeText !== false,
          });
          return { ok: true, page };
        }
        case 'screenshot':
        case 'wait':
          return action === 'wait' ? await cdp.wait(payload.ms) : legacyAgentAction(payload);
        case 'click': {
          if (typeof payload.ref === 'string' && payload.ref) {
            return await withPageFocus(wc, () => cdp.click(payload.ref, { doubleClick: Boolean(payload.doubleClick), guard }), tabId);
          }
          const point = await resolvePoint(entry, payload);
          if (!point.ok) return point;
          const zoomFactor = wc.getZoomFactor() || 1;
          // DIP de la vue → CSS px de la page.
          return await withPageFocus(wc, () => cdp.clickPoint({ x: point.x / zoomFactor, y: point.y / zoomFactor }, { guard }), tabId);
        }
        case 'hover':
          return await cdp.hover(payload.ref);
        case 'type':
          return await withPageFocus(
            wc,
            () => cdp.type(payload.ref, typeof payload.text === 'string' ? payload.text : '', {
              clear: payload.ref ? payload.clear !== false : Boolean(payload.clear),
              submit: Boolean(payload.submit),
              guard,
            }),
            tabId,
          );
        case 'press':
          return await withPageFocus(wc, () => cdp.press(payload.key, { ref: payload.ref, guard }), tabId);
        case 'scroll':
          return await cdp.scroll({ ref: payload.ref, direction: payload.direction, amount: payload.amount });
        case 'select_option':
          return await cdp.select(payload.ref, payload.value);
        case 'upload': {
          // Garde d'abord (sans télécharger le fichier pour rien), puis dépôt.
          if (guard && guard.writeGate && guard.approved !== true) {
            return await cdp.upload(payload.ref, '', { guard });
          }
          const file = await downloadAgentUpload(payload.url, payload.fileName);
          return await cdp.upload(payload.ref, file, { guard });
        }
        case 'dialog':
          return cdp.planDialog({ accept: payload.accept === true, text: payload.text, message: payload.message, guard });
        default:
          return { ok: false, error: 'unknown-action' };
      }
    } catch (error) {
      const failure = agentFailure(error);
      if (failure) return failure;
      // CDP indisponible (débogueur pris par un autre outil, ancien Chromium) : moteur DOM.
      if (['snapshot', 'click', 'type', 'press', 'scroll', 'select_option'].includes(action) && !wc.isDestroyed()) {
        if (guard && guard.writeGate && guard.approved !== true && (action === 'click' || action === 'press' || (action === 'type' && payload.submit))) {
          return { ok: false, error: 'engine-unavailable', message: "Moteur de pilotage indisponible sur cette page : l'action d'écriture n'est pas faite. Réessaie dans un instant." };
        }
        return legacyAgentAction(payload);
      }
      return { ok: false, error: error instanceof Error ? error.message : 'agent-action-failed' };
    }
  }

  async function legacyAgentAction(payload) {
    const { tabId, action } = payload || {};
    const entry = liveOrWokenEntry(tabId);
    if (!entry) return { ok: false, error: 'unknown-tab' };
    const wc = entry.view.webContents;

    try {
      switch (action) {
        case 'snapshot': {
          await waitForStablePage(wc);
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

  const api = {
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
    setPinned,
    setSafeBrowsingTexts,
    stop,
    setBounds,
    getState,
    zoom,
    findInPage,
    stopFindInPage,
    print,
    renderPdf,
    setPdfReady,
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
    setSiteAdblock,
    historySuggest,
    historyList,
    historyRemove,
    historyClear,
    setOverlay,
    agentAction,
    setAgentControl,
    setPinned,
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
    openExtensionTab,
    /** Onglet d'un webContents (extensions : chrome.tabs.update / remove). */
    tabIdOfWebContents(webContents) {
      if (!webContents || webContents.isDestroyed()) return null;
      for (const [id, entry] of tabs) if (entry.view.webContents === webContents) return id;
      return null;
    },
    /** Session des onglets web de la fenêtre (créée et configurée au premier appel). */
    browserSession: () => getBrowserSession(),
    webContentsOf(tabId) {
      const entry = tabs.get(tabId);
      return entry && !entry.view.webContents.isDestroyed() ? entry.view.webContents : null;
    },
    stateOf: (tabId) => buildState(tabId),
    // Incrustation vidéo et fenêtre d'appel (docs/picture-in-picture.md).
    pictureInPicture,
    setPictureInPictureTexts,
    /** Mise en veille (docs/tab-sleep.md) : `sleep` met un onglet en veille tout de suite (menu, tests). */
    sleep: ({ tabId } = {}) => sleepTab(tabId, { force: true }),
    isSleeping: (tabId) => sleepingTabs.has(tabId),
    sleepingTabIds: () => [...sleepingTabs.keys()],
    /** Budget d'onglets vivants (docs/many-tabs-perf.md) ; `minHiddenMs` pour le banc et les tests. */
    runLiveBudgetCheck: (options) => runLiveBudgetCheck(options),
    runSleepCheck: () => {
      const delayMs = tabSleepDelayMs();
      return delayMs > 0 ? runSleepCheck(delayMs) : Promise.resolve();
    },
  };
  if (privateMode) {
    // Fenêtre privée : ni mots de passe, ni saisie automatique, ni agent, ni historique du navigateur normal.
    for (const method of PRIVATE_DENIED_TAB_METHODS) {
      if (typeof api[method] === 'function') api[method] = () => ({ ok: false, error: 'private-window' });
    }
  }
  api.isPrivate = privateMode;
  /** Fenêtre passée à un autre profil ou un autre workspace : vues détruites, plus aucun abonnement. */
  api.dispose = () => {
    destroyAll();
    stopAdblockListener();
  };
  /** Fermeture d'une fenêtre privée : vues détruites, puis cookies, cache et stockage de sa session effacés. */
  api.destroySession = async () => {
    destroyAll();
    if (privateMode) await wipePrivateSession(session.fromPartition(browserPartition));
  };
  return api;
}

module.exports = {
  createBrowserTabManager,
  sharedSitePermissions,
  sharedExternalAppPermissions,
  sharedAdblock,
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
