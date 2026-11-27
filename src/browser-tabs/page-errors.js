'use strict';

/**
 * Pages d'erreur des onglets web et état de sécurité de la barre d'adresse
 * (docs/site-permissions.md, section « Pages d'erreur »).
 */

const path = require('path');
const { sanitizeBrowserUrl } = require('./url');

const ERROR_PAGE = path.join(__dirname, 'tab-error.html');

/** Erreurs réseau les plus courantes (codes Chromium net::ERR_*). */
const NETWORK_MESSAGES = {
  '-105': "Impossible de trouver l'adresse du serveur.",
  '-137': "Impossible de trouver l'adresse du serveur.",
  '-106': "Vous n'êtes pas connecté à Internet.",
  '-21': 'La connexion réseau a changé.',
  '-102': 'Le serveur a refusé la connexion.',
  '-101': 'La connexion a été réinitialisée.',
  '-100': 'La connexion a été fermée.',
  '-109': 'Le serveur est injoignable.',
  '-118': 'Le serveur met trop de temps à répondre.',
  '-7': 'Le serveur met trop de temps à répondre.',
  '-324': "Le serveur n'a envoyé aucune donnée.",
  '-310': 'Trop de redirections.',
  '-130': 'Le proxy a refusé la connexion.',
};

/** net::ERR_CERT_* et erreurs SSL voisines : Chromium les place entre -200 et -299. */
function isCertificateError(errorCode) {
  return Number.isInteger(errorCode) && errorCode <= -200 && errorCode >= -299;
}

/**
 * Échec de chargement du document principal → page à afficher, ou null (navigation annulée,
 * téléchargement, page d'erreur elle-même).
 */
function classifyLoadFailure({ errorCode, errorDescription, validatedURL, isMainFrame }) {
  if (!isMainFrame || errorCode === -3 || !Number.isInteger(errorCode) || errorCode >= 0) return null;
  const url = sanitizeBrowserUrl(validatedURL);
  if (!url) return null;
  const code = String(errorDescription || '').replace(/^net::/, '') || `ERR ${errorCode}`;
  if (isCertificateError(errorCode)) return { kind: 'certificate', url, code };
  return {
    kind: 'network',
    url,
    code,
    message: NETWORK_MESSAGES[String(errorCode)] || "La page n'a pas pu être chargée.",
  };
}

/** Raison d'un processus de page arrêté qui mérite la page « Cet onglet a planté ». */
function isTabCrash(details) {
  const reason = details && details.reason;
  return Boolean(reason) && reason !== 'clean-exit';
}

function isLocalHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1';
}

/**
 * Cadenas de la barre d'adresse :
 * - `secure` : https chargé ;
 * - `insecure` : http (sauf machine locale) ;
 * - `dangerous` : certificat refusé, ou site signalé par Safe Browsing (docs/safe-browsing.md) ;
 * - `local` : http sur cette machine ;
 * - null : rien à afficher (onglet vide, page d'erreur réseau ou plantage).
 */
function securityStateOf(url, errorPage) {
  if (errorPage) return errorPage.kind === 'certificate' || errorPage.kind === 'safe-browsing' ? 'dangerous' : null;
  try {
    const parsed = new URL(String(url || ''));
    if (parsed.protocol === 'https:') return 'secure';
    if (parsed.protocol === 'http:') return isLocalHost(parsed.hostname) ? 'local' : 'insecure';
  } catch (_) {
    // adresse vide
  }
  return null;
}

/** Paramètres lus par tab-error.js (texte seulement, jamais du HTML). */
function errorPageQuery(errorPage) {
  let host = '';
  try {
    host = new URL(errorPage.url).host;
  } catch (_) {
    host = '';
  }
  const query = { kind: errorPage.kind, url: errorPage.url || '', host };
  if (errorPage.code) query.code = String(errorPage.code);
  if (errorPage.message) query.message = String(errorPage.message);
  if (errorPage.reason) query.reason = String(errorPage.reason);
  if (errorPage.kind === 'safe-browsing') {
    query.threat = SAFE_BROWSING_THREATS.includes(errorPage.threat) ? errorPage.threat : 'malware';
    if (errorPage.token) query.token = String(errorPage.token);
    const texts = cleanSafeBrowsingTexts(errorPage.texts);
    if (texts) query.texts = JSON.stringify(texts);
  }
  return query;
}

/** Menaces de la page « Site dangereux » (docs/safe-browsing.md). */
const SAFE_BROWSING_THREATS = ['malware', 'phishing', 'unwanted'];

/** Textes de la page « Site dangereux » fournis par le portail, dans la langue de la personne. */
const SAFE_BROWSING_TEXT_KEYS = [
  'phishingTitle',
  'phishingMessage',
  'phishingDetails',
  'malwareTitle',
  'malwareMessage',
  'malwareDetails',
  'unwantedTitle',
  'unwantedMessage',
  'unwantedDetails',
  'back',
  'showDetails',
  'hideDetails',
  'proceed',
  'siteLabel',
];
const MAX_TEXT_LENGTH = 800;

/** Garde seulement les clés connues, en texte court (jamais du HTML : la page les insère en texte). */
function cleanSafeBrowsingTexts(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const key of SAFE_BROWSING_TEXT_KEYS) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim()) out[key] = value.trim().slice(0, MAX_TEXT_LENGTH);
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Geste lu dans l'adresse de la page d'avertissement après un clic (`#proceed-<jeton>` ou
 * `#back-<jeton>`, posé par tab-error.js avec `location.replace`). Le jeton, tiré au hasard à chaque
 * avertissement, empêche toute autre page d'ouvrir le site à sa place. Null sinon.
 */
function safeBrowsingGesture(url, errorPage) {
  if (!errorPage || errorPage.kind !== 'safe-browsing' || !errorPage.token) return null;
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch (_) {
    return null;
  }
  if (parsed.protocol !== 'file:') return null;
  const match = /^#(proceed|back)-([A-Za-z0-9-]+)$/.exec(parsed.hash);
  if (!match || match[2] !== errorPage.token) return null;
  return match[1];
}

/** Page « Site dangereux » de Lasco relue depuis son adresse (file://…/tab-error.html?kind=safe-browsing…). */
function safeBrowsingPageFromUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch (_) {
    return null;
  }
  if (parsed.protocol !== 'file:') return null;
  let filePath = '';
  try {
    filePath = require('url').fileURLToPath(`file://${parsed.host}${parsed.pathname}`);
  } catch (_) {
    return null;
  }
  if (path.resolve(filePath) !== path.resolve(ERROR_PAGE)) return null;
  const params = parsed.searchParams;
  if (params.get('kind') !== 'safe-browsing') return null;
  const blocked = sanitizeBrowserUrl(params.get('url') || '');
  const token = params.get('token') || '';
  if (!blocked || !/^[A-Za-z0-9-]+$/.test(token)) return null;
  const threat = SAFE_BROWSING_THREATS.includes(params.get('threat')) ? params.get('threat') : 'malware';
  let host = '';
  try {
    host = new URL(blocked).host;
  } catch (_) {
    host = '';
  }
  return { kind: 'safe-browsing', url: blocked, threat, token, title: host };
}

module.exports = {
  safeBrowsingPageFromUrl,
  ERROR_PAGE,
  isCertificateError,
  classifyLoadFailure,
  isTabCrash,
  isLocalHost,
  securityStateOf,
  errorPageQuery,
  cleanSafeBrowsingTexts,
  safeBrowsingGesture,
  SAFE_BROWSING_THREATS,
};
