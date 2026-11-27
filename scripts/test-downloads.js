'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { sanitizeFilename, uniqueSavePath } = require('../src/downloads/naming');
const { createDownloadsStore } = require('../src/downloads/store');
const { createDownloadService } = require('../src/downloads/service');

function memoryFs() {
  const files = new Map();
  return {
    files,
    readFileSync: (p) => {
      if (!files.has(p)) throw new Error('ENOENT');
      return files.get(p);
    },
    writeFileSync: (p, data) => files.set(p, data),
    renameSync: (from, to) => {
      files.set(to, files.get(from));
      files.delete(from);
    },
    mkdirSync: () => {},
  };
}

/** Minimal Electron DownloadItem. */
class FakeItem extends EventEmitter {
  constructor({ url = 'https://example.com/rapport.csv', filename = 'rapport.csv', total = 100 } = {}) {
    super();
    this.url = url;
    this.filename = filename;
    this.total = total;
    this.received = 0;
    this.state = 'progressing';
    this.paused = false;
    this.savePath = '';
    this.dialogOptions = null;
    this.cancelled = false;
  }
  getURL() { return this.url; }
  getFilename() { return this.filename; }
  getMimeType() { return 'text/csv'; }
  getTotalBytes() { return this.total; }
  getReceivedBytes() { return this.received; }
  getState() { return this.state; }
  isPaused() { return this.paused; }
  canResume() { return this.paused; }
  getCurrentBytesPerSecond() { return 10; }
  getSavePath() { return this.savePath; }
  setSavePath(p) { this.savePath = p; }
  setSaveDialogOptions(o) { this.dialogOptions = o; }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
  cancel() {
    this.cancelled = true;
    this.state = 'cancelled';
    this.emit('done', {}, 'cancelled');
  }
  progress(bytes) {
    this.received = bytes;
    this.emit('updated', {}, 'progressing');
  }
  finish() {
    this.received = this.total;
    this.state = 'completed';
    this.emit('done', {}, 'completed');
  }
}

function setup(overrides = {}) {
  const existing = new Set(overrides.existing || []);
  const events = [];
  const opened = [];
  const shown = [];
  const progress = [];
  const downloadedUrls = [];
  let n = 0;
  const service = createDownloadService({
    store: createDownloadsStore(),
    getDirectory: () => '/Users/me/Downloads',
    shouldAsk: overrides.shouldAsk || (() => false),
    fileExists: (p) => existing.has(p),
    openPath: (p) => opened.push(p),
    showItemInFolder: (p) => shown.push(p),
    openFolder: (p) => shown.push(`dir:${p}`),
    emit: (e) => events.push(e),
    getSession: () => ({ downloadURL: (u) => downloadedUrls.push(u) }),
    setProgress: (f) => progress.push(f),
    onStarted: overrides.onStarted,
    assessDanger: overrides.assessDanger,
    moveFile: overrides.moveFile || (() => true),
    removeFile: overrides.removeFile || (() => {}),
    randomId: () => `d${++n}`,
  });
  return { service, existing, events, opened, shown, progress, downloadedUrls };
}

describe('download file names', () => {
  it('strips directories, reserved characters and leading dots', () => {
    assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
    assert.equal(sanitizeFilename('..\\evil.exe'), 'evil.exe');
    assert.equal(sanitizeFilename('.bashrc'), 'bashrc');
    assert.equal(sanitizeFilename('a<b>:c?.txt'), 'a_b__c_.txt');
    assert.equal(sanitizeFilename(''), 'telechargement');
    assert.ok(sanitizeFilename(`${'x'.repeat(400)}.pdf`).endsWith('.pdf'));
    assert.ok(sanitizeFilename(`${'x'.repeat(400)}.pdf`).length <= 200);
  });

  it('numbers duplicates like Chrome', () => {
    const taken = new Set(['/d/rapport.csv', '/d/rapport (1).csv', '/d/a.tar.gz']);
    assert.equal(uniqueSavePath('/d', 'rapport.csv', (p) => taken.has(p)), path.join('/d', 'rapport (2).csv'));
    assert.equal(uniqueSavePath('/d', 'a.tar.gz', (p) => taken.has(p)), path.join('/d', 'a (1).tar.gz'));
    assert.equal(uniqueSavePath('/d', 'neuf.pdf', (p) => taken.has(p)), path.join('/d', 'neuf.pdf'));
  });
});

