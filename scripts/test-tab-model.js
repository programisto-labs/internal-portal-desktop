'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTabModel, diffStrips, sanitizeTabRecord, MAX_TABS_PER_STRIP } = require('../src/tab-model');
const { createTabSessionStore } = require('../src/tab-session-store');

const tab = (id, extra = {}) => ({ id, kind: 'internal', href: `/clad/${id}`, title: id, lastUsedAt: 1, ...extra });

describe('tab model records', () => {
  it('keeps only valid portal paths and http(s) pages', () => {
    assert.equal(sanitizeTabRecord(tab('a', { href: '//evil.com' })), null);
    assert.equal(sanitizeTabRecord(tab('a', { kind: 'external', href: 'javascript:alert(1)' })), null);
    assert.equal(sanitizeTabRecord(tab('a b')), null);
    const web = sanitizeTabRecord(tab('w', { kind: 'external', href: 'https://example.com/', blank: true, favicon: 'file:///x' }));
    assert.deepEqual(web, {
      id: 'w',
      kind: 'external',
      href: 'https://example.com/',
      title: 'w',
      favicon: null,
      blank: false,
      lastUsedAt: 1,
      pinned: false,
      groupId: null,
    });
  });

  it('carries pinned and group for later features', () => {
    const record = sanitizeTabRecord(tab('a', { pinned: true, groupId: 'g1' }));
    assert.equal(record.pinned, true);
    assert.equal(record.groupId, 'g1');
  });
});

describe('tab model commits', () => {
  it('stores the strip per window and scope, revision increasing', () => {
    const model = createTabModel();
    assert.equal(model.commit('main', { scope: '/clad', tabs: [tab('a'), tab('b')], activeId: 'b' }), 1);
    assert.equal(model.commit('main', { scope: '/clad', activeId: 'a' }), 2);
    const strip = model.readStrip('main', '/clad');
    assert.deepEqual(strip.tabs.map((t) => t.id), ['a', 'b']);
    assert.equal(strip.activeId, 'a');
    assert.equal(model.readStrip('main', '/other'), null);
  });

  it('drops duplicates and an active id that is not in the strip', () => {
    const model = createTabModel();
    model.commit('main', { scope: '/clad', tabs: [tab('a'), tab('a'), tab('b')], activeId: 'zz' });
    const strip = model.readStrip('main', '/clad');
    assert.deepEqual(strip.tabs.map((t) => t.id), ['a', 'b']);
    assert.equal(strip.activeId, 'a');
  });

  it('caps a strip, least recently used out', () => {
    const model = createTabModel();
    const tabs = Array.from({ length: MAX_TABS_PER_STRIP + 5 }, (_, i) => tab(`t${i}`, { lastUsedAt: i + 1 }));
    model.commit('main', { scope: '/clad', tabs });
    const strip = model.readStrip('main', '/clad');
    assert.equal(strip.tabs.length, MAX_TABS_PER_STRIP);
    assert.equal(strip.tabs[0].id, 't5');
  });

  it('refuses invalid window keys and scopes', () => {
    const model = createTabModel();
    assert.equal(model.commit('bad key', { scope: '/clad', tabs: [] }), null);
    assert.equal(model.commit('main', { scope: 42, tabs: [] }), null);
  });

  it('reports chrome.tabs-like events', () => {
    const events = [];
    const model = createTabModel({ onEvents: (key, list) => events.push(...list.map((e) => ({ key, ...e }))) });
    model.commit('main', { scope: '/clad', tabs: [tab('a'), tab('b')], activeId: 'a' });
    events.length = 0;
    model.commit('main', { scope: '/clad', tabs: [tab('b', { title: 'B' }), tab('a'), tab('c')], activeId: 'c' });
    assert.deepEqual(
      events.map((e) => e.type).sort(),
      ['activated', 'created', 'moved', 'moved', 'updated'].sort(),
    );
    assert.ok(events.every((e) => e.key === 'main' && e.scope === '/clad'));
  });
});

