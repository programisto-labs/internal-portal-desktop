'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  planFullPageCapture,
  stitchBitmaps,
  captureFilename,
  captureSiteLabel,
  captureFullPage,
  capturePageImage,
} = require('../src/browser-tabs/page-capture');
const { createDownloadsStore } = require('../src/downloads/store');
const { createDownloadService } = require('../src/downloads/service');

describe('planFullPageCapture', () => {
  it('captures a short page in one tile, full scale', () => {
    const plan = planFullPageCapture({ contentWidth: 1280, contentHeight: 3000, deviceScaleFactor: 2 });
    assert.equal(plan.scale, 1);
    assert.equal(plan.truncated, false);
    assert.deepEqual(plan.tiles, [{ x: 0, y: 0, width: 1280, height: 3000 }]);
  });

  it('splits a long page under the GPU tile limit, without gaps', () => {
    const plan = planFullPageCapture({ contentWidth: 1280, contentHeight: 18000, deviceScaleFactor: 2 });
    assert.equal(plan.scale, 1);
    // 8192 device px / 2 = 4096 CSS px per tile.
    assert.equal(plan.tiles.length, 5);
    assert.ok(plan.tiles.every((t) => t.height * 2 <= 8192));
    let y = 0;
    for (const tile of plan.tiles) {
      assert.equal(tile.y, y);
      y += tile.height;
    }
    assert.equal(y, 18000);
  });

  it('scales down a huge page, then cuts it below the minimum scale', () => {
    const scaled = planFullPageCapture({ contentWidth: 1280, contentHeight: 60000, deviceScaleFactor: 2 });
    assert.ok(scaled.scale < 1 && scaled.scale >= 0.5);
    assert.equal(scaled.truncated, false);
    assert.ok(1280 * 60000 * 4 * scaled.scale ** 2 <= 100_000_001);

    const cut = planFullPageCapture({ contentWidth: 1280, contentHeight: 1_000_000, deviceScaleFactor: 2 });
    assert.equal(cut.scale, 0.5);
    assert.equal(cut.truncated, true);
    assert.ok(cut.height < 1_000_000);
    assert.ok(cut.width * cut.height * 4 * 0.25 <= 100_000_000);
  });

  it('bounds an endless horizontal overflow and uses the viewport width at least', () => {
    assert.equal(planFullPageCapture({ contentWidth: 50000, contentHeight: 100 }).width, 8192);
    assert.equal(planFullPageCapture({ contentWidth: 800, contentHeight: 100, viewportWidth: 1024 }).width, 1024);
  });
});

describe('stitchBitmaps', () => {
  const part = (width, height, fill) => ({ width, height, bitmap: Buffer.alloc(width * height * 4, fill) });

  it('stacks tiles top to bottom', () => {
    const out = stitchBitmaps([part(2, 1, 1), part(2, 2, 2)]);
    assert.equal(out.width, 2);
    assert.equal(out.height, 3);
    assert.deepEqual([...out.bitmap.subarray(0, 8)], Array(8).fill(1));
    assert.deepEqual([...out.bitmap.subarray(8)], Array(16).fill(2));
  });

  it('keeps the narrowest width when rounding differs', () => {
    const out = stitchBitmaps([part(3, 1, 1), part(2, 1, 2)]);
    assert.equal(out.width, 2);
    assert.equal(out.bitmap.length, 2 * 2 * 4);
    assert.deepEqual([...out.bitmap.subarray(0, 8)], Array(8).fill(1));
  });

  it('returns null without tiles', () => {
    assert.equal(stitchBitmaps([]), null);
  });
});

describe('captureFilename', () => {
  const date = new Date(2026, 10, 27, 9, 5, 3);
  it('names after the site and the date, without characters refused by the OS', () => {
    assert.equal(
      captureFilename({ url: 'https://www.lemonde.fr/article', date }),
      'Capture lemonde.fr 2026-11-27 09.05.03.png',
    );
  });
  it('falls back on the title, then on « page »', () => {
    assert.equal(captureSiteLabel({ url: 'about:blank', title: 'Contacts / CRM' }), 'Contacts - CRM');
    assert.equal(captureFilename({ title: 'Contacts / CRM', date }), 'Capture Contacts - CRM 2026-11-27 09.05.03.png');
    assert.ok(!/[/\\:]/.test(captureFilename({ title: 'Contacts / CRM: a', date })));
    assert.equal(captureFilename({ date }), 'Capture page 2026-11-27 09.05.03.png');
  });
});

