'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { badgeLabel, normalizeBadgeCount, renderBadgePng } = require('../src/badge-overlay');
const { applyBadgeCount, showAgentNotification } = require('../src/agent-notifications');

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
});
