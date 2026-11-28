'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PAGE_MEDIA_PROBE_SCRIPT,
  VIDEO_PIP_EXIT_SCRIPT,
  CALL_CONTROLS,
  DEFAULT_PIP_TEXTS,
  callControlScript,
  videoPipEnterScript,
  isInCall,
  autoPipKind,
  floatControlsState,
  normalizePipTexts,
  floatBounds,
} = require('../src/browser-tabs/picture-in-picture');
const { tabSleepBlocker } = require('../src/browser-tabs/tab-sleep');

test('les scripts de page sont du JavaScript valide', () => {
  for (const code of [PAGE_MEDIA_PROBE_SCRIPT, VIDEO_PIP_EXIT_SCRIPT, videoPipEnterScript(), videoPipEnterScript({ x: 10, y: 20 })]) {
    assert.doesNotThrow(() => new Function(code));
  }
  for (const control of CALL_CONTROLS) assert.doesNotThrow(() => new Function(callControlScript(control)));
  assert.equal(callControlScript('reload'), null);
});

test('le point du clic droit est un nombre, jamais du code', () => {
  const code = videoPipEnterScript({ x: '1);alert(1', y: 3 });
  assert.match(code, /const x = null, y = 3;/);
});

test('appel : micro ou caméra accordés ET flux vivant lu par la page', () => {
  assert.equal(isInCall({ capturingMedia: true, probe: { liveMedia: true } }), true);
  // Réunion quittée (Meet garde l'adresse) : plus de flux vivant.
  assert.equal(isInCall({ capturingMedia: true, probe: { liveMedia: false } }), false);
  // Flux vivant sans micro ni caméra (vidéo en direct) : pas un appel.
  assert.equal(isInCall({ capturingMedia: false, probe: { liveMedia: true } }), false);
  assert.equal(isInCall({ capturingMedia: true, probe: null }), false);
});

test('incrustation automatique : appel, puis vidéo avec du son', () => {
  const base = { enabled: true, inCall: false, probe: { video: true, videoPip: false }, audible: true, alreadyFloating: false };
  assert.equal(autoPipKind(base), 'video');
  assert.equal(autoPipKind({ ...base, inCall: true }), 'call');
  assert.equal(autoPipKind({ ...base, audible: false }), null, 'vidéo muette en fond de page');
  assert.equal(autoPipKind({ ...base, probe: { video: true, videoPip: true } }), null, 'déjà incrustée');
  assert.equal(autoPipKind({ ...base, enabled: false, inCall: true }), null, 'réglage coupé');
  assert.equal(autoPipKind({ ...base, inCall: true, alreadyFloating: true }), null);
});

test('contrôles de la barre : seulement ce que la page expose', () => {
  assert.deepEqual(floatControlsState(null), {
    microphone: { available: false, off: null },
    camera: { available: false, off: null },
    hangup: false,
  });
  assert.deepEqual(
    floatControlsState({ controls: { microphone: { available: true, off: true }, camera: { available: true, off: 'x' }, hangup: true } }),
    { microphone: { available: true, off: true }, camera: { available: true, off: null }, hangup: true },
  );
});

test('textes : ceux du portail, sinon le français', () => {
  const texts = normalizePipTexts({ hangup: 'Hang up', backToTab: '', unknown: 'x', close: 'y'.repeat(200) });
  assert.equal(texts.hangup, 'Hang up');
  assert.equal(texts.backToTab, DEFAULT_PIP_TEXTS.backToTab);
  assert.equal(texts.close, DEFAULT_PIP_TEXTS.close);
  assert.equal(texts.unknown, undefined);
});

test('fenêtre flottante : en bas à droite, gardée dans la zone de travail', () => {
  const area = { x: 0, y: 25, width: 1440, height: 875 };
  assert.deepEqual(floatBounds(area), { x: 1440 - 400 - 16, y: 25 + 875 - 260 - 16, width: 400, height: 260 });
  const moved = floatBounds(area, { x: 5000, y: -100, width: 100, height: 100 });
  assert.equal(moved.width, 260);
  assert.equal(moved.height, 180);
  assert.equal(moved.x, 1440 - 260);
  assert.equal(moved.y, 25);
});

test('un onglet incrusté n’est jamais mis en veille', () => {
  const tab = { tabId: 'a', url: 'https://meet.google.com/abc', hiddenSince: 0, pictureInPicture: true };
  assert.equal(tabSleepBlocker(tab, { now: 10_000_000, delayMs: 1000, activeTabId: 'b', neverSites: [] }), 'picture-in-picture');
  assert.equal(
    tabSleepBlocker({ ...tab, pictureInPicture: false, capturingMedia: true }, { now: 10_000_000, delayMs: 1000, activeTabId: 'b', neverSites: [] }),
    'media',
  );
});