describe('downloads store', () => {
  it('lists newest first, filters, keeps running downloads on clear', () => {
    const store = createDownloadsStore();
    store.upsert({ id: 'a', url: 'https://x.com/a.pdf', savePath: '/d/a.pdf', state: 'completed', startTime: 1 });
    store.upsert({ id: 'b', url: 'https://y.com/b.zip', savePath: '/d/b.zip', state: 'progressing', startTime: 2 });
    assert.deepEqual(store.list().items.map((r) => r.id), ['b', 'a']);
    assert.deepEqual(store.list({ query: 'x.com' }).items.map((r) => r.id), ['a']);
    assert.equal(store.remove('b'), false);
    assert.deepEqual(store.clear(), ['a']);
    assert.deepEqual(store.list().items.map((r) => r.id), ['b']);
  });

  it('marks downloads running at quit as interrupted on reload', () => {
    const fsImpl = memoryFs();
    const first = createDownloadsStore({ filePath: '/u/downloads.json', fsImpl });
    first.upsert({ id: 'a', savePath: '/d/a.pdf', state: 'progressing', startTime: 5 });
    first.flush();
    const second = createDownloadsStore({ filePath: '/u/downloads.json', fsImpl });
    const [rec] = second.list().items;
    assert.equal(rec.state, 'interrupted');
    assert.equal(rec.error, 'shutdown');
  });

  it('drops invalid records', () => {
    const store = createDownloadsStore();
    assert.equal(store.upsert({ id: 'x' }), null);
    assert.equal(store.upsert(null), null);
  });
});

describe('download service', () => {
  it('saves to the chosen folder without overwriting, then reports completion', () => {
    const { service, events, progress } = setup({ existing: ['/Users/me/Downloads/rapport.csv'] });
    const item = new FakeItem();
    service.handleDownload(item, 'portal');
    assert.equal(item.savePath, path.join('/Users/me/Downloads', 'rapport (1).csv'));
    assert.equal(events[0].type, 'upsert');
    assert.equal(events[0].item.filename, 'rapport (1).csv');
    assert.equal(events[0].item.source, 'portal');

    // Two downloads of the same name at once never share a path.
    const second = new FakeItem();
    service.handleDownload(second, 'web');
    assert.equal(second.savePath, path.join('/Users/me/Downloads', 'rapport (2).csv'));

    item.finish();
    const last = events.at(-1);
    assert.equal(last.item.state, 'completed');
    assert.equal(last.item.receivedBytes, 100);
    assert.equal(service.activeCount(), 1);
    second.cancel();
    assert.equal(progress.at(-1), -1);
  });

  it('asks where to save when the setting is on, and forgets a cancelled dialog', () => {
    const { service, events } = setup({ shouldAsk: () => true });
    const item = new FakeItem();
    service.handleDownload(item, 'web');
    assert.equal(item.savePath, '');
    assert.equal(item.dialogOptions.defaultPath, path.join('/Users/me/Downloads', 'rapport.csv'));
    assert.equal(events.length, 0);
    item.cancel();
    assert.equal(events.length, 0);
    assert.equal(service.list().items.length, 0);
  });

  it('opens, shows, pauses and cancels by id only', () => {
    const { service, existing, opened, shown } = setup();
    const item = new FakeItem();
    service.handleDownload(item, 'web');
    const { id } = service.list().items[0];
    assert.equal(service.open({ id }).ok, false);
    assert.equal(service.pause({ id }).ok, true);
    assert.equal(service.list().items[0].paused, true);
    assert.equal(service.resume({ id }).ok, true);
    item.finish();
    existing.add(item.savePath);
    assert.equal(service.open({ id }).ok, true);
    assert.deepEqual(opened, [item.savePath]);
    service.show({ id });
    assert.deepEqual(shown, [item.savePath]);
    assert.equal(service.list().items[0].exists, true);
    assert.equal(service.open({ id: '../etc/passwd' }).ok, false);
    assert.equal(service.cancel({ id }).ok, false);
  });

  it('retries http(s) downloads only, replacing the failed entry', () => {
    const { service, events, downloadedUrls } = setup();
    const item = new FakeItem();
    service.handleDownload(item, 'web');
    const { id } = service.list().items[0];
    item.state = 'interrupted';
    item.emit('done', {}, 'interrupted');
    assert.equal(service.list().items[0].error, 'failed');
    assert.equal(service.retry({ id }).ok, true);
    assert.deepEqual(downloadedUrls, ['https://example.com/rapport.csv']);
    service.handleDownload(new FakeItem(), 'web');
    assert.ok(events.some((e) => e.type === 'remove' && e.ids[0] === id));
    assert.equal(service.list().items.length, 1);

    const blob = new FakeItem({ url: 'blob:https://app.lascoapp.com/123' });
    service.handleDownload(blob, 'portal');
    blob.cancel();
    const blobId = service.list().items.find((r) => r.url.startsWith('blob:')).id;
    assert.equal(service.retry({ id: blobId }).error, 'not-retryable');
  });
});

