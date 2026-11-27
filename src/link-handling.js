'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeShortcuts } = require('./background-mode');
const { normalizeTabSleepSettings, DEFAULT_TAB_SLEEP_MINUTES } = require('./browser-tabs/tab-sleep');

const LASCO_PROTOCOL = 'lasco';
/** `themeSource`: app appearance (Réglages > Général), applied to `nativeTheme.themeSource`. */
const THEME_SOURCES = Object.freeze(['system', 'light', 'dark']);
/**
 * `keepInBackground`: closing the main window hides it, Lasco stays in the menu bar (macOS).
 * `backgroundHintShown`: the « Lasco reste ouvert » notification was shown once.
 * `shortcuts`: global shortcuts (see background-mode.js). Docs: docs/background.md.
 * `downloadsDirectory`: folder of the downloads (null = the OS Downloads folder), `downloadsAskWhere`:
 * « Enregistrer sous » for each file. Docs: docs/downloads.md.
 */
const DEFAULT_SETTINGS = Object.freeze({
  openLinksInApp: true,
  themeSource: 'system',
  keepInBackground: true,
  backgroundHintShown: false,
  downloadsDirectory: null,
  downloadsAskWhere: false,
  // Économiseur de mémoire (docs/tab-sleep.md) : délai en minutes (0 = jamais), sites exclus.
  tabSleepMinutes: DEFAULT_TAB_SLEEP_MINUTES,
  tabSleepNeverSites: [],
});

/** Keep only known keys with valid types; unknown / invalid values fall back to defaults. */
function normalizeSettings(raw) {
  const out = { ...DEFAULT_SETTINGS };
  const obj = raw && typeof raw === 'object' ? raw : {};
  for (const key of ['openLinksInApp', 'keepInBackground', 'backgroundHintShown', 'downloadsAskWhere']) {
    if (typeof obj[key] === 'boolean') out[key] = obj[key];
  }
  if (THEME_SOURCES.includes(obj.themeSource)) {
    out.themeSource = obj.themeSource;
  }
  if (typeof obj.downloadsDirectory === 'string' && path.isAbsolute(obj.downloadsDirectory)) {
    out.downloadsDirectory = obj.downloadsDirectory;
  }
  out.shortcuts = normalizeShortcuts(obj.shortcuts);
  Object.assign(out, normalizeTabSleepSettings(obj));
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

/**
 * Payload for the renderer when a link must open in the internal browser.
 * `reveal` tells the web UI to re-open the right-hand column if it is collapsed
 * so the opened page is immediately visible.
 */
function buildBrowserOpenRequest(safeUrl) {
  if (typeof safeUrl !== 'string' || !safeUrl) return null;
  return { url: safeUrl, reveal: true };
}

module.exports = {
  buildBrowserOpenRequest,
  LASCO_PROTOCOL,
  DEFAULT_SETTINGS,
  THEME_SOURCES,
  normalizeSettings,
  createSettingsStore,
  extractPortalTarget,
};
