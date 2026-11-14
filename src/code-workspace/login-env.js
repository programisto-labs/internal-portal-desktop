'use strict';

/**
 * Environment for git, gh and terminals.
 *
 * An app started from the Dock / Finder gets a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin):
 * `gh`, Homebrew git, nvm node… would be missing. The PATH of the user's login shell is read once
 * (`$SHELL -l -c` printing PATH between markers) and merged in. Never throws: falls back to the
 * process environment.
 */

const { execFile } = require('child_process');

const MARK = '__LASCO_PATH__';
let cached = null;

function cleanEnv(base) {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (key.startsWith('ELECTRON_') || key === 'NODE_OPTIONS' || key === 'GOOGLE_API_KEY') delete env[key];
  }
  return env;
}

function readLoginPath({ platform = process.platform, env = process.env, execFileImpl = execFile } = {}) {
  if (platform === 'win32') return Promise.resolve(null);
  const shell = env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
  return new Promise((resolve) => {
    execFileImpl(
      shell,
      ['-l', '-c', `printf '%s%s%s' '${MARK}' "$PATH" '${MARK}'`],
      { timeout: 5000, env: { ...cleanEnv(env), TERM: 'dumb' }, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) return resolve(null);
        const text = String(stdout || '');
        const start = text.indexOf(MARK);
        const end = text.lastIndexOf(MARK);
        if (start === -1 || end <= start) return resolve(null);
        const value = text.slice(start + MARK.length, end).trim();
        resolve(value && !value.includes('\n') ? value : null);
      }
    );
  });
}

function mergePath(loginPath, currentPath, delimiter) {
  const parts = [];
  for (const chunk of [loginPath, currentPath]) {
    for (const p of String(chunk || '').split(delimiter)) {
      if (p && !parts.includes(p)) parts.push(p);
    }
  }
  return parts.join(delimiter);
}

/** Resolved once per process; later calls reuse the promise. */
function getLoginEnv(options = {}) {
  if (cached && !options.refresh) return cached;
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  cached = readLoginPath({ ...options, platform, env }).then((loginPath) => {
    const base = cleanEnv(env);
    const delimiter = platform === 'win32' ? ';' : ':';
    if (loginPath) base.PATH = mergePath(loginPath, base.PATH, delimiter);
    if (platform !== 'win32' && !base.LANG && !base.LC_ALL) base.LANG = 'en_US.UTF-8';
    return base;
  });
  return cached;
}

module.exports = { getLoginEnv, cleanEnv, mergePath, readLoginPath };
