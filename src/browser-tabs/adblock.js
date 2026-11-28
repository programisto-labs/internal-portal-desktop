'use strict';

/**
 * Bloqueur de pubs et de traqueurs des onglets web (docs/adblock.md).
 *
 * Moteur Ghostery (`@ghostery/adblocker`), listes EasyList + EasyPrivacy (et les listes uBlock
 * associées), filtres réseau et cosmétiques. Le moteur est téléchargé et compilé dans un worker
 * (`adblock-worker.js`), gardé sur le disque (userData/adblock) et rafraîchi au plus une fois par
 * jour : le démarrage ne l'attend jamais. Appliqué à la seule session des onglets web
 * (`persist:browser-tabs`), jamais à `persist:portal` ni aux pages de Lasco.
 *
 * Interrupteur global (activé par défaut) et exceptions par site, gardés dans
 * userData/browser-adblock.json.
 */

const fs = require('fs');
const path = require('path');
const { siteOrigin, siteHost } = require('./site-permissions');
const { webRequestHub } = require('./web-request-hub');

const DAY_MS = 24 * 60 * 60 * 1000;
/** Un téléchargement raté est retenté au plus tôt une heure plus tard. */
const RETRY_MS = 60 * 60 * 1000;
/** Vérification périodique de l'âge des listes (application ouverte des jours durant). */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

const ENGINE_FILE = 'engine.bin';
const META_FILE = 'engine.json';

/** Version du moteur : un cache compilé par une autre version est rejeté. */
function engineVersion() {
  try {
    return require('@ghostery/adblocker/package.json').version;
  } catch (_) {
    return 'unknown';
  }
}

/**
 * Réglages : `{ version: 1, enabled: true, allowedOrigins: ["https://exemple.fr"] }`.
 * `allowedOrigins` : sites où le bloqueur est coupé (exception, comme les boucliers de Brave).
 */
