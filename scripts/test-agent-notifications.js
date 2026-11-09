'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { badgeLabel, normalizeBadgeCount, renderBadgePng } = require('../src/badge-overlay');
const {
  applyBadgeCount,
  showAgentNotification,
  closeDesktopNotification,
  notificationSettingsTarget,
  readNotificationPermission,
} = require('../src/agent-notifications');

const AGENT = '507f1f77bcf86cd799439011';
const CONV = '507f1f77bcf86cd799439012';

describe('badge Lasco', () => {
  it('normalise le compte et libellé 99+', () => {
    assert.equal(normalizeBadgeCount(-3), 0);
    assert.equal(normalizeBadgeCount(3.8), 3);
    assert.equal(badgeLabel(0), '');
    assert.equal(badgeLabel(99), '99');
    assert.equal(badgeLabel(140), '99+');
  });

  it('produit un PNG et pose le badge dock plus l’overlay Windows', () => {
    const png = renderBadgePng(12);
    assert.equal(png[0], 137);
    assert.equal(png.toString('ascii', 1, 4), 'PNG');
    const badges = [];
    const overlays = [];
    const result = applyBadgeCount({
      app: { setBadgeCount: (n) => badges.push(n) },
      platform: 'win32',
      getWindow: () => ({ setOverlayIcon: (image, description) => overlays.push({ image, description }) }),
      nativeImage: { createFromBuffer: (buffer) => ({ buffer }) },
      count: 12,
    });
    assert.equal(result.count, 12);
    assert.deepEqual(badges, [12]);
    assert.equal(overlays.length, 1);
    assert.match(overlays[0].description, /12/);
    const cleared = [];
    applyBadgeCount({
      app: { setBadgeCount: (n) => cleared.push(n) },
      platform: 'win32',
      getWindow: () => ({ setOverlayIcon: (image) => cleared.push(image) }),
      nativeImage: { createFromBuffer: (buffer) => buffer },
      count: 0,
    });
    assert.deepEqual(cleared, [0, null]);
  });

  it('sur macOS appelle setBadgeCount sans overlay', () => {
    let overlay = 0;
    const badges = [];
    applyBadgeCount({
      app: { setBadgeCount: (n) => badges.push(n) },
      platform: 'darwin',
      getWindow: () => ({ setOverlayIcon: () => { overlay += 1; } }),
      nativeImage: { createFromBuffer: () => ({}) },
      count: 17,
    });
    assert.deepEqual(badges, [17]);
    assert.equal(overlay, 0);
  });
});

describe('notification Lasco', () => {
  it('un clic focalise la fenêtre et ouvre la conversation', () => {
    const sent = [];
    const calls = [];
    const win = {
      isDestroyed: () => false,
      isMinimized: () => true,
      restore: () => calls.push('restore'),
      show: () => calls.push('show'),
      focus: () => calls.push('focus'),
      webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
    };
    let click = null;
    let shown = false;
    function Notification(options) {
      this.options = options;
      this.on = (event, handler) => {
        if (event === 'click') click = handler;
      };
      this.show = () => {
        shown = true;
      };
    }
    const result = showAgentNotification({
      Notification,
      getWindow: () => win,
      payload: { title: 'Lasco Designer', body: 'La maquette', agentId: AGENT, conversationId: CONV },
    });
    assert.equal(result.ok, true);
    assert.equal(shown, true);
    click();
    assert.deepEqual(calls, ['restore', 'show', 'focus']);
    assert.deepEqual(sent, [{ channel: 'lasco-notification-open', payload: { agentId: AGENT, conversationId: CONV } }]);
  });

  it('refuse un identifiant qui n’ouvre pas une conversation', () => {
    const result = showAgentNotification({
      Notification: function Notification() { this.on = () => {}; this.show = () => {}; },
      getWindow: () => ({}),
      payload: { title: 'x', body: 'y', agentId: '../admin', conversationId: CONV },
    });
    assert.equal(result.ok, false);
  });

  it('remplace la notification du même tag et coupe le son sur la mise à jour', () => {
    const open = new Map();
    const shown = [];
    function Notification(options) {
      this.options = options;
      this.closed = false;
      this.on = () => {};
      this.close = () => {
        this.closed = true;
      };
      this.show = () => {
        shown.push(options);
      };
    }
    const first = showAgentNotification({
      Notification,
      getWindow: () => ({ webContents: { send() {} }, isDestroyed: () => false }),
      openNotifications: open,
      payload: { title: 'Lasco Designer', body: '1', agentId: AGENT, conversationId: CONV, tag: 'agent:designer' },
    });
    const second = showAgentNotification({
      Notification,
      getWindow: () => ({ webContents: { send() {} }, isDestroyed: () => false }),
      openNotifications: open,
      payload: {
        title: 'Lasco Designer',
        body: '5 nouveaux messages',
        agentId: AGENT,
        conversationId: CONV,
        tag: 'agent:designer',
        silent: true,
      },
    });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(shown.length, 2);
    assert.equal(shown[0].silent, false);
    assert.equal(shown[1].silent, true);
    assert.equal(shown[0].sound, undefined);
    assert.equal(open.size, 1);
    const closed = closeDesktopNotification({ openNotifications: open, tag: 'agent:designer' });
    assert.equal(closed.ok, true);
    assert.equal(open.size, 0);
  });

  it('ouvre un chemin du portail et refuse une URL externe', () => {
    const sent = [];
    let click = null;
    function Notification() {
      this.on = (event, handler) => {
        if (event === 'click') click = handler;
      };
      this.show = () => {};
    }
    const ok = showAgentNotification({
      Notification,
      getWindow: () => ({
        isDestroyed: () => false,
        show() {},
        focus() {},
        webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
      }),
      payload: { title: 'Congé', body: 'Nouvelle mise à jour', actionUrl: '/clad/programisto/leaves/123', tag: 'leaves:1' },
    });
    assert.equal(ok.ok, true);
    click();
    assert.deepEqual(sent, [{
      channel: 'lasco-notification-open',
      payload: { actionUrl: '/clad/programisto/leaves/123', tag: 'leaves:1' },
    }]);
    const external = showAgentNotification({
      Notification,
      getWindow: () => ({}),
      payload: { title: 'Congé', body: 'x', actionUrl: 'https://evil.example/steal' },
    });
    assert.equal(external.ok, false);
    const protocolRelative = showAgentNotification({
      Notification,
      getWindow: () => ({}),
      payload: { title: 'Congé', body: 'x', actionUrl: '//evil.example/steal' },
    });
    assert.equal(protocolRelative.ok, false);
  });

  it('pointe les réglages macOS et Windows, et signale un refus OS', () => {
    assert.match(notificationSettingsTarget('darwin'), /Notifications/);
    assert.equal(notificationSettingsTarget('win32'), 'ms-settings:notifications');
    assert.equal(notificationSettingsTarget('linux'), null);
    assert.equal(readNotificationPermission({ Notification: { isSupported: () => true }, failed: false }), 'prompt');
    assert.equal(readNotificationPermission({ Notification: { isSupported: () => true }, failed: true }), 'denied');
    assert.equal(readNotificationPermission({ Notification: { isSupported: () => false }, failed: false }), 'unsupported');
  });
});
