'use strict';

/**
 * Garde de configuration (docs/security.md) : échoue si une fenêtre ou une vue relâche l'isolation,
 * si un certificat invalide est accepté, si un gestionnaire IPC est posé avant la barrière, ou si les
 * fusibles disparaissent du build.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function jsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = jsFiles(path.join(ROOT, 'src')).map((file) => ({ file: path.relative(ROOT, file), text: fs.readFileSync(file, 'utf8') }));

describe('webPreferences and switches', () => {
  const forbidden = [
    [/nodeIntegration\s*:\s*true/, 'nodeIntegration: true'],
    [/nodeIntegrationInSubFrames\s*:\s*true/, 'nodeIntegrationInSubFrames: true'],
    [/nodeIntegrationInWorker\s*:\s*true/, 'nodeIntegrationInWorker: true'],
    [/contextIsolation\s*:\s*false/, 'contextIsolation: false'],
    [/sandbox\s*:\s*false/, 'sandbox: false'],
    [/webSecurity\s*:\s*false/, 'webSecurity: false'],
    [/allowRunningInsecureContent\s*:\s*true/, 'allowRunningInsecureContent: true'],
    [/webviewTag\s*:\s*true/, 'webviewTag: true'],
    [/experimentalFeatures\s*:\s*true/, 'experimentalFeatures: true'],
    [/enableBlinkFeatures\s*:/, 'enableBlinkFeatures'],
    [/setCertificateVerifyProc\s*\(/, 'setCertificateVerifyProc'],
    [/ignore-certificate-errors/, 'ignore-certificate-errors'],
    [/disable-web-security/, 'disable-web-security'],
    [/no-sandbox/, 'no-sandbox'],
  ];
  for (const [pattern, label] of forbidden) {
    it(`no ${label}`, () => {
      assert.deepEqual(files.filter(({ text }) => pattern.test(text)).map(({ file }) => file), []);
    });
  }

  it('inline webPreferences objects are sandboxed with context isolation', () => {
    const offenders = [];
    for (const { file, text } of files) {
      const re = /webPreferences\s*(?::|=)\s*\{([^}]*)\}/g;
      let m;
      while ((m = re.exec(text))) {
        const body = m[1];
        if (!/sandbox\s*:\s*true/.test(body) || !/contextIsolation\s*:\s*true/.test(body)) {
          offenders.push(`${file}: ${body.replace(/\s+/g, ' ').trim().slice(0, 100)}`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });

  it('no certificate-error handler accepts a bad certificate', () => {
    const hits = files.filter(({ text }) => /certificate-error[\s\S]{0,400}callback\(\s*true\s*\)/.test(text)).map(({ file }) => file);
    assert.deepEqual(hits, []);
  });
});

describe('IPC gate', () => {
  it('is installed in main.js before the first ipcMain registration', () => {
    const main = files.find(({ file }) => file === path.join('src', 'main.js')).text;
    const gate = main.indexOf('ipcGate.install(ipcMain)');
    const first = main.search(/ipcMain\.(on|handle|once|handleOnce)\(/);
    assert.ok(gate > 0, 'ipcGate.install missing');
    assert.ok(first > gate, 'an ipcMain handler is registered before the gate');
  });
});

describe('build hardening', () => {
  it('flips Electron fuses after packing', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.build.afterPack, 'build/hooks/after-pack-fuses.js');
    const { fusesConfig } = require('../build/hooks/after-pack-fuses');
    const { FuseV1Options } = require('@electron/fuses');
    const mac = fusesConfig('darwin', FuseV1Options);
    assert.equal(mac[FuseV1Options.EnableNodeOptionsEnvironmentVariable], false);
    assert.equal(mac[FuseV1Options.EnableNodeCliInspectArguments], false);
    assert.equal(mac[FuseV1Options.OnlyLoadAppFromAsar], true);
    assert.equal(mac[FuseV1Options.EnableEmbeddedAsarIntegrityValidation], true);
    const win = fusesConfig('win32', FuseV1Options);
    assert.equal(win[FuseV1Options.EnableEmbeddedAsarIntegrityValidation], false);
  });
});
