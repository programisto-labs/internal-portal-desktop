'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readers = require('../src/browser-import/readers');
const { detectBrowsers, publicBrowser } = require('../src/browser-import/browsers');
const { createBrowserImport } = require('../src/browser-import/index');
const { createHistoryStore } = require('../src/browser-tabs/history');

const FIXTURES = path.join(__dirname, 'fixtures', 'browser-import');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

let sqlite = null;
try {
  sqlite = require('node:sqlite');
} catch (_) {
  // Node < 22.5: the SQLite readers are skipped (Electron's Node has it).
}
const withSqlite = sqlite ? it : it.skip;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lasco-import-test-'));
}

function makeDb(file, sql, rows) {
  const db = new sqlite.DatabaseSync(file);
  db.exec(sql.schema);
  const stmt = db.prepare(sql.insert);
  for (const row of rows) stmt.run(...row);
  db.close();
}

/** Same encryption as Chromium on macOS (`v10`, AES-128-CBC, PBKDF2 « saltysalt »). */
function encryptChromium(text, secret) {
  const key = readers.chromiumMacKey(secret);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from('v10'), cipher.update(text, 'utf8'), cipher.final()]);
}

/** WebKit time (µs since 1601) of a JavaScript date. */
const webkit = (ms) => (ms + 11644473600000) * 1000;

function chromiumProfile(dir, { secret = 'keychain-secret' } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Bookmarks'), fixture('chromium-Bookmarks.json'));
  makeDb(
    path.join(dir, 'History'),
    {
      schema: 'CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER)',
      insert: 'INSERT INTO urls (url, title, visit_count, last_visit_time, hidden) VALUES (?, ?, ?, ?, 0)',
    },
    [
      ['https://news.example.com/a', 'Actualités', 3, webkit(Date.UTC(2026, 10, 20))],
      ['https://old.example.com/', 'Ancien', 1, webkit(Date.UTC(2026, 0, 2))],
      ['chrome://settings/', 'Réglages', 2, webkit(Date.UTC(2026, 10, 21))],
      ['https://never.example.com/', 'Jamais vu', 0, 0],
    ],
  );
  const logins = {
    schema: 'CREATE TABLE logins (origin_url TEXT, username_value TEXT, password_value BLOB, blacklisted_by_user INTEGER)',
    insert: 'INSERT INTO logins VALUES (?, ?, ?, ?)',
  };
  makeDb(path.join(dir, 'Login Data'), logins, [
    ['https://example.com/login', 'alice', encryptChromium('mot-de-passe', secret), 0],
    ['https://blocked.example.com/', '', Buffer.alloc(0), 1],
    ['android://hash@com.example/', 'bob', encryptChromium('x', secret), 0],
    ['https://broken.example.com/', 'carol', Buffer.from('v20garbage'), 0],
  ]);
  makeDb(path.join(dir, 'Login Data For Account'), logins, [
    ['https://example.com/login', 'alice', encryptChromium('mot-de-passe', secret), 0],
    ['https://account.example.org/', 'dave', encryptChromium('compte', secret), 0],
  ]);
}

describe('browser import: Chromium', () => {
  it('flattens bookmarks with their root and folder path, web addresses only', () => {
    const items = readers.parseChromiumBookmarks(fixture('chromium-Bookmarks.json'));
    assert.deepEqual(
      items.map((b) => [b.root, b.folder.join('/'), b.title, b.url]),
      [
        ['bar', '', 'Exemple', 'https://example.com/'],
        ['bar', 'Docs', 'MDN', 'https://developer.mozilla.org/'],
        ['bar', 'Docs/Profond', 'http://deep.example.org/a', 'http://deep.example.org/a'],
        ['other', '', 'Autre', 'https://other.example.net/'],
      ],
    );
  });

  it('converts WebKit times', () => {
    // The SQL already divides by 1000 (ms since 1601).
    assert.equal(readers.chromiumTimeToMs(webkit(Date.UTC(2026, 0, 1)) / 1000), Date.UTC(2026, 0, 1));
    assert.equal(readers.chromiumTimeToMs(0), 0);
  });

  withSqlite('reads the history from a copy, newest first, visited web pages only', () => {
    const dir = path.join(tmpDir(), 'Default');
    chromiumProfile(dir);
    const items = readers.readChromiumHistory(dir);
    assert.deepEqual(
      items.map((h) => [h.url, h.visitCount, new Date(h.lastVisit).toISOString().slice(0, 10)]),
      [
        ['https://news.example.com/a', 3, '2026-11-20'],
        ['https://old.example.com/', 1, '2026-01-02'],
      ],
    );
  });

  withSqlite('decrypts macOS passwords of both login databases, skipping the rest', () => {
    const dir = path.join(tmpDir(), 'Default');
    chromiumProfile(dir, { secret: 's3cr3t' });
    const key = readers.chromiumMacKey('s3cr3t');
    const { items, undecryptable } = readers.readChromiumPasswords(dir, (blob) => readers.decryptChromiumValue(blob, key));
    assert.deepEqual(items, [
      { url: 'https://example.com/login', username: 'alice', password: 'mot-de-passe' },
      { url: 'https://account.example.org/', username: 'dave', password: 'compte' },
    ]);
    assert.equal(undecryptable, 1);
  });

  it('refuses to decrypt with a wrong key', () => {
    const blob = encryptChromium('secret', 'right');
    assert.equal(readers.decryptChromiumValue(blob, readers.chromiumMacKey('wrong')), null);
    assert.equal(readers.decryptChromiumValue(Buffer.from('plain'), readers.chromiumMacKey('right')), null);
  });
});

