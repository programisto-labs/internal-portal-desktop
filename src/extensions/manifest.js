'use strict';

/**
 * Manifestes des extensions (docs/extensions.md) : avertissements d'autorisations, accès aux
 * sites et manifeste effectif chargé par Electron.
 */

const fs = require('fs');
const path = require('path');
const { stripBom } = require('./crx');

const ORIGINAL_MANIFEST = 'manifest.lasco-original.json';

/**
 * Avertissements d'autorisations affichés à l'installation, dans l'ordre de Chrome. Clés
 * techniques : le portail les traduit (`permissionWarningText`), Desktop a un texte de secours.
 */
const PERMISSION_WARNINGS = [
  { key: 'allHosts', fallback: 'Lire et modifier toutes vos données sur tous les sites' },
  { key: 'hosts', fallback: 'Lire et modifier vos données sur certains sites' },
  { key: 'debugger', permission: 'debugger', fallback: 'Accéder à la page de débogage du navigateur' },
  { key: 'nativeMessaging', permission: 'nativeMessaging', fallback: 'Communiquer avec des applications natives' },
  { key: 'history', permission: 'history', fallback: "Lire et modifier l'historique de navigation" },
  { key: 'tabs', permission: 'tabs', fallback: "Lire l'historique de navigation" },
  { key: 'bookmarks', permission: 'bookmarks', fallback: 'Lire et modifier vos favoris' },
  { key: 'clipboardRead', permission: 'clipboardRead', fallback: 'Lire les données copiées et collées' },
  { key: 'clipboardWrite', permission: 'clipboardWrite', fallback: 'Modifier les données copiées et collées' },
  { key: 'downloads', permission: 'downloads', fallback: 'Gérer vos téléchargements' },
  { key: 'geolocation', permission: 'geolocation', fallback: 'Détecter votre position' },
  { key: 'notifications', permission: 'notifications', fallback: 'Afficher des notifications' },
  { key: 'privacy', permission: 'privacy', fallback: 'Modifier vos paramètres de confidentialité' },
  { key: 'management', permission: 'management', fallback: 'Gérer vos applications, extensions et thèmes' },
  { key: 'proxy', permission: 'proxy', fallback: 'Lire et modifier tous vos paramètres de proxy' },
  { key: 'webNavigation', permission: 'webNavigation', fallback: "Lire l'historique de navigation" },
  { key: 'declarativeNetRequest', permission: 'declarativeNetRequest', fallback: 'Bloquer des contenus sur toutes les pages' },
  { key: 'cookies', permission: 'cookies', fallback: 'Lire et modifier les cookies des sites' },
  { key: 'identity', permission: 'identity', fallback: 'Vous connecter à des services en votre nom' },
  { key: 'userScripts', permission: 'userScripts', fallback: 'Exécuter des scripts sur les pages' },
];

function isAllHostsPattern(pattern) {
  if (typeof pattern !== 'string') return false;
  return pattern === '<all_urls>' || /^(\*|https?|wss?):\/\/\*\/\*$/.test(pattern) || pattern === '*://*/*';
}

/** Hôtes demandés (host_permissions, permissions MV2, scripts de contenu). */
function requestedHostPatterns(manifest) {
  const out = new Set();
  const add = (pattern) => {
    if (typeof pattern === 'string' && /^(<all_urls>|[a-z*]+:\/\/)/.test(pattern)) out.add(pattern);
  };
  for (const p of Array.isArray(manifest.host_permissions) ? manifest.host_permissions : []) add(p);
  if (manifest.manifest_version === 2) for (const p of manifest.permissions || []) add(p);
  for (const script of Array.isArray(manifest.content_scripts) ? manifest.content_scripts : []) {
    for (const p of script.matches || []) add(p);
  }
  return [...out];
}

function apiPermissions(manifest) {
  return (Array.isArray(manifest.permissions) ? manifest.permissions : []).filter(
    (p) => typeof p === 'string' && !p.includes('://') && p !== '<all_urls>',
  );
}

