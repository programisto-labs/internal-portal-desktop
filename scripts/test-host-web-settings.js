'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHostOpsStore } = require('../src/host-ops/store');
const { createHostOpsWebSettings, buildEnableDialog } = require('../src/host-ops/web-settings');

let tmp;
let store;
let asked;
let answer;
let clock;
let opened;

function mk(overrides = {}) {
  return createHostOpsWebSettings({
    store,
    now: () => clock,
    openSettings: () => {
      opened += 1;
    },
    confirmEnable: async (request) => {
      asked.push(request);
      return typeof answer === 'function' ? answer(request) : answer;
    },
    ...overrides,
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-web-settings-'));
  store = createHostOpsStore(path.join(tmp, 'host-ops.json'));
  asked = [];
  answer = false;
  clock = 1_000_000;
  opened = 0;
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('host-ops web settings (profil > Cet ordinateur)', () => {
  it('status: switches and grant counts only, no paths, commands or ids', () => {
    store.setEnabled(true);
    store.setShellEnabled(true);
    store.addGrant({ userId: 'u1', deviceId: store.getDeviceId(), agentId: 'a1', agentName: 'Dev', operation: 'shell.run', commandPrefix: ['git', 'status'], cwdRoots: [tmp] });
    store.addGrant({ userId: 'u1', deviceId: store.getDeviceId(), agentId: 'a1', operation: 'code.write', destinationRoots: [tmp] });
    const s = mk().status();
    assert.deepEqual(s, {
      available: true,
      enabled: true,
      shellEnabled: true,
      codeEnabled: false,
      grants: { files: 0, shell: 1, code: 1, total: 2 },
    });
    assert.ok(!JSON.stringify(s).includes(tmp));
    assert.ok(!JSON.stringify(s).includes('git'));
  });

  it('disable and revoke all apply directly, without any dialog', () => {
    store.setEnabled(true);
    store.setShellEnabled(true);
    store.addGrant({ userId: 'u1', deviceId: store.getDeviceId(), agentId: 'a1', operation: 'code.write', destinationRoots: [tmp] });
    const web = mk();
    assert.equal(web.disable('shell').status.shellEnabled, false);
    assert.equal(web.revokeAll().status.grants.total, 0);
    assert.equal(web.disable('host').status.enabled, false);
    assert.equal(asked.length, 0);
    assert.equal(web.disable('everything').ok, false);
  });

  it('turning host operations off also turns shell and code off: re-enabling host does not revive them', async () => {
    store.setEnabled(true);
    store.setShellEnabled(true);
    store.setCodeEnabled(true);
    const web = mk();
    web.disable('host');
    answer = true;
    await web.requestEnable('host');
    assert.equal(store.isEnabled(), true);
    assert.equal(store.isShellEnabled(), false);
    assert.equal(store.isCodeEnabled(), false);
    assert.deepEqual(asked[0].features, ['host']);
  });

  it('enable never happens without the native confirmation', async () => {
    const web = mk();
    answer = false;
    const res = await web.requestEnable('host');
    assert.equal(res.decision, 'denied');
    assert.equal(store.isEnabled(), false);
    assert.equal(asked.length, 1);
  });

  it('enable after confirmation; shell asks for host operations in the same dialog', async () => {
    const web = mk();
    answer = true;
    const res = await web.requestEnable('shell');
    assert.equal(res.decision, 'enabled');
    assert.deepEqual(asked[0].features, ['host', 'shell']);
    assert.equal(store.isEnabled(), true);
    assert.equal(store.isShellEnabled(), true);
    assert.equal(store.isCodeEnabled(), false);
    // Already on: no second dialog.
    assert.equal((await web.requestEnable('shell')).decision, 'already');
    assert.equal(asked.length, 1);
  });

  it('one dialog at a time, and a cooldown after a refusal', async () => {
    let release;
    answer = () => new Promise((resolve) => (release = resolve));
    const web = mk();
    const first = web.requestEnable('code');
    const second = await web.requestEnable('host');
    assert.equal(second.error.code, 'busy');
    release(false);
    assert.equal((await first).decision, 'denied');
    answer = true;
    assert.equal((await web.requestEnable('code')).error.code, 'cooldown');
    clock += 31_000;
    assert.equal((await web.requestEnable('code')).decision, 'enabled');
    assert.equal(store.isCodeEnabled(), true);
  });

  it('a failing dialog counts as a refusal', async () => {
    const web = mk({ confirmEnable: async () => { throw new Error('closed'); } });
    assert.equal((await web.requestEnable('host')).decision, 'denied');
    assert.equal(store.isEnabled(), false);
  });

  it('dialog: « Annuler » is the default and the cancel button', () => {
    const d = buildEnableDialog({ title: 'Activer ?', detail: 'Effet.' });
    assert.deepEqual(d.buttons, ['Annuler', 'Activer']);
    assert.equal(d.defaultId, 0);
    assert.equal(d.cancelId, 0);
    assert.match(d.detail, /page Réglages de Lasco/);
  });

  it('open settings delegates to the native window', () => {
    assert.deepEqual(mk().open(), { ok: true, opened: true });
    assert.equal(opened, 1);
  });
});
