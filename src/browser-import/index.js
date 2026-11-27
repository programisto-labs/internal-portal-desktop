'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { execFile } = require('child_process');
const { CHROMIUM_BROWSERS, detectBrowsers, publicBrowser } = require('./browsers');
const readers = require('./readers');

/**
 * Import from another browser of this computer (docs/browser-import.md): bookmarks, history, passwords.
 *
 * - History goes straight into Desktop's history store.
 * - Bookmarks are returned to the portal, which saves them as Lasco favorites.
 * - Passwords stay in this process: `run` returns a one-time token, the portal takes the list once
 *   (`takePasswords`) to save it in the Vault, then it is forgotten. Unclaimed lists expire after 10 min.
 *   Passwords are never logged nor written to disk.
 */

const PASSWORDS_TTL_MS = 10 * 60 * 1000;
const KEYCHAIN_TIMEOUT_MS = 120 * 1000;

/** macOS Keychain secret of « <Browser> Safe Storage ». The system asks the person to allow it. */
function readKeychainSecret({ service, account }, { execFileImpl = execFile } = {}) {
  const run = (args) =>
    new Promise((resolve, reject) => {
      execFileImpl('/usr/bin/security', args, { timeout: KEYCHAIN_TIMEOUT_MS, encoding: 'utf8' }, (error, stdout) => {
        if (error) reject(error);
        else resolve(String(stdout || '').replace(/\n$/, ''));
      });
    });
  const keychainError = (error) => {
    // 44: item not found; killed: nobody answered the dialog in time; else the person refused it.
    if (error && (error.killed || error.signal)) return new readers.ImportReadError('keychain-timeout');
    return new readers.ImportReadError(error && error.code === 44 ? 'keychain-not-found' : 'keychain-denied');
  };
  return run(['find-generic-password', '-w', '-s', service, '-a', account]).catch((error) => {
    if (error && error.code === 44) {
      // Some builds name the account differently: the service alone is enough.
      return run(['find-generic-password', '-w', '-s', service]).catch((again) => {
        throw keychainError(again);
      });
    }
    throw keychainError(error);
  });
}

function errorCode(error) {
  return (error && typeof error.code === 'string' && error.code) || 'read-failed';
}

