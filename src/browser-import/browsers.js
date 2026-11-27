'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Other browsers installed on this computer, and their profiles (docs/browser-import.md).
 * Pure Node: `fsImpl`, `home`, `platform` and `env` are injected so the detection is unit-tested.
 */

/** Chromium family. `keychain` names the macOS Keychain item that holds the password key. */
const CHROMIUM_BROWSERS = [
  {
    id: 'chrome',
    name: 'Google Chrome',
    dirs: {
      darwin: ['Library/Application Support/Google/Chrome'],
      win32: ['%LOCALAPPDATA%/Google/Chrome/User Data'],
      linux: ['.config/google-chrome'],
    },
    keychain: { service: 'Chrome Safe Storage', account: 'Chrome' },
  },
  {
    id: 'brave',
    name: 'Brave',
    dirs: {
      darwin: ['Library/Application Support/BraveSoftware/Brave-Browser'],
      win32: ['%LOCALAPPDATA%/BraveSoftware/Brave-Browser/User Data'],
      linux: ['.config/BraveSoftware/Brave-Browser'],
    },
    keychain: { service: 'Brave Safe Storage', account: 'Brave' },
  },
  {
    id: 'arc',
    name: 'Arc',
    dirs: { darwin: ['Library/Application Support/Arc/User Data'] },
    keychain: { service: 'Arc Safe Storage', account: 'Arc' },
  },
  {
    id: 'edge',
    name: 'Microsoft Edge',
    dirs: {
      darwin: ['Library/Application Support/Microsoft Edge'],
      win32: ['%LOCALAPPDATA%/Microsoft/Edge/User Data'],
      linux: ['.config/microsoft-edge'],
    },
    keychain: { service: 'Microsoft Edge Safe Storage', account: 'Microsoft Edge' },
  },
  {
    id: 'vivaldi',
    name: 'Vivaldi',
    dirs: {
      darwin: ['Library/Application Support/Vivaldi'],
      win32: ['%LOCALAPPDATA%/Vivaldi/User Data'],
      linux: ['.config/vivaldi'],
    },
    keychain: { service: 'Vivaldi Safe Storage', account: 'Vivaldi' },
  },
  {
    id: 'chromium',
    name: 'Chromium',
    dirs: {
      darwin: ['Library/Application Support/Chromium'],
      win32: ['%LOCALAPPDATA%/Chromium/User Data'],
      linux: ['.config/chromium'],
    },
    keychain: { service: 'Chromium Safe Storage', account: 'Chromium' },
  },
];

const FIREFOX_DIRS = {
  darwin: ['Library/Application Support/Firefox'],
  win32: ['%APPDATA%/Mozilla/Firefox'],
  linux: ['.mozilla/firefox'],
};

const CHROMIUM_DATA_FILES = ['Bookmarks', 'History', 'Login Data'];
const MAX_PROFILES = 20;

function expandDir(dir, { home, env }) {
  let missing = false;
  const expanded = dir.replace(/%([A-Z_]+)%/g, (_, name) => {
    const value = env && env[name];
    if (!value) missing = true;
    return value || '';
  });
  if (missing) return null;
  if (dir.includes('%')) return path.normalize(expanded);
  return path.join(home, expanded);
}

function exists(fsImpl, file) {
  try {
    fsImpl.accessSync(file);
    return true;
  } catch (_) {
    return false;
  }
}

