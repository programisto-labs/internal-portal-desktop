'use strict';

/**
 * Adresse → expressions hachées, comme le décrit Google Safe Browsing
 * (« URLs and Hashing », docs/safe-browsing.md) :
 * 1. canonicaliser l'adresse ;
 * 2. combiner jusqu'à 5 suffixes d'hôte et 6 préfixes de chemin (30 expressions au plus) ;
 * 3. SHA-256 de chaque expression : les préfixes (4 octets le plus souvent) sont cherchés dans la
 *    base locale, l'adresse elle-même ne quitte jamais l'ordinateur.
 */

const crypto = require('crypto');

const MAX_HOST_SUFFIXES = 5;
const MAX_PATH_PREFIXES = 6;

/** Décode les %XX jusqu'à ce qu'il n'y en ait plus (« %2525 » → « % »). */
function fullyUnescape(value) {
  let current = String(value);
  for (let i = 0; i < 1024; i += 1) {
    const next = current.replace(/%([0-9a-fA-F]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
    if (next === current) return current;
    current = next;
  }
  return current;
}

/** Ré-échappe ce que la spécification demande : ≤ 0x20, ≥ 0x7f, « # » et « % ». */
function escapeCanonical(value) {
  let out = '';
  for (const char of Buffer.from(String(value), 'latin1')) {
    if (char <= 0x20 || char >= 0x7f || char === 0x23 || char === 0x25) {
      out += `%${char.toString(16).toUpperCase().padStart(2, '0')}`;
    } else {
      out += String.fromCharCode(char);
    }
  }
  return out;
}

/** Chaîne JS → octets UTF-8 lus un par un (pour que l'échappement porte sur les octets). */
function toLatin1Bytes(value) {
  return Buffer.from(String(value), 'utf8').toString('latin1');
}

/** `/a/./b/../c//d` → `/a/c/d`. */
function normalizePath(rawPath) {
  const parts = [];
  for (const segment of rawPath.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  const trailing = /\/(\.|\.\.)?$/.test(rawPath) && parts.length > 0;
  return `/${parts.join('/')}${trailing ? '/' : ''}`;
}

function isIpv4(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/**
 * Adresse canonique `{ host, path, query }` (query sans « ? », null s'il n'y en a pas), ou null
 * pour ce qui n'est pas une page http(s).
 */
function canonicalizeUrl(input) {
  let raw = String(input || '').replace(/[\t\r\n]/g, '').trim();
  if (!raw) return null;
  const hashIndex = raw.indexOf('#');
  if (hashIndex >= 0) raw = raw.slice(0, hashIndex);
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = `http://${raw}`;
  let parsed;
  try {
    // L'analyseur WHATWG s'occupe du schéma, des identifiants, du port, des adresses IP
    // écrites en octal / hexadécimal / entier et du passage des domaines en minuscules. Le
    // décodage des %XX se fait ensuite, partie par partie : un « %23 » décodé n'est pas un fragment.
    parsed = new URL(raw);
  } catch (_) {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  let host = fullyUnescape(parsed.hostname).toLowerCase();
  if (host.startsWith('[')) return { host, path: '/', query: null, ip: true };
  host = host.replace(/^\.+|\.+$/g, '').replace(/\.{2,}/g, '.');
  if (!host) return null;

  // Chemin et query : déjà décodés une fois par l'analyseur, décodés jusqu'au bout puis ré-échappés.
  const rawPath = toLatin1Bytes(fullyUnescape(parsed.pathname || '/'));
  const path = escapeCanonical(normalizePath(rawPath));
  const search = parsed.href.includes('?') ? parsed.search.replace(/^\?/, '') : null;
  const query = search === null ? null : escapeCanonical(toLatin1Bytes(fullyUnescape(search)));
  return { host: escapeCanonical(toLatin1Bytes(host)), path, query, ip: isIpv4(host) };
}

/** Hôte exact, puis les 4 derniers suffixes au plus (jamais le domaine de premier niveau seul). */
function hostSuffixes(host, ip) {
  if (ip) return [host];
  const labels = host.split('.');
  const suffixes = [host];
  const start = Math.max(1, labels.length - MAX_HOST_SUFFIXES);
  for (let i = start; i < labels.length - 1 && suffixes.length < MAX_HOST_SUFFIXES; i += 1) {
    suffixes.push(labels.slice(i).join('.'));
  }
  return suffixes;
}

/** Chemin exact avec query, sans query, puis « / » et les dossiers qui mènent au chemin (4 au plus). */
function pathPrefixes(path, query) {
  const out = [];
  const add = (value) => {
    if (!out.includes(value) && out.length < MAX_PATH_PREFIXES) out.push(value);
  };
  if (query !== null) add(`${path}?${query}`);
  add(path);
  const segments = path.split('/').filter(Boolean);
  const prefixes = ['/'];
  let current = '/';
  for (let i = 0; i < segments.length - (path.endsWith('/') ? 0 : 1) && prefixes.length < 4; i += 1) {
    current += `${segments[i]}/`;
    prefixes.push(current);
  }
  for (const prefix of prefixes) add(prefix);
  return out;
}

/** Expressions « hôte/chemin » à hacher, dans l'ordre de la spécification. */
function urlExpressions(input) {
  const canonical = canonicalizeUrl(input);
  if (!canonical) return [];
  const paths = pathPrefixes(canonical.path, canonical.query);
  const out = [];
  for (const host of hostSuffixes(canonical.host, canonical.ip)) {
    for (const path of paths) out.push(`${host}${path}`);
  }
  return out;
}

/** SHA-256 (32 octets) de chaque expression de l'adresse. */
function urlFullHashes(input) {
  return urlExpressions(input).map((expression) =>
    crypto.createHash('sha256').update(Buffer.from(expression, 'latin1')).digest(),
  );
}

module.exports = {
  canonicalizeUrl,
  hostSuffixes,
  pathPrefixes,
  urlExpressions,
  urlFullHashes,
};