function createBrowserImport({
  home,
  platform = process.platform,
  env = process.env,
  fsImpl = fs,
  history,
  emit = () => {},
  getKeychainSecret = readKeychainSecret,
  readersImpl = readers,
  now = Date.now,
  detect = detectBrowsers,
}) {
  /** @type {Map<string, { items: Array<{ url: string, username: string, password: string }>, expiresAt: number }>} */
  const pending = new Map();
  let busy = false;

  function prune() {
    const at = now();
    for (const [token, entry] of pending) if (entry.expiresAt <= at) pending.delete(token);
  }

  function holdPasswords(items) {
    prune();
    const token = crypto.randomBytes(18).toString('base64url');
    pending.set(token, { items, expiresAt: now() + PASSWORDS_TTL_MS });
    return token;
  }

  function findBrowsers() {
    return detect({ fsImpl, home, platform, env });
  }

  function list() {
    return { ok: true, platform, browsers: findBrowsers().map(publicBrowser) };
  }

  function progress(importId, step, status, extra) {
    emit({ importId, step, status, ...(extra || {}) });
  }

  const tick = () => new Promise((resolve) => setImmediate(resolve));

  async function importHistory(browser, profile) {
    let items;
    if (browser.kind === 'chromium') items = readersImpl.readChromiumHistory(profile.dir);
    else if (browser.kind === 'firefox') items = readersImpl.readFirefoxHistory(profile.dir);
    else items = readersImpl.readSafariHistory(profile.dir);
    const { imported, skipped } = history.importEntries(items);
    return { found: items.length, imported, skipped };
  }

  function readBookmarks(browser, profile) {
    if (browser.kind === 'chromium') return readersImpl.readChromiumBookmarks(profile.dir);
    if (browser.kind === 'firefox') return readersImpl.readFirefoxBookmarks(profile.dir);
    return readersImpl.readSafariBookmarks(profile.dir);
  }

  async function readPasswords(browser, profile) {
    if (browser.kind !== 'chromium' || platform !== 'darwin') {
      throw new readers.ImportReadError('passwords-csv-only');
    }
    const def = CHROMIUM_BROWSERS.find((b) => b.id === browser.id);
    const secret = await getKeychainSecret(def.keychain);
    const key = readersImpl.chromiumMacKey(secret);
    return readersImpl.readChromiumPasswords(profile.dir, (blob) => readersImpl.decryptChromiumValue(blob, key));
  }

  /**
   * `{ importId, browserId, profileId, kinds: { bookmarks, history, passwords } }` →
   * `{ ok, history?, bookmarks?, passwords?, errors }`. Each kind succeeds or fails on its own.
   */
  async function run(payload = {}) {
    if (busy) return { ok: false, error: 'busy' };
    const importId = typeof payload.importId === 'string' ? payload.importId.slice(0, 64) : '';
    const kinds = payload.kinds && typeof payload.kinds === 'object' ? payload.kinds : {};
    const browser = findBrowsers().find((b) => b.id === payload.browserId);
    if (!browser) return { ok: false, error: 'unknown-browser' };
    const profile = browser.profiles.find((p) => p.id === payload.profileId) || browser.profiles[0];
    if (!profile) return { ok: false, error: 'unknown-profile' };
    busy = true;
    const result = { ok: true, browser: browser.name, profile: profile.name, errors: {} };
    try {
      if (kinds.history === true) {
        progress(importId, 'history', 'running');
        await tick();
        try {
          result.history = await importHistory(browser, profile);
          progress(importId, 'history', 'done', { count: result.history.imported });
        } catch (error) {
          result.errors.history = errorCode(error);
          progress(importId, 'history', 'failed', { error: result.errors.history });
        }
      }
      if (kinds.bookmarks === true) {
        progress(importId, 'bookmarks', 'running');
        await tick();
        try {
          const items = readBookmarks(browser, profile);
          result.bookmarks = { items, found: items.length };
          progress(importId, 'bookmarks', 'done', { count: items.length });
        } catch (error) {
          result.errors.bookmarks = errorCode(error);
          progress(importId, 'bookmarks', 'failed', { error: result.errors.bookmarks });
        }
      }
      if (kinds.passwords === true) {
        progress(importId, 'passwords', 'running');
        await tick();
        try {
          const { items, undecryptable } = await readPasswords(browser, profile);
          result.passwords = { token: holdPasswords(items), found: items.length, unreadable: undecryptable };
          progress(importId, 'passwords', 'done', { count: items.length });
        } catch (error) {
          result.errors.passwords = errorCode(error);
          progress(importId, 'passwords', 'failed', { error: result.errors.passwords });
        }
      }
    } finally {
      busy = false;
    }
    return result;
  }

  /** Password CSV chosen by the person (`filePath` from the native open dialog). */
  function importPasswordsCsv({ filePath } = {}) {
    if (typeof filePath !== 'string' || !filePath) return { ok: false, error: 'canceled' };
    let text;
    try {
      const stat = fsImpl.statSync(filePath);
      if (stat.size > 20 * 1024 * 1024) return { ok: false, error: 'csv-too-large' };
      text = fsImpl.readFileSync(filePath, 'utf8');
    } catch (_) {
      return { ok: false, error: 'read-failed' };
    }
    try {
      const { items, skipped } = readersImpl.parsePasswordCsv(text);
      return { ok: true, token: holdPasswords(items), found: items.length, skipped };
    } catch (error) {
      return { ok: false, error: errorCode(error) };
    }
  }

  /** Once: the list is forgotten as soon as it is returned. */
  function takePasswords({ token } = {}) {
    prune();
    const entry = typeof token === 'string' ? pending.get(token) : null;
    if (!entry) return { ok: false, error: 'expired' };
    pending.delete(token);
    return { ok: true, items: entry.items };
  }

  function discardPasswords({ token } = {}) {
    if (typeof token === 'string') pending.delete(token);
    return { ok: true };
  }

  return { list, run, importPasswordsCsv, takePasswords, discardPasswords, isBusy: () => busy };
}

module.exports = { createBrowserImport, readKeychainSecret, PASSWORDS_TTL_MS };
