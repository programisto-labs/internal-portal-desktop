'use strict';

/**
 * Moteur `declarativeNetRequest` (docs/extensions.md). Electron ne l'implémente pas : Desktop
 * évalue les règles des extensions dans la chaîne `webRequest` de la session des onglets web.
 *
 * Règles de Chrome reprises (developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest) :
 * - dans une extension, la règle de plus haute priorité l'emporte ; à priorité égale :
 *   allow > allowAllRequests > block > upgradeScheme > redirect ;
 * - modifyHeaders : toutes les règles plus prioritaires que la meilleure règle allow / allowAllRequests ;
 * - entre extensions : un blocage l'emporte, puis la redirection (extension installée en dernier) ;
 * - sans `resourceTypes` ni `excludedResourceTypes`, une règle ne vise pas `main_frame` ;
 * - `allowAllRequests` (main_frame / sub_frame) autorise ensuite les requêtes de ce cadre.
 */

const { getDomain } = require('tldts-experimental');

const RESOURCE_TYPES = [
  'main_frame',
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'csp_report',
  'media',
  'websocket',
  'webtransport',
  'webbundle',
  'other',
];

const ELECTRON_TO_DNR_TYPE = {
  mainFrame: 'main_frame',
  subFrame: 'sub_frame',
  stylesheet: 'stylesheet',
  script: 'script',
  image: 'image',
  font: 'font',
  object: 'object',
  xhr: 'xmlhttprequest',
  ping: 'ping',
  cspReport: 'csp_report',
  media: 'media',
  webSocket: 'websocket',
  other: 'other',
};

const ACTION_RANK = { allow: 5, allowAllRequests: 4, block: 3, upgradeScheme: 2, redirect: 1, modifyHeaders: 0 };

/** Limites de Chrome (règles dynamiques et de session : 30 000 « sûres », 5 000 non sûres ; regex : 1 000). */
const LIMITS = {
  MAX_NUMBER_OF_DYNAMIC_RULES: 30000,
  MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 5000,
  MAX_NUMBER_OF_SESSION_RULES: 30000,
  MAX_NUMBER_OF_UNSAFE_SESSION_RULES: 5000,
  MAX_NUMBER_OF_REGEX_RULES: 1000,
  MAX_NUMBER_OF_STATIC_RULESETS: 100,
  MAX_NUMBER_OF_ENABLED_STATIC_RULESETS: 50,
  GUARANTEED_MINIMUM_STATIC_RULES: 30000,
};
/** Règles statiques d'une extension au-delà desquelles un jeu n'est plus chargé (garde mémoire). */
const MAX_STATIC_RULES_PER_EXTENSION = 330000;

function dnrResourceType(electronType) {
  return ELECTRON_TO_DNR_TYPE[electronType] || 'other';
}

// --- urlFilter ---

function escapeRegex(text) {
  return text.replace(/[.+?${}()|[\]\\/]/g, '\\$&');
}

/** Expression régulière d'un `urlFilter` (`||`, `|`, `*`, `^`). */
function urlFilterToRegExp(filter, caseSensitive) {
  let source = String(filter);
  let prefix = '';
  let suffix = '';
  if (source.startsWith('||')) {
    prefix = '^[a-z][a-z0-9+.-]*:\\/\\/(?:[^\\/?#]*\\.)?';
    source = source.slice(2);
  } else if (source.startsWith('|')) {
    prefix = '^';
    source = source.slice(1);
  }
  if (source.endsWith('|') && !source.endsWith('\\|')) {
    suffix = '$';
    source = source.slice(0, -1);
  }
  let body = '';
  for (const char of source) {
    if (char === '*') body += '.*';
    else if (char === '^') body += '(?:[^a-zA-Z0-9_\\-.%]|$)';
    else body += escapeRegex(char);
  }
  return new RegExp(prefix + body + suffix, caseSensitive ? '' : 'i');
}

