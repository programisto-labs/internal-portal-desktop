'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createPasswordController, passwordHostOf } = require('../src/browser-tabs/passwords');
const { createPasswordPopover, popoverBounds } = require('../src/browser-tabs/password-popover');

describe('browser password manager (main process)', () => {
  let events;
  let sent;
  let menus;
  let hidden;
  let keys;
  let focused;
  let timers;
  let urls;
  let controller;

  beforeEach(() => {
    events = [];
    sent = [];
    menus = [];
    hidden = 0;
    keys = [];
    focused = false;
    timers = [];
    urls = new Map([['t1', 'https://www.linkedin.com/login']]);
    controller = createPasswordController({
      emit: (channel, payload) => events.push({ channel, payload }),
      getTabUrl: (tabId) => urls.get(tabId) || '',
      sendToTab: (tabId, channel, payload) => {
        if (!urls.has(tabId)) return false;
        sent.push({ tabId, channel, payload });
        return true;
      },
      popover: {
        show: (tabId, rect, model, onChoose) => menus.push({ tabId, rect, model, onChoose }),
        hide: () => {
          hidden += 1;
        },
        key: (name) => keys.push(name),
        isFocused: () => focused,
      },
      setTimer: (fn) => {
        timers.push(fn);
        return timers.length;
      },
      clearTimer: () => undefined,
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

  it('opens the popover only for the same host, on focus only with Vault credentials', () => {
    controller.setEnabled({ enabled: true });
    const rect = { x: 10, y: 20, width: 200, height: 30 };
    controller.onMessage('t1', 'https://linkedin.com/login', 'lasco-pw:field', { kind: 'password', trigger: 'focus', rect });
    assert.equal(menus.length, 0);
    // No credential for the site: nothing on focus, the popover on a click (another Vault credential).
    controller.setSuggestions({ tabId: 't1', host: 'linkedin.com', items: [], labels: { other: 'Choose…' } });
    controller.onMessage('t1', 'https://linkedin.com/login', 'lasco-pw:field', { kind: 'password', trigger: 'focus', rect });
    assert.equal(menus.length, 0);
    controller.onMessage('t1', 'https://linkedin.com/login', 'lasco-pw:field', { kind: 'password', trigger: 'click', rect });
    assert.equal(menus.length, 1);
    assert.equal(menus[0].model.labels.other, 'Choose…');
    assert.equal(menus[0].model.labels.manage, 'Gérer les mots de passe');

    controller.setSuggestions({ tabId: 't1', host: 'linkedin.com', items: [{ id: 's1', username: 'a@x.fr', label: 'a@x.fr' }] });
    controller.onMessage('t1', 'https://evil.com/login', 'lasco-pw:field', { kind: 'password', trigger: 'focus', rect });
    assert.equal(menus.length, 1);
    controller.onMessage('t1', 'https://linkedin.com/login', 'lasco-pw:field', { kind: 'password', trigger: 'focus', rect });
    assert.equal(menus.length, 2);
    assert.deepEqual(menus[1].rect, rect);
    assert.ok(sent.some((m) => m.channel === 'lasco-pw:popover' && m.payload.open === true));
    menus[1].onChoose({ type: 'fill', id: 'unknown' });
    menus[1].onChoose({ type: 'fill', id: 's1' });
    menus[1].onChoose({ type: 'manage' });
    assert.deepEqual(events.map((e) => [e.channel, e.payload.secretId || e.payload.action]), [
      ['browser-tab-password-fill-request', 's1'],
      ['browser-tab-password-action', 'manage'],
    ]);
  });

  it('forwards keys while open and closes on escape, typing, or a blur outside the popover', () => {
    controller.setEnabled({ enabled: true });
    controller.setSuggestions({ tabId: 't1', host: 'linkedin.com', items: [{ id: 's1', username: 'a' }] });
    const field = { kind: 'username', trigger: 'focus', rect: { x: 0, y: 0, width: 100, height: 20 } };
    controller.onMessage('t1', 'https://linkedin.com/login', 'lasco-pw:field', field);
    controller.onMessage('t1', 'https://linkedin.com/login', 'lasco-pw:key', { key: 'ArrowDown' });
    controller.onMessage('t1', 'https://linkedin.com/login', 'lasco-pw:key', { key: 'a' });
    assert.deepEqual(keys, ['ArrowDown']);
    controller.onMessage('t1', 'https://linkedin.com/login', 'lasco-pw:key', { key: 'Escape' });
    assert.equal(controller.popoverTabId(), null);

    controller.onMessage('t1', 'https://linkedin.com/login', 'lasco-pw:field', field);
    controller.onMessage('t1', 'https://linkedin.com/login', 'lasco-pw:field-leave', { reason: 'input' });
    assert.equal(controller.popoverTabId(), null);

    // Blur while the person clicks in the popover: kept open.
    controller.onMessage('t1', 'https://linkedin.com/login', 'lasco-pw:field', field);
    focused = true;
    controller.onMessage('t1', 'https://linkedin.com/login', 'lasco-pw:field-leave', { reason: 'blur' });
    timers.pop()();
    assert.equal(controller.popoverTabId(), 't1');
    focused = false;
    controller.onMessage('t1', 'https://linkedin.com/login', 'lasco-pw:field-leave', { reason: 'blur' });
    timers.pop()();
    assert.equal(controller.popoverTabId(), null);

    controller.onMessage('t1', 'https://linkedin.com/login', 'lasco-pw:field', field);
    controller.onNavigate('t1', 'https://linkedin.com/feed');
    assert.equal(controller.popoverTabId(), null);
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

describe('password autofill popover', () => {
  const view = { x: 0, y: 100, width: 1000, height: 600 };

  it('sits under the field, above it without room, inside the tab view', () => {
    assert.deepEqual(popoverBounds({ x: 100, y: 50, width: 300, height: 40 }, { view, height: 200 }), {
      x: 100,
      y: 196,
      width: 300,
      height: 200,
    });
    // Narrow field: minimum width; zoom applied.
    const zoomed = popoverBounds({ x: 100, y: 50, width: 100, height: 40 }, { view, zoom: 2, height: 200 });
    assert.equal(zoomed.width, 280);
    assert.equal(zoomed.x, 200);
    // Field near the bottom: above it.
    const above = popoverBounds({ x: 100, y: 550, width: 300, height: 40 }, { view, height: 200 });
    assert.equal(above.y, 100 + 550 - 6 - 200);
    // Field near the right edge: kept inside.
    const right = popoverBounds({ x: 950, y: 50, width: 300, height: 40 }, { view, height: 200 });
    assert.equal(right.x + right.width, 992);
    // Scrolled out of the view.
    assert.equal(popoverBounds({ x: 0, y: -200, width: 300, height: 40 }, { view, height: 200 }), null);
  });

  it('ignores choices until armed and maps them to the model', () => {
    const sentToView = [];
    const timers = [];
    const focus = [];
    const popover = createPasswordPopover({
      createView: () => ({
        load: () => undefined,
        send: (channel, payload) => sentToView.push([channel, payload]),
        setBounds: () => undefined,
        setVisible: () => undefined,
        raise: () => undefined,
        isFocused: () => false,
        isSender: (id) => id === 7,
        destroy: () => undefined,
      }),
      anchorOf: () => ({ view, zoom: 1 }),
      isDark: () => true,
      focusTab: (tabId) => focus.push(['tab', tabId]),
      focusPortal: () => focus.push(['portal']),
      setTimer: (fn) => {
        timers.push(fn);
        return timers.length;
      },
      clearTimer: () => undefined,
    });
    const choices = [];
    const model = {
      host: 'linkedin.com',
      items: [{ id: 's1', username: 'a@x.fr', label: 'Perso' }],
      labels: { title: 'Coffre', empty: 'Rien', other: 'Autre', manage: 'Gérer' },
    };
    popover.show('t1', { x: 0, y: 0, width: 200, height: 30 }, model, (choice) => choices.push(choice));
    const render = sentToView.find(([channel]) => channel === 'lasco-pw-popover:render')[1];
    assert.deepEqual(render.items, [{ label: 'Perso', sub: 'a@x.fr', icon: 'key' }]);
    assert.equal(render.dark, true);
    popover.onMessage({ type: 'choose', action: 'item', index: 0 });
    assert.equal(choices.length, 0);
    popover.key('Enter');
    assert.equal(sentToView.some(([channel]) => channel === 'lasco-pw-popover:key'), false);
    timers.pop()();
    popover.onMessage({ type: 'choose', action: 'item', index: 3 });
    popover.onMessage({ type: 'choose', action: 'item', index: 0 });
    assert.deepEqual(choices, [{ type: 'fill', id: 's1' }]);
    assert.deepEqual(focus, [['tab', 't1']]);
    assert.equal(popover.isSender(7), true);
    assert.equal(popover.isSender(8), false);
  });
});
