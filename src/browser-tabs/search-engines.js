'use strict';

/**
 * Moteurs de recherche du navigateur de Lasco (docs/search-engines.md).
 *
 * - Moteurs proposés (Google, Bing, DuckDuckGo, Ecosia…), un seul par défaut.
 * - Recherche sur les sites, comme Chrome / Brave : un raccourci (« wikipedia.org ») et une URL
 *   où `%s` est remplacé par la recherche. Ajoutés à la main (Réglages > Moteur de recherche) ou
 *   repérés sur les sites visités qui déclarent une description OpenSearch
 *   (`<link rel="search" type="application/opensearchdescription+xml">`).
 *
 * Pur Node (pas d'Electron) pour être testé ; le disque passe par `fsImpl`.
 */

const fs = require('fs');
const path = require('path');
const { sanitizeBrowserUrl } = require('./url');

const BUILTIN_ENGINES = Object.freeze([
  { id: 'google', name: 'Google', keyword: 'google.com', template: 'https://www.google.com/search?q=%s' },
  { id: 'bing', name: 'Bing', keyword: 'bing.com', template: 'https://www.bing.com/search?q=%s' },
  { id: 'duckduckgo', name: 'DuckDuckGo', keyword: 'duckduckgo.com', template: 'https://duckduckgo.com/?q=%s' },
  { id: 'ecosia', name: 'Ecosia', keyword: 'ecosia.org', template: 'https://www.ecosia.org/search?q=%s' },
  { id: 'brave', name: 'Brave Search', keyword: 'search.brave.com', template: 'https://search.brave.com/search?q=%s' },
  { id: 'qwant', name: 'Qwant', keyword: 'qwant.com', template: 'https://www.qwant.com/?q=%s' },
  { id: 'startpage', name: 'Startpage', keyword: 'startpage.com', template: 'https://www.startpage.com/do/search?q=%s' },
  { id: 'kagi', name: 'Kagi', keyword: 'kagi.com', template: 'https://kagi.com/search?q=%s' },
]);
const DEFAULT_ENGINE_ID = 'google';

const MAX_NAME_LENGTH = 60;
const MAX_KEYWORD_LENGTH = 60;
const MAX_TEMPLATE_LENGTH = 2048;
const MAX_CUSTOM_ENGINES = 100;
const MAX_SITE_ENGINES = 300;
const MAX_DESCRIPTION_BYTES = 64 * 1024;
const SAVE_DELAY_MS = 500;

/** Paramètres OpenSearch connus : `?` = facultatif (vidé), sinon valeur fixe. */
const OPENSEARCH_PARAMS = {
  searchTerms: '%s',
  inputEncoding: 'UTF-8',
  outputEncoding: 'UTF-8',
  language: '*',
  count: '',
  startIndex: '',
  startPage: '',
};

function normalizeKeyword(value) {
  return String(value || '').trim().toLowerCase();
}

/** Hôte comparé sans `www.` (« www.wikipedia.org » et « wikipedia.org » sont le même site). */
function bareHost(hostname) {
  return String(hostname || '').toLowerCase().replace(/^www\./, '');
}

function cleanText(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * URL de recherche valide : http(s), sans identifiants, avec `%s`. Renvoie le gabarit normalisé
 * (`%s` gardé tel quel) ou null.
 */
function validateTemplate(template) {
  const raw = String(template || '').trim();
  if (!raw || raw.length > MAX_TEMPLATE_LENGTH || !raw.includes('%s')) return null;
  // `%s` n'est pas un échappement valide : on le protège le temps de vérifier l'URL.
  const marker = 'lascosearchterms';
  const probe = sanitizeBrowserUrl(raw.split('%s').join(marker));
  if (!probe || !probe.includes(marker)) return null;
  try {
    const parsed = new URL(raw.split('%s').join(marker));
    if (parsed.username || parsed.password) return null;
  } catch (_) {
    return null;
  }
  return probe.split(marker).join('%s');
}

function buildSearchUrl(engine, text) {
  if (!engine || !engine.template) return null;
  const query = String(text || '').trim();
  if (!query) return null;
  return sanitizeBrowserUrl(engine.template.split('%s').join(encodeURIComponent(query)));
}

function decodeXmlEntities(value) {
  return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (all, code) => {
    const lower = code.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    const n = lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all;
  });
}