describe('tab model diff', () => {
  it('sees removals and no change', () => {
    const a = { tabs: [tab('a'), tab('b')], activeId: 'a' };
    assert.deepEqual(diffStrips(a, a), []);
    assert.deepEqual(diffStrips(a, { tabs: [tab('a')], activeId: 'a' }), [{ type: 'removed', tabId: 'b' }]);
  });
});

describe('tab model moves between windows', () => {
  it('moves the record, pushes both windows, keeps it durable', () => {
    const changes = [];
    const model = createTabModel({ onChange: (key, scope, strip, meta) => changes.push({ key, scope, meta, strip }) });
    model.commit('main', { scope: '/clad', tabs: [tab('a'), tab('b')], activeId: 'b' });
    changes.length = 0;
    assert.equal(model.moveTab({ tabId: 'b', fromKey: 'main', toKey: 'w-1', scope: '/clad' }), true);
    assert.deepEqual(model.readStrip('main', '/clad').tabs.map((t) => t.id), ['a']);
    assert.equal(model.readStrip('main', '/clad').activeId, 'a');
    assert.deepEqual(model.readStrip('w-1', '/clad').tabs.map((t) => t.id), ['b']);
    assert.equal(model.readStrip('w-1', '/clad').activeId, 'b');
    assert.deepEqual(changes.map((c) => [c.key, c.meta.origin]), [['main', 'main'], ['w-1', 'main']]);
  });

  it('uses the descriptor when the source never committed the tab', () => {
    const model = createTabModel();
    assert.equal(model.moveTab({ tabId: 'x', fromKey: 'main', toKey: 'w-1', scope: '/clad', tab: tab('x') }), true);
    assert.deepEqual(model.readStrip('w-1', '/clad').tabs.map((t) => t.id), ['x']);
  });
});

describe('tab session', () => {
  it('restores detached windows with their tabs, never the main one, and forgets closed ones', () => {
    const model = createTabModel();
    model.commit('main', { scope: '/clad', tabs: [tab('a')] });
    model.commit('w-1', { scope: '/clad', tabs: [tab('b'), tab('c', { kind: 'external', href: 'https://x.test/' })], activeId: 'c', locationHref: '/clad/new-tab' });
    model.commit('w-2', { scope: '/clad', tabs: [tab('d')], activeId: 'd' });
    model.commit('w-3', { scope: '/clad', tabs: [] });
    model.setBounds('w-1', { x: 10, y: 20, width: 900, height: 700 });
    model.forgetWindow('w-2');
    model.forgetWindow('main');

    const restored = createTabModel();
    restored.load(JSON.parse(JSON.stringify(model.serialize())));
    assert.deepEqual(restored.windowsToRestore(), [
      { key: 'w-1', bounds: { x: 10, y: 20, width: 900, height: 700 }, startHref: '/clad/new-tab' },
    ]);
    assert.deepEqual(restored.readStrip('main', '/clad').tabs.map((t) => t.id), ['a']);
    assert.deepEqual(restored.readStrip('w-1', '/clad').tabs.map((t) => t.id), ['b', 'c']);
    assert.equal(restored.readWindow('w-1').lastScope, '/clad');
  });

  it('ignores a corrupt or foreign session', () => {
    const model = createTabModel();
    model.load({ version: 99, windows: [{ key: 'w-1' }] });
    model.load('nope');
    model.load({ version: 1, windows: [{ key: '../x', strips: {} }, { key: 'w-2', strips: { '/a': { tabs: 'x' } } }] });
    assert.equal(model.readWindow('../x'), null);
    assert.deepEqual(model.readStrip('w-2', '/a').tabs, []);
  });

  it('writes atomically and reads back', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-session-'));
    const store = createTabSessionStore({ dir });
    assert.equal(store.read(), null);
    store.bind(() => ({ version: 1, windows: [] }));
    store.flush();
    assert.deepEqual(store.read(), { version: 1, windows: [] });
    assert.deepEqual(fs.readdirSync(dir), ['tab-session.json']);
    fs.writeFileSync(store.file, '{broken');
    assert.equal(store.read(), null);
  });
});
