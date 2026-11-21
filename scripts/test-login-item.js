'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  LOGIN_HIDDEN_ARG,
  linuxLaunchPath,
  windowsLaunchPath,
  quoteExecArg,
  buildAutostartEntry,
  autostartDir,
  createLinuxAutostart,
  launchedHidden,
} = require('../src/login-item');

function memoryFs() {
  const files = new Map();
  return {
    files,
    readFileSync(p) {
      if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files.get(p);
    },
    writeFileSync(p, text) {
      files.set(p, text);
    },
    mkdirSync() {},
    unlinkSync(p) {
      if (!files.delete(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
  };
}

describe('login item', () => {
  it('relaunches the AppImage or the portable exe, not their temporary copy', () => {
    assert.equal(linuxLaunchPath({ env: { APPIMAGE: '/home/u/Lasco.AppImage' }, execPath: '/tmp/.mount_x/lasco' }), '/home/u/Lasco.AppImage');
    assert.equal(linuxLaunchPath({ env: {}, execPath: '/opt/Lasco/lasco' }), '/opt/Lasco/lasco');
    assert.equal(windowsLaunchPath({ env: { PORTABLE_EXECUTABLE_FILE: 'D:\\Lasco.exe' }, execPath: 'C:\\Temp\\x\\Lasco.exe' }), 'D:\\Lasco.exe');
  });

  it('quotes the Exec line', () => {
    assert.equal(quoteExecArg('/opt/My Apps/la$co"`\\'), '"/opt/My Apps/la\\$co\\"\\`\\\\"');
    const entry = buildAutostartEntry({ launchPath: '/opt/Lasco/lasco' });
    assert.match(entry, /^Exec="\/opt\/Lasco\/lasco" --lasco-hidden$/m);
    assert.match(entry, /^\[Desktop Entry\]$/m);
  });

  it('uses XDG_CONFIG_HOME when absolute', () => {
    assert.equal(autostartDir({ env: {}, homeDir: '/home/u' }), '/home/u/.config/autostart');
    assert.equal(autostartDir({ env: { XDG_CONFIG_HOME: '/cfg' }, homeDir: '/home/u' }), '/cfg/autostart');
    assert.equal(autostartDir({ env: { XDG_CONFIG_HOME: 'rel' }, homeDir: '/home/u' }), '/home/u/.config/autostart');
  });

  it('writes and removes the autostart file', () => {
    const fs = memoryFs();
    const a = createLinuxAutostart({ fs, dir: '/home/u/.config/autostart', launchPath: '/opt/Lasco/lasco' });
    assert.equal(a.isEnabled(), false);
    a.setEnabled(true);
    assert.equal(a.isEnabled(), true);
    assert.equal(a.file, '/home/u/.config/autostart/lasco.desktop');
    a.setEnabled(false);
    assert.equal(a.isEnabled(), false);
    // Removing twice is fine.
    a.setEnabled(false);
  });

  it('ignores an entry for another install or hidden by the desktop', () => {
    const fs = memoryFs();
    const a = createLinuxAutostart({ fs, dir: '/d', launchPath: '/opt/Lasco/lasco' });
    fs.writeFileSync(a.file, buildAutostartEntry({ launchPath: '/old/lasco' }));
    assert.equal(a.isEnabled(), false);
    fs.writeFileSync(a.file, `${buildAutostartEntry({ launchPath: '/opt/Lasco/lasco' })}Hidden=true\n`);
    assert.equal(a.isEnabled(), false);
  });

  it('detects a hidden start', () => {
    assert.equal(launchedHidden(['lasco', LOGIN_HIDDEN_ARG]), true);
    assert.equal(launchedHidden(['lasco']), false);
  });
});