function readJson(fsImpl, file) {
  try {
    return JSON.parse(fsImpl.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function cleanName(value, fallback) {
  const text = typeof value === 'string' ? value.trim().slice(0, 80) : '';
  return text || fallback;
}

/** Profiles of a Chromium user data dir: `Local State` names them, folders with data confirm them. */
function chromiumProfiles(fsImpl, root) {
  const state = readJson(fsImpl, path.join(root, 'Local State'));
  const cache = state && state.profile && state.profile.info_cache && typeof state.profile.info_cache === 'object'
    ? state.profile.info_cache
    : {};
  const ids = new Set(Object.keys(cache));
  try {
    for (const name of fsImpl.readdirSync(root)) {
      if (name === 'Default' || /^Profile \d+$/.test(name)) ids.add(name);
    }
  } catch (_) {
    // Unreadable: Local State only.
  }
  const profiles = [];
  for (const id of ids) {
    if (!/^[\w .-]+$/.test(id) || id.includes('..')) continue;
    const dir = path.join(root, id);
    const data = CHROMIUM_DATA_FILES.filter((file) => exists(fsImpl, path.join(dir, file)));
    if (!data.length) continue;
    const info = cache[id] || {};
    profiles.push({
      id,
      name: cleanName(info.name, id === 'Default' ? 'Default' : id),
      email: cleanName(info.user_name, '') || undefined,
      dir,
      data: {
        bookmarks: data.includes('Bookmarks'),
        history: data.includes('History'),
        passwords: data.includes('Login Data'),
      },
    });
  }
  profiles.sort((a, b) => (a.id === 'Default' ? -1 : b.id === 'Default' ? 1 : a.id.localeCompare(b.id, 'en', { numeric: true })));
  return profiles.slice(0, MAX_PROFILES);
}

/** Firefox profiles from `profiles.ini` (relative or absolute paths). */
function firefoxProfiles(fsImpl, root) {
  let ini;
  try {
    ini = fsImpl.readFileSync(path.join(root, 'profiles.ini'), 'utf8');
  } catch (_) {
    return [];
  }
  const sections = [];
  let current = null;
  for (const raw of ini.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      current = { section: header[1] };
      sections.push(current);
      continue;
    }
    const kv = /^([^=]+)=(.*)$/.exec(line);
    if (current && kv) current[kv[1].trim()] = kv[2].trim();
  }
  const profiles = [];
  for (const s of sections) {
    if (!/^Profile\d+$/.test(s.section) || !s.Path) continue;
    const dir = s.IsRelative === '0' ? path.normalize(s.Path) : path.join(root, s.Path);
    if (!exists(fsImpl, path.join(dir, 'places.sqlite'))) continue;
    profiles.push({
      id: s.section,
      name: cleanName(s.Name, s.section),
      dir,
      default: s.Default === '1',
      data: { bookmarks: true, history: true, passwords: false },
    });
  }
  return profiles.slice(0, MAX_PROFILES);
}

/**
 * Installed browsers with at least one profile. Safari is listed on macOS even when its folder is
 * unreadable: reading it needs the Full Disk Access permission (`needsFullDiskAccess`).
 */
function detectBrowsers({ fsImpl = fs, home, platform = process.platform, env = process.env } = {}) {
  const browsers = [];
  for (const def of CHROMIUM_BROWSERS) {
    for (const dir of def.dirs[platform] || []) {
      const root = expandDir(dir, { home, env });
      if (!root || !exists(fsImpl, root)) continue;
      const profiles = chromiumProfiles(fsImpl, root);
      if (!profiles.length) continue;
      browsers.push({
        id: def.id,
        name: def.name,
        kind: 'chromium',
        root,
        profiles,
        // Passwords are decrypted with the macOS Keychain key; elsewhere, a CSV export is proposed.
        passwords: platform === 'darwin' ? 'native' : 'csv',
        keychainItem: platform === 'darwin' ? def.keychain.service : undefined,
      });
      break;
    }
  }
  if (platform === 'darwin') {
    const root = path.join(home, 'Library/Safari');
    let readable = false;
    let present = exists(fsImpl, root);
    try {
      fsImpl.readdirSync(root);
      readable = true;
    } catch (error) {
      // EPERM / EACCES: the folder is there, TCC blocks it without Full Disk Access.
      if (error && (error.code === 'EPERM' || error.code === 'EACCES')) present = true;
    }
    if (present) {
      browsers.push({
        id: 'safari',
        name: 'Safari',
        kind: 'safari',
        root,
        needsFullDiskAccess: !readable,
        profiles: [
          {
            id: 'default',
            name: 'Safari',
            dir: root,
            data: {
              bookmarks: !readable || exists(fsImpl, path.join(root, 'Bookmarks.plist')),
              history: !readable || exists(fsImpl, path.join(root, 'History.db')),
              passwords: false,
            },
          },
        ],
        passwords: 'csv',
      });
    }
  }
  for (const dir of FIREFOX_DIRS[platform] || []) {
    const root = expandDir(dir, { home, env });
    if (!root || !exists(fsImpl, root)) continue;
    const profiles = firefoxProfiles(fsImpl, root);
    if (profiles.length) browsers.push({ id: 'firefox', name: 'Firefox', kind: 'firefox', root, profiles, passwords: 'csv' });
    break;
  }
  return browsers;
}

/** Public view for the portal: no file paths. */
function publicBrowser(browser) {
  return {
    id: browser.id,
    name: browser.name,
    passwords: browser.passwords,
    keychainItem: browser.keychainItem,
    needsFullDiskAccess: browser.needsFullDiskAccess === true || undefined,
    profiles: browser.profiles.map((p) => ({ id: p.id, name: p.name, email: p.email, data: { ...p.data } })),
  };
}

module.exports = {
  CHROMIUM_BROWSERS,
  detectBrowsers,
  publicBrowser,
  chromiumProfiles,
  firefoxProfiles,
};
