'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  compareVersions,
  parseMinimumVersion,
  isBelowMinimum,
  fetchMinimumVersion,
  createSecurityFloor,
  SECURITY_MAX_DEFER_MS,
  MANUAL_UPDATE_AFTER_MS,
} = require('../src/security/minimum-version');
const { decideForcedInstall, createForcedUpdateScheduler } = require('../src/forced-update');

describe('compareVersions', () => {
  it('orders semver numerically', () => {
    assert.equal(compareVersions('2.9.0', '2.10.0'), -1);
    assert.equal(compareVersions('v2.12.0', '2.12.0'), 0);
    assert.equal(compareVersions('3.0.0', '2.99.99'), 1);
    assert.equal(compareVersions('2.12.0-beta.1', '2.12.0'), 0);
    assert.equal(compareVersions('nope', '1.0.0'), null);
  });
});

describe('parseMinimumVersion', () => {
  it('reads a valid file, rejects anything else', () => {
    assert.deepEqual(parseMinimumVersion('{"minimumVersion":"v2.13.1","reason":"CVE-2026-1234"}'), {
      minimumVersion: '2.13.1',
      reason: 'CVE-2026-1234',
    });
    assert.equal(parseMinimumVersion('{"minimumVersion":"latest"}'), null);
    assert.equal(parseMinimumVersion('<html>'), null);
    assert.equal(parseMinimumVersion(null), null);
  });
  it('the committed file is valid', () => {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'security', 'minimum-version.json'), 'utf8');
    assert.ok(parseMinimumVersion(raw));
  });
});

describe('fetchMinimumVersion', () => {
  it('returns null on network errors and non-200', async () => {
    assert.equal(await fetchMinimumVersion({ fetchImpl: async () => { throw new Error('offline'); } }), null);
    assert.equal(await fetchMinimumVersion({ fetchImpl: async () => ({ ok: false }) }), null);
  });
  it('parses the body', async () => {
    const r = await fetchMinimumVersion({ fetchImpl: async () => ({ ok: true, text: async () => '{"minimumVersion":"2.13.0"}' }) });
    assert.deepEqual(r, { minimumVersion: '2.13.0', reason: '' });
  });
});

describe('createSecurityFloor', () => {
  it('below the floor: short defer, manual prompt after 6 h, once', () => {
    let t = 0;
    const floor = createSecurityFloor({ currentVersion: '2.12.0', now: () => t });
    floor.update({ minimumVersion: '2.13.0', reason: '' });
    assert.equal(isBelowMinimum('2.12.0', floor.floor()), true);
    assert.equal(floor.required(), true);
    assert.equal(floor.maxDeferMs(2 * 60 * 60 * 1000), SECURITY_MAX_DEFER_MS);
    assert.equal(floor.shouldPromptManualUpdate({ updateDownloaded: false }), false);
    t = MANUAL_UPDATE_AFTER_MS;
    assert.equal(floor.shouldPromptManualUpdate({ updateDownloaded: true }), false);
    assert.equal(floor.shouldPromptManualUpdate({ updateDownloaded: false }), true);
    assert.equal(floor.shouldPromptManualUpdate({ updateDownloaded: false }), false);
  });
  it('at or above the floor, or unreadable file: nothing changes', () => {
    const floor = createSecurityFloor({ currentVersion: '2.13.0' });
    floor.update({ minimumVersion: '2.13.0', reason: '' });
    assert.equal(floor.required(), false);
    floor.update(null);
    assert.equal(floor.maxDeferMs(1000), 1000);
  });
});

describe('forced update with a security floor', () => {
  it('a busy app still installs after the short defer', () => {
    assert.equal(decideForcedInstall({ downloadedAt: 0, now: SECURITY_MAX_DEFER_MS, busy: true, maxDeferMs: SECURITY_MAX_DEFER_MS }), 'install');
    assert.equal(decideForcedInstall({ downloadedAt: 0, now: SECURITY_MAX_DEFER_MS, busy: true }), 'wait');
  });
  it('the scheduler reads maxDeferMs as a function at each tick', () => {
    let t = 0;
    let installed = 0;
    let max = 2 * 60 * 60 * 1000;
    const s = createForcedUpdateScheduler({
      isBusy: () => true,
      install: () => { installed += 1; },
      now: () => t,
      setInterval: () => ({}),
      clearInterval: () => {},
      maxDeferMs: () => max,
    });
    s.onDownloaded({ version: '2.13.0' });
    t = SECURITY_MAX_DEFER_MS;
    s.tick();
    assert.equal(installed, 0);
    max = SECURITY_MAX_DEFER_MS;
    s.tick();
    assert.equal(installed, 1);
  });
});