describe('browser import: Safari and Firefox', () => {
  it('parses an XML property list', () => {
    const plist = readers.parseXmlPlist(fixture('safari-Bookmarks.xml'));
    assert.equal(plist.WebBookmarkFileVersion, 1);
    assert.equal(plist.Sync.Flag, true);
    assert.equal(plist.Sync.Data, 'AAEC');
  });

  it('flattens Safari bookmarks without the reading list', () => {
    const items = readers.parseSafariBookmarks(readers.parseXmlPlist(fixture('safari-Bookmarks.xml')));
    assert.deepEqual(
      items.map((b) => [b.root, b.folder.join('/'), b.title, b.url]),
      [
        ['bar', '', 'Apple & Co', 'https://www.apple.com/'],
        ['bar', 'Lectures', 'Wiki', 'https://fr.wikipedia.org/'],
      ],
    );
  });

  withSqlite('reads Safari history (Core Data times, last title)', () => {
    const dir = tmpDir();
    const db = new sqlite.DatabaseSync(path.join(dir, 'History.db'));
    db.exec(`CREATE TABLE history_items (id INTEGER PRIMARY KEY, url TEXT, visit_count INTEGER);
      CREATE TABLE history_visits (id INTEGER PRIMARY KEY, history_item INTEGER, visit_time REAL, title TEXT);
      INSERT INTO history_items VALUES (1, 'https://a.example.com/', 4), (2, 'about:blank', 1);
      INSERT INTO history_visits VALUES (1, 1, 100.5, 'Ancien titre'), (2, 1, 200.5, 'Titre'), (3, 2, 300, NULL);`);
    db.close();
    const items = readers.readSafariHistory(dir);
    assert.deepEqual(items, [
      { url: 'https://a.example.com/', title: 'Titre', visitCount: 4, lastVisit: (200.5 + 978307200) * 1000 },
    ]);
  });

  it('reports a Safari folder blocked by macOS as « full-disk-access »', () => {
    const denied = { accessSync: () => { const e = new Error('denied'); e.code = 'EPERM'; throw e; } };
    assert.throws(() => readers.readSafariBookmarks('/Users/x/Library/Safari', { fsImpl: denied }), { code: 'full-disk-access' });
  });

  it('builds Firefox bookmarks from moz_bookmarks rows, toolbar first', () => {
    const rows = [
      { id: 1, type: 2, parent: 0, guid: 'root________', title: '' },
      { id: 2, type: 2, parent: 1, guid: 'menu________', title: 'menu' },
      { id: 3, type: 2, parent: 1, guid: 'toolbar_____', title: 'toolbar' },
      { id: 4, type: 2, parent: 1, guid: 'tags________', title: 'tags' },
      { id: 10, type: 1, parent: 2, position: 0, title: 'Menu', url: 'https://menu.example.com/' },
      { id: 11, type: 2, parent: 3, position: 1, title: 'Dossier', guid: 'x' },
      { id: 12, type: 1, parent: 11, position: 0, title: 'Dans le dossier', url: 'https://in.example.com/' },
      { id: 13, type: 1, parent: 3, position: 0, title: 'Barre', url: 'https://bar.example.com/' },
      { id: 14, type: 1, parent: 4, position: 0, title: 'Tag', url: 'https://tag.example.com/' },
      { id: 15, type: 1, parent: 3, position: 2, title: 'Place', url: 'place:sort=8' },
    ];
    assert.deepEqual(
      readers.buildFirefoxBookmarks(rows).map((b) => [b.root, b.folder.join('/'), b.title]),
      [
        ['bar', '', 'Barre'],
        ['bar', 'Dossier', 'Dans le dossier'],
        ['menu', '', 'Menu'],
      ],
    );
  });
});

