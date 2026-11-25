'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  sanitizeTabDescriptor,
  encodeTabWindowArg,
  decodeTabWindowArg,
  findWindowAtPoint,
  buildDetachedWindowBounds,
  buildNewWindowBounds,
  createAdoptQueue,
  isPortalPath,
  resolveTabDropTarget,
  followPosition,
  isSpareWindowUsable,
} = require('../src/tab-windows');
const { sanitizeBrowserUrl } = require('../src/browser-tabs/url');
const { resolveWindowMenuActions, buildTabMenuTemplate } = require('../src/browser-tabs/tab-menu');

const deps = { sanitizeBrowserUrl };

describe('tab descriptor', () => {
  it('keeps a portal tab on its own path', () => {
    const tab = sanitizeTabDescriptor(
      { id: 'tab-1', kind: 'internal', href: '/clad/profile', title: ' Mon profil ', locationHref: '/evil' },
      deps,
    );
    assert.deepEqual(tab, {
      id: 'tab-1',
      kind: 'internal',
      href: '/clad/profile',
      locationHref: '/clad/profile',
      title: 'Mon profil',
      favicon: null,
      blank: false,
    });
  });

  it('keeps a web tab on its URL and the shell on /new-tab', () => {
    const tab = sanitizeTabDescriptor(
      { id: 't2', kind: 'external', href: 'https://example.com/a', locationHref: '/clad/new-tab', favicon: 'https://example.com/f.ico' },
      deps,
    );
    assert.equal(tab.href, 'https://example.com/a');
    assert.equal(tab.locationHref, '/clad/new-tab');
    assert.equal(tab.favicon, 'https://example.com/f.ico');
  });

  it('rejects unsafe paths, URLs and ids', () => {
    for (const href of ['//evil.com/x', 'https://evil.com', '/a\\\\b', '', 'javascript:alert(1)']) {
      assert.equal(sanitizeTabDescriptor({ id: 't', kind: 'internal', href }, deps), null, href);
    }
    assert.equal(sanitizeTabDescriptor({ id: 't', kind: 'external', href: 'file:///etc/passwd', locationHref: '/x/new-tab' }, deps), null);
    assert.equal(sanitizeTabDescriptor({ id: 't', kind: 'external', href: 'https://a.com', locationHref: '//x' }, deps), null);
    assert.equal(sanitizeTabDescriptor({ id: 'a b', kind: 'internal', href: '/x' }, deps), null);
    assert.equal(sanitizeTabDescriptor({ id: 't', kind: 'internal', href: '/x', favicon: 'data:image/png;base64,AA' }, deps).favicon, null);
    assert.equal(isPortalPath('/ok?x=1#y'), true);
  });
});

describe('window argument', () => {
  it('round-trips role and initial tab (UTF-8 titles included)', () => {
    const arg = encodeTabWindowArg({ role: 'detached', initialTab: { id: 't', title: 'Pédagogie — été' } });
    assert.deepEqual(decodeTabWindowArg(['x', arg]), { role: 'detached', initialTab: { id: 't', title: 'Pédagogie — été' } });
    assert.deepEqual(decodeTabWindowArg([encodeTabWindowArg({ role: 'bogus' })]), { role: 'main', initialTab: null });
    assert.equal(decodeTabWindowArg(['--lasco-tab-window=%%%']), null);
    assert.equal(decodeTabWindowArg([]), null);
  });
});

describe('window under a dropped tab', () => {
  const windows = [
    { id: 1, bounds: { x: 0, y: 0, width: 1000, height: 800 } },
    { id: 2, bounds: { x: 500, y: 100, width: 800, height: 600 } },
    { id: 3, bounds: { x: 2000, y: 0, width: 800, height: 600 }, minimized: true },
  ];
  it('skips the source window and minimized windows', () => {
    assert.equal(findWindowAtPoint(windows, { x: 600, y: 200 }, 1).id, 2);
    assert.equal(findWindowAtPoint(windows, { x: 600, y: 200 }, 2).id, 1);
    assert.equal(findWindowAtPoint(windows, { x: 2100, y: 10 }, 1), null);
    assert.equal(findWindowAtPoint(windows, { x: 5000, y: 5000 }, 1), null);
    assert.equal(findWindowAtPoint(windows, null, 1), null);
  });
});

describe('detached window bounds', () => {
  const workArea = { x: 0, y: 25, width: 1440, height: 875 };
  it('puts the tab strip under the pointer, inside the work area', () => {
    const b = buildDetachedWindowBounds({ point: { x: 700, y: 400 }, size: { width: 1200, height: 800 }, workArea });
    assert.equal(b.width, 1200);
    assert.equal(b.y, 100);
    assert.ok(b.x >= 0 && b.x + b.width <= 1440);
    const corner = buildDetachedWindowBounds({ point: { x: 1430, y: 890 }, size: { width: 1200, height: 800 }, workArea });
    assert.equal(corner.x, 240);
    assert.equal(corner.y, 100);
  });
  it('centres the window without a pointer and respects the minimum size', () => {
    const b = buildDetachedWindowBounds({ point: null, size: { width: 300, height: 200 }, workArea });
    assert.deepEqual(b, { width: 800, height: 500, x: 320, y: 213 });
  });
});

