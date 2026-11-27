'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Readers of the other browsers' profile files (docs/browser-import.md). Each returns plain data:
 * - bookmarks: `[{ title, url, root, folder: string[] }]`: `root` = 'bar' | 'menu' | 'other' | 'mobile',
 *   `folder` = sub-folder names under that root;
 * - history: `[{ url, title, visitCount, lastVisit }]` (`lastVisit` in ms since 1970);
 * - passwords: `[{ url, username, password }]`, decrypted in the main process, never logged.
 *
 * SQLite files are copied to a private temporary folder before reading: the browser may hold a lock.
 */

const MAX_BOOKMARKS = 5000;
const MAX_HISTORY = 5000;
const MAX_PASSWORDS = 2000;
const MAX_TITLE = 300;
const MAX_URL = 2048;

/** Chrome / WebKit times: µs since 1601-01-01. */
const WEBKIT_EPOCH_OFFSET_MS = 11644473600000;
/** Safari (Core Data) times: s since 2001-01-01. */
const MAC_EPOCH_OFFSET_S = 978307200;

class ImportReadError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

function isWebUrl(url) {
  return typeof url === 'string' && url.length <= MAX_URL && /^https?:\/\//i.test(url);
}

function cleanTitle(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE) : '';
}

function readError(error) {
  if (error instanceof ImportReadError) return error;
  const code = error && error.code;
  if (code === 'EPERM' || code === 'EACCES') return new ImportReadError('full-disk-access');
  if (code === 'ENOENT') return new ImportReadError('not-found');
  return new ImportReadError('read-failed');
}

// --- SQLite ---------------------------------------------------------------

function loadSqlite() {
  // node:sqlite ships with Electron's Node (24+); required lazily so tests can run without it.
  return require('node:sqlite');
}

/**
 * Copy `file` (and its journal / WAL) to a temporary folder, open the copy, run `fn(db)`, delete it.
 * The copy is opened read-write so SQLite can replay a hot journal; the original is never touched.
 */
function withSqliteCopy(file, fn, { fsImpl = fs, tmpRoot = os.tmpdir() } = {}) {
  let dir;
  try {
    dir = fsImpl.mkdtempSync(path.join(tmpRoot, 'lasco-import-'));
    const copy = path.join(dir, 'db.sqlite');
    fsImpl.copyFileSync(file, copy);
    for (const suffix of ['-journal', '-wal', '-shm']) {
      try {
        fsImpl.copyFileSync(`${file}${suffix}`, `${copy}${suffix}`);
      } catch (_) {
        // No sidecar file.
      }
    }
    const { DatabaseSync } = loadSqlite();
    const db = new DatabaseSync(copy);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } catch (error) {
    throw readError(error);
  } finally {
    if (dir) {
      try {
        fsImpl.rmSync(dir, { recursive: true, force: true });
      } catch (_) {
        // Temp folder: cleaned by the OS later.
      }
    }
  }
}

// --- Chromium -------------------------------------------------------------

/** Root folders, as stable keys (the portal names them in the person's language). */
const CHROMIUM_ROOTS = { bookmark_bar: 'bar', other: 'other', synced: 'mobile' };

/** `Bookmarks` JSON → flat list with the folder path. */
function parseChromiumBookmarks(json, { max = MAX_BOOKMARKS } = {}) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const roots = (data && data.roots) || {};
  const out = [];
  function walk(node, root, folder, depth) {
    if (!node || typeof node !== 'object' || out.length >= max || depth > 30) return;
    if (node.type === 'url') {
      if (isWebUrl(node.url)) out.push({ title: cleanTitle(node.name) || node.url, url: node.url, root, folder });
      return;
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        walk(child, root, child.type === 'folder' ? [...folder, cleanTitle(child.name) || '…'] : folder, depth + 1);
      }
    }
  }
  for (const key of ['bookmark_bar', 'other', 'synced']) {
    if (roots[key]) walk(roots[key], CHROMIUM_ROOTS[key], [], 0);
  }
  return out;
}

/** `value` in ms since 1601 (the SQL divides Chrome's µs by 1000: µs overflow JavaScript's safe integers). */
function chromiumTimeToMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(0, Math.round(n - WEBKIT_EPOCH_OFFSET_MS));
}

function readChromiumHistory(profileDir, { max = MAX_HISTORY, ...opts } = {}) {
  return withSqliteCopy(
    path.join(profileDir, 'History'),
    (db) =>
      db
        .prepare('SELECT url, title, visit_count, last_visit_time / 1000 AS last_visit_time FROM urls WHERE visit_count > 0 ORDER BY last_visit_time DESC LIMIT ?')
        .all(max)
        .filter((row) => isWebUrl(row.url))
        .map((row) => ({
          url: row.url,
          title: cleanTitle(row.title),
          visitCount: Math.max(1, Number(row.visit_count) || 1),
          lastVisit: chromiumTimeToMs(row.last_visit_time),
        })),
    opts,
  );
}