/** Fake webContents with a debugger answering the DevTools commands. */
function fakeWebContents({ height = 10000, attached = false, failCapture = false } = {}) {
  const calls = [];
  const state = { attached, detached: 0 };
  const wc = {
    calls,
    state,
    debugger: {
      isAttached: () => state.attached,
      attach: () => {
        state.attached = true;
      },
      detach: () => {
        state.attached = false;
        state.detached += 1;
      },
      sendCommand: async (method, params) => {
        calls.push({ method, params });
        if (method === 'Page.getLayoutMetrics') {
          return { cssContentSize: { width: 1000, height }, cssLayoutViewport: { clientWidth: 1000 } };
        }
        if (method === 'Runtime.evaluate') return { result: { value: 1 } };
        if (method === 'Page.captureScreenshot') {
          if (failCapture) throw new Error('boom');
          return { data: Buffer.from(JSON.stringify(params.clip)).toString('base64') };
        }
        throw new Error(`unexpected ${method}`);
      },
    },
    capturePage: async () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 1000, height: 700 }),
      toPNG: () => Buffer.from('visible'),
    }),
  };
  return wc;
}

/** nativeImage whose "PNG" is the JSON clip of the tile. */
const fakeNativeImage = {
  createFromBuffer: (buf) => {
    const clip = JSON.parse(buf.toString());
    const width = clip.width;
    const height = clip.height;
    return { getSize: () => ({ width, height }), toBitmap: () => Buffer.alloc(width * height * 4, 7) };
  },
  createFromBitmap: (bitmap, size) => ({ toPNG: () => Buffer.from(`stitched:${size.width}x${size.height}`) }),
};

describe('captureFullPage', () => {
  it('captures beyond the viewport, in tiles, then detaches the debugger it attached', async () => {
    const wc = fakeWebContents({ height: 10000 });
    const result = await captureFullPage(wc, { nativeImage: fakeNativeImage, limits: { maxTileDevicePx: 4000 } });
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'full');
    assert.equal(result.width, 1000);
    assert.equal(result.height, 10000);
    assert.equal(result.png.toString(), 'stitched:1000x10000');
    const shots = wc.calls.filter((c) => c.method === 'Page.captureScreenshot');
    assert.equal(shots.length, 3);
    assert.ok(shots.every((c) => c.params.captureBeyondViewport === true && c.params.format === 'png'));
    assert.equal(wc.state.attached, false);
    assert.equal(wc.state.detached, 1);
  });

  it('leaves an already attached debugger in place', async () => {
    const wc = fakeWebContents({ height: 500, attached: true });
    const result = await captureFullPage(wc, { nativeImage: fakeNativeImage });
    assert.equal(result.ok, true);
    assert.equal(wc.state.attached, true);
    assert.equal(wc.state.detached, 0);
  });

  it('detaches even when the capture fails, and falls back on the visible part', async () => {
    const wc = fakeWebContents({ failCapture: true });
    const result = await capturePageImage(wc, { mode: 'full', nativeImage: fakeNativeImage });
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'visible');
    assert.equal(result.fallback, true);
    assert.equal(wc.state.attached, false);
  });
});

describe('download service saveFile', () => {
  it('writes next to the downloads without overwriting and lists it as finished', () => {
    const written = new Map();
    const events = [];
    const existing = new Set([path.join('/dl', 'Capture x.png')]);
    const service = createDownloadService({
      store: createDownloadsStore({}),
      getDirectory: () => '/dl',
      fileExists: (p) => existing.has(p) || written.has(p),
      openPath: () => {},
      showItemInFolder: () => {},
      openFolder: () => {},
      emit: (e) => events.push(e),
      getSession: () => null,
      writeFile: (p, data) => written.set(p, data),
      randomId: () => 'id-1',
    });
    const res = service.saveFile({ name: 'Capture x.png', data: Buffer.from('png'), mimeType: 'image/png' });
    assert.equal(res.ok, true);
    assert.equal(res.item.filename, 'Capture x (1).png');
    assert.equal(res.item.state, 'completed');
    assert.equal(res.item.exists, true);
    assert.ok(written.has(path.join('/dl', 'Capture x (1).png')));
    assert.equal(events[0].type, 'upsert');
    assert.equal(service.list().items[0].id, 'id-1');
  });
});