function readAttributes(tag) {
  const attrs = {};
  const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(tag))) attrs[m[1].toLowerCase()] = decodeXmlEntities(m[3] !== undefined ? m[3] : m[4]);
  return attrs;
}

/** OpenSearch `{param}` / `{param?}` → `%s`, valeur fixe ou vide. Paramètre inconnu requis : refus. */
function openSearchTemplateToPattern(template) {
  let ok = true;
  const out = String(template || '').replace(/\{([\w:]+)(\?)?\}/g, (_all, name, optional) => {
    const local = name.includes(':') ? name.split(':').pop() : name;
    if (Object.prototype.hasOwnProperty.call(OPENSEARCH_PARAMS, local) && !name.includes(':')) {
      return OPENSEARCH_PARAMS[local];
    }
    if (optional) return '';
    ok = false;
    return '';
  });
  return ok ? out : null;
}

/**
 * Lit une description OpenSearch : nom court et URL de recherche HTML (`<Url type="text/html">`,
 * méthode GET). Renvoie `{ name, template }` (`%s` à la place de la recherche) ou null.
 */
function parseOpenSearchDescription(xml) {
  const text = String(xml || '');
  if (!text || text.length > MAX_DESCRIPTION_BYTES) return null;
  const nameMatch = /<(?:[\w-]+:)?ShortName[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?ShortName>/i.exec(text);
  const name = cleanText(decodeXmlEntities(nameMatch ? nameMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '') : ''), MAX_NAME_LENGTH);
  const urlTags = text.match(/<(?:[\w-]+:)?Url\b[^>]*>/gi) || [];
  for (const tag of urlTags) {
    const attrs = readAttributes(tag);
    if (String(attrs.type || '').toLowerCase() !== 'text/html') continue;
    const method = String(attrs.method || 'get').toLowerCase();
    if (method !== 'get') continue;
    if (!attrs.template || !attrs.template.includes('{searchTerms}')) continue;
    const pattern = openSearchTemplateToPattern(attrs.template);
    const template = pattern && validateTemplate(pattern);
    if (template) return { name, template };
  }
  return null;
}

/**
 * Un site ne peut déclarer qu'une recherche chez lui : même hôte (au `www.` près) pour la page,
 * la description OpenSearch et l'URL de recherche. Renvoie le raccourci (hôte sans `www.`) ou null.
 */
function discoveryKeyword(pageUrl, descriptionUrl, template) {
  const page = sanitizeBrowserUrl(pageUrl);
  const description = sanitizeBrowserUrl(descriptionUrl);
  const search = template && sanitizeBrowserUrl(template.split('%s').join('x'));
  if (!page || !description || !search) return null;
  const host = bareHost(new URL(page).hostname);
  if (!host || !host.includes('.')) return null;
  if (bareHost(new URL(description).hostname) !== host) return null;
  if (bareHost(new URL(search).hostname) !== host) return null;
  return host;
}

function randomId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function publicEngine(engine, kind) {
  return {
    id: engine.id,
    name: engine.name,
    keyword: engine.keyword,
    template: engine.template,
    kind,
    active: kind === 'site' ? engine.active !== false : true,
    ...(engine.favicon ? { favicon: engine.favicon } : {}),
  };
}

/**
 * @param {{ filePath?: string, fsImpl?: typeof fs, now?: () => number, saveDelayMs?: number }} [options]
 */
