'use strict';

const BLOCKED_PROTOCOLS = new Set([
  'javascript:',
  'data:',
  'blob:',
  'file:',
  'about:',
  'chrome:',
  'chrome-extension:',
  'devtools:',
  'view-source:',
]);

/**
 * True when the string looks like a host/URL the user intends to open directly
 * rather than a search query.
 */
function looksLikeUrl(input) {
  const value = String(input || '').trim();
  if (!value) return false;
  if (/^https?:\/\//i.test(value)) return true;
  if (/^localhost(:\d+)?([/:?#].*)?$/i.test(value)) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/:?#].*)?$/.test(value)) return true;
  // domain.tld or subdomain.domain.tld with optional path/query/hash
  return /^[\w.-]+\.[a-z]{2,}([/:?#].*)?$/i.test(value);
}

/**
 * Convert omnibox input into a navigable http(s) URL.
 * Valid URLs / hostnames navigate directly; everything else searches Google.
 */
function resolveOmniboxInput(input) {
  const trimmed = String(input || '').trim();
  if (!trimmed) return null;

  if (/^https?:\/\//i.test(trimmed)) {
    return sanitizeBrowserUrl(trimmed);
  }

  if (looksLikeUrl(trimmed)) {
    const withScheme = /^localhost|^127\.|^0\.0\.0\.0|^\[::1\]|\d{1,3}(\.\d{1,3}){3}/i.test(
      trimmed,
    )
      ? `http://${trimmed}`
      : `https://${trimmed}`;
    return sanitizeBrowserUrl(withScheme);
  }

  return sanitizeBrowserUrl(
    `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`,
  );
}

/**
 * Accept only http(s) URLs. Reject privileged / dangerous schemes.
 * Returns the normalized href or null.
 */
function sanitizeBrowserUrl(urlString) {
  if (typeof urlString !== 'string' || !urlString.trim()) return null;
  let parsed;
  try {
    parsed = new URL(urlString.trim());
  } catch (_) {
    return null;
  }
  const protocol = parsed.protocol.toLowerCase();
  if (BLOCKED_PROTOCOLS.has(protocol)) return null;
  if (protocol !== 'http:' && protocol !== 'https:') return null;
  // Disallow credentials in the URL for safety
  if (parsed.username || parsed.password) {
    parsed.username = '';
    parsed.password = '';
  }
  return parsed.href;
}

function isSafeBrowserUrl(urlString) {
  return sanitizeBrowserUrl(urlString) !== null;
}

module.exports = {
  looksLikeUrl,
  resolveOmniboxInput,
  sanitizeBrowserUrl,
  isSafeBrowserUrl,
};
