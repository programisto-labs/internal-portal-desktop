'use strict';

/**
 * Commande réelle d'un harnais de code, et options que sa version connaît.
 *
 * - macOS / Linux : le nom du binaire suffit (`PATH` du shell de connexion).
 * - Windows : `spawn('codex')` ne trouve que `codex.exe`. Les CLI installés par npm (`codex.cmd`, `claude.cmd`)
 *   et par l'installeur de Cursor (`cursor-agent.cmd`) sont des scripts `.cmd`, que Node ne lance qu'à travers
 *   `cmd.exe` : la consigne de l'agent passerait alors par l'interpréteur de cmd (`%`, `^`, `&`, retours à la
 *   ligne). On lance donc directement le programme que le script appelle (`node.exe` + script JS), sans shell.
 *   Un script qu'on ne sait pas lire est refusé plutôt que lancé par cmd.
 */

const fsDefault = require('fs');
const pathDefault = require('path');
const { execFile } = require('child_process');

function envValue(env, name) {
  const key = Object.keys(env || {}).find((k) => k.toUpperCase() === name);
  return key ? env[key] : undefined;
}

function isFile(fs, file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Premier fichier `bin` + extension trouvé dans le PATH (Windows), ou null. */
function findOnWindowsPath(bin, { env, fs = fsDefault, path = pathDefault.win32 } = {}) {
  const dirs = String(envValue(env, 'PATH') || '')
    .split(';')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
  // Dossiers des installeurs, ajoutés au PATH de l'utilisateur après le lancement de Desktop si le CLI a été
  // installé entre-temps : Cursor (`%LOCALAPPDATA%\cursor-agent`), npm (`%APPDATA%\npm`), Claude (`~\.local\bin`).
  const local = envValue(env, 'LOCALAPPDATA');
  const roaming = envValue(env, 'APPDATA');
  const home = envValue(env, 'USERPROFILE');
  for (const extra of [local && path.join(local, 'cursor-agent'), roaming && path.join(roaming, 'npm'), home && path.join(home, '.local', 'bin')]) {
    if (extra && !dirs.some((d) => d.toLowerCase() === extra.toLowerCase())) dirs.push(extra);
  }
  for (const dir of dirs) {
    // `.exe` d'abord : lancé directement, sans script intermédiaire.
    for (const ext of ['.exe', '.cmd', '.bat']) {
      const file = path.join(dir, `${bin}${ext}`);
      if (isFile(fs, file)) return file;
    }
  }
  return null;
}

/**
 * Script `.cmd` → `{ command, prefixArgs }` sans cmd.exe.
 * 1. Raccourci npm (cmd-shim) : `"%_prog%" "%dp0%\node_modules\…\cli.js" %*` → node.exe (à côté, sinon du PATH).
 * 2. Installeur Cursor : `<dossier>\versions\<version>\node.exe` + `index.js`, version la plus récente.
 */
function resolveWindowsShim(shim, { env, fs = fsDefault, path = pathDefault.win32 } = {}) {
  const dir = path.dirname(shim);
  let text = '';
  try {
    text = fs.readFileSync(shim, 'utf8');
  } catch {
    text = '';
  }
  const nodeNextToShim = path.join(dir, 'node.exe');
  const node = isFile(fs, nodeNextToShim) ? nodeNextToShim : findOnWindowsPath('node', { env, fs, path });

  const launch = text.split(/\r?\n/).find((line) => line.includes('%*'));
  if (launch) {
    const quoted = [...launch.matchAll(/"([^"]+)"/g)]
      .map((m) => m[1].replace(/%~dp0\\?|%dp0%\\?/gi, `${dir}\\`))
      .filter((q) => !q.includes('%'));
    const script = quoted.find((q) => /\.(c|m)?js$/i.test(q));
    // Script qui nomme son propre node.exe (installeurs autonomes) : celui-là, sinon celui d'à côté ou du PATH.
    const ownNode = quoted.map((q) => path.normalize(q)).find((q) => /node\.exe$/i.test(q) && isFile(fs, q));
    if (script && (ownNode || node)) return { command: ownNode || node, prefixArgs: [path.normalize(script)] };
  }

  const versionsDir = path.join(dir, 'versions');
  let versions = [];
  try {
    versions = fs
      .readdirSync(versionsDir)
      .filter((name) => !name.startsWith('.') && !/staged|previous/i.test(name))
      .sort()
      .reverse();
  } catch {
    versions = [];
  }
  for (const version of versions) {
    const vNode = path.join(versionsDir, version, 'node.exe');
    const vIndex = path.join(versionsDir, version, 'index.js');
    if (isFile(fs, vNode) && isFile(fs, vIndex)) return { command: vNode, prefixArgs: [vIndex] };
  }
  return null;
}

/**
 * `{ command, prefixArgs }` pour lancer `bin`, ou `{ error: 'not_installed' | 'unsupported_shim' }`.
 * Hors Windows, toujours `{ command: bin, prefixArgs: [] }` (ENOENT au lancement si absent).
 */
function resolveHarnessCommand(bin, { env = process.env, platform = process.platform, fs = fsDefault } = {}) {
  if (platform !== 'win32') return { command: bin, prefixArgs: [] };
  const found = findOnWindowsPath(bin, { env, fs });
  if (!found) return { error: 'not_installed' };
  if (/\.exe$/i.test(found)) return { command: found, prefixArgs: [] };
  const resolved = resolveWindowsShim(found, { env, fs });
  return resolved || { error: 'unsupported_shim', shim: found };
}

/** `execFile` qui passe par la résolution ci-dessus ; erreur ENOENT si le binaire est introuvable. */
function execHarness(bin, args, options, callback, { platform = process.platform, execFileImpl = execFile, fs } = {}) {
  const resolved = resolveHarnessCommand(bin, { env: options?.env, platform, fs });
  if (resolved.error) {
    const err = Object.assign(new Error(`${bin} introuvable`), { code: 'ENOENT' });
    setImmediate(() => callback(err, '', ''));
    return null;
  }
  return execFileImpl(resolved.command, [...resolved.prefixArgs, ...args], { windowsHide: true, ...options }, callback);
}

const helpCache = new Map();
const HELP_TTL_MS = 10 * 60 * 1000;

/**
 * Options longues (`--trust`, `--force`…) listées par `<bin> --help`, en cache 10 min.
 * `null` si l'aide est illisible : l'appelant garde alors ses options par défaut.
 */
function helpFlags(bin, { env, execImpl = execHarness, now = Date.now } = {}) {
  const cached = helpCache.get(bin);
  if (cached && now() - cached.at < HELP_TTL_MS) return cached.promise;
  const promise = new Promise((resolve) => {
    execImpl(bin, ['--help'], { env, timeout: 10000, maxBuffer: 512 * 1024 }, (err, stdout, stderr) => {
      const text = `${stdout || ''}\n${stderr || ''}`;
      const flags = new Set(text.match(/--[a-z][a-z0-9-]*/gi) || []);
      resolve(flags.size ? flags : null);
    });
  });
  helpCache.set(bin, { at: now(), promise });
  return promise;
}

function clearHelpCache() {
  helpCache.clear();
}

module.exports = { resolveHarnessCommand, resolveWindowsShim, findOnWindowsPath, execHarness, helpFlags, clearHelpCache };
