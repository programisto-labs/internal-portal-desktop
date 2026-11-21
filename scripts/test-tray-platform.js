'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  trayIconFiles,
  supportsTrayTitle,
  usesAttachedMenu,
  trayPlaceLabel,
  computePopoverBounds,
  buildTrayMenuItems,
} = require('../src/tray/tray-platform');
const { buildTrayView, normalizePortalTrayState, resolveTrayAction } = require('../src/tray/tray-state');

const W = 360;
const H = 320;

describe('tray per platform', () => {
  it('uses template icons on macOS, color icons elsewhere', () => {
    assert.deepEqual(trayIconFiles('darwin'), { plain: 'trayTemplate.png', dot: 'trayDotTemplate.png', template: true });
    assert.deepEqual(trayIconFiles('win32'), { plain: 'tray.png', dot: 'trayDot.png', template: false });
    assert.equal(trayIconFiles('linux').template, false);
  });

  it('knows title, attached menu and place names', () => {
    assert.equal(supportsTrayTitle('darwin'), true);
    assert.equal(supportsTrayTitle('win32'), false);
    assert.equal(usesAttachedMenu('linux'), true);
    assert.equal(usesAttachedMenu('win32'), false);
    assert.equal(trayPlaceLabel('win32'), 'la zone de notification');
    assert.equal(trayPlaceLabel('linux'), 'la barre système');
  });
});

describe('popover position', () => {
  it('opens under the icon with a top bar (macOS)', () => {
    const b = computePopoverBounds({
      trayBounds: { x: 1200, y: 0, width: 24, height: 24 },
      display: { bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 25, width: 1440, height: 875 } },
      width: W,
      height: H,
    });
    assert.deepEqual(b, { x: 1032, y: 28, width: W, height: H });
  });

  it('opens above the icon with a bottom taskbar (Windows), kept on screen', () => {
    const b = computePopoverBounds({
      trayBounds: { x: 1840, y: 1050, width: 24, height: 30 },
      display: { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
      width: W,
      height: H,
    });
    assert.deepEqual(b, { x: 1552, y: 712, width: W, height: H });
  });

  it('opens beside a taskbar on the left', () => {
    const b = computePopoverBounds({
      trayBounds: { x: 10, y: 900, width: 24, height: 24 },
      display: { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 48, y: 0, width: 1872, height: 1080 } },
      width: W,
      height: H,
    });
    assert.equal(b.x, 56);
    assert.ok(b.y + b.height <= 1072);
  });

  it('falls back to the pointer when the icon has no position (Linux)', () => {
    const display = { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 32, width: 1920, height: 1048 } };
    const top = computePopoverBounds({ trayBounds: { x: 0, y: 0, width: 0, height: 0 }, display, cursor: { x: 1800, y: 10 }, width: W, height: H });
    assert.deepEqual(top, { x: 1552, y: 32, width: W, height: H });
    const bottom = computePopoverBounds({ trayBounds: null, display, cursor: { x: 100, y: 1070 }, width: W, height: H });
    assert.deepEqual(bottom, { x: 8, y: 746, width: W, height: H });
  });

  it('never gets taller than the screen', () => {
    const b = computePopoverBounds({
      trayBounds: { x: 100, y: 0, width: 20, height: 20 },
      display: { bounds: { x: 0, y: 0, width: 800, height: 400 }, workArea: { x: 0, y: 20, width: 800, height: 380 } },
      width: W,
      height: 640,
    });
    assert.equal(b.height, 364);
  });
});

describe('native tray menu', () => {
  const portal = normalizePortalTrayState({
    approvals: [{ conversationId: 'a'.repeat(24), callId: 'c1', label: 'Envoyer' }],
    unread: [],
    unreadTotal: 3,
    canAsk: true,
  });

  it('lists actions the popover would resolve', () => {
    const view = buildTrayView({ portal, hostOpsEnabled: true, askAccelerator: 'Alt+Shift+Space' });
    const items = buildTrayMenuItems(view, { askShortcut: view.askAccelerator });
    const labels = items.filter((i) => i.label).map((i) => i.label);
    assert.deepEqual(labels, [
      'Ouvrir Lasco',
      'Demander à Lasco…',
      '1 à valider',
      '3 non lus',
      'Suspendre les opérations sur cet ordinateur',
      'Réglages…',
      'Quitter Lasco',
    ]);
    assert.equal(items[1].accelerator, 'Alt+Shift+Space');
    for (const item of items.filter((i) => i.action)) assert.ok(resolveTrayAction(view, item.action), item.label);
  });

  it('hides « Demander à Lasco » without a connected portal', () => {
    const view = buildTrayView({ portal: null });
    const labels = buildTrayMenuItems(view).filter((i) => i.label).map((i) => i.label);
    assert.deepEqual(labels, ['Ouvrir Lasco', 'Réglages…', 'Quitter Lasco']);
  });

  it('keeps only a valid accelerator', () => {
    assert.equal(buildTrayView({ portal, askAccelerator: 'nope' }).askAccelerator, '');
  });
});
