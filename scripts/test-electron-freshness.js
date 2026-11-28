'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { assessElectron } = require('./check-electron-freshness');

const releases = [
  { version: '47.0.0-nightly.20261126', date: '2026-11-26' },
  { version: '45.5.0', date: '2026-11-24', chrome: '156' },
  { version: '44.11.6', date: '2026-11-24', chrome: '152.169' },
  { version: '44.11.5', date: '2026-11-19', chrome: '152.168' },
  { version: '44.5.1', date: '2026-09-29', chrome: '152.130' },
  { version: '43.8.13', date: '2026-11-24' },
  { version: '42.11.18', date: '2026-10-21' },
];
const now = Date.parse('2026-11-28');

describe('assessElectron', () => {
  it('latest patch of a supported line: up to date', () => {
    const a = assessElectron({ installed: '44.11.6', releases, now });
    assert.equal(a.overdue, false);
    assert.deepEqual(a.supported, [45, 44, 43]);
  });
  it('missed patches older than the grace period: overdue', () => {
    const a = assessElectron({ installed: '44.5.1', releases, now });
    assert.equal(a.overdue, true);
    assert.deepEqual(a.missed, ['44.11.6', '44.11.5']);
  });
  it('a patch released yesterday is not yet overdue', () => {
    const a = assessElectron({ installed: '44.11.5', releases, now: Date.parse('2026-11-25') });
    assert.equal(a.overdue, false);
  });
  it('an unsupported line is overdue', () => {
    const a = assessElectron({ installed: '42.11.18', releases, now });
    assert.equal(a.overdue, true);
    assert.match(a.problems[0], /plus maintenu/);
  });
});
