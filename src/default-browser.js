'use strict';

/**
 * Lasco as the system's default web browser (Réglages > Général > Navigateur).
 *
 * macOS: http/https are declared in Info.plist (CFBundleURLTypes, package.json
 * `mac.extendInfo`), so Lasco appears in System Settings > Default web browser,
 * and `app.setAsDefaultProtocolClient` asks macOS to switch (the system shows
 * its own confirmation). Links then arrive through `open-url`. Being a real
 * browser is also what Apple requires before granting the web-browser passkey
 * entitlement (com.apple.developer.web-browser.public-key-credential).
 *
 * Windows / Linux: not offered (the installer does not register http/https).
 */

const WEB_SCHEMES = Object.freeze(['http', 'https']);

/** `lasco` | `web` | null for a URL handed over by the OS. */
function classifyIncomingUrl(urlString, lascoProtocol = 'lasco') {
  if (typeof urlString !== 'string' || !urlString) return null;
  let url;
  try {
    url = new URL(urlString);
  } catch (_) {
    return null;
  }
  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  if (scheme === lascoProtocol) return 'lasco';
  if (WEB_SCHEMES.includes(scheme) && url.hostname) return 'web';
  return null;
}

/** Default browser can only be offered by the installed macOS app (never the dev Electron binary). */
function isDefaultBrowserAvailable({ platform = process.platform, isPackaged = false } = {}) {
  return platform === 'darwin' && Boolean(isPackaged);
}

function defaultBrowserSnapshot(app, platform = process.platform) {
  const available = isDefaultBrowserAvailable({ platform, isPackaged: app.isPackaged });
  let isDefault = false;
  if (available) {
    try {
      isDefault = WEB_SCHEMES.every((scheme) => app.isDefaultProtocolClient(scheme));
    } catch (_) {
      isDefault = false;
    }
  }
  return { available, isDefault };
}

/** Asks the OS to make Lasco the default browser (macOS shows a confirmation). */
function setAsDefaultBrowser(app, platform = process.platform) {
  if (!isDefaultBrowserAvailable({ platform, isPackaged: app.isPackaged })) return false;
  let ok = true;
  for (const scheme of WEB_SCHEMES) {
    try {
      ok = app.setAsDefaultProtocolClient(scheme) && ok;
    } catch (_) {
      ok = false;
    }
  }
  return ok;
}

/**
 * Web links received before the portal can show them (cold start, window not
 * loaded yet). Flushed once the main window's portal has loaded.
 */
function createPendingWebUrls(limit = 20) {
  const urls = [];
  return {
    push(url) {
      if (urls.length < limit) urls.push(url);
    },
    drain() {
      return urls.splice(0, urls.length);
    },
    get size() {
      return urls.length;
    },
  };
}

module.exports = {
  WEB_SCHEMES,
  classifyIncomingUrl,
  isDefaultBrowserAvailable,
  defaultBrowserSnapshot,
  setAsDefaultBrowser,
  createPendingWebUrls,
};
