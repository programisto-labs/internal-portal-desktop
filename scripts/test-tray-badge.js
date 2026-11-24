'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { trayBadgeText, drawTrayBadge } = require('../src/tray/tray-badge');
const { buildTrayView, normalizePortalTrayState, trayBadgeCount } = require('../src/tray/tray-state');

const pixel = (buf, w, x, y) => Array.from(buf.subarray((y * w + x) * 4, (y * w + x) * 4 + 4));

describe('tray badge (Windows / Linux)', () => {
  it('fits the text to the image size', () => {
    assert.equal(trayBadgeText(0, 1), '');
    assert.equal(trayBadgeText(3, 1), '3');
    assert.equal(trayBadgeText(12, 1), '+');
    assert.equal(trayBadgeText(12, 2), '12');
    assert.equal(trayBadgeText(240, 2), '+');
  });

  it('draws a red pill top right, white digits, nothing elsewhere', () => {
    const w = 16;
    const buf = Buffer.alloc(w * w * 4);
    drawTrayBadge(buf, { width: w, height: w, text: '7', scale: 1 });
    assert.deepEqual(pixel(buf, w, 0, 15), [0, 0, 0, 0]);
    const opaque = [];
    for (let y = 0; y < w; y += 1) for (let x = 0; x < w; x += 1) if (pixel(buf, w, x, y)[3]) opaque.push([x, y]);
    assert.ok(opaque.length > 0);
    assert.ok(opaque.every(([x, y]) => x >= 5 && y <= 11), 'pill stays in the top-right corner');
    assert.ok(opaque.some(([x, y]) => pixel(buf, w, x, y)[0] === 229), 'red background');
  });

  it('writes BGRA when asked', () => {
    const w = 16;
    const rgba = drawTrayBadge(Buffer.alloc(w * w * 4), { width: w, height: w, text: '1' });
    const bgra = drawTrayBadge(Buffer.alloc(w * w * 4), { width: w, height: w, text: '1', order: 'bgra' });
    for (let i = 0; i < rgba.length; i += 4) {
      assert.equal(bgra[i], rgba[i + 2]);
      assert.equal(bgra[i + 2], rgba[i]);
    }
  });

  it('counts pending items and unread replies', () => {
    const portal = normalizePortalTrayState({
      approvals: [{ conversationId: '64b000000000000000000001', callId: 'c1', toolName: 'x' }],
      unreadTotal: 4,
    });
    const view = buildTrayView({ portal, hostConfirms: [{ id: 'h1' }] });
    assert.equal(trayBadgeCount(view), view.hostConfirms.length + view.approvals.length + 4);
    assert.equal(trayBadgeCount(buildTrayView({ portal: null })), 0);
  });
});
