'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { decideForcedInstall, createForcedUpdateScheduler } = require('../src/forced-update');

describe('mise à jour imposée', () => {
  it('attend le préavis, puis installe si rien ne travaille', () => {
    assert.equal(decideForcedInstall({ downloadedAt: 0, now: 30_000, busy: false }), 'wait');
    assert.equal(decideForcedInstall({ downloadedAt: 0, now: 61_000, busy: false }), 'install');
  });

  it('un travail en cours repousse, au plus deux heures', () => {
    assert.equal(decideForcedInstall({ downloadedAt: 0, now: 10 * 60_000, busy: true }), 'wait');
    assert.equal(decideForcedInstall({ downloadedAt: 0, now: 2 * 60 * 60_000, busy: true }), 'install');
  });

  it('le planificateur prévient une fois et installe une seule fois', () => {
    let t = 0;
    let busy = true;
    const installs = [];
    const notices = [];
    const scheduler = createForcedUpdateScheduler({
      now: () => t,
      isBusy: () => busy,
      install: () => installs.push(t),
      notify: (info) => notices.push(info.version),
      setInterval: () => ({}),
      clearInterval: () => {},
    });
    scheduler.onDownloaded({ version: '2.8.0' });
    scheduler.onDownloaded({ version: '2.8.0' });
    assert.deepEqual(notices, ['2.8.0']);
    t = 5 * 60_000;
    scheduler.tick();
    assert.equal(installs.length, 0);
    busy = false;
    scheduler.tick();
    scheduler.tick();
    assert.deepEqual(installs, [5 * 60_000]);
    assert.equal(scheduler.pending(), false);
  });
});
