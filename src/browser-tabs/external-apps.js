'use strict';

/**
 * Links to desktop applications (`unityhub://…`, `zoommtg://…`, `vscode://…`,
 * `mailto:`…) opened from a web tab. Like Chrome: the app associated with the
 * scheme is opened after a native confirmation, with « Always allow » per site
 * and per scheme. Used by sign-in flows that hand the result back to an app
 * (Unity Hub, Figma, Slack, Zoom…).
 */

const fs = require('fs');
const path = require('path');

/** Never handed to the OS: privileged, local files, network shares, OS settings, Lasco itself. */
const NEVER_LAUNCH_SCHEMES = new Set([
  'http',
  'https',
  'javascript',
  'data',
  'blob',
  'file',
  'about',
  'chrome',
  'chrome-extension',
  'devtools',
  'view-source',
  'filesystem',
  'ws',
  'wss',
  'smb',
  'afp',
  'nfs',
  'cifs',
  'ftp',
  'ftps',
  'sftp',
  'vnc',
  'ssh',
  'telnet',
  'x-apple.systempreferences',
  'x-apple-helpbasic',
  'applescript',
  'search-ms',
  'search',
  'ms-msdt',
  'ms-officecmd',
  'ms-settings',
  'shell',
  'lasco',
]);

/** Same link launched again within this delay (page redirect + link click) is ignored. */
const DUPLICATE_WINDOW_MS = 2000;

/** Returns `{ href, scheme }` for a link to an external app, otherwise null. */
function parseExternalAppUrl(urlString) {
  if (typeof urlString !== 'string') return null;
  const trimmed = urlString.trim();
  if (!trimmed || trimmed.length > 8192) return null;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (_) {
    return null;
  }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (!/^[a-z][a-z0-9+.-]{1,63}$/.test(scheme)) return null;
  if (NEVER_LAUNCH_SCHEMES.has(scheme)) return null;
  return { href: parsed.href, scheme };
}

/** Origin of the page that asks for the app (`https://api.unity.com`), or null. */
function initiatorOrigin(pageUrl) {
  try {
    const u = new URL(pageUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin;
  } catch (_) {
    return null;
  }
}

/** « Always allow » choices: `{ [origin]: [scheme, …] }` in a JSON file of userData. */
function createExternalAppPermissionStore({ filePath, fsImpl = fs } = {}) {
  let allowed = null;

  function load() {
    if (allowed) return allowed;
    allowed = new Map();
    if (!filePath) return allowed;
    try {
      const raw = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
      const entries = raw && typeof raw.allowed === 'object' && raw.allowed ? raw.allowed : {};
      for (const [origin, schemes] of Object.entries(entries)) {
        if (!initiatorOrigin(origin) || !Array.isArray(schemes)) continue;
        const valid = schemes.filter((s) => parseExternalAppUrl(`${s}:x`));
        if (valid.length) allowed.set(origin, new Set(valid));
      }
    } catch (_) {
      // Missing or unreadable file: nothing allowed.
    }
    return allowed;
  }

  function save() {
    if (!filePath) return;
    try {
      fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
      const payload = {};
      for (const [origin, schemes] of load()) payload[origin] = [...schemes];
      const tmp = `${filePath}.tmp`;
      fsImpl.writeFileSync(tmp, JSON.stringify({ version: 1, allowed: payload }));
      fsImpl.renameSync(tmp, filePath);
    } catch (_) {
      // Not persisted: the question comes back next time.
    }
  }

  return {
    isAllowed(origin, scheme) {
      return Boolean(origin && load().get(origin)?.has(scheme));
    },
    allow(origin, scheme) {
      if (!origin || !scheme) return;
      const map = load();
      if (!map.has(origin)) map.set(origin, new Set());
      map.get(origin).add(scheme);
      save();
    },
    clear() {
      allowed = new Map();
      save();
    },
  };
}

/**
 * Opens external-app links after confirmation.
 * `launch({ url, pageUrl, key })` returns true when the URL is an external-app
 * link (handled here, the navigation must be cancelled), false otherwise.
 */
function createExternalAppLauncher({
  shell,
  showMessageBox,
  getApplicationNameForProtocol,
  getParentWindow,
  permissions,
  now = () => Date.now(),
}) {
  const pending = new Set();
  const recent = new Map();

  function appNameFor(href) {
    try {
      const name = getApplicationNameForProtocol ? getApplicationNameForProtocol(href) : '';
      return typeof name === 'string' ? name.replace(/\.app$/i, '').trim() : '';
    } catch (_) {
      return '';
    }
  }

  async function confirmAndOpen({ href, scheme, origin, appName, key }) {
    pending.add(key);
    try {
      const host = origin ? new URL(origin).host : null;
      const options = {
        type: 'question',
        buttons: [`Ouvrir ${appName}`, 'Annuler'],
        defaultId: 0,
        cancelId: 1,
        message: `Ouvrir ${appName} ?`,
        detail: origin ? `${origin} veut ouvrir cette application.` : 'Cette page veut ouvrir cette application.',
        ...(host
          ? {
              checkboxLabel: `Toujours autoriser ${host} à ouvrir les liens de ce type dans l’application associée`,
              checkboxChecked: false,
            }
          : {}),
      };
      const parent = getParentWindow ? getParentWindow() : null;
      const result =
        parent && !parent.isDestroyed() ? await showMessageBox(parent, options) : await showMessageBox(options);
      if (result.response !== 0) return;
      if (origin && result.checkboxChecked) permissions.allow(origin, scheme);
      await shell.openExternal(href);
    } catch (_) {
      // Dialog closed with the window, or the OS refused: nothing to do.
    } finally {
      pending.delete(key);
    }
  }

  function launch({ url, pageUrl, key = 'default' }) {
    const target = parseExternalAppUrl(url);
    if (!target) return false;
    const { href, scheme } = target;

    const at = now();
    for (const [seenHref, seenAt] of recent) {
      if (at - seenAt > DUPLICATE_WINDOW_MS) recent.delete(seenHref);
    }
    if (pending.has(key) || recent.has(href)) return true;
    recent.set(href, at);

    // No app registered for this scheme: ignore, as Chrome does.
    const appName = appNameFor(href);
    if (!appName) return true;

    const origin = initiatorOrigin(pageUrl);
    if (permissions.isAllowed(origin, scheme)) {
      Promise.resolve(shell.openExternal(href)).catch(() => {});
      return true;
    }
    void confirmAndOpen({ href, scheme, origin, appName, key });
    return true;
  }

  return { launch };
}

module.exports = {
  NEVER_LAUNCH_SCHEMES,
  parseExternalAppUrl,
  initiatorOrigin,
  createExternalAppPermissionStore,
  createExternalAppLauncher,
};
