'use strict';

const fs = require('fs');
const path = require('path');

const MAX_PATH_LENGTH = 4096;

class HostOpsError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

/** Reject anything that is not a plain absolute path without traversal segments. */
function assertPlainAbsolutePath(input, label, platform = process.platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_PATH_LENGTH) {
    throw new HostOpsError('invalid_path', `${label}: chemin invalide.`);
  }
  if (input.includes('\0')) throw new HostOpsError('invalid_path', `${label}: caractère nul interdit.`);
  if (!p.isAbsolute(input)) throw new HostOpsError('path_not_absolute', `${label}: le chemin doit être absolu.`);
  const segments = input.split(/[\\/]+/);
  if (segments.some((s) => s === '..' || s === '.')) {
    throw new HostOpsError('path_traversal', `${label}: segments « . » et « .. » interdits.`);
  }
  return p.normalize(input);
}

function assertSafeName(name, label) {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name.length > 255 ||
    name === '.' ||
    name === '..' ||
    /[\\/\0]/.test(name)
  ) {
    throw new HostOpsError('invalid_name', `${label}: nom invalide (séparateurs interdits).`);
  }
  return name;
}

function normKey(p, platform = process.platform) {
  return platform === 'win32' || platform === 'darwin' ? p.toLowerCase() : p;
}

/** True when `dir` equals `root` or lives under it (real paths expected). */
function isWithin(root, dir, platform = process.platform) {
  const rel = path.relative(normKey(root, platform), normKey(dir, platform));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function lstatOrNull(fsp, p) {
  try {
    return await fsp.lstat(p);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
    throw err;
  }
}

function fingerprint(st) {
  return st ? { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs } : null;
}

function sameFingerprint(a, b) {
  if (!a || !b) return a === b;
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/**
 * Resolve an existing regular file. Final component must not be a symlink; intermediate
 * symlinks are resolved so that the user consents to (and grants match) the real path.
 */
async function resolveExistingFile(fsp, input, label, platform) {
  const normalized = assertPlainAbsolutePath(input, label, platform);
  const st = await lstatOrNull(fsp, normalized);
  if (!st) throw new HostOpsError('source_missing', `${label}: fichier introuvable.`);
  if (st.isSymbolicLink()) throw new HostOpsError('symlink_rejected', `${label}: lien symbolique refusé.`);
  if (!st.isFile()) throw new HostOpsError('not_a_file', `${label}: ce n'est pas un fichier régulier.`);
  const realDir = await fsp.realpath(path.dirname(normalized));
  const real = path.join(realDir, path.basename(normalized));
  return { path: real, dir: realDir, name: path.basename(real), fingerprint: fingerprint(st) };
}

/** Resolve a target that may or may not exist; its parent directory must exist. */
async function resolveTarget(fsp, input, label, platform) {
  const normalized = assertPlainAbsolutePath(input, label, platform);
  const name = assertSafeName(path.basename(normalized), label);
  let realDir;
  try {
    realDir = await fsp.realpath(path.dirname(normalized));
  } catch (err) {
    throw new HostOpsError('parent_missing', `${label}: dossier parent introuvable.`);
  }
  const parentSt = await fsp.stat(realDir);
  if (!parentSt.isDirectory()) throw new HostOpsError('parent_not_directory', `${label}: parent invalide.`);
  const real = path.join(realDir, name);
  const st = await lstatOrNull(fsp, real);
  if (st && st.isSymbolicLink()) throw new HostOpsError('symlink_rejected', `${label}: lien symbolique refusé.`);
  return { path: real, dir: realDir, name, exists: Boolean(st), isDirectory: Boolean(st && st.isDirectory()), fingerprint: fingerprint(st) };
}

module.exports = {
  HostOpsError,
  assertPlainAbsolutePath,
  assertSafeName,
  isWithin,
  normKey,
  lstatOrNull,
  fingerprint,
  sameFingerprint,
  resolveExistingFile,
  resolveTarget,
  fs,
};