function readChromiumBookmarks(profileDir, { fsImpl = fs } = {}) {
  try {
    return parseChromiumBookmarks(fsImpl.readFileSync(path.join(profileDir, 'Bookmarks'), 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new ImportReadError('read-failed');
    throw readError(error);
  }
}

/** Key derived from the Keychain secret of « <Browser> Safe Storage » (macOS, `v10` / `v11` values). */
function chromiumMacKey(keychainSecret) {
  return crypto.pbkdf2Sync(Buffer.from(String(keychainSecret), 'utf8'), 'saltysalt', 1003, 16, 'sha1');
}

/** Decrypt one `password_value`. Returns null when it cannot be read (other format, wrong key). */
function decryptChromiumValue(blob, key) {
  const buf = Buffer.isBuffer(blob) ? blob : blob ? Buffer.from(blob) : null;
  if (!buf || buf.length === 0) return null;
  const prefix = buf.subarray(0, 3).toString('latin1');
  if (prefix !== 'v10' && prefix !== 'v11') return null;
  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    const plain = Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()]);
    const text = plain.toString('utf8');
    // A wrong key yields bytes that are not valid UTF-8: refuse rather than import garbage.
    if (text.includes('�')) return null;
    return text;
  } catch (_) {
    return null;
  }
}

/**
 * Rows of `Login Data` (and `Login Data For Account`: the passwords of the browser's synced account).
 * `decrypt(blob)` → string | null. Duplicates (same url + username) are kept once.
 */