/** Avertissements d'un manifeste : `[{ key, hosts?, fallback }]`. */
function permissionWarnings(manifest) {
  const hosts = requestedHostPatterns(manifest);
  const permissions = new Set(apiPermissions(manifest));
  const out = [];
  if (hosts.some(isAllHostsPattern)) out.push({ key: 'allHosts', fallback: PERMISSION_WARNINGS[0].fallback });
  else if (hosts.length > 0) {
    const names = [...new Set(hosts.map(hostLabel).filter(Boolean))].slice(0, 10);
    out.push({ key: 'hosts', hosts: names, fallback: `${PERMISSION_WARNINGS[1].fallback} : ${names.join(', ')}` });
  }
  for (const warning of PERMISSION_WARNINGS) {
    if (!warning.permission || !permissions.has(warning.permission)) continue;
    // `tabs` et `webNavigation` donnent le même avertissement : une fois.
    if (warning.key === 'webNavigation' && permissions.has('tabs')) continue;
    out.push({ key: warning.key, fallback: warning.fallback });
  }
  return out;
}

function hostLabel(pattern) {
  const match = /^[a-z*]+:\/\/([^/]+)/.exec(pattern);
  if (!match) return null;
  return match[1].replace(/^\*\./, '');
}

/** Nouvelles autorisations d'une mise à jour (clés d'avertissement absentes avant). */
function addedWarnings(previousManifest, nextManifest) {
  const before = new Set(permissionWarnings(previousManifest).map((w) => (w.key === 'hosts' ? `hosts:${w.hosts}` : w.key)));
  const had = new Set(permissionWarnings(previousManifest).map((w) => w.key));
  return permissionWarnings(nextManifest).filter((w) => {
    if (w.key === 'hosts') return !had.has('allHosts') && !before.has(`hosts:${w.hosts}`);
    if (w.key === 'allHosts') return !had.has('allHosts');
    return !had.has(w.key);
  });
}

function hasAction(manifest) {
  return Boolean(manifest && (manifest.action || manifest.browser_action || manifest.page_action));
}