describe('browser import: password CSV', () => {
  it('parses Chrome exports (quotes, commas, duplicates, non-web rows)', () => {
    const { items, skipped } = readers.parsePasswordCsv(fixture('chrome-passwords.csv'));
    assert.deepEqual(items, [{ url: 'https://example.com/login', username: 'alice', password: 'p,a"ss' }]);
    assert.equal(skipped, 3);
  });

  it('parses Firefox and Safari exports', () => {
    assert.deepEqual(readers.parsePasswordCsv(fixture('firefox-passwords.csv')).items, [
      { url: 'https://accounts.example.org', username: 'dave', password: 's3cret' },
    ]);
    assert.deepEqual(readers.parsePasswordCsv(fixture('safari-passwords.csv')).items, [
      { url: 'https://site.example.com/', username: 'eve', password: 'multi\nligne' },
    ]);
  });

  it('refuses a file without url and password columns', () => {
    assert.throws(() => readers.parsePasswordCsv('a,b\n1,2\n'), { code: 'csv-format' });
    assert.throws(() => readers.parsePasswordCsv(''), { code: 'csv-empty' });
  });
});

describe('browser import: detection', () => {
  it('finds Chromium profiles named by Local State, Safari behind Full Disk Access, Firefox profiles', () => {
    const home = tmpDir();
    const chrome = path.join(home, 'Library/Application Support/Google/Chrome');
    fs.mkdirSync(path.join(chrome, 'Default'), { recursive: true });
    fs.mkdirSync(path.join(chrome, 'Profile 2'), { recursive: true });
    fs.mkdirSync(path.join(chrome, 'Profile 3'), { recursive: true }); // no data: ignored
    fs.writeFileSync(path.join(chrome, 'Default', 'Bookmarks'), '{}');
    fs.writeFileSync(path.join(chrome, 'Profile 2', 'History'), '');
    fs.writeFileSync(
      path.join(chrome, 'Local State'),
      JSON.stringify({ profile: { info_cache: { Default: { name: 'Perso', user_name: 'a@example.com' }, 'Profile 2': { name: 'Travail' } } } }),
    );
    const firefox = path.join(home, 'Library/Application Support/Firefox');
    fs.mkdirSync(path.join(firefox, 'Profiles/abc.default'), { recursive: true });
    fs.writeFileSync(path.join(firefox, 'Profiles/abc.default/places.sqlite'), '');
    fs.writeFileSync(path.join(firefox, 'profiles.ini'), '[General]\nStartWithLastProfile=1\n\n[Profile0]\nName=default\nIsRelative=1\nPath=Profiles/abc.default\nDefault=1\n');
    fs.mkdirSync(path.join(home, 'Library/Safari'), { recursive: true });

    const realReaddir = fs.readdirSync;
    const fsImpl = {
      ...fs,
      readdirSync: (dir, ...rest) => {
        if (dir === path.join(home, 'Library/Safari')) {
          const error = new Error('Operation not permitted');
          error.code = 'EPERM';
          throw error;
        }
        return realReaddir(dir, ...rest);
      },
    };
    const browsers = detectBrowsers({ home, platform: 'darwin', env: {}, fsImpl }).map(publicBrowser);
    assert.deepEqual(
      browsers.map((b) => [b.id, b.passwords, b.needsFullDiskAccess || false, b.profiles.map((p) => `${p.id}:${p.name}`)]),
      [
        ['chrome', 'native', false, ['Default:Perso', 'Profile 2:Travail']],
        ['safari', 'csv', true, ['default:Safari']],
        ['firefox', 'csv', false, ['Profile0:default']],
      ],
    );
    assert.equal(JSON.stringify(browsers).includes(home), false, 'no file path is sent to the portal');
  });

  it('uses %LOCALAPPDATA% on Windows and proposes a CSV for passwords', () => {
    const local = tmpDir();
    const dir = path.join(local, 'Microsoft/Edge/User Data/Default');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'Bookmarks'), '{}');
    const browsers = detectBrowsers({ home: tmpDir(), platform: 'win32', env: { LOCALAPPDATA: local } });
    assert.deepEqual(browsers.map((b) => [b.id, b.passwords]), [['edge', 'csv']]);
    assert.deepEqual(detectBrowsers({ home: tmpDir(), platform: 'win32', env: {} }), []);
  });
});

