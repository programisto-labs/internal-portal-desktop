'use strict';

const fs = require('fs');
const path = require('path');

const LASCO_PROTOCOL = 'lasco';
const DEFAULT_SETTINGS = Object.freeze({ openLinksInApp: true });

/** Keep only known keys with valid types; unknown / invalid values fall back to defaults. */
function normalizeSettings(raw) {
  const out = { ...DEFAULT_SETTINGS };
  if (raw && typeof raw === 'object' && typeof raw.openLinksInApp === 'boolean') {
    out.openLinksInApp = raw.openLinksInApp;
  }
  return out;
}

/** Tiny JSON settings store (injectable fs for tests). */
function createSettingsStore(filePath, fsImpl = fs) {
  let cache = null;

  function load() {
    if (cache) return cache;
    try {
      cache = normalizeSettings(JSON.parse(fsImpl.readFileSync(filePath, 'utf8')));
    } catch (_) {
      cache = normalizeSettings(null);
    }
    return cache;
  }

  return {
    get: () => ({ ...load() }),
    set(partial) {
      cache = normalizeSettings({ ...load(), ...(partial || {}) });
      try {
        fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
        fsImpl.writeFileSync(filePath, JSON.stringify(cache));
      } catch (_) {
        // keep in-memory value even if persistence fails
      }
      return { ...cache };
    },
  };
}

/**
 * Extract an in-app portal path (pathname + search + hash) from a link.
 * Accepts lasco://open?target=/path and http(s) links for which isPortalUrl is true.
 * Returns null when the link is not a Lasco link.
 */
function extractPortalTarget(urlString, isPortalUrl) {
  let u;
  try {
    u = new URL(urlString);
  } catch (_) {
    return null;
  }
  if (u.protocol === `${LASCO_PROTOCOL}:`) {
    const target = u.searchParams.get('target');
    // reject protocol-relative ("//host") targets
    if (!target || !target.startsWith('/') || target.startsWith('//')) return null;
    return target;
  }
  if (u.protocol === 'https:' || u.protocol === 'http:') {
    if (typeof isPortalUrl === 'function' && isPortalUrl(urlString)) {
      return `${u.pathname}${u.search}${u.hash}`;
    }
  }
  return null;
}

module.exports = {
  LASCO_PROTOCOL,
  DEFAULT_SETTINGS,
  normalizeSettings,
  createSettingsStore,
  extractPortalTarget,
};