function createSearchEngineStore({ filePath, fsImpl = fs, now = () => Date.now(), saveDelayMs = SAVE_DELAY_MS } = {}) {
  let loaded = false;
  let defaultId = DEFAULT_ENGINE_ID;
  let autoDiscover = true;
  /** @type {Array<{ id: string, name: string, keyword: string, template: string, createdAt: number }>} */
  let custom = [];
  /** @type {Array<{ id: string, name: string, keyword: string, template: string, host: string, favicon?: string, active: boolean, addedAt: number, lastUsedAt: number }>} */
  let sites = [];
  let saveTimer = null;
  const listeners = new Set();

  function load() {
    if (loaded) return;
    loaded = true;
    if (!filePath) return;
    try {
      const raw = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
      if (raw && typeof raw === 'object') {
        if (typeof raw.defaultId === 'string') defaultId = raw.defaultId;
        if (typeof raw.autoDiscover === 'boolean') autoDiscover = raw.autoDiscover;
        const seen = new Set(BUILTIN_ENGINES.map((e) => e.keyword));
        for (const item of Array.isArray(raw.custom) ? raw.custom : []) {
          const entry = sanitizeStored(item);
          if (!entry || seen.has(entry.keyword)) continue;
          seen.add(entry.keyword);
          custom.push({ ...entry, createdAt: Number(item.createdAt) || 0 });
        }
        for (const item of Array.isArray(raw.sites) ? raw.sites : []) {
          const entry = sanitizeStored(item);
          if (!entry || seen.has(entry.keyword)) continue;
          seen.add(entry.keyword);
          sites.push({
            ...entry,
            host: entry.keyword,
            active: item.active !== false,
            addedAt: Number(item.addedAt) || 0,
            lastUsedAt: Number(item.lastUsedAt) || 0,
            ...(typeof item.favicon === 'string' && sanitizeBrowserUrl(item.favicon) ? { favicon: item.favicon } : {}),
          });
        }
      }
    } catch (_) {
      // Fichier absent ou illisible : réglages par défaut.
    }
    if (!findById(defaultId)) defaultId = DEFAULT_ENGINE_ID;
  }

  function sanitizeStored(item) {
    if (!item || typeof item.id !== 'string' || !item.id) return null;
    const name = cleanText(item.name, MAX_NAME_LENGTH);
    const keyword = normalizeKeyword(item.keyword);
    const template = validateTemplate(item.template);
    if (!name || !keyword || /\s/.test(keyword) || keyword.length > MAX_KEYWORD_LENGTH || !template) return null;
    return { id: item.id, name, keyword, template };
  }

  function writeNow() {
    if (!filePath) return;
    try {
      fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      fsImpl.writeFileSync(tmp, JSON.stringify({ version: 1, defaultId, autoDiscover, custom, sites }));
      fsImpl.renameSync(tmp, filePath);
    } catch (_) {
      // Au mieux : un échec d'écriture ne casse pas la navigation.
    }
  }

  function changed() {
    if (filePath && !saveTimer) {
      saveTimer = setTimeout(() => {
        saveTimer = null;
        writeNow();
      }, saveDelayMs);
      if (saveTimer.unref) saveTimer.unref();
    }
    for (const listener of listeners) {
      try {
        listener();
      } catch (_) {
        // Un abonné en erreur n'empêche pas les autres.
      }
    }
  }

  function flush() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (loaded) writeNow();
  }

  function findById(id) {
    const builtin = BUILTIN_ENGINES.find((e) => e.id === id);
    if (builtin) return publicEngine(builtin, 'builtin');
    const own = custom.find((e) => e.id === id);
    if (own) return publicEngine(own, 'custom');
    const site = sites.find((e) => e.id === id);
    if (site) return publicEngine(site, 'site');
    return null;
  }

  function keywordTaken(keyword, exceptId) {
    return (
      BUILTIN_ENGINES.some((e) => e.keyword === keyword && e.id !== exceptId) ||
      custom.some((e) => e.keyword === keyword && e.id !== exceptId) ||
      sites.some((e) => e.keyword === keyword && e.id !== exceptId)
    );
  }

  function getDefault() {
    load();
    const engine = findById(defaultId);
    return engine && engine.active ? engine : findById(DEFAULT_ENGINE_ID);
  }

  function list() {
    load();
    return {
      defaultId: getDefault().id,
      autoDiscover,
      engines: [
        ...BUILTIN_ENGINES.map((e) => publicEngine(e, 'builtin')),
        ...custom.map((e) => publicEngine(e, 'custom')),
        ...[...sites].sort((a, b) => a.name.localeCompare(b.name)).map((e) => publicEngine(e, 'site')),
      ],
    };
  }

  /** Ce que la barre d'adresse du portail reçoit : moteur par défaut et raccourcis actifs. */
  function snapshot() {
    const { defaultId: id, engines } = list();
    return {
      defaultEngine: engines.find((e) => e.id === id),
      engines: engines.filter((e) => e.active),
    };
  }

  function setDefault(id) {
    load();
    const engine = findById(id);
    if (!engine || !engine.active) return { ok: false, error: 'unknown-engine' };
    if (defaultId !== engine.id) {
      defaultId = engine.id;
      changed();
    }
    return { ok: true };
  }

  function setAutoDiscover(enabled) {
    load();
    if (typeof enabled !== 'boolean') return { ok: false, error: 'invalid' };
    if (autoDiscover !== enabled) {
      autoDiscover = enabled;
      changed();
    }
    return { ok: true };
  }

  function validateFields({ name, keyword, template }, exceptId) {
    const cleanName = cleanText(name, MAX_NAME_LENGTH + 1);
    if (!cleanName) return { error: 'name-required' };
    if (cleanName.length > MAX_NAME_LENGTH) return { error: 'name-too-long' };
    const cleanKeyword = normalizeKeyword(keyword);
    if (!cleanKeyword) return { error: 'keyword-required' };
    if (/\s/.test(cleanKeyword)) return { error: 'keyword-spaces' };
    if (cleanKeyword.length > MAX_KEYWORD_LENGTH) return { error: 'keyword-too-long' };
    if (keywordTaken(cleanKeyword, exceptId)) return { error: 'keyword-taken' };
    const cleanTemplate = validateTemplate(template);
    if (!cleanTemplate) return { error: 'invalid-template' };
    return { value: { name: cleanName, keyword: cleanKeyword, template: cleanTemplate } };
  }

  function addCustom(fields = {}) {
    load();
    if (custom.length >= MAX_CUSTOM_ENGINES) return { ok: false, error: 'too-many' };
    const checked = validateFields(fields, null);
    if (checked.error) return { ok: false, error: checked.error };
    const entry = { id: randomId('custom'), ...checked.value, createdAt: now() };
    custom.push(entry);
    changed();
    return { ok: true, engine: publicEngine(entry, 'custom') };
  }

  /** Modifie un moteur ajouté à la main, ou un moteur de site (qui devient alors un moteur à soi). */
  function update(id, fields = {}) {
    load();
    const own = custom.find((e) => e.id === id);
    const site = own ? null : sites.find((e) => e.id === id);
    const target = own || site;
    if (!target) return { ok: false, error: 'unknown-engine' };
    const checked = validateFields({ ...target, ...fields }, id);
    if (checked.error) return { ok: false, error: checked.error };
    if (site) {
      // Modifié à la main : le site ne le réécrit plus.
      sites = sites.filter((e) => e.id !== id);
      custom.push({ id, ...checked.value, createdAt: now() });
    } else {
      Object.assign(own, checked.value);
    }
    changed();
    return { ok: true, engine: findById(id) };
  }

  function remove(id) {
    load();
    const before = custom.length + sites.length;
    custom = custom.filter((e) => e.id !== id);
    sites = sites.filter((e) => e.id !== id);
    if (custom.length + sites.length === before) return { ok: false, error: 'unknown-engine' };
    if (defaultId === id) defaultId = DEFAULT_ENGINE_ID;
    changed();
    return { ok: true };
  }

  function setActive(id, active) {
    load();
    const site = sites.find((e) => e.id === id);
    if (!site || typeof active !== 'boolean') return { ok: false, error: 'unknown-engine' };
    if (site.active !== active) {
      site.active = active;
      if (!active && defaultId === id) defaultId = DEFAULT_ENGINE_ID;
      changed();
    }
    return { ok: true };
  }

  /** Un raccourci vient de servir dans la barre d'adresse (garde les sites utilisés en cas d'éviction). */
  function markUsed(id) {
    load();
    const site = sites.find((e) => e.id === id);
    if (!site) return { ok: false, error: 'unknown-engine' };
    site.lastUsedAt = now();
    changed();
    return { ok: true };
  }

  /** Le site a-t-il déjà un raccourci (pour éviter de relire sa description à chaque page) ? */
  function knowsHost(host) {
    load();
    return keywordTaken(bareHost(host), null);
  }

  /**
   * Moteur déclaré par un site (OpenSearch). Ignoré si la découverte est coupée, si le raccourci
   * existe déjà, ou si l'URL ne reste pas sur le site. Un moteur de site supprimé revient à la
   * visite suivante (comme Chrome) : le désactiver le garde hors de la barre d'adresse.
   */
  function addDiscovered({ pageUrl, descriptionUrl, name, template, favicon } = {}) {
    load();
    if (!autoDiscover) return { ok: false, error: 'disabled' };
    const cleanTemplate = validateTemplate(template);
    const keyword = cleanTemplate && discoveryKeyword(pageUrl, descriptionUrl, cleanTemplate);
    if (!keyword) return { ok: false, error: 'invalid' };
    if (keywordTaken(keyword, null)) return { ok: false, error: 'exists' };
    const entry = {
      id: randomId('site'),
      name: cleanText(name, MAX_NAME_LENGTH) || keyword,
      keyword,
      template: cleanTemplate,
      host: keyword,
      active: true,
      addedAt: now(),
      lastUsedAt: 0,
      ...(typeof favicon === 'string' && sanitizeBrowserUrl(favicon) ? { favicon } : {}),
    };
    sites.push(entry);
    if (sites.length > MAX_SITE_ENGINES) {
      // Le moins récemment utilisé (puis le plus ancien) part, jamais celui par défaut.
      const victim = [...sites]
        .filter((e) => e.id !== defaultId && e.id !== entry.id)
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.addedAt - b.addedAt)[0];
      if (victim) sites = sites.filter((e) => e !== victim);
    }
    changed();
    return { ok: true, engine: publicEngine(entry, 'site') };
  }

  function isAutoDiscoverEnabled() {
    load();
    return autoDiscover;
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return {
    list,
    snapshot,
    getDefault,
    setDefault,
    setAutoDiscover,
    isAutoDiscoverEnabled,
    addCustom,
    update,
    remove,
    setActive,
    markUsed,
    knowsHost,
    addDiscovered,
    subscribe,
    flush,
  };
}

