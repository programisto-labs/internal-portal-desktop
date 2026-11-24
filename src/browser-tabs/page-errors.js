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
 * - `dangerous` : certificat refusé ;
 * - `local` : http sur cette machine ;
 * - null : rien à afficher (onglet vide, page d'erreur réseau ou plantage).
 */
function securityStateOf(url, errorPage) {
  if (errorPage) return errorPage.kind === 'certificate' ? 'dangerous' : null;
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
  return query;
}

module.exports = {
  ERROR_PAGE,
  isCertificateError,
  classifyLoadFailure,
  isTabCrash,
  isLocalHost,
  securityStateOf,
  errorPageQuery,
};
