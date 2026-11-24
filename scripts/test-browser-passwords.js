'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createPasswordController, passwordHostOf } = require('../src/browser-tabs/passwords');

describe('browser password manager (main process)', () => {
  let events;
  let sent;
  let menus;
  let urls;
  let controller;

  beforeEach(() => {
    events = [];
    sent = [];
    menus = [];
    urls = new Map([['t1', 'https://www.linkedin.com/login']]);
    controller = createPasswordController({
      emit: (channel, payload) => events.push({ channel, payload }),
      getTabUrl: (tabId) => urls.get(tabId) || '',
      sendToTab: (tabId, channel, payload) => {
        if (!urls.has(tabId)) return false;
        sent.push({ tabId, channel, payload });
        return true;
      },
      popupMenu: (tabId, point, items, onChoose) => menus.push({ tabId, point, items, onChoose }),
    });
  });

  it('only accepts https pages (and local development hosts)', () => {
    assert.equal(passwordHostOf('https://www.LinkedIn.com/x'), 'linkedin.com');
    assert.equal(passwordHostOf('http://example.com/login'), null);
    assert.equal(passwordHostOf('http://localhost:3001/login'), 'localhost');
    assert.equal(passwordHostOf('http://app.test/login'), 'app.test');
    assert.equal(passwordHostOf('file:///etc/passwd'), null);
    assert.equal(passwordHostOf('not a url'), null);
  });

  it('keeps nothing while the portal has not enabled the password manager', () => {
    controller.onMessage('t1', 'https://linkedin.com/login', 'lasco-pw:capture', { username: 'a', password: 'p' });
    assert.equal(events.length, 0);
  });

  it('announces a sign-in without the password and hands it over once', () => {
    controller.setEnabled({ enabled: true });
    controller.onMessage('t1', 'https://www.linkedin.com/login', 'lasco-pw:capture', { username: 'a@x.fr', password: 'secret' });
    assert.equal(events.length, 1);
    const { channel, payload } = events[0];
    assert.equal(channel, 'browser-tab-password-capture');
    assert.equal(payload.host, 'linkedin.com');
    assert.equal(payload.username, 'a@x.fr');
    assert.ok(!JSON.stringify(payload).includes('secret'));
    assert.deepEqual(controller.takeCapture({ tabId: 't1', captureId: 'other' }), { ok: false, error: 'expired' });
    const taken = controller.takeCapture({ tabId: 't1', captureId: payload.captureId });
    assert.equal(taken.password, 'secret');
    assert.deepEqual(controller.takeCapture({ tabId: 't1', captureId: payload.captureId }), { ok: false, error: 'expired' });
  });

  it('ignores plain http pages and pairs a two-step sign-in', () => {
    controller.setEnabled({ enabled: true });
    controller.onMessage('t1', 'http://example.com/login', 'lasco-pw:capture', { username: 'a', password: 'p' });
    assert.equal(events.length, 0);
    controller.onMessage('t1', 'https://accounts.google.com/signin', 'lasco-pw:username', { username: 'me@gmail.com' });
    controller.onMessage('t1', 'https://accounts.google.com/challenge', 'lasco-pw:capture', { username: '', password: 'pw' });
    assert.equal(events[0].payload.username, 'me@gmail.com');
  });

  it('shows the native menu only with Vault credentials for the same host', () => {
    controller.setEnabled({ enabled: true });
    const rect = { x: 10, y: 20, width: 200, height: 30 };
    controller.onMessage('t1', 'https://linkedin.com/login', 'lasco-pw:field', { kind: 'password', rect });
    assert.equal(menus.length, 0);
    controller.setSuggestions({ tabId: 't1', host: 'linkedin.com', items: [{ id: 's1', username: 'a@x.fr', label: 'a@x.fr' }] });
    controller.onMessage('t1', 'https://evil.com/login', 'lasco-pw:field', { kind: 'password', rect });
    assert.equal(menus.length, 0);
    controller.onMessage('t1', 'https://linkedin.com/login', 'lasco-pw:field', { kind: 'password', rect });
    assert.equal(menus.length, 1);
    assert.deepEqual(menus[0].point, { x: 10, y: 50 });
    menus[0].onChoose({ type: 'fill', id: 's1' });
    menus[0].onChoose({ type: 'manage' });
    assert.deepEqual(events.map((e) => [e.channel, e.payload.secretId || e.payload.action]), [
      ['browser-tab-password-fill-request', 's1'],
      ['browser-tab-password-action', 'manage'],
    ]);
  });

  it('fills only the host the tab shows and reports what was filled', async () => {
    controller.setEnabled({ enabled: true });
    assert.deepEqual(await controller.fill({ tabId: 't1', host: 'evil.com', username: 'a', password: 'p' }), {
      ok: false,
      error: 'host-mismatch',
    });
    const pending = controller.fill({ tabId: 't1', host: 'linkedin.com', username: 'a', password: 'p', submit: true });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].channel, 'lasco-pw:fill');
    assert.equal(sent[0].payload.submit, true);
    controller.onMessage('t1', 'https://linkedin.com/login', 'lasco-pw:fill-result', {
      requestId: sent[0].payload.requestId,
      username: true,
      password: true,
      submitted: true,
    });
    assert.deepEqual(await pending, { ok: true, username: true, password: true, submitted: true });

    urls.set('t1', 'http://example.com/');
    assert.deepEqual(await controller.fill({ tabId: 't1', host: 'example.com', password: 'p' }), {
      ok: false,
      error: 'unsupported-page',
    });
  });

  it('drops suggestions when the tab leaves the site and everything when disabled', () => {
    controller.setEnabled({ enabled: true });
    controller.setSuggestions({ tabId: 't1', host: 'linkedin.com', items: [{ id: 's1', username: 'a' }] });
    controller.onNavigate('t1', 'https://example.com/');
    controller.onMessage('t1', 'https://linkedin.com/login', 'lasco-pw:field', { kind: 'password', rect: { x: 0, y: 0, width: 1, height: 1 } });
    assert.equal(menus.length, 0);
    controller.onMessage('t1', 'https://linkedin.com/login', 'lasco-pw:capture', { username: 'a', password: 'p' });
    controller.setEnabled({ enabled: false });
    assert.deepEqual(controller.takeCapture({ tabId: 't1', captureId: events[0].payload.captureId }), { ok: false, error: 'expired' });
  });
});
