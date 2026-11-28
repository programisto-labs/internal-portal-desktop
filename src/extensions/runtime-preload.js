'use strict';

/**
 * APIs ajoutées par Lasco aux contextes d'extension (service worker et pages `chrome-extension://`),
 * en plus de celles d'Electron et d'`electron-chrome-extensions` (docs/extensions.md) :
 * `chrome.declarativeNetRequest` et `chrome.identity` (partiel).
 *
 * Les appels passent par le routeur d'`electron-chrome-extensions` (canal `crx-msg`), qui vérifie
 * l'extension appelante. Ce script est inscrit AVANT celui de la bibliothèque : elle gèle ensuite
 * l'objet `chrome` (`Object.freeze`) et retire son propre pont du monde principal.
 * Jamais dans une page web : rien n'est injecté hors des contextes d'extension.
 */

const { contextBridge, ipcRenderer, webFrame } = require('electron');

const BRIDGE_KEY = '__lascoExtensionBridge';

function mainWorldInstall() {
  // Electron définit un `browser` partiel (sans permissions, tabs…) que Chrome n'a pas : les
  // extensions qui préfèrent `browser` à `chrome` (uBlock Origin Lite) planteraient. Retiré, comme Chrome.
  try {
    if (globalThis.browser && globalThis.browser !== globalThis.chrome) delete globalThis.browser;
  } catch (_) {
    // Non supprimable : laissé.
  }
  const chrome = globalThis.chrome;
  if (!chrome || !chrome.runtime || !chrome.runtime.id) return;
  const extensionId = chrome.runtime.id;
  // Pont posé par ce préchargement, retiré du monde principal dès qu'il est lu.
  const bridge = globalThis.__lascoExtensionBridge;
  try {
    delete globalThis.__lascoExtensionBridge;
  } catch (_) {
    // Propriété non supprimable : laissée (elle ne permet que les appels de cette extension).
  }
  if (!bridge || typeof bridge.invoke !== 'function') return;
  const invoke = (name) => (...args) => {
    const callback = typeof args[args.length - 1] === 'function' ? args.pop() : null;
    const promise = Promise.resolve(bridge.invoke(extensionId, name, ...args));
    if (!callback) return promise;
    promise.then(
      (value) => callback(value),
      (error) => {
        try {
          console.error(error);
        } finally {
          callback(undefined);
        }
      },
    );
    return undefined;
  };
  const event = () => ({ addListener() {}, removeListener() {}, hasListener: () => false, hasListeners: () => false });

  const manifest = (chrome.runtime.getManifest && chrome.runtime.getManifest()) || {};
  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  const hasDnr = permissions.some((p) => typeof p === 'string' && p.startsWith('declarativeNetRequest'));
  if (hasDnr && !chrome.declarativeNetRequest) {
    const names = [
      'updateDynamicRules',
      'getDynamicRules',
      'updateSessionRules',
      'getSessionRules',
      'updateEnabledRulesets',
      'getEnabledRulesets',
      'getAvailableStaticRuleCount',
      'isRegexSupported',
      'setExtensionActionOptions',
      'getMatchedRules',
      'testMatchOutcome',
      'getDisabledRuleIds',
      'updateStaticRules',
    ];
    const api = {
      MAX_NUMBER_OF_DYNAMIC_RULES: 30000,
      MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 5000,
      MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES: 30000,
      MAX_NUMBER_OF_SESSION_RULES: 30000,
      MAX_NUMBER_OF_UNSAFE_SESSION_RULES: 5000,
      MAX_NUMBER_OF_REGEX_RULES: 1000,
      MAX_NUMBER_OF_STATIC_RULESETS: 100,
      MAX_NUMBER_OF_ENABLED_STATIC_RULESETS: 50,
      GUARANTEED_MINIMUM_STATIC_RULES: 30000,
      DYNAMIC_RULESET_ID: '_dynamic',
      SESSION_RULESET_ID: '_session',
      GETMATCHEDRULES_QUOTA_INTERVAL: 10,
      MAX_GETMATCHEDRULES_CALLS_PER_INTERVAL: 20,
      onRuleMatchedDebug: event(),
    };
    for (const name of names) api[name] = invoke(`declarativeNetRequest.${name}`);
    for (const [key, values] of Object.entries({
      ResourceType: ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport', 'webbundle', 'other'],
      RuleActionType: ['block', 'redirect', 'allow', 'upgradeScheme', 'modifyHeaders', 'allowAllRequests'],
      DomainType: ['firstParty', 'thirdParty'],
      HeaderOperation: ['append', 'set', 'remove'],
      RequestMethod: ['connect', 'delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'other'],
    })) {
      api[key] = Object.fromEntries(values.map((v) => [v.toUpperCase(), v]));
    }
    try {
      Object.defineProperty(chrome, 'declarativeNetRequest', { value: api, enumerable: true, configurable: true });
    } catch (_) {
      chrome.declarativeNetRequest = api;
    }
  }

  if (permissions.includes('identity') && !chrome.identity) {
    const notSupported = (name) => (...args) => {
      const callback = typeof args[args.length - 1] === 'function' ? args.pop() : null;
      const error = new Error(`chrome.identity.${name} is not supported in Lasco.`);
      if (callback) {
        callback(undefined);
        return undefined;
      }
      return Promise.reject(error);
    };
    const identity = {
      getRedirectURL: (path) => `https://${extensionId}.chromiumapp.org/${typeof path === 'string' ? path.replace(/^\//, '') : ''}`,
      launchWebAuthFlow: invoke('identity.launchWebAuthFlow'),
      getAuthToken: notSupported('getAuthToken'),
      removeCachedAuthToken: (details, callback) => (callback ? callback() : Promise.resolve()),
      clearAllCachedAuthTokens: (callback) => (callback ? callback() : Promise.resolve()),
      getProfileUserInfo: (...args) => {
        const callback = typeof args[args.length - 1] === 'function' ? args.pop() : null;
        const info = { email: '', id: '' };
        return callback ? callback(info) : Promise.resolve(info);
      },
      getAccounts: (callback) => (callback ? callback([]) : Promise.resolve([])),
      onSignInChanged: event(),
    };
    try {
      Object.defineProperty(chrome, 'identity', { value: identity, enumerable: true, configurable: true });
    } catch (_) {
      chrome.identity = identity;
    }
  }
}

const isExtensionContext =
  process.type === 'service-worker' ||
  (typeof location !== 'undefined' && String(location.href).startsWith('chrome-extension://'));

if (isExtensionContext) {
  try {
    contextBridge.exposeInMainWorld(BRIDGE_KEY, {
      invoke: (extensionId, name, ...args) => ipcRenderer.invoke('crx-msg', extensionId, name, ...args),
    });
    if (contextBridge && typeof contextBridge.executeInMainWorld === 'function') {
      contextBridge.executeInMainWorld({ func: mainWorldInstall });
    } else if (webFrame) {
      void webFrame.executeJavaScript(`(${mainWorldInstall.toString()})()`);
    }
  } catch (error) {
    console.error('[lasco-extensions] runtime preload failed', error);
  }
}