describe('browser import: controller', () => {
  withSqlite('imports history into the store, returns bookmarks and a one-time password token', async () => {
    const home = tmpDir();
    const profile = path.join(home, 'Library/Application Support/BraveSoftware/Brave-Browser/Default');
    chromiumProfile(profile, { secret: 'brave-secret' });
    const history = createHistoryStore({ now: () => Date.UTC(2026, 10, 27) });
    history.recordVisit('https://news.example.com/a', 'Déjà vu');
    const events = [];
    const keychainCalls = [];
    const controller = createBrowserImport({
      home,
      platform: 'darwin',
      env: {},
      history,
      emit: (e) => events.push(`${e.step}:${e.status}`),
      getKeychainSecret: async (item) => {
        keychainCalls.push(item.service);
        return 'brave-secret';
      },
    });
    assert.deepEqual(controller.list().browsers.map((b) => b.id), ['brave']);

    const result = await controller.run({
      importId: 'i1',
      browserId: 'brave',
      profileId: 'Default',
      kinds: { history: true, bookmarks: true, passwords: true },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.history, { found: 2, imported: 1, skipped: 1 });
    assert.equal(history.list().total, 2);
    assert.equal(result.bookmarks.found, 4);
    assert.deepEqual(keychainCalls, ['Brave Safe Storage']);
    assert.equal(result.passwords.found, 2);
    assert.equal(JSON.stringify(result).includes('mot-de-passe'), false, 'no password in the run result');
    assert.deepEqual(events, ['history:running', 'history:done', 'bookmarks:running', 'bookmarks:done', 'passwords:running', 'passwords:done']);

    const taken = controller.takePasswords({ token: result.passwords.token });
    assert.equal(taken.ok, true);
    assert.equal(taken.items[0].password, 'mot-de-passe');
    assert.deepEqual(controller.takePasswords({ token: result.passwords.token }), { ok: false, error: 'expired' });

    // Same import again: nothing counted twice.
    const again = await controller.run({ browserId: 'brave', profileId: 'Default', kinds: { history: true } });
    assert.deepEqual(again.history, { found: 2, imported: 0, skipped: 2 });
  });

  it('reports a refused Keychain access per kind, without failing the others', async () => {
    const home = tmpDir();
    const profile = path.join(home, 'Library/Application Support/Google/Chrome/Default');
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(profile, 'Bookmarks'), fixture('chromium-Bookmarks.json'));
    fs.writeFileSync(path.join(profile, 'Login Data'), '');
    const controller = createBrowserImport({
      home,
      platform: 'darwin',
      env: {},
      history: createHistoryStore(),
      getKeychainSecret: async () => {
        throw new readers.ImportReadError('keychain-denied');
      },
    });
    const result = await controller.run({ browserId: 'chrome', kinds: { bookmarks: true, passwords: true } });
    assert.equal(result.bookmarks.found, 4);
    assert.deepEqual(result.errors, { passwords: 'keychain-denied' });
  });

  it('expires unclaimed passwords and reads a CSV once', () => {
    let t = 0;
    const dir = tmpDir();
    const file = path.join(dir, 'p.csv');
    fs.copyFileSync(path.join(FIXTURES, 'firefox-passwords.csv'), file);
    const controller = createBrowserImport({ home: dir, platform: 'darwin', env: {}, history: createHistoryStore(), now: () => t });
    const csv = controller.importPasswordsCsv({ filePath: file });
    assert.equal(csv.ok, true);
    assert.equal(csv.found, 1);
    t = 11 * 60 * 1000;
    assert.deepEqual(controller.takePasswords({ token: csv.token }), { ok: false, error: 'expired' });
    assert.deepEqual(controller.importPasswordsCsv({}), { ok: false, error: 'canceled' });
  });
});

describe('history store: importEntries', () => {
  it('keeps the larger count and the latest visit, never a future date, prunes to the limit', () => {
    const now = Date.UTC(2026, 10, 27);
    const store = createHistoryStore({ now: () => now, maxEntries: 3 });
    store.recordVisit('https://a.example.com/', 'A');
    const res = store.importEntries([
      { url: 'https://a.example.com/', title: 'A importé', visitCount: 7, lastVisit: now - 1000 },
      { url: 'https://b.example.com/', title: 'B', visitCount: 2, lastVisit: now + 10 ** 9 },
      { url: 'https://c.example.com/', title: 'C', visitCount: 1, lastVisit: now - 5000 },
      { url: 'https://d.example.com/', title: 'D', visitCount: 1, lastVisit: 1 },
      { url: 'javascript:void(0)', title: 'x' },
    ]);
    assert.deepEqual(res, { imported: 2, skipped: 3 });
    const { items } = store.list();
    assert.deepEqual(items.map((e) => [e.url, e.visitCount, e.title]), [
      ['https://a.example.com/', 7, 'A'],
      ['https://b.example.com/', 2, 'B'],
      ['https://c.example.com/', 1, 'C'],
    ]);
    assert.equal(items[1].lastVisit, now);
  });
});
