'use strict';

/**
 * `declarativeNetRequest` d'une session (docs/extensions.md) : règles des extensions chargées,
 * appliquées dans la chaîne `webRequest` (avant le bloqueur de Lasco), API exposée aux extensions
 * par le routeur d'`electron-chrome-extensions` (`declarativeNetRequest.*`).
 *
 * Jamais pour une adresse de Lasco (`isProtectedUrl`). Les redirections et les en-têtes ne
 * s'appliquent qu'aux sites auxquels l'extension a accès (`hostAllowed`), comme Chrome.
 */

const fs = require('fs');
const path = require('path');
const { webRequestHub } = require('../../browser-tabs/web-request-hub');
const { stripBom } = require('../crx');
const {
  LIMITS,
  applyHeaderRules,
  buildRequest,
  createExtensionRules,
  dnrResourceType,
  evaluateAll,
  isRegexSupported,
} = require('./engine');

function readJson(file) {
  return JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

/** Fichier d'un jeu statique, confiné au dossier de l'extension. */
function rulesetFile(extensionDir, relative) {
  const target = path.resolve(extensionDir, String(relative || '').replace(/^\/+/, ''));
  return target.startsWith(path.resolve(extensionDir) + path.sep) ? target : null;
}

function createDnrService({ browserSession, isProtectedUrl = () => false, hostAllowed = () => true, dataDirFor, tabIdFor = () => -1, onRulesetsChanged = () => {} }) {
  /** extensionId → { rules, dynamicFile, stateFile } (ordre d'installation). */
  const extensions = new Map();
  let matchedCount = 0;

  function setFor(extensionId) {
    return extensions.get(extensionId) || null;
  }

  function orderedSets() {
    return [...extensions.values()].sort((a, b) => a.rules.installedAt - b.rules.installedAt).map((e) => e.rules);
  }

  /** Charge les règles d'une extension (au chargement par Electron). */
  function addExtension(extension, { installedAt = Date.now(), rulesetState = null } = {}) {
    const manifest = extension.manifest || {};
    const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
    const hasDnr =
      permissions.includes('declarativeNetRequest') ||
      permissions.includes('declarativeNetRequestWithHostAccess') ||
      permissions.includes('declarativeNetRequestFeedback');
    if (!hasDnr) return;
    const rules = createExtensionRules({ extensionId: extension.id, installedAt });
    const resources = (manifest.declarative_net_request && manifest.declarative_net_request.rule_resources) || [];
    const dataDir = dataDirFor(extension.id);
    const stateFile = path.join(dataDir, 'dnr-rulesets.json');
    let saved = rulesetState;
    if (!saved) {
      try {
        saved = readJson(stateFile);
      } catch (_) {
        saved = null;
      }
    }
    for (const resource of resources.slice(0, LIMITS.MAX_NUMBER_OF_STATIC_RULESETS)) {
      if (!resource || typeof resource.id !== 'string') continue;
      const enabled = saved && typeof saved[resource.id] === 'boolean' ? saved[resource.id] : resource.enabled === true;
      const file = rulesetFile(extension.path, resource.path);
      let list = [];
      try {
        // Jeu désactivé : lu à la demande (updateEnabledRulesets), pas au démarrage.
        if (enabled && file) list = readJson(file);
      } catch (error) {
        console.warn(`[extensions] ruleset ${resource.id} of ${extension.id} unreadable:`, error && error.message);
      }
      rules.setStaticRuleset(resource.id, list, enabled);
    }
    const dynamicFile = path.join(dataDir, 'dnr-dynamic.json');
    try {
      rules.setDynamicRules(readJson(dynamicFile));
    } catch (_) {
      // Aucune règle dynamique.
    }
    extensions.set(extension.id, { rules, dynamicFile, stateFile, extension, resources });
  }

  function removeExtension(extensionId) {
    extensions.delete(extensionId);
  }

  function frameKeyOf(details) {
    if (!details.webContentsId) return null;
    const frame = details.frame;
    const frameId = frame && !frame.isDestroyed?.() ? `${frame.processId}:${frame.routingId}` : 'main';
    return `${details.webContentsId}:${frameId}`;
  }

  function parentFrameKeys(details) {
    if (!details.webContentsId) return null;
    const keys = [`${details.webContentsId}:main`];
    let frame = details.frame;
    try {
      while (frame) {
        keys.push(`${details.webContentsId}:${frame.processId}:${frame.routingId}`);
        frame = frame.parent;
      }
    } catch (_) {
      // Cadre détruit pendant la requête.
    }
    return keys;
  }

  function requestFor(details) {
    const type = dnrResourceType(details.resourceType);
    const isFrame = type === 'main_frame' || type === 'sub_frame';
    return buildRequest({
      url: details.url,
      method: details.method,
      resourceType: type,
      initiator: type === 'main_frame' ? null : details.referrer || (details.frame && safeFrameUrl(details.frame.top)) || null,
      tabId: details.webContentsId ? tabIdFor(details.webContentsId) : -1,
      frameKey: isFrame ? (type === 'main_frame' ? `${details.webContentsId}:main` : frameKeyOf(details)) : null,
      frameKeys: isFrame ? null : parentFrameKeys(details),
    });
  }

  function safeFrameUrl(frame) {
    try {
      return frame && !frame.isDestroyed() ? frame.url : null;
    } catch (_) {
      return null;
    }
  }

  function shouldSkip(details) {
    if (extensions.size === 0) return true;
    const url = details.url || '';
    if (!/^(https?|wss?):/i.test(url)) return true;
    if (isProtectedUrl(url)) return true;
    if (details.referrer && isProtectedUrl(details.referrer)) return true;
    return false;
  }

  function permittedSets(url) {
    return orderedSets().filter((set) => hostAllowed(set.extensionId, url));
  }

  const hub = webRequestHub(browserSession);
  hub.add(
    'onBeforeRequest',
    (details, callback) => {
      try {
        if (shouldSkip(details)) return callback({});
        const request = requestFor(details);
        if (request.type === 'main_frame') {
          for (const set of orderedSets()) set.forgetFrames(`${details.webContentsId}:`);
        }
        // Blocage : toutes les extensions ; redirection : seulement avec accès au site (Chrome).
        const decision = evaluateAll(orderedSets(), request);
        if (!decision) return callback({});
        if (decision.cancel) {
          matchedCount += 1;
          return callback({ cancel: true });
        }
        if (decision.redirectURL) {
          const extensionId = decision.matched && decision.matched.extensionId;
          const allowed = !extensionId || hostAllowed(extensionId, details.url);
          if (allowed && !isProtectedUrl(decision.redirectURL)) {
            matchedCount += 1;
            return callback({ redirectURL: decision.redirectURL });
          }
        }
        return callback({});
      } catch (_) {
        return callback({});
      }
    },
    // Avant le bloqueur de Lasco : une règle `allow` d'une extension n'empêche pas ce dernier,
    // mais ses blocages et redirections passent d'abord (même ordre que Chrome + boucliers).
    { first: true },
  );

  function headerDecision(details) {
    if (shouldSkip(details)) return null;
    const decision = evaluateAll(permittedSets(details.url), requestFor(details));
    return decision && decision.headers ? decision.headers : null;
  }

  hub.add('onBeforeSendHeaders', (details, callback) => {
    try {
      const rules = headerDecision(details);
      if (!rules) return callback({});
      return callback({ requestHeaders: applyHeaderRules(rules, details.requestHeaders || {}, 'requestHeaders') });
    } catch (_) {
      return callback({});
    }
  });

  hub.add('onHeadersReceived', (details, callback) => {
    try {
      const rules = headerDecision(details);
      if (!rules) return callback({});
      return callback({ responseHeaders: applyHeaderRules(rules, details.responseHeaders || {}, 'responseHeaders') });
    } catch (_) {
      return callback({});
    }
  });

  function requireSet(extension) {
    const entry = extension && setFor(extension.id);
    if (!entry) throw new Error('declarativeNetRequest is not available for this extension.');
    return entry;
  }

  function persistDynamic(entry) {
    writeJson(entry.dynamicFile, entry.rules.getDynamicRules());
  }

  function persistRulesets(entry) {
    const enabled = new Set(entry.rules.getEnabledRulesets());
    const state = {};
    for (const resource of entry.resources) if (resource && resource.id) state[resource.id] = enabled.has(resource.id);
    writeJson(entry.stateFile, state);
  }

  /** Gestionnaires de l'API, à inscrire dans le routeur des extensions (`router.handle`). */
  const api = {
    'declarativeNetRequest.updateDynamicRules': ({ extension }, options = {}) => {
      const entry = requireSet(extension);
      entry.rules.updateDynamicRules(options);
      persistDynamic(entry);
    },
    'declarativeNetRequest.getDynamicRules': ({ extension }, filter) => requireSet(extension).rules.getDynamicRules(filter || {}),
    'declarativeNetRequest.updateSessionRules': ({ extension }, options = {}) => {
      requireSet(extension).rules.updateSessionRules(options);
    },
    'declarativeNetRequest.getSessionRules': ({ extension }, filter) => requireSet(extension).rules.getSessionRules(filter || {}),
    'declarativeNetRequest.updateEnabledRulesets': ({ extension }, options = {}) => {
      const entry = requireSet(extension);
      for (const id of options.enableRulesetIds || []) {
        const resource = entry.resources.find((r) => r && r.id === id);
        if (!resource) throw new Error(`Invalid ruleset id: ${id}.`);
        const file = rulesetFile(entry.extension.path, resource.path);
        entry.rules.setStaticRuleset(id, file ? readJson(file) : [], true);
      }
      entry.rules.updateEnabledRulesets(options);
      persistRulesets(entry);
      onRulesetsChanged(extension.id);
    },
    'declarativeNetRequest.getEnabledRulesets': ({ extension }) => requireSet(extension).rules.getEnabledRulesets(),
    'declarativeNetRequest.getAvailableStaticRuleCount': ({ extension }) =>
      requireSet(extension).rules.availableStaticRuleCount(),
    'declarativeNetRequest.isRegexSupported': (_event, { regex } = {}) =>
      isRegexSupported(regex) ? { isSupported: true } : { isSupported: false, reason: 'syntaxError' },
    'declarativeNetRequest.setExtensionActionOptions': () => undefined,
    'declarativeNetRequest.getMatchedRules': () => ({ rulesMatchedInfo: [] }),
    'declarativeNetRequest.testMatchOutcome': ({ extension }, request = {}) => {
      const entry = requireSet(extension);
      const req = buildRequest({
        url: request.url,
        method: request.method,
        resourceType: request.type || 'other',
        initiator: request.initiator,
        tabId: request.tabId,
      });
      const { best } = entry.rules.evaluate(req);
      return { matchedRules: best && best.id ? [{ ruleId: best.id, rulesetId: best.source.replace(/^static:/, '') }] : [] };
    },
    'declarativeNetRequest.getDisabledRuleIds': () => [],
    'declarativeNetRequest.updateStaticRules': () => undefined,
  };

  return {
    addExtension,
    removeExtension,
    api,
    get matchedCount() {
      return matchedCount;
    },
    ruleCount: (id) => {
      const entry = setFor(id);
      return entry ? entry.rules.ruleCount : 0;
    },
  };
}

module.exports = { createDnrService, LIMITS };
