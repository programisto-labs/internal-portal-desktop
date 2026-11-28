'use strict';

/**
 * Écouteurs `webRequest` d'une session (docs/extensions.md).
 *
 * Electron n'accepte qu'un écouteur par événement et par session : un second `onBeforeRequest`
 * remplace le premier. Le bloqueur de pubs, les en-têtes du client et `declarativeNetRequest` des
 * extensions passent donc par ce répartiteur, qui s'inscrit une fois par événement et appelle les
 * gestionnaires dans l'ordre :
 * - `onBeforeRequest` : le premier qui annule ou redirige l'emporte ;
 * - `onBeforeSendHeaders` / `onHeadersReceived` : les en-têtes passent d'un gestionnaire au suivant ;
 *   une réponse réécrite (`statusLine`) arrête la chaîne.
 */

const EVENTS = ['onBeforeRequest', 'onBeforeSendHeaders', 'onHeadersReceived'];

/** Motifs `<all_urls>`, `https://*\/*`, `http://*\/*`, `*://*\/*` (les seuls utilisés). */
function urlMatches(patterns, url) {
  if (!Array.isArray(patterns) || patterns.length === 0) return true;
  return patterns.some((pattern) => {
    if (pattern === '<all_urls>') return true;
    const match = /^(\*|https?|wss?|file):\/\/\*\/\*$/.exec(pattern);
    if (!match) return false;
    if (match[1] === '*') return /^(https?|wss?):/i.test(url);
    return url.toLowerCase().startsWith(`${match[1]}:`);
  });
}

function callHandler(handler, details) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value || {});
    };
    try {
      const returned = handler(details, finish);
      if (returned && typeof returned.then === 'function') returned.then(finish, () => finish({}));
    } catch (_) {
      finish({});
    }
  });
}

function createSessionHub(browserSession) {
  const handlers = { onBeforeRequest: [], onBeforeSendHeaders: [], onHeadersReceived: [] };
  const registered = new Set();

  function ensure(event) {
    if (registered.has(event)) return;
    registered.add(event);
    browserSession.webRequest[event]({ urls: ['<all_urls>'] }, (details, callback) => {
      void run(event, details).then(callback, () => callback({}));
    });
  }

  async function run(event, details) {
    const list = handlers[event].filter((h) => urlMatches(h.urls, details.url || ''));
    if (list.length === 0) return {};
    if (event === 'onBeforeRequest') {
      for (const { fn } of list) {
        const result = await callHandler(fn, details);
        if (result.cancel || result.redirectURL) return result;
      }
      return {};
    }
    const key = event === 'onBeforeSendHeaders' ? 'requestHeaders' : 'responseHeaders';
    let headers = details[key];
    let changed = false;
    for (const { fn } of list) {
      const result = await callHandler(fn, { ...details, [key]: headers });
      if (result.cancel) return { cancel: true };
      if (event === 'onHeadersReceived' && result.statusLine) return result;
      if (result[key]) {
        headers = result[key];
        changed = true;
      }
    }
    return changed ? { [key]: headers } : {};
  }

  return {
    /** Ajoute un gestionnaire (`fn(details, callback)` ou promesse). Renvoie de quoi le retirer. */
    add(event, fn, { urls = ['<all_urls>'], first = false } = {}) {
      if (!EVENTS.includes(event)) throw new Error(`unsupported webRequest event ${event}`);
      const entry = { fn, urls };
      if (first) handlers[event].unshift(entry);
      else handlers[event].push(entry);
      ensure(event);
      return () => {
        handlers[event] = handlers[event].filter((h) => h !== entry);
      };
    },
  };
}

const hubs = new WeakMap();

/** Répartiteur de la session (créé au premier usage). */
function webRequestHub(browserSession) {
  let hub = hubs.get(browserSession);
  if (!hub) {
    hub = createSessionHub(browserSession);
    hubs.set(browserSession, hub);
  }
  return hub;
}

module.exports = { webRequestHub, urlMatches, createSessionHub };
