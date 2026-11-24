'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const {
  parseExternalAppUrl,
  initiatorOrigin,
  createExternalAppPermissionStore,
  createExternalAppLauncher,
} = require('../src/browser-tabs/external-apps');

const UNITY = 'unityhub://login/?code=abc&state=xyz';
const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup({ appName = 'Unity Hub.app', response = 0, checkboxChecked = false, now } = {}) {
  const opened = [];
  const dialogs = [];
  const permissions = createExternalAppPermissionStore({});
  const launcher = createExternalAppLauncher({
    shell: { openExternal: async (url) => opened.push(url) },
    showMessageBox: async (...args) => {
      dialogs.push(args[args.length - 1]);
      return { response, checkboxChecked };
    },
    getApplicationNameForProtocol: () => appName,
    getParentWindow: () => null,
    permissions,
    now,
  });
  return { launcher, opened, dialogs, permissions };
}

describe('browser links to desktop apps', () => {
  it('recognises app schemes, never web, local or privileged ones', () => {
    assert.deepEqual(parseExternalAppUrl(UNITY), { href: UNITY, scheme: 'unityhub' });
    assert.equal(parseExternalAppUrl('mailto:a@b.c').scheme, 'mailto');
    for (const url of [
      'https://example.com',
      'http://x',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,x',
      'smb://server/share',
      'x-apple.systempreferences:com.apple.Security',
      'lasco://open',
      'not a url',
    ]) {
      assert.equal(parseExternalAppUrl(url), null, url);
    }
    assert.equal(initiatorOrigin('https://api.unity.com/v1/oauth2?x=1'), 'https://api.unity.com');
    assert.equal(initiatorOrigin('about:blank'), null);
  });

  it('asks before opening the app, like Chrome', async () => {
    const { launcher, opened, dialogs } = setup();
    assert.equal(launcher.launch({ url: UNITY, pageUrl: 'https://api.unity.com/v1/oauth2' }), true);
    await flush();
    assert.equal(dialogs.length, 1);
    assert.equal(dialogs[0].message, 'Ouvrir Unity Hub ?');
    assert.match(dialogs[0].detail, /https:\/\/api\.unity\.com/);
    assert.match(dialogs[0].checkboxLabel, /api\.unity\.com/);
    assert.deepEqual(opened, [UNITY]);
  });

  it('cancel opens nothing', async () => {
    const { launcher, opened } = setup({ response: 1 });
    launcher.launch({ url: UNITY, pageUrl: 'https://api.unity.com/' });
    await flush();
    assert.deepEqual(opened, []);
  });

  it('« always allow » skips the question for that site and scheme only', async () => {
    let clock = 0;
    const { launcher, opened, dialogs } = setup({ checkboxChecked: true, now: () => clock });
    launcher.launch({ url: UNITY, pageUrl: 'https://api.unity.com/' });
    await flush();
    clock += 5000;
    launcher.launch({ url: 'unityhub://login/?code=2', pageUrl: 'https://api.unity.com/' });
    await flush();
    assert.equal(dialogs.length, 1);
    assert.equal(opened.length, 2);
    launcher.launch({ url: 'unityhub://login/?code=3', pageUrl: 'https://evil.example/' });
    await flush();
    assert.equal(dialogs.length, 2);
  });

  it('ignores links without an installed app, and repeated launches', async () => {
    const none = setup({ appName: '' });
    assert.equal(none.launcher.launch({ url: UNITY, pageUrl: 'https://a.com/' }), true);
    await flush();
    assert.equal(none.dialogs.length, 0);
    assert.deepEqual(none.opened, []);

    const { launcher, dialogs } = setup();
    launcher.launch({ url: UNITY, pageUrl: 'https://a.com/', key: 't1' });
    launcher.launch({ url: UNITY, pageUrl: 'https://a.com/', key: 't1' });
    await flush();
    assert.equal(dialogs.length, 1);
  });

  it('web links are left to the browser', () => {
    const { launcher } = setup();
    assert.equal(launcher.launch({ url: 'https://example.com', pageUrl: 'https://a.com/' }), false);
  });

  it('persists « always allow » and forgets it on clear', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lasco-ext-apps-'));
    const filePath = path.join(dir, 'browser-external-apps.json');
    const store = createExternalAppPermissionStore({ filePath });
    store.allow('https://api.unity.com', 'unityhub');
    assert.equal(createExternalAppPermissionStore({ filePath }).isAllowed('https://api.unity.com', 'unityhub'), true);
    assert.equal(createExternalAppPermissionStore({ filePath }).isAllowed('https://api.unity.com', 'zoommtg'), false);
    store.clear();
    assert.equal(createExternalAppPermissionStore({ filePath }).isAllowed('https://api.unity.com', 'unityhub'), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
