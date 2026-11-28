'use strict';

/**
 * Onglets web épinglés (docs/pinned-tabs.md). Le portail décide de l'épingle et la transmet par
 * `browserTabs.setPinned({ tabId, pinnedUrl })` ; Desktop n'en retient que l'adresse d'origine pour
 * envoyer dans un nouvel onglet les liens vers un autre site, comme Chrome.
 */

/** Suffixes publics à deux niveaux les plus courants (même liste que le portail). */
const TWO_LEVEL_PUBLIC_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'co.jp', 'ne.jp', 'or.jp', 'com.au', 'net.au', 'org.au',
  'com.br', 'com.mx', 'com.ar', 'co.nz', 'co.za', 'co.in', 'com.cn', 'com.tr', 'co.kr', 'com.sg',
  'github.io', 'vercel.app', 'netlify.app', 'pages.dev', 'herokuapp.com', 'web.app', 'firebaseapp.com',
]);

function siteOf(url) {
  let host;
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
  if (!host || /^[\d.]+$/.test(host) || host.includes(':')) return host || null;
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const lastTwo = labels.slice(-2).join('.');
  return TWO_LEVEL_PUBLIC_SUFFIXES.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
}

/** Navigation d'un onglet épinglé vers un autre site : à ouvrir dans un nouvel onglet. */
function isPinnedCrossSiteNavigation(pinnedUrl, targetUrl) {
  const from = siteOf(pinnedUrl);
  const to = siteOf(targetUrl);
  return Boolean(from && to && from !== to);
}

/** Adresse reçue de la page : http(s) seulement, bornée ; `null` = plus épinglé. */
function normalizePinnedUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 4096) return null;
  return siteOf(value) ? value : null;
}

module.exports = { isPinnedCrossSiteNavigation, normalizePinnedUrl, siteOf };
