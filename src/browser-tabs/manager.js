'use strict';

const { app, WebContentsView, session, clipboard, ClipboardItem, shell, dialog, Menu } = require('electron');
const { sanitizeBrowserUrl } = require('./url');
const { buildPageAgentScript } = require('./agent-dom');

const BROWSER_PARTITION = 'persist:browser-tabs';
const STATE_CHANNEL = 'browser-tab-state';
const OPEN_REQUEST_CHANNEL = 'browser-tab-open-request';
const FIND_RESULT_CHANNEL = 'browser-tab-find-result';
const SHORTCUT_CHANNEL = 'browser-tab-shortcut';

/** Chrome's zoom ladder. */
const ZOOM_LEVELS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const AGENT_WORLD_ID = 1001;
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
function createBrowserTabManager({ getMainWindow }) {
  const userAgent = buildChromiumUserAgent();
  let sessionConfigured = false;

  /** @type {Map<string, { view: import('electron').WebContentsView, url: string }>} */
  const tabs = new Map();
  let activeTabId = null;
  /** @type {{ x: number, y: number, width: number, height: number } | null} */
  let lastBounds = null;
  let viewsVisible = false;
  /** Portal HTML overlay (menu, dialog) is open above the viewport: keep the native view hidden. */
  let overlayActive = false;

  function getBrowserSession() {
    const browserSession = session.fromPartition(BROWSER_PARTITION);
    if (!sessionConfigured) {
      sessionConfigured = true;
      browserSession.setUserAgent(userAgent, buildAcceptLanguages(app.getPreferredSystemLanguages()));
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
    const url = sanitizeBrowserUrl(wc.getURL()) || entry.url || '';
    const history = wc.navigationHistory;
    return {
      tabId,
      url,
      title: wc.getTitle() || entry.title || url || 'Nouvel onglet',
      favicon: entry.favicon || null,
      canGoBack: history ? history.canGoBack() : wc.canGoBack(),
      canGoForward: history ? history.canGoForward() : wc.canGoForward(),
      isLoading: wc.isLoading(),
      zoomFactor: wc.getZoomFactor(),
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

  function applyBounds(view) {
    if (!lastBounds || !view) return;
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
    if (activeTabId === tabId) activeTabId = null;
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

  function destroyAll() {
    for (const tabId of [...tabs.keys()]) {
      destroyTab(tabId);
    }
    activeTabId = null;
    viewsVisible = false;
  }

  function wireWebContents(tabId, view) {
    const wc = view.webContents;

    wc.setWindowOpenHandler(({ url }) => {
      const safe = sanitizeBrowserUrl(url);
      if (safe) {
        emitToRenderer(OPEN_REQUEST_CHANNEL, { url: safe, openerTabId: tabId });
      }
      return { action: 'deny' };
    });

    wc.on('will-navigate', (event, url) => {
      const safe = sanitizeBrowserUrl(url);
      if (!safe) {
        event.preventDefault();
      }
    });

    wc.on('will-redirect', (event, url) => {
      const safe = sanitizeBrowserUrl(url);
      if (!safe) {
        event.preventDefault();
      }
    });

    wc.on('page-title-updated', () => pushState(tabId));
    wc.on('page-favicon-updated', (_event, favicons) => {
      const entry = tabs.get(tabId);
      if (!entry) return;
      entry.favicon = Array.isArray(favicons) && favicons[0] ? favicons[0] : null;
      pushState(tabId);
    });
    wc.on('did-start-loading', () => pushState(tabId));
    wc.on('did-stop-loading', () => pushState(tabId));
    wc.on('did-navigate', () => pushState(tabId));
    wc.on('did-navigate-in-page', () => pushState(tabId));
    wc.on('did-fail-load', (_event, errorCode, _errorDescription, _validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      pushState(tabId);
    });
    wc.on('destroyed', () => {
      if (tabs.has(tabId)) {
        tabs.delete(tabId);
        if (activeTabId === tabId) activeTabId = null;
      }
    });

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
      if (input.type !== 'keyDown' || input.alt) return;
      const mod = process.platform === 'darwin' ? input.meta : input.control;
      if (!mod) return;
      const key = String(input.key || '').toLowerCase();
      const forward = (action) => emitToRenderer(SHORTCUT_CHANNEL, { tabId, action });
      const handlers = {
        f: () => forward('find'),
        g: () => forward(input.shift ? 'find-previous' : 'find-next'),
        l: () => forward('focus-address'),
        t: () => forward('new-tab'),
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
      if (!handler || (input.shift && !['g', '=', '+'].includes(key))) return;
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
        if (safe) emitToRenderer(OPEN_REQUEST_CHANNEL, { url: safe, openerTabId: tabId });
      };

      if (params.linkURL && sanitizeBrowserUrl(params.linkURL)) {
        template.push(
          { label: 'Ouvrir le lien dans un nouvel onglet', click: () => openInNewTab(params.linkURL) },
          { label: "Copier l'adresse du lien", click: () => void clipboard.writeText(params.linkURL) },
          separator,
        );
      }
      if (params.mediaType === 'image' && params.srcURL) {
        template.push(
          { label: "Ouvrir l'image dans un nouvel onglet", click: () => openInNewTab(params.srcURL) },
          { label: "Copier l'image", click: () => wc.copyImageAt(params.x, params.y) },
          { label: "Copier l'adresse de l'image", click: () => void clipboard.writeText(params.srcURL) },
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
            label: `Rechercher « ${preview} » sur Google`,
            click: () => openInNewTab(`https://www.google.com/search?q=${encodeURIComponent(selection)}`),
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

  function createView(tabId, initialUrl) {
    const view = new WebContentsView({
      webPreferences: {
        session: getBrowserSession(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        // No preload — untrusted web content must not reach Electron APIs.
        allowRunningInsecureContent: false,
      },
    });
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
    void view.webContents.loadURL(initialUrl);
    return entry;
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
    void entry.view.webContents.loadURL(safe);
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
        entry.view.setVisible(false);
        detachView(entry.view);
      }
    }
    pushState(tabId);
    return { ok: true, tabId };
  }

  function hide() {
    viewsVisible = false;
    activeTabId = null;
    for (const entry of tabs.values()) {
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

  function reload({ tabId }) {
    const entry = tabs.get(tabId);
    if (!entry || entry.view.webContents.isDestroyed()) {
      return { ok: false, error: 'unknown-tab' };
    }
    const wc = entry.view.webContents;
    const current = wc.getURL();
    entry.abortedBlank = false;
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
    lastBounds = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height)),
    };
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
    return { ok: true };
  }

  function setOverlay({ active }) {
    overlayActive = Boolean(active);
    if (!viewsVisible || !activeTabId) return { ok: true };
    const entry = tabs.get(activeTabId);
    if (!entry) return { ok: true };
    if (overlayActive) {
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

  /** Give synthetic input to the page, then hand keyboard focus back to the portal (chat composer). */
  async function withPageFocus(wc, fn) {
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
          });
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
          });
          return { ok: true, page: await settleAndSnapshot(wc) };
        }
        case 'press': {
          const combo = parseKeyCombo(payload.key);
          if (!combo) return { ok: false, error: 'invalid-key' };
          await withPageFocus(wc, async () => sendKey(wc, combo));
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

  return {
    create,
    navigate,
    select,
    hide,
    close,
    goBack,
    goForward,
    reload,
    stop,
    setBounds,
    getState,
    zoom,
    findInPage,
    stopFindInPage,
    print,
    capture,
    copyScreenshot,
    openExternal,
    openDevTools,
    clearBrowsingData,
    setOverlay,
    agentAction,
    destroyAll,
    has(tabId) {
      return tabs.has(tabId);
    },
  };
}

module.exports = {
  createBrowserTabManager,
  STATE_CHANNEL,
  OPEN_REQUEST_CHANNEL,
  FIND_RESULT_CHANNEL,
  SHORTCUT_CHANNEL,
  BROWSER_PARTITION,
  parseKeyCombo,
  nextZoomFactor,
  buildChromiumUserAgent,
  buildAcceptLanguages,
};
