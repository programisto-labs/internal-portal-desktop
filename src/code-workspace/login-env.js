'use strict';

/**
 * Environment for git, gh and terminals.
 *
 * An app started from the Dock / Finder gets a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin):
 * `gh`, Homebrew git, nvm node, `~/.local/bin` (claude, cursor-agent)… would be missing. The PATH of the
 * user's shell is read once and merged in: an interactive login shell first (`$SHELL -i -l -c`, like
 * VS Code: `.zshrc` / `.bashrc` is where nvm and `~/.local/bin` are usually added), then a plain login
 * shell. Existing user bin folders (`~/.local/bin`, `~/bin`, …) are appended last. Never throws: falls
 * back to the process environment.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const USER_BIN_DIRS = ['.local/bin', 'bin', '.bun/bin', '.cargo/bin', '.npm-global/bin', '.volta/bin'];

const MARK = '__LASCO_PATH__';
let cached = null;

function cleanEnv(base) {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (key.startsWith('ELECTRON_') || key === 'NODE_OPTIONS' || key === 'GOOGLE_API_KEY') delete env[key];
  }
  return env;
}

function readShellPath(shell, flags, env, execFileImpl, timeout) {
  return new Promise((resolve) => {
    execFileImpl(
      shell,
      [...flags, '-c', `printf '%s%s%s' '${MARK}' "$PATH" '${MARK}'`],
      { timeout, env: { ...cleanEnv(env), TERM: 'dumb' }, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
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

async function readLoginPath({ platform = process.platform, env = process.env, execFileImpl = execFile } = {}) {
  if (platform === 'win32') return null;
  const shell = env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
  return (
    (await readShellPath(shell, ['-i', '-l'], env, execFileImpl, 10000)) ||
    (await readShellPath(shell, ['-l'], env, execFileImpl, 5000))
  );
}

function versionKey(v) {
  return String(v).replace(/^v/, '').split('.').map((n) => Number(n) || 0);
}

/**
 * Dossiers bin de nvm : `nvm use` ne tourne pas hors terminal. Version de `alias/default` en premier, puis les
 * autres de la plus récente à la plus ancienne (un CLI installé globalement sous une seule version reste trouvé).
 */
function nvmBinDirs(home, { exists = fs.existsSync, readFile = fs.readFileSync, readdir = fs.readdirSync } = {}) {
  const root = path.join(home, '.nvm', 'versions', 'node');
  let versions;
  try {
    versions = readdir(root).filter((v) => /^v\d+\.\d+\.\d+$/.test(v));
  } catch {
    return [];
  }
  if (!versions.length) return [];
  let wanted = '';
  try {
    wanted = String(readFile(path.join(home, '.nvm', 'alias', 'default'), 'utf8')).trim().replace(/^v/, '');
  } catch {
    /* pas d'alias */
  }
  const sorted = versions.sort((a, b) => {
    const [x, y] = [versionKey(a), versionKey(b)];
    for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return y[i] - x[i];
    return 0;
  });
  const match = wanted && /^[\d.]+$/.test(wanted) && sorted.find((v) => `${v.slice(1)}.`.startsWith(`${wanted}.`));
  const ordered = match ? [match, ...sorted.filter((v) => v !== match)] : sorted;
  return ordered.map((v) => path.join(root, v, 'bin')).filter((d) => exists(d));
}

/** Dossiers bin de l'utilisateur qui existent (`~/.local/bin`…), au cas où le shell ne les ajoute pas. */
function userBinDirs(home, exists = fs.existsSync) {
  if (!home) return [];
  const dirs = USER_BIN_DIRS.map((d) => path.join(home, d)).filter((d) => {
    try {
      return exists(d);
    } catch {
      return false;
    }
  });
  return exists === fs.existsSync ? [...dirs, ...nvmBinDirs(home)] : dirs;
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
    if (platform !== 'win32') {
      const extra = userBinDirs(base.HOME || options.home, options.exists);
      if (extra.length) base.PATH = mergePath(base.PATH, extra.join(delimiter), delimiter);
    }
    if (platform !== 'win32' && !base.LANG && !base.LC_ALL) base.LANG = 'en_US.UTF-8';
    return base;
  });
  return cached;
}

module.exports = { getLoginEnv, cleanEnv, mergePath, readLoginPath, userBinDirs, nvmBinDirs };
