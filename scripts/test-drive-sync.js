'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDriveSyncStore } = require('../src/drive-sync/store');
const { createDriveSyncFsOps, sanitizeManifest, isConfinedRelativePath } = require('../src/drive-sync/fs-ops');
const { registerDriveSyncIpc } = require('../src/drive-sync/ipc');

let tmp;
let root;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'drive-sync-')));
  root = path.join(tmp, 'Drive');
  fs.mkdirSync(root);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const fakeFetch = (body, { status = 200 } = {}) => async () =>
  new Response(status === 200 ? body : null, { status });

describe('drive-sync store', () => {
  it('is disabled by default and never enabled without a folder', () => {
    const store = createDriveSyncStore(path.join(tmp, 'c.json'));
    assert.deepEqual(store.publicConfig(), { enabled: false, rootPath: null, ownerUserId: null });
    store.setEnabled(true);
    assert.equal(store.get().enabled, false);
  });

  it('binds the folder to the first account and refuses another one', () => {
    const store = createDriveSyncStore(path.join(tmp, 'c.json'));
    store.setFolder(root);
    store.setEnabled(true);
    assert.deepEqual(store.bind('u1', 'Ana'), { ok: true });
    assert.deepEqual(store.bind('u2', 'Bob'), { ok: false, error: 'account-mismatch' });
    assert.equal(store.rejectedAccount().label, 'Bob');
    assert.equal(store.allows(root, 'u1'), true);
    assert.equal(store.allows(root, 'u2'), false);
    // Nouveau dossier : libre pour le compte connecté.
    store.setFolder(path.join(tmp, 'Autre'));
    assert.equal(store.get().ownerUserId, null);
    assert.equal(store.rejectedAccount(), null);
  });

  it('persists and notifies config changes', () => {
    const file = path.join(tmp, 'c.json');
    const store = createDriveSyncStore(file);
    const seen = [];
    store.onChange((c) => seen.push(c));
    store.setFolder(root);
    store.setEnabled(true);
    assert.equal(seen.length, 2);
    assert.equal(createDriveSyncStore(file).get().enabled, true);
  });

  it('only records runs of the bound account', () => {
    const store = createDriveSyncStore(path.join(tmp, 'c.json'));
    store.setFolder(root);
    store.setEnabled(true);
    store.bind('u1');
    assert.equal(store.reportRun('u2', { status: 'up-to-date' }), false);
    assert.equal(store.reportRun('u1', { status: 'up-to-date', downloaded: 3, notices: [{ kind: 'conflict-kept' }] }, 42), true);
    assert.deepEqual(store.get().lastRun, { status: 'up-to-date', downloaded: 3, skipped: 0, error: null, noticeKinds: ['conflict-kept'], at: 42 });
  });
});