describe('adopt queue', () => {
  it('holds tabs until the page is ready, then sends them right away', () => {
    const sent = [];
    const q = createAdoptQueue({ send: (id, tab) => sent.push([id, tab.id]) });
    q.deliver(7, { id: 'a' });
    assert.equal(q.pendingCount(7), 1);
    assert.deepEqual(q.ready(7).map((t) => t.id), ['a']);
    q.deliver(7, { id: 'b' });
    assert.deepEqual(sent, [[7, 'b']]);
    q.reset(7);
    q.deliver(7, { id: 'c' });
    assert.deepEqual(sent, [[7, 'b']]);
    assert.deepEqual(q.ready(7).map((t) => t.id), ['c']);
    q.forget(7);
    assert.equal(q.pendingCount(7), 0);
  });
});

describe('window actions in the tab menu', () => {
  it('are hidden from pages that do not handle them', () => {
    assert.ok(!resolveWindowMenuActions({ windowActions: false, role: 'main', tabCount: 3 }).includes('detach'));
  });
  it('main window: detach only with another tab left', () => {
    assert.ok(!resolveWindowMenuActions({ windowActions: true, role: 'main', tabCount: 1 }).includes('detach'));
    const actions = resolveWindowMenuActions({ windowActions: true, role: 'main', tabCount: 2 });
    assert.deepEqual(actions, ['reload', 'duplicate', 'detach', 'close', 'close-others', 'close-right']);
  });
  it('detached window: attach, and detach with several tabs', () => {
    assert.deepEqual(
      resolveWindowMenuActions({ windowActions: true, role: 'detached', tabCount: 1 }).filter((a) => a === 'attach' || a === 'detach'),
      ['attach'],
    );
    assert.deepEqual(
      resolveWindowMenuActions({ windowActions: true, role: 'detached', tabCount: 2 }).filter((a) => a === 'attach' || a === 'detach'),
      ['attach', 'detach'],
    );
  });
  it('separates page, window and close groups', () => {
    const t = buildTabMenuTemplate({
      tabId: 't',
      tabCount: 2,
      actions: resolveWindowMenuActions({ windowActions: true, role: 'detached', tabCount: 2 }),
    });
    assert.deepEqual(
      t.map((i) => (i.type === 'separator' ? '---' : i.label)),
      [
        'Actualiser',
        'Dupliquer',
        '---',
        'Rattacher à la fenêtre principale',
        'Détacher dans une nouvelle fenêtre',
        '---',
        "Fermer l'onglet",
        'Fermer les autres onglets',
        'Fermer les onglets à droite',
      ],
    );
  });
});

describe('live drag out', () => {
  const windows = [
    { id: 9, bounds: { x: 600, y: 300, width: 1000, height: 700 } }, // floating window under the cursor
    { id: 1, bounds: { x: 0, y: 0, width: 1000, height: 800 } }, // source
    { id: 2, bounds: { x: 1100, y: 0, width: 800, height: 600 } },
  ];
  it('never targets the window that follows the cursor', () => {
    assert.deepEqual(resolveTabDropTarget({ windows, point: { x: 1200, y: 400 }, sourceId: 1, floatingId: 9 }), { kind: 'window', id: 2 });
    assert.deepEqual(resolveTabDropTarget({ windows, point: { x: 700, y: 400 }, sourceId: 1, floatingId: 9 }), { kind: 'source' });
    assert.deepEqual(resolveTabDropTarget({ windows, point: { x: 1500, y: 900 }, sourceId: 1, floatingId: 9 }), { kind: 'none' });
  });
  it('keeps the grabbed point under the cursor', () => {
    assert.deepEqual(followPosition({ x: 500, y: 300 }, { x: 150, y: 22 }), { x: 350, y: 278 });
  });
});

describe('spare window', () => {
  const origin = 'https://app.lascoapp.com';
  it('is usable while it still sits on its new-tab page', () => {
    assert.equal(isSpareWindowUsable({ url: `${origin}/clad/new-tab`, href: '/clad/new-tab', origin }), true);
    assert.equal(isSpareWindowUsable({ url: `${origin}/clad/new-tab?x=1#a`, href: '/clad/new-tab', origin }), true);
  });
  it('is dropped once it left that page (login, error page, other workspace)', () => {
    assert.equal(isSpareWindowUsable({ url: `${origin}/login`, href: '/clad/new-tab', origin }), false);
    assert.equal(isSpareWindowUsable({ url: 'file:///app/error.html', href: '/clad/new-tab', origin }), false);
    assert.equal(isSpareWindowUsable({ url: `${origin}/other/new-tab`, href: '/clad/new-tab', origin }), false);
    assert.equal(isSpareWindowUsable({ url: '', href: '/clad/new-tab', origin }), false);
    assert.equal(isSpareWindowUsable({ url: `${origin}/clad/new-tab`, href: '//evil/new-tab', origin }), false);
  });
});

describe('buildNewWindowBounds (⌘N)', () => {
  const workArea = { x: 0, y: 25, width: 1920, height: 1055 };
  it('cascades from the source window, same size', () => {
    assert.deepEqual(buildNewWindowBounds({ sourceBounds: { x: 100, y: 80, width: 1280, height: 800 }, workArea }), {
      x: 128,
      y: 108,
      width: 1280,
      height: 800,
    });
  });
  it('wraps back to the work area corner when the shift would leave it', () => {
    const b = buildNewWindowBounds({ sourceBounds: { x: 700, y: 300, width: 1280, height: 800 }, workArea });
    assert.equal(b.x, 0);
    assert.equal(b.y, 25);
  });
  it('centres without a source window', () => {
    const b = buildNewWindowBounds({ sourceBounds: null, workArea });
    assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y));
  });
});