function readChromiumPasswords(profileDir, decrypt, { max = MAX_PASSWORDS, fsImpl = fs, ...opts } = {}) {
  const out = [];
  const seen = new Set();
  let undecryptable = 0;
  let found = false;
  for (const name of ['Login Data', 'Login Data For Account']) {
    const file = path.join(profileDir, name);
    try {
      fsImpl.accessSync(file);
    } catch (_) {
      continue;
    }
    found = true;
    const rows = withSqliteCopy(
      file,
      (db) =>
        db
          .prepare('SELECT origin_url, username_value, password_value, blacklisted_by_user FROM logins')
          .all(),
      { fsImpl, ...opts },
    );
    for (const row of rows) {
      if (out.length >= max) break;
      if (Number(row.blacklisted_by_user) === 1 || !isWebUrl(row.origin_url)) continue;
      const password = decrypt(row.password_value);
      if (password == null) {
        undecryptable += 1;
        continue;
      }
      if (!password) continue;
      const username = typeof row.username_value === 'string' ? row.username_value.slice(0, 320) : '';
      const dedupe = `${row.origin_url}\n${username}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push({ url: row.origin_url, username, password });
    }
  }
  if (!found) throw new ImportReadError('not-found');
  return { items: out, undecryptable };
}

// --- Firefox --------------------------------------------------------------

function readFirefoxHistory(profileDir, { max = MAX_HISTORY, ...opts } = {}) {
  return withSqliteCopy(
    path.join(profileDir, 'places.sqlite'),
    (db) =>
      db
        .prepare(
          'SELECT url, title, visit_count, last_visit_date FROM moz_places WHERE visit_count > 0 AND hidden = 0 ORDER BY last_visit_date DESC LIMIT ?',
        )
        .all(max)
        .filter((row) => isWebUrl(row.url))
        .map((row) => ({
          url: row.url,
          title: cleanTitle(row.title),
          visitCount: Math.max(1, Number(row.visit_count) || 1),
          lastVisit: Math.max(0, Math.round((Number(row.last_visit_date) || 0) / 1000)),
        })),
    opts,
  );
}

const FIREFOX_ROOTS = { toolbar_____: 'bar', menu________: 'menu', unfiled_____: 'other', mobile______: 'mobile' };

/** `moz_bookmarks` rows (id, type 1 = url / 2 = folder, parent, title, guid, url) → flat list. */
function buildFirefoxBookmarks(rows, { max = MAX_BOOKMARKS } = {}) {
  const children = new Map();
  for (const row of rows) {
    const list = children.get(row.parent) || [];
    list.push(row);
    children.set(row.parent, list);
  }
  for (const list of children.values()) list.sort((a, b) => (a.position || 0) - (b.position || 0));
  const out = [];
  function walk(id, root, folder, depth) {
    if (depth > 30) return;
    for (const row of children.get(id) || []) {
      if (out.length >= max) return;
      if (Number(row.type) === 1) {
        if (isWebUrl(row.url)) out.push({ title: cleanTitle(row.title) || row.url, url: row.url, root, folder });
      } else if (Number(row.type) === 2) {
        walk(row.id, root, [...folder, cleanTitle(row.title) || '…'], depth + 1);
      }
    }
  }
  // Toolbar first: the bookmarks people use most.
  for (const guid of Object.keys(FIREFOX_ROOTS)) {
    const rootRow = rows.find((row) => row.guid === guid);
    if (rootRow) walk(rootRow.id, FIREFOX_ROOTS[guid], [], 0);
  }
  return out;
}

function readFirefoxBookmarks(profileDir, opts = {}) {
  return withSqliteCopy(
    path.join(profileDir, 'places.sqlite'),
    (db) =>
      buildFirefoxBookmarks(
        db
          .prepare(
            'SELECT b.id, b.type, b.parent, b.position, b.title, b.guid, p.url FROM moz_bookmarks b LEFT JOIN moz_places p ON p.id = b.fk',
          )
          .all(),
      ),
    opts,
  );
}

// --- Safari ---------------------------------------------------------------

function decodeXmlEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Minimal XML property list parser (dict, array, string, integer, real, true / false, date, data). */
function parseXmlPlist(xml) {
  const tokens = String(xml).match(/<\/?[a-zA-Z]+\s*\/?>|[^<]+/g) || [];
  let i = 0;
  function nextTag() {
    while (i < tokens.length) {
      const tok = tokens[i++];
      if (tok.startsWith('<')) return tok;
    }
    return null;
  }
  function textUntil(close) {
    let text = '';
    while (i < tokens.length && tokens[i] !== close) text += tokens[i++];
    i += 1;
    return decodeXmlEntities(text);
  }
  function value(tag) {
    const name = /^<\/?([a-zA-Z]+)/.exec(tag)[1];
    const selfClosing = /\/>$/.test(tag);
    switch (name) {
      case 'dict': {
        const out = {};
        if (selfClosing) return out;
        for (;;) {
          const t = nextTag();
          if (t === null || t === '</dict>') return out;
          if (t === '<key>') {
            const key = textUntil('</key>');
            out[key] = value(nextTag());
          }
        }
      }
      case 'array': {
        const out = [];
        if (selfClosing) return out;
        for (;;) {
          const t = nextTag();
          if (t === null || t === '</array>') return out;
          out.push(value(t));
        }
      }
      case 'string':
        return selfClosing ? '' : textUntil('</string>');
      case 'integer':
      case 'real':
        return Number(textUntil(`</${name}>`));
      case 'date':
        return textUntil('</date>');
      case 'data':
        return selfClosing ? '' : textUntil('</data>').replace(/\s+/g, '');
      case 'true':
        return true;
      case 'false':
        return false;
      default:
        return null;
    }
  }
  for (;;) {
    const tag = nextTag();
    if (tag === null) return null;
    if (/^<(dict|array|string|integer|real|true|false|date|data)\b/.test(tag)) return value(tag);
  }
}

const SAFARI_ROOTS = { BookmarksBar: 'bar', BookmarksMenu: 'menu' };

/** Parsed `Bookmarks.plist` → flat list. The reading list (`com.apple.ReadingList`) is not a bookmark. */
function parseSafariBookmarks(plist, { max = MAX_BOOKMARKS } = {}) {
  const out = [];
  function walk(node, root, folder, depth) {
    if (!node || typeof node !== 'object' || out.length >= max || depth > 30) return;
    if (node.WebBookmarkType === 'WebBookmarkTypeLeaf') {
      const url = node.URLString;
      const title = (node.URIDictionary && node.URIDictionary.title) || node.Title;
      if (isWebUrl(url)) out.push({ title: cleanTitle(title) || url, url, root, folder });
      return;
    }
    if (!Array.isArray(node.Children)) return;
    for (const child of node.Children) {
      if (!child || typeof child !== 'object') continue;
      if (child.WebBookmarkType === 'WebBookmarkTypeList') {
        if (child.Title === 'com.apple.ReadingList' || child.WebBookmarkIdentifier === 'com.apple.ReadingList') continue;
        if (depth === 0) walk(child, SAFARI_ROOTS[child.Title] || 'other', SAFARI_ROOTS[child.Title] ? [] : [cleanTitle(child.Title) || '…'], 1);
        else walk(child, root, [...folder, cleanTitle(child.Title) || '…'], depth + 1);
      } else {
        walk(child, root, folder, depth + 1);
      }
    }
  }
  walk(plist, 'other', [], 0);
  return out;
}

/** `Bookmarks.plist` is binary: `plutil` (macOS) converts it to XML on stdout. */
function readSafariBookmarks(safariDir, { execFileSync = require('child_process').execFileSync, fsImpl = fs } = {}) {
  const file = path.join(safariDir, 'Bookmarks.plist');
  try {
    fsImpl.accessSync(file, fs.constants.R_OK);
    // Read access first: plutil reports a TCC refusal as a generic failure.
    fsImpl.closeSync(fsImpl.openSync(file, 'r'));
  } catch (error) {
    throw readError(error);
  }
  let xml;
  try {
    xml = execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', file], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 20000,
    });
  } catch (_) {
    throw new ImportReadError('read-failed');
  }
  return parseSafariBookmarks(parseXmlPlist(xml));
}

function readSafariHistory(safariDir, { max = MAX_HISTORY, ...opts } = {}) {
  return withSqliteCopy(
    path.join(safariDir, 'History.db'),
    (db) =>
      db
        .prepare(
          `SELECT i.url AS url, i.visit_count AS visit_count, MAX(v.visit_time) AS last_visit,
             (SELECT title FROM history_visits t WHERE t.history_item = i.id AND t.title IS NOT NULL ORDER BY t.visit_time DESC LIMIT 1) AS title
           FROM history_items i JOIN history_visits v ON v.history_item = i.id
           GROUP BY i.id ORDER BY last_visit DESC LIMIT ?`,
        )
        .all(max)
        .filter((row) => isWebUrl(row.url))
        .map((row) => ({
          url: row.url,
          title: cleanTitle(row.title),
          visitCount: Math.max(1, Number(row.visit_count) || 1),
          lastVisit: Math.max(0, Math.round(((Number(row.last_visit) || 0) + MAC_EPOCH_OFFSET_S) * 1000)),
        })),
    opts,
  );
}

// --- CSV (passwords exported by a browser) ----------------------------------

/** RFC 4180 CSV → rows of strings (quoted fields, doubled quotes, CRLF / LF, BOM). */
function parseCsv(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell !== ''));
}

const CSV_COLUMNS = {
  url: ['url', 'login_uri', 'website', 'web site', 'origin', 'adresse', 'site'],
  username: ['username', 'login', 'login_username', 'user', 'email', "nom d'utilisateur", 'identifiant'],
  password: ['password', 'login_password', 'mot de passe'],
};

/**
 * Password CSV of Chrome / Edge / Brave / Arc (name,url,username,password,note), Firefox (url,username,password,…),
 * Safari (Title,URL,Username,Password,Notes,OTPAuth), Bitwarden / 1Password-like headers.
 */
function parsePasswordCsv(text, { max = MAX_PASSWORDS } = {}) {
  const rows = parseCsv(text);
  if (!rows.length) throw new ImportReadError('csv-empty');
  const header = rows[0].map((cell) => cell.trim().toLowerCase());
  const column = (names) => header.findIndex((h) => names.includes(h));
  const urlIdx = column(CSV_COLUMNS.url);
  const userIdx = column(CSV_COLUMNS.username);
  const passIdx = column(CSV_COLUMNS.password);
  if (urlIdx < 0 || passIdx < 0) throw new ImportReadError('csv-format');
  const items = [];
  const seen = new Set();
  let skipped = 0;
  for (const row of rows.slice(1)) {
    if (items.length >= max) {
      skipped += 1;
      continue;
    }
    let url = (row[urlIdx] || '').trim();
    if (url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(url)) url = `https://${url}`;
    const password = row[passIdx] || '';
    const username = userIdx >= 0 ? (row[userIdx] || '').trim().slice(0, 320) : '';
    if (!isWebUrl(url) || !password) {
      skipped += 1;
      continue;
    }
    const dedupe = `${url}\n${username}`;
    if (seen.has(dedupe)) {
      skipped += 1;
      continue;
    }
    seen.add(dedupe);
    items.push({ url, username, password });
  }
  return { items, skipped };
}

module.exports = {
  ImportReadError,
  MAX_HISTORY,
  MAX_BOOKMARKS,
  withSqliteCopy,
  parseChromiumBookmarks,
  readChromiumBookmarks,
  readChromiumHistory,
  readChromiumPasswords,
  chromiumMacKey,
  decryptChromiumValue,
  chromiumTimeToMs,
  readFirefoxHistory,
  readFirefoxBookmarks,
  buildFirefoxBookmarks,
  parseXmlPlist,
  parseSafariBookmarks,
  readSafariBookmarks,
  readSafariHistory,
  parseCsv,
  parsePasswordCsv,
};