describe('drive-sync fs-ops', () => {
  const ops = (fetchImpl) => createDriveSyncFsOps({ manifestDir: path.join(tmp, 'manifests'), fetchImpl });

  it('rejects paths that leave the folder', () => {
    for (const p of ['../x', '/etc/passwd', 'a/../../b', 'a\\b', 'C:/x', '', 'a//b', './a']) {
      assert.equal(isConfinedRelativePath(p), false, p);
    }
    assert.equal(isConfinedRelativePath('Dossier/sous dossier/fichier.pdf'), true);
  });

  it('downloads into nested folders and never overwrites', async () => {
    const o = ops(fakeFetch('hello'));
    const res = await o.writeFile({ root, relativePath: 'A/B/doc.txt', url: 'https://s3.example/doc' });
    assert.deepEqual(res, { ok: true, size: 5 });
    assert.equal(fs.readFileSync(path.join(root, 'A/B/doc.txt'), 'utf8'), 'hello');
    const again = await ops(fakeFetch('other')).writeFile({ root, relativePath: 'A/B/doc.txt', url: 'https://s3.example/doc' });
    assert.deepEqual(again, { ok: false, error: 'exists' });
    assert.equal(fs.readFileSync(path.join(root, 'A/B/doc.txt'), 'utf8'), 'hello');
    assert.deepEqual(fs.readdirSync(path.join(root, 'A/B')), ['doc.txt']);
  });

  it('refuses to write through a symlink', async () => {
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, 'link'));
    const res = await ops(fakeFetch('x')).writeFile({ root, relativePath: 'link/evil.txt', url: 'https://s3.example/x' });
    assert.deepEqual(res, { ok: false, error: 'path-escape' });
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.equal((await ops().stat(root, 'link/evil.txt')).exists, true);
  });

  it('refuses non-https download urls and leaves no partial file', async () => {
    const o = ops(fakeFetch('x'));
    assert.deepEqual(await o.writeFile({ root, relativePath: 'a.txt', url: 'file:///etc/passwd' }), { ok: false, error: 'network' });
    assert.deepEqual(await ops(fakeFetch('', { status: 500 })).writeFile({ root, relativePath: 'a.txt', url: 'https://s3/x' }), {
      ok: false,
      error: 'network',
    });
    assert.deepEqual(fs.readdirSync(root), []);
  });

  it('reports a missing folder', async () => {
    assert.deepEqual(await ops().validateFolder(path.join(tmp, 'nope')), { ok: false, error: 'folder-not-found' });
    assert.deepEqual(await ops().validateFolder(root), { ok: true });
    assert.deepEqual(fs.readdirSync(root), []);
  });

  it('keeps manifests per account and folder', async () => {
    const o = ops();
    const manifest = { version: 1, userId: 'u1', rootPath: root, entries: { r1: { fileId: 'f1', relativePath: 'a.txt', localSize: 1 } } };
    assert.deepEqual(await o.writeManifest(manifest), { ok: true });
    assert.deepEqual(await o.readManifest('u1', root), manifest);
    assert.equal(await o.readManifest('u2', root), null);
  });

  it('drops unsafe manifest entries sent by the page', () => {
    const m = sanitizeManifest(
      { version: 1, userId: 'u1', rootPath: root, entries: { ok: { fileId: 'f', relativePath: 'a.txt' }, bad: { fileId: 'f', relativePath: '../x' } } },
      { userId: 'u1', rootPath: root },
    );
    assert.deepEqual(Object.keys(m.entries), ['ok']);
    assert.equal(sanitizeManifest({ version: 1, userId: 'u2', rootPath: root, entries: {} }, { userId: 'u1', rootPath: root }), null);
  });
});

describe('drive-sync ipc', () => {
  function setup({ trusted = true } = {}) {
    const handlers = {};
    const store = createDriveSyncStore(path.join(tmp, 'c.json'));
    const writes = [];
    registerDriveSyncIpc({
      ipcMain: { handle: (ch, fn) => (handlers[ch] = fn) },
      store,
      fsOps: {
        validateFolder: async () => ({ ok: true }),
        readManifest: async () => null,
        writeManifest: async () => ({ ok: true }),
        stat: async () => ({ exists: false }),
        writeFile: async (p) => (writes.push(p), { ok: true, size: 1 }),
      },
      isTrustedPortalSender: () => trusted,
      isFromSettings: () => true,
      pickFolder: async () => root,
      openFolder: () => undefined,
      openSettings: () => undefined,
      refreshSettings: () => undefined,
      notifyPortal: () => undefined,
    });
    const call = (ch, ...args) => handlers[ch]({}, ...args);
    return { store, call, writes };
  }

  it('enabling without a folder asks for one', async () => {
    const { store, call } = setup();
    assert.deepEqual(await call('settings-modal-drive-set-enabled', true), { ok: true });
    assert.equal(store.get().rootPath, root);
    assert.equal(store.get().enabled, true);
  });

  it('the page only writes into the bound folder', async () => {
    const { call, writes } = setup();
    await call('settings-modal-drive-set-enabled', true);
    // Pas encore lié à un compte : refusé.
    assert.equal((await call('drive-sync-write-file', { root, relativePath: 'a', url: 'https://x' })).ok, false);
    await call('drive-sync-bind', { userId: 'u1' });
    assert.equal((await call('drive-sync-write-file', { root: '/tmp/autre', relativePath: 'a', url: 'https://x' })).ok, false);
    assert.equal((await call('drive-sync-write-file', { root, relativePath: 'a', url: 'https://x' })).ok, true);
    assert.equal(writes.length, 1);
    assert.equal((await call('drive-sync-stat', { root: '/tmp/autre', relativePath: 'a' })).exists, true);
  });

  it('an untrusted sender gets nothing', async () => {
    const { call } = setup({ trusted: false });
    assert.equal(await call('drive-sync-get-config'), null);
    assert.equal((await call('drive-sync-bind', { userId: 'u1' })).ok, false);
  });
});
