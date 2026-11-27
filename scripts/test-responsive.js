'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeResponsiveSettings,
  responsiveLayout,
  deviceUserAgent,
  deviceMetrics,
  FRAME_PADDING,
} = require('../src/browser-tabs/responsive');

test('a known device imposes its screen, density and type', () => {
  const s = normalizeResponsiveSettings({ device: 'iphone-se', width: 9999, deviceScaleFactor: 1, mobile: false });
  assert.deepEqual(s, { device: 'iphone-se', width: 375, height: 667, deviceScaleFactor: 2, mobile: true, rotated: false, zoom: 'fit' });
});

test('rotating a device swaps width and height', () => {
  const s = normalizeResponsiveSettings({ device: 'iphone-se', rotated: true });
  assert.equal(s.width, 667);
  assert.equal(s.height, 375);
});

test('free size is clamped and density snaps to a known value', () => {
  const s = normalizeResponsiveSettings({ device: 'nope', width: 10, height: '99999', deviceScaleFactor: 2.4, mobile: 0, zoom: 0.8 });
  assert.equal(s.device, 'responsive');
  assert.equal(s.width, 50);
  assert.equal(s.height, 4000);
  assert.equal(s.deviceScaleFactor, 2.625);
  assert.equal(s.mobile, false);
  assert.equal(s.zoom, 0.75);
});

test('garbage input falls back to defaults', () => {
  const s = normalizeResponsiveSettings('<script>');
  assert.equal(s.device, 'responsive');
  assert.equal(s.width, 400);
  assert.equal(s.zoom, 'fit');
});

test('layout centres the device and never overflows the tab area', () => {
  const area = { x: 100, y: 80, width: 1000, height: 600 };
  const phone = responsiveLayout(area, normalizeResponsiveSettings({ device: 'iphone-se' }));
  assert.equal(phone.scale, 1 > (600 - FRAME_PADDING * 2) / 667 ? (600 - FRAME_PADDING * 2) / 667 : 1);
  assert.ok(phone.bounds.height <= area.height - FRAME_PADDING * 2 + 1);
  assert.equal(phone.bounds.x, Math.round(100 + (1000 - phone.bounds.width) / 2));

  const big = responsiveLayout(area, normalizeResponsiveSettings({ device: 'desktop-hd', zoom: 2 }));
  assert.ok(big.bounds.width <= area.width);
  assert.ok(big.bounds.x >= area.x && big.bounds.y >= area.y);
  assert.ok(big.scale < 1);
});

test('a smaller zoom than fit is kept', () => {
  const area = { x: 0, y: 0, width: 2000, height: 2000 };
  const r = responsiveLayout(area, normalizeResponsiveSettings({ device: 'iphone-se', zoom: 0.5 }));
  assert.equal(r.scale, 0.5);
  assert.equal(r.bounds.width, 188);
});

test('device identity: Safari for iPhone, Chrome mobile for Android, none for laptops', () => {
  assert.match(deviceUserAgent('iphone-15-pro').userAgent, /iPhone; CPU iPhone OS/);
  const android = deviceUserAgent('pixel-8', '152.0.1.2');
  assert.match(android.userAgent, /Android .*Chrome\/152\.0\.0\.0 Mobile/);
  assert.equal(android.userAgentMetadata.mobile, true);
  assert.equal(android.userAgentMetadata.platform, 'Android');
  assert.equal(deviceUserAgent('laptop'), null);
  assert.equal(deviceUserAgent('responsive'), null);
});

test('metrics carry orientation and scale', () => {
  const m = deviceMetrics(normalizeResponsiveSettings({ device: 'iphone-se', rotated: true }), 0.5);
  assert.equal(m.scale, 0.5);
  assert.equal(m.mobile, true);
  assert.equal(m.screenOrientation.type, 'landscapePrimary');
});

test('panel messages: only well-formed set / off are accepted', () => {
  const { parsePanelMessage, MESSAGE_PREFIX } = require('../src/browser-tabs/devtools-responsive');
  assert.deepEqual(parsePanelMessage(`${MESSAGE_PREFIX}{"op":"off"}`), { op: 'off' });
  assert.deepEqual(parsePanelMessage(`${MESSAGE_PREFIX}{"op":"set","settings":{"device":"pixel-8"}}`), {
    op: 'set',
    settings: { device: 'pixel-8' },
  });
  assert.equal(parsePanelMessage('{"op":"off"}'), null);
  assert.equal(parsePanelMessage(`${MESSAGE_PREFIX}{"op":"set"}`), null);
  assert.equal(parsePanelMessage(`${MESSAGE_PREFIX}{"op":"eval"}`), null);
  assert.equal(parsePanelMessage(`${MESSAGE_PREFIX}not json`), null);
  assert.equal(parsePanelMessage(`${MESSAGE_PREFIX}${'x'.repeat(3000)}`), null);
});

test('the panel and Desktop share one device catalog', () => {
  const catalog = require('../src/browser-tabs/devtools-extension/devices.json');
  const { DEVICES } = require('../src/browser-tabs/responsive');
  assert.deepEqual(DEVICES.map((d) => d.id), catalog.devices.map((d) => d.id));
  for (const d of catalog.devices) assert.ok(d.ua === null || ['iphone', 'ipad', 'android'].includes(d.ua));
});