/** Hôte « ancré » d'un filtre `||exemple.com^…` (index par domaine), sinon null. */
function anchoredHost(filter) {
  if (typeof filter !== 'string' || !filter.startsWith('||')) return null;
  const match = /^\|\|([a-z0-9.-]+)(?=[\^/:*|]|$)/i.exec(filter);
  if (!match) return null;
  const host = match[1].toLowerCase().replace(/\.$/, '');
  return host.includes('*') || !host.includes('.') ? null : host;
}

/** Plus long morceau littéral (≥ 3 caractères) d'un filtre ou d'une regex simple : clé d'index. */
function literalToken(text) {
  if (typeof text !== 'string') return null;
  let best = null;
  for (const part of text.toLowerCase().split(/[^a-z0-9%]+/)) {
    if (part.length >= 3 && (!best || part.length > best.length)) best = part;
  }
  return best;
}

function urlTokens(url) {
  return new Set(url.toLowerCase().split(/[^a-z0-9%]+/).filter((part) => part.length >= 3));
}

// --- Domaines ---

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch (_) {
    return '';
  }
}

/** Vrai si `host` est `domain` ou l'un de ses sous-domaines. */
function hostMatches(host, domain) {
  if (!host || !domain) return false;
  const d = domain.toLowerCase();
  return host === d || host.endsWith(`.${d}`);
}

function anyHostMatches(host, domains) {
  return Array.isArray(domains) && domains.some((domain) => hostMatches(host, domain));
}

/** Suffixes d'un hôte : a.b.c.fr → a.b.c.fr, b.c.fr, c.fr, fr. */
function hostSuffixes(host) {
  const out = [];
  let rest = host;
  while (rest) {
    out.push(rest);
    const dot = rest.indexOf('.');
    if (dot < 0) break;
    rest = rest.slice(dot + 1);
  }
  return out;
}

function registrableDomain(host) {
  if (!host) return '';
  try {
    return getDomain(host, { allowPrivateDomains: true }) || host;
  } catch (_) {
    return host;
  }
}

// --- Règles ---

function isValidRule(rule) {
  if (!rule || typeof rule !== 'object') return false;
  if (!Number.isInteger(rule.id) || rule.id < 1) return false;
  const action = rule.action;
  if (!action || typeof action.type !== 'string' || !(action.type in ACTION_RANK)) return false;
  if (rule.priority !== undefined && (!Number.isInteger(rule.priority) || rule.priority < 1)) return false;
  const condition = rule.condition || {};
  if (condition.urlFilter !== undefined && condition.regexFilter !== undefined) return false;
  if (condition.urlFilter !== undefined && (typeof condition.urlFilter !== 'string' || !condition.urlFilter)) {
    return false;
  }
  if (condition.regexFilter !== undefined && !isRegexSupported(condition.regexFilter)) return false;
  if (action.type === 'redirect' && !action.redirect) return false;
  if (action.type === 'modifyHeaders' && !action.requestHeaders && !action.responseHeaders) return false;
  if (action.type === 'allowAllRequests') {
    const types = condition.resourceTypes;
    if (!Array.isArray(types) || types.some((t) => t !== 'main_frame' && t !== 'sub_frame')) return false;
  }
  return true;
}