/** Script lu dans un monde isolé de la page : adresse de sa description OpenSearch, ou null. */
const OPENSEARCH_LINK_SCRIPT = `(() => {
  const link = document.querySelector('link[rel~="search" i][type="application/opensearchdescription+xml" i][href]');
  return link ? { href: link.href, title: link.getAttribute('title') || '' } : null;
})()`;

/**
 * Repère le moteur d'un site après le chargement d'une page.
 * `readLink()` → `{ href, title }` | null ; `fetchText(url)` → texte de la description (borné).
 */
async function discoverSiteSearchEngine({ store, pageUrl, readLink, fetchText, favicon }) {
  const page = sanitizeBrowserUrl(pageUrl);
  if (!store || !page || !store.isAutoDiscoverEnabled()) return { ok: false, error: 'skipped' };
  const host = new URL(page).hostname;
  if (store.knowsHost(host)) return { ok: false, error: 'exists' };
  const link = await readLink();
  const href = link && sanitizeBrowserUrl(link.href);
  if (!href || bareHost(new URL(href).hostname) !== bareHost(host)) return { ok: false, error: 'no-description' };
  const xml = await fetchText(href);
  const parsed = parseOpenSearchDescription(xml);
  if (!parsed) return { ok: false, error: 'invalid-description' };
  return store.addDiscovered({
    pageUrl: page,
    descriptionUrl: href,
    name: parsed.name || cleanText(link.title, MAX_NAME_LENGTH),
    template: parsed.template,
    favicon,
  });
}

module.exports = {
  BUILTIN_ENGINES,
  DEFAULT_ENGINE_ID,
  MAX_DESCRIPTION_BYTES,
  OPENSEARCH_LINK_SCRIPT,
  createSearchEngineStore,
  buildSearchUrl,
  validateTemplate,
  parseOpenSearchDescription,
  discoveryKeyword,
  discoverSiteSearchEngine,
};