function optionsPage(manifest) {
  const page = (manifest.options_ui && manifest.options_ui.page) || manifest.options_page;
  return typeof page === 'string' ? page.replace(/^\//, '') : null;
}

/** Icône la plus proche de `size` (chemin relatif dans l'extension). */
function bestIconPath(manifest, size = 32) {
  const icons = { ...(manifest.icons || {}) };
  const action = manifest.action || manifest.browser_action || {};
  if (action.default_icon && typeof action.default_icon === 'object') Object.assign(icons, action.default_icon);
  else if (typeof action.default_icon === 'string') icons[String(size)] = action.default_icon;
  const entries = Object.entries(icons)
    .map(([key, value]) => [Number(key), value])
    .filter(([key, value]) => Number.isFinite(key) && typeof value === 'string');
  if (entries.length === 0) return null;
  entries.sort((a, b) => {
    const da = a[0] >= size ? a[0] - size : (size - a[0]) * 4;
    const db = b[0] >= size ? b[0] - size : (size - b[0]) * 4;
    return da - db;
  });
  return entries[0][1].replace(/^\//, '');
}

// --- Accès aux sites et manifeste effectif ---

/**
 * Motifs de correspondance d'un site accordé (`https://exemple.fr`) : le site et ses sous-domaines.
 */
function patternsForSite(origin) {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return [];
    const host = url.hostname;
    return [`${url.protocol}//${host}/*`, `${url.protocol}//*.${host}/*`];
  } catch (_) {
    return [];
  }
}

/** Motifs d'exclusion des adresses de Lasco (origines du portail et de l'API). */
function lascoExcludePatterns(protectedOrigins) {
  const out = new Set();
  for (const origin of protectedOrigins || []) {
    try {
      const url = new URL(origin);
      out.add(`${url.protocol}//${url.hostname}/*`);
    } catch (_) {
      // Origine illisible : ignorée.
    }
  }
  return [...out];
}

/**
 * Manifeste effectif : `siteAccess` `all` (comme déclaré), `specific` (sites accordés seulement)
 * ou `click` (aucun site au chargement ; accès temporaire au clic). Les adresses de Lasco sont
 * toujours exclues des scripts de contenu.
 */
function effectiveManifest(original, { siteAccess = 'all', sites = [], protectedOrigins = [] } = {}) {
  const manifest = JSON.parse(JSON.stringify(original));
  const exclude = lascoExcludePatterns(protectedOrigins);
  const granted = siteAccess === 'specific' ? sites.flatMap(patternsForSite) : siteAccess === 'click' ? [] : null;
  if (granted) {
    const keepHost = (pattern) => !(typeof pattern === 'string' && /^(<all_urls>|[a-z*]+:\/\/)/.test(pattern));
    if (Array.isArray(manifest.host_permissions)) {
      manifest.host_permissions = granted.length > 0 ? granted : [];
    }
    if (manifest.manifest_version === 2 && Array.isArray(manifest.permissions)) {
      manifest.permissions = [...manifest.permissions.filter(keepHost), ...granted];
    }
    if (Array.isArray(manifest.optional_host_permissions)) {
      manifest.optional_host_permissions = [...new Set([...manifest.optional_host_permissions, ...requestedHostPatterns(original)])];
    }
  }
  if (Array.isArray(manifest.content_scripts)) {
    manifest.content_scripts = manifest.content_scripts
      .map((script) => {
        const next = { ...script };
        if (granted) next.matches = intersectMatches(script.matches || [], granted);
        if (exclude.length > 0) next.exclude_matches = [...new Set([...(script.exclude_matches || []), ...exclude])];
        return next;
      })
      // Chrome refuse un script sans `matches` : retiré tant que le site n'est pas accordé.
      .filter((script) => Array.isArray(script.matches) && script.matches.length > 0);
  }
  return manifest;
}

/** Motifs du script gardés pour les sites accordés (un motif large devient les sites accordés). */
function intersectMatches(matches, granted) {
  const out = new Set();
  for (const pattern of matches) {
    if (isAllHostsPattern(pattern) || /^[a-z*]+:\/\/\*\//.test(pattern)) {
      for (const g of granted) out.add(g);
      continue;
    }
    const host = hostLabel(pattern);
    if (host && granted.some((g) => hostLabel(g) === host || hostLabel(g) === `*.${host}`)) out.add(pattern);
  }
  return [...out];
}

/** Lit le manifeste d'origine d'un dossier d'extension (celui de l'éditeur, jamais l'effectif). */
function readOriginalManifest(dir, fsImpl = fs) {
  const original = path.join(dir, ORIGINAL_MANIFEST);
  const file = fsImpl.existsSync(original) ? original : path.join(dir, 'manifest.json');
  return JSON.parse(stripBom(fsImpl.readFileSync(file, 'utf8')));
}

/** Écrit le manifeste effectif (dossier géré par Lasco seulement : jamais un dossier décompressé). */
function writeEffectiveManifest(dir, options, fsImpl = fs) {
  const originalPath = path.join(dir, ORIGINAL_MANIFEST);
  if (!fsImpl.existsSync(originalPath)) fsImpl.copyFileSync(path.join(dir, 'manifest.json'), originalPath);
  const original = readOriginalManifest(dir, fsImpl);
  const effective = effectiveManifest(original, options);
  const target = path.join(dir, 'manifest.json');
  const tmp = `${target}.tmp`;
  fsImpl.writeFileSync(tmp, JSON.stringify(effective, null, 2));
  fsImpl.renameSync(tmp, target);
  return { original, effective };
}

/** Texte localisé `__MSG_nom__` du manifeste (dossier `_locales`). */
function localizeManifestString(dir, manifest, value, locales = [], fsImpl = fs) {
  if (typeof value !== 'string') return value;
  const match = /^__MSG_(.+)__$/.exec(value);
  if (!match) return value;
  const key = match[1].toLowerCase();
  const candidates = [...locales, manifest.default_locale, 'en'].filter(Boolean);
  for (const locale of candidates) {
    for (const variant of [locale, String(locale).replace('-', '_'), String(locale).split(/[-_]/)[0]]) {
      try {
        const file = path.join(dir, '_locales', variant, 'messages.json');
        const messages = JSON.parse(stripBom(fsImpl.readFileSync(file, 'utf8')));
        const entry = Object.entries(messages).find(([name]) => name.toLowerCase() === key);
        if (entry && entry[1] && typeof entry[1].message === 'string') return entry[1].message;
      } catch (_) {
        // Langue absente : suivante.
      }
    }
  }
  return value;
}

module.exports = {
  ORIGINAL_MANIFEST,
  PERMISSION_WARNINGS,
  addedWarnings,
  apiPermissions,
  bestIconPath,
  effectiveManifest,
  hasAction,
  isAllHostsPattern,
  localizeManifestString,
  optionsPage,
  patternsForSite,
  permissionWarnings,
  readOriginalManifest,
  requestedHostPatterns,
  writeEffectiveManifest,
};