function isRegexSupported(regex) {
  if (typeof regex !== 'string' || !regex || regex.length > 2000) return false;
  try {
    // RE2 n'a ni références arrière ni assertions de recherche : refusées, comme Chrome.
    if (/\\[1-9]|\(\?[=!<]/.test(regex)) return false;
    new RegExp(regex);
    return true;
  } catch (_) {
    return false;
  }
}

/** Règle compilée : correspondance paresseuse (la regex n'est créée qu'au premier test). */
function compileRule(rule, extensionId, source) {
  const condition = rule.condition || {};
  const caseSensitive = condition.isUrlFilterCaseSensitive === true;
  let matcher = null;
  const getMatcher = () => {
    if (matcher) return matcher;
    if (typeof condition.regexFilter === 'string') matcher = new RegExp(condition.regexFilter, caseSensitive ? '' : 'i');
    else if (typeof condition.urlFilter === 'string') matcher = urlFilterToRegExp(condition.urlFilter, caseSensitive);
    else matcher = /^/;
    return matcher;
  };
  let resourceTypes = null;
  if (Array.isArray(condition.resourceTypes)) resourceTypes = new Set(condition.resourceTypes);
  else if (Array.isArray(condition.excludedResourceTypes)) {
    const excluded = new Set(condition.excludedResourceTypes);
    resourceTypes = new Set(RESOURCE_TYPES.filter((t) => !excluded.has(t)));
  } else resourceTypes = new Set(RESOURCE_TYPES.filter((t) => t !== 'main_frame'));
  return {
    rule,
    extensionId,
    source,
    id: rule.id,
    priority: rule.priority || 1,
    type: rule.action.type,
    rank: ACTION_RANK[rule.action.type],
    condition,
    resourceTypes,
    getMatcher,
  };
}

function ruleMatches(compiled, request) {
  const { condition } = compiled;
  if (!compiled.resourceTypes.has(request.type)) return false;
  if (Array.isArray(condition.requestMethods) && !condition.requestMethods.includes(request.method)) return false;
  if (Array.isArray(condition.excludedRequestMethods) && condition.excludedRequestMethods.includes(request.method)) {
    return false;
  }
  if (Array.isArray(condition.tabIds) && !condition.tabIds.includes(request.tabId)) return false;
  if (Array.isArray(condition.excludedTabIds) && condition.excludedTabIds.includes(request.tabId)) return false;
  if (condition.requestDomains && !anyHostMatches(request.host, condition.requestDomains)) return false;
  if (anyHostMatches(request.host, condition.excludedRequestDomains)) return false;
  const initiator = request.initiatorHost;
  if (condition.initiatorDomains && !anyHostMatches(initiator, condition.initiatorDomains)) return false;
  if (initiator && anyHostMatches(initiator, condition.excludedInitiatorDomains)) return false;
  // Ancien nom (Chrome < 101) encore présent dans des jeux de règles.
  if (condition.domains && !anyHostMatches(initiator, condition.domains)) return false;
  if (initiator && anyHostMatches(initiator, condition.excludedDomains)) return false;
  if (condition.domainType) {
    const third = Boolean(initiator) && registrableDomain(initiator) !== registrableDomain(request.host);
    if (condition.domainType === 'thirdParty' && !third) return false;
    if (condition.domainType === 'firstParty' && third) return false;
  }
  if (condition.urlFilter === undefined && condition.regexFilter === undefined) return true;
  return compiled.getMatcher().test(request.url);
}

/** Index d'un ensemble de règles : par hôte ancré / requestDomains, par morceau littéral, sinon générique. */
function createRuleIndex() {
  const byHost = new Map();
  const byToken = new Map();
  const generic = [];
  let size = 0;
  let regexCount = 0;
  const push = (map, key, compiled) => {
    let list = map.get(key);
    if (!list) map.set(key, (list = []));
    list.push(compiled);
  };
  return {
    add(compiled) {
      size += 1;
      const condition = compiled.condition;
      if (typeof condition.regexFilter === 'string') regexCount += 1;
      const host = anchoredHost(condition.urlFilter);
      if (host) return push(byHost, host, compiled);
      if (Array.isArray(condition.requestDomains) && condition.requestDomains.length > 0) {
        for (const domain of condition.requestDomains) push(byHost, String(domain).toLowerCase(), compiled);
        return undefined;
      }
      const token =
        typeof condition.urlFilter === 'string'
          ? literalToken(condition.urlFilter.replace(/^\|\|?/, ''))
          : typeof condition.regexFilter === 'string' && /^[\w\-.\\/:]+$/.test(condition.regexFilter)
            ? literalToken(condition.regexFilter)
            : null;
      if (token) return push(byToken, token, compiled);
      generic.push(compiled);
      return undefined;
    },
    candidates(request) {
      const out = [];
      for (const suffix of hostSuffixes(request.host)) {
        const list = byHost.get(suffix);
        if (list) out.push(...list);
      }
      for (const token of request.tokens) {
        const list = byToken.get(token);
        if (list) out.push(...list);
      }
      out.push(...generic);
      return out;
    },
    get size() {
      return size;
    },
    get regexCount() {
      return regexCount;
    },
  };
}

/**
 * Règles d'une extension : jeux statiques activés, règles dynamiques et de session.
 * `staticRulesets` : Map id → règles brutes (chargées depuis les fichiers du manifeste).
 */
function createExtensionRules({ extensionId, installedAt = 0 }) {
  const staticRulesets = new Map();
  const enabledRulesets = new Set();
  let dynamicRules = [];
  let sessionRules = [];
  let index = null;
  /** Règles allowAllRequests retenues par cadre (clé `${webContentsId}:${frameKey}`) : priorité. */
  const frameAllow = new Map();

  function rebuild() {
    const next = createRuleIndex();
    let staticCount = 0;
    for (const id of enabledRulesets) {
      const rules = staticRulesets.get(id) || [];
      for (const rule of rules) {
        if (staticCount >= MAX_STATIC_RULES_PER_EXTENSION) break;
        if (!isValidRule(rule)) continue;
        next.add(compileRule(rule, extensionId, `static:${id}`));
        staticCount += 1;
      }
    }
    for (const rule of dynamicRules) next.add(compileRule(rule, extensionId, 'dynamic'));
    for (const rule of sessionRules) next.add(compileRule(rule, extensionId, 'session'));
    index = next;
  }

  function updateRuleList(current, { removeRuleIds = [], addRules = [] } = {}, limit) {
    const removed = new Set(Array.isArray(removeRuleIds) ? removeRuleIds : []);
    const kept = current.filter((rule) => !removed.has(rule.id));
    const ids = new Set(kept.map((rule) => rule.id));
    const added = Array.isArray(addRules) ? addRules : [];
    for (const rule of added) {
      if (!isValidRule(rule)) throw new Error(`Rule with id ${rule && rule.id} is invalid.`);
      if (ids.has(rule.id)) throw new Error(`Rule with id ${rule.id} does not have a unique ID.`);
      ids.add(rule.id);
    }
    const next = [...kept, ...added.map((rule) => JSON.parse(JSON.stringify(rule)))];
    if (next.length > limit) throw new Error('Dynamic rule count exceeded.');
    const regexes = next.filter((rule) => rule.condition && typeof rule.condition.regexFilter === 'string').length;
    if (regexes > LIMITS.MAX_NUMBER_OF_REGEX_RULES) throw new Error('Regular expression rule count exceeded.');
    return next;
  }

  return {
    extensionId,
    installedAt,
    setStaticRuleset(id, rules, enabled) {
      staticRulesets.set(id, Array.isArray(rules) ? rules : []);
      if (enabled) enabledRulesets.add(id);
      index = null;
    },
    hasStaticRuleset: (id) => staticRulesets.has(id),
    getEnabledRulesets: () => [...enabledRulesets],
    updateEnabledRulesets({ enableRulesetIds = [], disableRulesetIds = [] } = {}) {
      for (const id of [...enableRulesetIds, ...disableRulesetIds]) {
        if (!staticRulesets.has(id)) throw new Error(`Invalid ruleset id: ${id}.`);
      }
      for (const id of disableRulesetIds) enabledRulesets.delete(id);
      for (const id of enableRulesetIds) enabledRulesets.add(id);
      if (enabledRulesets.size > LIMITS.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS) {
        throw new Error('The number of enabled static rulesets exceeds the limit.');
      }
      index = null;
    },
    getDynamicRules: ({ ruleIds } = {}) => filterIds(dynamicRules, ruleIds),
    getSessionRules: ({ ruleIds } = {}) => filterIds(sessionRules, ruleIds),
    setDynamicRules(rules) {
      dynamicRules = Array.isArray(rules) ? rules.filter(isValidRule) : [];
      index = null;
    },
    updateDynamicRules(options) {
      dynamicRules = updateRuleList(dynamicRules, options, LIMITS.MAX_NUMBER_OF_DYNAMIC_RULES);
      index = null;
      return dynamicRules;
    },
    updateSessionRules(options) {
      sessionRules = updateRuleList(sessionRules, options, LIMITS.MAX_NUMBER_OF_SESSION_RULES);
      index = null;
    },
    availableStaticRuleCount() {
      let used = 0;
      for (const id of enabledRulesets) used += (staticRulesets.get(id) || []).length;
      return Math.max(0, LIMITS.GUARANTEED_MINIMUM_STATIC_RULES - used);
    },
    /** Meilleure décision de l'extension pour une requête (`null` si aucune règle). */
    evaluate(request) {
      if (!index) rebuild();
      let best = null;
      const headerRules = [];
      const seen = new Set();
      for (const compiled of index.candidates(request)) {
        if (seen.has(compiled)) continue;
        seen.add(compiled);
        if (!ruleMatches(compiled, request)) continue;
        if (compiled.type === 'modifyHeaders') {
          headerRules.push(compiled);
          continue;
        }
        if (
          !best ||
          compiled.priority > best.priority ||
          (compiled.priority === best.priority && compiled.rank > best.rank)
        ) {
          best = compiled;
        }
      }
      // allowAllRequests d'un cadre parent : autorise les requêtes du cadre de moindre priorité.
      const inherited = request.frameKeys ? maxFrameAllow(frameAllow, request.frameKeys) : 0;
      if (inherited && (!best || inherited >= best.priority)) {
        best = { type: 'allow', priority: inherited, rank: ACTION_RANK.allow, inherited: true };
      }
      if (best && best.type === 'allowAllRequests' && request.frameKey) frameAllow.set(request.frameKey, best.priority);
      const allowPriority = best && (best.type === 'allow' || best.type === 'allowAllRequests') ? best.priority : 0;
      const headers = headerRules
        .filter((rule) => rule.priority > allowPriority)
        .sort((a, b) => b.priority - a.priority);
      return { best, headers };
    },
    forgetFrames(prefix) {
      for (const key of frameAllow.keys()) if (key.startsWith(prefix)) frameAllow.delete(key);
    },
    get ruleCount() {
      if (!index) rebuild();
      return index.size;
    },
  };
}

function maxFrameAllow(frameAllow, keys) {
  let max = 0;
  for (const key of keys) {
    const value = frameAllow.get(key);
    if (value && value > max) max = value;
  }
  return max;
}

function filterIds(rules, ruleIds) {
  const copy = (list) => list.map((rule) => JSON.parse(JSON.stringify(rule)));
  if (!Array.isArray(ruleIds)) return copy(rules);
  const wanted = new Set(ruleIds);
  return copy(rules.filter((rule) => wanted.has(rule.id)));
}

/** Requête normalisée pour l'évaluation. */
function buildRequest({ url, method = 'GET', resourceType, initiator, tabId = -1, frameKey = null, frameKeys = null }) {
  const host = hostOf(url);
  let initiatorHost = '';
  if (initiator) initiatorHost = hostOf(initiator);
  return {
    url,
    host,
    method: String(method || 'GET').toLowerCase(),
    type: resourceType,
    initiatorHost,
    tabId,
    tokens: urlTokens(url),
    frameKey,
    frameKeys,
  };
}

// --- Redirections ---

function applyTransform(url, transform) {
  const target = new URL(url);
  if (transform.scheme) target.protocol = `${transform.scheme}:`;
  if (transform.host) target.hostname = transform.host;
  if (transform.port !== undefined) target.port = transform.port;
  if (transform.path !== undefined) target.pathname = transform.path || '/';
  if (transform.query !== undefined) target.search = transform.query;
  if (transform.queryTransform) {
    const params = target.searchParams;
    for (const name of transform.queryTransform.removeParams || []) params.delete(name);
    for (const { key, value, replaceOnly } of transform.queryTransform.addOrReplaceParams || []) {
      if (replaceOnly && !params.has(key)) continue;
      params.set(key, value);
    }
  }
  if (transform.fragment !== undefined) target.hash = transform.fragment;
  if (transform.username !== undefined) target.username = transform.username;
  if (transform.password !== undefined) target.password = transform.password;
  return target.href;
}

/** Adresse de redirection d'une règle, ou null. */
function redirectUrlFor(compiled, url) {
  const redirect = compiled.rule.action.redirect || {};
  try {
    if (typeof redirect.url === 'string') return redirect.url;
    if (typeof redirect.extensionPath === 'string') {
      const pathPart = redirect.extensionPath.startsWith('/') ? redirect.extensionPath : `/${redirect.extensionPath}`;
      return `chrome-extension://${compiled.extensionId}${pathPart}`;
    }
    if (redirect.transform) return applyTransform(url, redirect.transform);
    if (typeof redirect.regexSubstitution === 'string' && typeof compiled.condition.regexFilter === 'string') {
      const regex = compiled.getMatcher();
      const match = regex.exec(url);
      if (!match) return null;
      return redirect.regexSubstitution.replace(/\\(\d)/g, (_, n) => match[Number(n)] || '');
    }
  } catch (_) {
    return null;
  }
  return null;
}

/**
 * Décision pour toutes les extensions (`sets` : règles par extension, la plus récente en dernier).
 * Renvoie `{ cancel } | { redirectURL } | { headers: [compiled…] } | null`.
 */
function evaluateAll(sets, request) {
  let redirect = null;
  const headers = [];
  for (const set of sets) {
    const { best, headers: extHeaders } = set.evaluate(request);
    if (best && best.type === 'block') return { cancel: true, matched: best };
    if (best && best.type === 'upgradeScheme') {
      if (/^(http|ws):/i.test(request.url)) {
        redirect = { url: request.url.replace(/^http:/i, 'https:').replace(/^ws:/i, 'wss:'), matched: best };
      }
    } else if (best && best.type === 'redirect') {
      const target = redirectUrlFor(best, request.url);
      if (target && target !== request.url) redirect = { url: target, matched: best };
    }
    headers.push(...extHeaders);
  }
  if (redirect) return { redirectURL: redirect.url, matched: redirect.matched };
  if (headers.length > 0) return { headers };
  return null;
}

/**
 * Applique les opérations sur les en-têtes (`requestHeaders` ou `responseHeaders`). Comme Chrome,
 * une fois qu'un en-tête est modifié par une règle (set / remove), une règle de moindre priorité
 * ne le touche plus (sauf `append` après `append`).
 */
function applyHeaderRules(headerRules, headers, kind) {
  const out = { ...headers };
  const touched = new Map();
  const keyOf = (name) => Object.keys(out).find((key) => key.toLowerCase() === name.toLowerCase());
  for (const compiled of headerRules) {
    const ops = compiled.rule.action[kind];
    if (!Array.isArray(ops)) continue;
    for (const { header, operation, value } of ops) {
      if (typeof header !== 'string') continue;
      const lower = header.toLowerCase();
      const previous = touched.get(lower);
      if (previous && !(previous === 'append' && operation === 'append')) continue;
      const existing = keyOf(header);
      if (operation === 'remove') {
        if (existing) delete out[existing];
      } else if (operation === 'set') {
        if (existing) delete out[existing];
        out[header] = kind === 'responseHeaders' ? [String(value)] : String(value);
      } else if (operation === 'append') {
        if (existing) {
          const current = out[existing];
          if (kind === 'responseHeaders') out[existing] = [...(Array.isArray(current) ? current : [current]), String(value)];
          else out[existing] = `${current}, ${value}`;
        } else out[header] = kind === 'responseHeaders' ? [String(value)] : String(value);
      } else continue;
      touched.set(lower, operation);
    }
  }
  return out;
}

module.exports = {
  LIMITS,
  RESOURCE_TYPES,
  applyHeaderRules,
  buildRequest,
  createExtensionRules,
  dnrResourceType,
  evaluateAll,
  isRegexSupported,
  isValidRule,
  urlFilterToRegExp,
};
