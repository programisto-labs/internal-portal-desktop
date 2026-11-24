'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createVaultAuth } = require('../src/vault-auth');

function fakeRun(outputs) {
  const calls = [];
  const runFile = (file, args, options, callback) => {
    calls.push({ file, args, options });
    const next = outputs.shift();
    if (next instanceof Error) callback(next, '');
    else callback(null, `${next}\n`);
  };
  return { runFile, calls };
}

describe('vault identity check', () => {
  it('macOS with Touch ID: prompts through Electron and remembers a success for a minute', async () => {
    let clock = 1000;
    let prompts = 0;
    const auth = createVaultAuth({
      platform: 'darwin',
      now: () => clock,
      systemPreferences: { canPromptTouchID: () => true, promptTouchID: async () => { prompts += 1; } },
    });
    assert.deepEqual(await auth.verifyUser({ reason: 'afficher' }), { ok: true });
    assert.deepEqual(await auth.verifyUser({}), { ok: true, recent: true });
    clock += 61_000;
    assert.deepEqual(await auth.verifyUser({}), { ok: true });
    assert.equal(prompts, 2);
    auth.reset();
  });

  it('macOS without Touch ID: system sheet with the session password; refusal is reported', async () => {
    const { runFile, calls } = fakeRun(['ok', 'denied']);
    let clock = 0;
    const auth = createVaultAuth({ platform: 'darwin', runFile, now: () => (clock += 100_000), systemPreferences: { canPromptTouchID: () => false } });
    assert.deepEqual(await auth.verifyUser({ reason: 'afficher le mot de passe de a.com' }), { ok: true });
    assert.equal(calls[0].file, '/usr/bin/osascript');
    assert.equal(calls[0].args.at(-1), 'afficher le mot de passe de a.com');
    assert.deepEqual(await auth.verifyUser({}), { ok: false, error: 'denied' });
  });

  it('macOS Touch ID cancelled: denied, never cached', async () => {
    const auth = createVaultAuth({
      platform: 'darwin',
      systemPreferences: { canPromptTouchID: () => true, promptTouchID: async () => { throw new Error('cancel'); } },
    });
    assert.deepEqual(await auth.verifyUser({}), { ok: false, error: 'denied' });
    assert.deepEqual(await auth.verifyUser({}), { ok: false, error: 'denied' });
  });

  it('Windows Hello: reason through the environment, unavailable when Hello is not set up', async () => {
    const { runFile, calls } = fakeRun(['unavailable', 'ok']);
    const auth = createVaultAuth({ platform: 'win32', runFile, env: {} });
    assert.deepEqual(await auth.verifyUser({ reason: "x'; Remove-Item C:\\ -Recurse" }), { ok: false, error: 'unavailable' });
    assert.equal(calls[0].file, 'powershell.exe');
    assert.ok(!calls[0].args.join(' ').includes('Remove-Item'));
    assert.equal(calls[0].options.env.LASCO_VERIFY_REASON, "x'; Remove-Item C:\\ -Recurse");
    assert.deepEqual(await auth.verifyUser({}), { ok: true });
  });

  it('other systems: unsupported; a failing script is a failure, not a success', async () => {
    assert.deepEqual(await createVaultAuth({ platform: 'linux' }).verifyUser({}), { ok: false, error: 'unsupported' });
    const { runFile } = fakeRun([new Error('boom')]);
    assert.deepEqual(await createVaultAuth({ platform: 'win32', runFile }).verifyUser({}), { ok: false, error: 'failed' });
  });

  it('concurrent requests share one prompt', async () => {
    let prompts = 0;
    const auth = createVaultAuth({
      platform: 'darwin',
      systemPreferences: { canPromptTouchID: () => true, promptTouchID: () => new Promise((r) => { prompts += 1; setTimeout(r, 10); }) },
    });
    const [a, b] = await Promise.all([auth.verifyUser({}), auth.verifyUser({})]);
    assert.equal(a.ok && b.ok, true);
    assert.equal(prompts, 1);
  });
});