describe('download start in a page', () => {
  it('tells which page started the download', () => {
    const started = [];
    const { service } = setup({ onStarted: (e) => started.push(e) });
    const session = new EventEmitter();
    service.attach(session, 'web');
    const page = { id: 7 };
    session.emit('will-download', {}, new FakeItem(), page);
    assert.deepEqual(started, [{ webContents: page, source: 'web' }]);
    assert.equal(service.list().items.length, 1);
  });
  it('keeps the download when the page hook throws', () => {
    const { service } = setup({ onStarted: () => { throw new Error('boom'); } });
    const session = new EventEmitter();
    service.attach(session, 'web');
    session.emit('will-download', {}, new FakeItem(), { id: 1 });
    assert.equal(service.list().items.length, 1);
  });
});

describe('downloads: dangerous files (Safe Browsing)', () => {
  it('cancels a file of a flagged site and lists it as dangerous', () => {
    const { service, events } = setup({ assessDanger: () => ({ verdict: 'dangerous', threat: 'malware' }) });
    const item = new FakeItem({ url: 'https://bad.example/virus.exe', filename: 'virus.exe' });
    service.handleDownload(item, 'web');
    assert.equal(item.cancelled, true);
    const last = events.filter((e) => e.type === 'upsert').pop().item;
    assert.equal(last.error, 'dangerous');
    assert.equal(last.danger, 'malware');
    assert.equal(last.state, 'cancelled');
  });

  it('writes under a temporary name while a prefix is verified, then renames a safe file', async () => {
    let resolveCheck;
    const moved = [];
    const { service, events } = setup({
      assessDanger: () => ({ verdict: 'check', check: () => new Promise((r) => { resolveCheck = r; }) }),
      moveFile: (from, to) => moved.push([from, to]) > 0,
    });
    const item = new FakeItem();
    service.handleDownload(item, 'web');
    assert.equal(item.savePath, '/Users/me/Downloads/rapport.csv.lasco-verification');
    item.finish();
    await new Promise((r) => setImmediate(r));
    resolveCheck({ verdict: 'safe' });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(moved, [['/Users/me/Downloads/rapport.csv.lasco-verification', '/Users/me/Downloads/rapport.csv']]);
    const last = events.filter((e) => e.type === 'upsert').pop().item;
    assert.equal(last.state, 'completed');
    assert.equal(last.savePath, '/Users/me/Downloads/rapport.csv');
  });

  it('deletes a small file finished before the verdict when it is dangerous', async () => {
    let resolveCheck;
    const removed = [];
    const { service, events } = setup({
      assessDanger: () => ({ verdict: 'check', check: () => new Promise((r) => { resolveCheck = r; }) }),
      removeFile: (p) => removed.push(p),
    });
    const item = new FakeItem({ url: 'https://bad.example/a.exe', filename: 'a.exe' });
    service.handleDownload(item, 'web');
    item.finish();
    await new Promise((r) => setImmediate(r));
    resolveCheck({ verdict: 'dangerous', threat: 'malware' });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(removed, ['/Users/me/Downloads/a.exe.lasco-verification']);
    const last = events.filter((e) => e.type === 'upsert').pop().item;
    assert.equal(last.state, 'cancelled');
    assert.equal(last.error, 'dangerous');
    assert.equal(last.savePath, '/Users/me/Downloads/a.exe');
  });

  it('« Conserver quand même » downloads it again without the check', () => {
    const assessed = [];
    const { service, downloadedUrls } = setup({
      assessDanger: ({ urls }) => {
        assessed.push(urls[0]);
        return { verdict: 'dangerous', threat: 'phishing' };
      },
    });
    service.handleDownload(new FakeItem({ url: 'https://bad.example/f.zip', filename: 'f.zip' }), 'web');
    assert.deepEqual(service.keepDangerous({ id: 'd1' }), { ok: true });
    assert.deepEqual(downloadedUrls, ['https://bad.example/f.zip']);
    const again = new FakeItem({ url: 'https://bad.example/f.zip', filename: 'f.zip' });
    service.handleDownload(again, 'web');
    assert.equal(again.cancelled, false);
    assert.equal(assessed.length, 1);
    assert.deepEqual(service.keepDangerous({ id: 'd2' }), { ok: false });
  });
});