function createAdblockSettingsStore({ filePath, fsImpl = fs } = {}) {
  let state = null;
  const listeners = new Set();

  function load() {
    if (state) return state;
    state = { enabled: true, allowed: new Set() };
    if (!filePath) return state;
    try {
      const raw = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
      if (raw && raw.enabled === false) state.enabled = false;
      for (const origin of Array.isArray(raw && raw.allowedOrigins) ? raw.allowedOrigins : []) {
        if (typeof origin === 'string' && siteOrigin(origin) === origin) state.allowed.add(origin);
      }
    } catch (_) {
      // Fichier absent ou illisible : activé, sans exception.
    }
    return state;
  }

  function save() {
    if (!filePath) return;
    try {
      fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      fsImpl.writeFileSync(
        tmp,
        JSON.stringify({ version: 1, enabled: state.enabled, allowedOrigins: [...state.allowed].sort() }),
      );
      fsImpl.renameSync(tmp, filePath);
    } catch (_) {
      // Non enregistré : le réglage reste en mémoire jusqu'au redémarrage.
    }
  }

  function changed() {
    save();
    for (const listener of listeners) {
      try {
        listener();
      } catch (_) {
        // un abonné en erreur ne bloque pas les autres
      }
    }
  }

  return {
    isEnabled() {
      return load().enabled;
    },
    setEnabled(enabled) {
      if (typeof enabled !== 'boolean') return false;
      if (load().enabled === enabled) return true;
      state.enabled = enabled;
      changed();
      return true;
    },
    /** Exception : le bloqueur est coupé sur ce site. */
    isSiteAllowed(origin) {
      return Boolean(origin) && load().allowed.has(origin);
    },
    /** `allowed` true : couper le bloqueur sur ce site ; false : le réactiver. */
    setSiteAllowed(origin, allowed) {
      if (typeof origin !== 'string' || siteOrigin(origin) !== origin || typeof allowed !== 'boolean') return false;
      const set = load().allowed;
      if (set.has(origin) === allowed) return true;
      if (allowed) set.add(origin);
      else set.delete(origin);
      changed();
      return true;
    },
    /** `[{ origin, host }]` triés par hôte. */
    listSites() {
      return [...load().allowed]
        .map((origin) => ({ origin, host: siteHost(origin) }))
        .sort((a, b) => a.host.localeCompare(b.host) || a.origin.localeCompare(b.origin));
    },
    clearSites() {
      if (!load().allowed.size) return;
      state.allowed.clear();
      changed();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Chargement du moteur : cache disque d'abord, puis téléchargement en arrière-plan si les listes ont
 * plus d'un jour (ou pas de cache). `compile()` → Promise<Uint8Array> (moteur sérialisé, fait par le
 * worker) ; `deserialize(bytes)` → moteur (ElectronBlocker).
 */
function createAdblockEngineLoader({
  cacheDir,
  compile,
  deserialize,
  fsImpl = fs.promises,
  now = () => Date.now(),
  version = engineVersion(),
  maxAgeMs = DAY_MS,
  retryMs = RETRY_MS,
  log = (...args) => console.warn('[adblock]', ...args),
} = {}) {
  let engine = null;
  let fetchedAt = 0;
  let lastAttemptAt = 0;
  let refreshing = null;
  let started = null;
  const listeners = new Set();

  const enginePath = () => path.join(cacheDir, ENGINE_FILE);
  const metaPath = () => path.join(cacheDir, META_FILE);

  function setEngine(next) {
    engine = next;
    for (const listener of listeners) {
      try {
        listener(engine);
      } catch (_) {
        // abonné en erreur
      }
    }
  }

  async function loadCache() {
    try {
      const meta = JSON.parse(await fsImpl.readFile(metaPath(), 'utf8'));
      if (!meta || meta.version !== version) return false;
      const bytes = await fsImpl.readFile(enginePath());
      setEngine(deserialize(new Uint8Array(bytes)));
      fetchedAt = Number(meta.fetchedAt) || 0;
      return true;
    } catch (_) {
      return false;
    }
  }

  async function writeCache(bytes, at) {
    try {
      await fsImpl.mkdir(cacheDir, { recursive: true });
      const tmp = `${enginePath()}.tmp`;
      await fsImpl.writeFile(tmp, bytes);
      await fsImpl.rename(tmp, enginePath());
      await fsImpl.writeFile(metaPath(), JSON.stringify({ version, fetchedAt: at }));
    } catch (error) {
      log('cache not written', error && error.message);
    }
  }

  /** Télécharge et compile les listes (une seule fois à la fois). Le moteur en place reste en cas d'échec. */
  function refresh() {
    if (refreshing) return refreshing;
    lastAttemptAt = now();
    refreshing = (async () => {
      try {
        const bytes = await compile();
        const next = deserialize(bytes);
        const at = now();
        setEngine(next);
        fetchedAt = at;
        await writeCache(bytes, at);
        return true;
      } catch (error) {
        log('lists not updated', error && error.message);
        return false;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  function isStale() {
    return !engine || now() - fetchedAt >= maxAgeMs;
  }

  /** Rafraîchit si les listes ont plus d'un jour, sauf échec récent. */
  function maybeRefresh() {
    if (!isStale() || refreshing) return refreshing || Promise.resolve(false);
    if (lastAttemptAt && now() - lastAttemptAt < retryMs) return Promise.resolve(false);
    return refresh();
  }

  return {
    /** Cache puis rafraîchissement : jamais attendu par le démarrage. */
    start() {
      if (!started) {
        started = (async () => {
          await loadCache();
          await maybeRefresh();
        })();
      }
      return started;
    },
    refresh,
    maybeRefresh,
    getEngine: () => engine,
    getFetchedAt: () => fetchedAt,
    onEngine(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Requête d'Electron → requête Ghostery. `pageUrl` : page affichée par l'onglet. */
function buildEngineRequest(Request, details, pageUrl) {
  const frameUrl = details.frame && typeof details.frame.url === 'string' ? details.frame.url : '';
  const sourceUrl = (frameUrl && /^https?:/.test(frameUrl) ? frameUrl : '') || pageUrl || details.referrer || '';
  return Request.fromRawDetails({
    _originalRequestDetails: details,
    requestId: `${details.id}`,
    sourceUrl,
    tabId: details.webContentsId,
    type: details.resourceType || 'other',
    url: details.url,
  });
}

/**
 * Décide si le bloqueur s'applique à une page : activé, page web http(s), pas une page Lasco,
 * pas d'exception pour son site.
 */
function adblockActiveFor({ settings, isProtectedUrl }, pageUrl) {
  if (!settings.isEnabled()) return false;
  const origin = siteOrigin(pageUrl);
  if (!origin) return false;
  if (isProtectedUrl && isProtectedUrl(pageUrl)) return false;
  return !settings.isSiteAllowed(origin);
}

/**
 * Gestionnaire `onBeforeRequest` de la session des onglets web.
 * `pageUrlFor(webContentsId)` : adresse de la page de l'onglet ; `onBlocked(webContentsId, details)`.
 */
function createAdblockRequestFilter({ getEngine, settings, isProtectedUrl, pageUrlFor, onBlocked, Request }) {
  return function onBeforeRequest(details, callback) {
    try {
      if (!details || details.resourceType === 'mainFrame') return callback({});
      const engine = getEngine();
      if (!engine || !settings.isEnabled()) return callback({});
      if (!/^(https?|wss?):/i.test(details.url || '')) return callback({});
      if (isProtectedUrl && isProtectedUrl(details.url)) return callback({});
      // Requête sans onglet (service worker, préchargement) : la page est inconnue, rien n'est bloqué.
      const pageUrl = details.webContentsId ? pageUrlFor(details.webContentsId) : null;
      if (!pageUrl || !adblockActiveFor({ settings, isProtectedUrl }, pageUrl)) return callback({});
      const { redirect, match } = engine.match(buildEngineRequest(Request, details, pageUrl));
      if (redirect) {
        if (onBlocked) onBlocked(details.webContentsId, details);
        return callback({ redirectURL: redirect.dataUrl });
      }
      if (match) {
        if (onBlocked) onBlocked(details.webContentsId, details);
        return callback({ cancel: true });
      }
      return callback({});
    } catch (_) {
      return callback({});
    }
  };
}

/**
 * Gestionnaires IPC du script cosmétique de Ghostery (`@ghostery/adblocker-electron-preload`).
 * Seulement pour les onglets web (`isBrowserTabSender`), jamais pour une page exceptée ou Lasco.
 */
function createCosmeticHandlers({ getEngine, settings, isProtectedUrl, isBrowserTabSender }) {
  function activeForSender(event) {
    const sender = event && event.sender;
    if (!sender || (sender.isDestroyed && sender.isDestroyed())) return null;
    if (!isBrowserTabSender(sender)) return null;
    const engine = getEngine();
    if (!engine) return null;
    let pageUrl = '';
    try {
      pageUrl = sender.getURL();
    } catch (_) {
      return null;
    }
    return adblockActiveFor({ settings, isProtectedUrl }, pageUrl) ? engine : null;
  }
  return {
    async injectCosmeticFilters(event, url, msg) {
      const engine = activeForSender(event);
      if (!engine || typeof url !== 'string' || (isProtectedUrl && isProtectedUrl(url))) return undefined;
      return engine.onInjectCosmeticFilters(event, url, msg);
    },
    async isMutationObserverEnabled(event) {
      const engine = activeForSender(event);
      return engine ? engine.config.enableMutationObserver : false;
    },
  };
}

const INJECT_CHANNEL = '@ghostery/adblocker/inject-cosmetic-filters';
const MUTATION_CHANNEL = '@ghostery/adblocker/is-mutation-observer-enabled';

/**
 * Service partagé par toutes les fenêtres (une session, un moteur). Chaque gestionnaire d'onglets
 * déclare ses onglets (`trackTab`) pour recevoir le nombre de requêtes bloquées.
 */
function createAdblockService({ userDataDir, electron }) {
  const { ipcMain, webContents: webContentsApi } = electron;
  const settings = createAdblockSettingsStore({ filePath: path.join(userDataDir, 'browser-adblock.json') });
  let ElectronBlocker = null;
  let Request = null;
  function ghostery() {
    if (!ElectronBlocker) ({ ElectronBlocker, Request } = require('@ghostery/adblocker-electron'));
    return { ElectronBlocker, Request };
  }
  const loader = createAdblockEngineLoader({
    cacheDir: path.join(userDataDir, 'adblock'),
    compile: () => compileInWorker(),
    deserialize: (bytes) => ghostery().ElectronBlocker.deserialize(bytes),
  });
  /** webContents id → `{ onBlocked }` (onglet web d'une fenêtre). */
  const tracked = new Map();
  let isProtectedUrl = () => false;
  const installed = new WeakSet();
  let timers = null;

  function pageUrlFor(webContentsId) {
    try {
      const wc = webContentsApi.fromId(webContentsId);
      return wc && !wc.isDestroyed() ? wc.getURL() : null;
    } catch (_) {
      return null;
    }
  }

  function scheduleLoading() {
    if (timers) return;
    // Lecture asynchrone du cache (la désérialisation prend ~10 ms), compilation dans un worker :
    // rien n'est attendu, la première page part même si le moteur n'est pas encore prêt.
    void loader.start();
    const checkTimer = setInterval(() => void loader.maybeRefresh(), CHECK_INTERVAL_MS);
    if (checkTimer.unref) checkTimer.unref();
    timers = { checkTimer };
  }

  return {
    settings,
    loader,
    /** Pages Lasco (portail, API) : jamais filtrées. */
    setProtectedUrlMatcher(matcher) {
      if (typeof matcher === 'function') isProtectedUrl = matcher;
    },
    isProtected: (url) => Boolean(url) && isProtectedUrl(url),
    /** Branche le bloqueur sur la session des onglets web (une fois par session). */
    install(browserSession) {
      if (installed.has(browserSession)) return false;
      installed.add(browserSession);
      const filter = createAdblockRequestFilter({
        getEngine: loader.getEngine,
        settings,
        isProtectedUrl: (url) => isProtectedUrl(url),
        pageUrlFor,
        onBlocked: (id, details) => {
          const tab = tracked.get(id);
          if (tab) tab.onBlocked(details);
        },
        Request: { fromRawDetails: (raw) => ghostery().Request.fromRawDetails(raw) },
      });
      // Un seul écouteur webRequest par session : passe par le répartiteur (docs/extensions.md).
      webRequestHub(browserSession).add('onBeforeRequest', filter);
      const cosmetic = createCosmeticHandlers({
        getEngine: loader.getEngine,
        settings,
        isProtectedUrl: (url) => isProtectedUrl(url),
        isBrowserTabSender: (sender) => tracked.has(sender.id) && sender.session === browserSession,
      });
      try {
        browserSession.registerPreloadScript({
          type: 'frame',
          filePath: require.resolve('@ghostery/adblocker-electron-preload'),
        });
        ipcMain.handle(INJECT_CHANNEL, cosmetic.injectCosmeticFilters);
        ipcMain.handle(MUTATION_CHANNEL, cosmetic.isMutationObserverEnabled);
      } catch (error) {
        console.warn('[adblock] cosmetic filters unavailable', error && error.message);
      }
      scheduleLoading();
      return true;
    },
    trackTab(webContentsId, onBlocked) {
      tracked.set(webContentsId, { onBlocked });
    },
    untrackTab(webContentsId) {
      tracked.delete(webContentsId);
    },
    /** Le bloqueur s'applique-t-il à cette page (réglages, exception, page Lasco) ? */
    isActiveFor(pageUrl) {
      return adblockActiveFor({ settings, isProtectedUrl }, pageUrl);
    },
    isReady: () => Boolean(loader.getEngine()),
  };
}

/** Compile le moteur dans un worker thread : le parsage des listes ne gèle jamais la fenêtre. */
function compileInWorker() {
  const { Worker } = require('worker_threads');
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'adblock-worker.js'));
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error('timeout'));
    }, 120_000);
    worker.once('message', (msg) => {
      clearTimeout(timer);
      void worker.terminate();
      if (msg && msg.ok && msg.bytes) resolve(new Uint8Array(msg.bytes));
      else reject(new Error((msg && msg.error) || 'compile failed'));
    });
    worker.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

module.exports = {
  DAY_MS,
  createAdblockSettingsStore,
  createAdblockEngineLoader,
  createAdblockRequestFilter,
  createCosmeticHandlers,
  createAdblockService,
  adblockActiveFor,
  buildEngineRequest,
};
