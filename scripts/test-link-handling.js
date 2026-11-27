'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSettings, createSettingsStore, extractPortalTarget } = require('../src/link-handling');
const { DEFAULT_SHORTCUTS } = require('../src/background-mode');
const BASE = { keepInBackground: true, backgroundHintShown: false, downloadsDirectory: null, downloadsAskWhere: false, safeBrowsingEnabled: true, shortcuts: { ...DEFAULT_SHORTCUTS } };

const isPortal = (u) => new URL(u).hostname === 'app.lascoapp.com';

describe('link handling', () => {
  it('extracts targets from lasco:// links', () => {
    assert.equal(extractPortalTarget('lasco://open?target=%2Fa%2Fb%3Fx%3D1', isPortal), '/a/b?x=1');
    assert.equal(extractPortalTarget('lasco://open?target=evil', isPortal), null);
    assert.equal(extractPortalTarget('lasco://open?target=%2F%2Fevil.com', isPortal), null);
    assert.equal(extractPortalTarget('lasco://open', isPortal), null);
  });

  it('extracts paths from portal https links only', () => {
    assert.equal(extractPortalTarget('https://app.lascoapp.com/s/w?x=1#h', isPortal), '/s/w?x=1#h');
    assert.equal(extractPortalTarget('https://example.com/s', isPortal), null);
    assert.equal(extractPortalTarget('javascript:alert(1)', isPortal), null);
    assert.equal(extractPortalTarget('not a url', isPortal), null);
  });

  it('normalizes settings with defaults', () => {
    assert.deepEqual(normalizeSettings(null), { openLinksInApp: true, themeSource: 'system', ...BASE });
    assert.deepEqual(normalizeSettings({ openLinksInApp: 'no', x: 1 }), { openLinksInApp: true, themeSource: 'system', ...BASE });
    assert.deepEqual(normalizeSettings({ openLinksInApp: false }), { openLinksInApp: false, themeSource: 'system', ...BASE });
    assert.deepEqual(normalizeSettings({ themeSource: 'dark' }), { openLinksInApp: true, themeSource: 'dark', ...BASE });
    assert.deepEqual(normalizeSettings({ themeSource: 'sepia' }), { openLinksInApp: true, themeSource: 'system', ...BASE });
    // Téléchargements : chemin absolu seulement, booléen pour « Enregistrer sous ».
    assert.equal(normalizeSettings({ downloadsDirectory: '/Users/me/Dl' }).downloadsDirectory, '/Users/me/Dl');
    assert.equal(normalizeSettings({ downloadsDirectory: 'relative/dir' }).downloadsDirectory, null);
    assert.equal(normalizeSettings({ downloadsAskWhere: true }).downloadsAskWhere, true);
    assert.equal(normalizeSettings({ downloadsAskWhere: 'yes' }).downloadsAskWhere, false);
    // Protection contre les sites dangereux : activée par défaut.
    assert.equal(normalizeSettings({ safeBrowsingEnabled: false }).safeBrowsingEnabled, false);
    assert.equal(normalizeSettings({ safeBrowsingEnabled: 'no' }).safeBrowsingEnabled, true);
  });

  it('persists settings through the store', () => {
    const files = new Map();
    const fsImpl = {
      readFileSync: (p) => {
        if (!files.has(p)) throw new Error('ENOENT');
        return files.get(p);
      },
      writeFileSync: (p, c) => files.set(p, c),
      mkdirSync: () => {},
    };
    const store = createSettingsStore('/tmp/s.json', fsImpl);
    assert.equal(store.get().openLinksInApp, true);
    assert.equal(store.set({ openLinksInApp: false }).openLinksInApp, false);
    assert.equal(createSettingsStore('/tmp/s.json', fsImpl).get().openLinksInApp, false);
  });
});
