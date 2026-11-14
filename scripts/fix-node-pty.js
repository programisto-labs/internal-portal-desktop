'use strict';

/**
 * npm drops the exec bit of node-pty's prebuilt `spawn-helper` (macOS / Linux), which makes every
 * terminal fail with "posix_spawnp failed". Restore it after install so packaged builds ship it
 * executable (electron-builder keeps file modes).
 */
const path = require('path');
const { ensureSpawnHelperExecutable } = require('../src/code-workspace/terminals');

let dir;
try {
  dir = path.dirname(require.resolve('node-pty/package.json'));
} catch (_) {
  process.exit(0);
}
for (const platform of ['darwin', 'linux']) {
  if (process.platform === platform) ensureSpawnHelperExecutable(dir, platform);
}
// Prebuilds of both macOS architectures (universal / cross-arch builds).
const fs = require('fs');
for (const arch of ['darwin-arm64', 'darwin-x64']) {
  const helper = path.join(dir, 'prebuilds', arch, 'spawn-helper');
  try {
    const st = fs.statSync(helper);
    if ((st.mode & 0o111) === 0) fs.chmodSync(helper, st.mode | 0o755);
  } catch (_) {
    // not shipped for this platform
  }
}
