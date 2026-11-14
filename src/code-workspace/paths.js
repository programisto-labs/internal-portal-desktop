'use strict';

/**
 * Paths inside a code project (Lasco Code workspace).
 *
 * The web page never sends an absolute path: it names a project (registered natively through a
 * folder picker) and a path relative to its root. Everything is resolved here and must stay inside
 * the project's real root. `.git` internals are never reachable through file operations (git state
 * goes through git commands).
 */

const path = require('path');
const { HostOpsError, isWithin, lstatOrNull } = require('../host-ops/paths');

const MAX_RELATIVE_PATH = 4096;

/**
 * Files an agent never reads, writes without a dialog, or sees in search results: environment
 * files, private keys and credential stores. The user still opens them in the editor.
 */
const SENSITIVE_BASENAME_RE = [
  /^\.env$/i,
  /^\.env\.(?!example$|sample$|template$|dist$|defaults$)[^/]+$/i,
  /\.(pem|key|p12|pfx|keystore|jks|kdbx|asc|gpg)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.(npmrc|netrc|pypirc|pgpass|git-credentials|htpasswd)$/i,
  /^credentials(\.json)?$/i,
  /^secrets?\.(json|ya?ml|toml)$/i,
  /^service-account.*\.json$/i,
];

function isSensitiveFile(relPath) {
  const base = String(relPath || '').split('/').pop() || '';
  return SENSITIVE_BASENAME_RE.some((re) => re.test(base));
}

/**
 * Normalise a project-relative path to forward-slash segments.
 * `''`, `.` and `/` mean the project root. Rejects absolute paths, traversal, NUL and `.git`.
 */
function splitRelative(input, { allowRoot = true } = {}) {
  if (input === undefined || input === null) input = '';
  if (typeof input !== 'string' || input.length > MAX_RELATIVE_PATH || input.includes('\0')) {
    throw new HostOpsError('invalid_path', 'Chemin invalide.');
  }
  const trimmed = input.trim().replace(/\\/g, '/');
  if (/^[A-Za-z]:/.test(trimmed) || trimmed.startsWith('//')) {
    throw new HostOpsError('path_not_relative', 'Le chemin doit être relatif à la racine du projet.');
  }
  const segments = trimmed.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.some((s) => s === '..')) {
    throw new HostOpsError('path_traversal', 'Le chemin ne peut pas sortir du projet (« .. » interdit).');
  }
  if (segments.some((s) => s.toLowerCase() === '.git')) {
    throw new HostOpsError('forbidden_path', 'Le dossier .git n’est pas accessible par les opérations de fichiers.');
  }
  if (!allowRoot && segments.length === 0) {
    throw new HostOpsError('invalid_path', 'Chemin de fichier requis.');
  }
  return segments;
}

function toRelative(root, absolute) {
  return path.relative(root, absolute).split(path.sep).join('/');
}

/**
 * Resolve an existing entry. Symlinks are followed only when their real target stays inside the
 * project root (read / list). Returns the real path and the stat of the real target.
 */
async function resolveExisting(fsp, root, rel, platform = process.platform) {
  const segments = splitRelative(rel);
  const joined = path.join(root, ...segments);
  let real;
  try {
    real = await fsp.realpath(joined);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      throw new HostOpsError('not_found', `Introuvable : ${segments.join('/') || '/'}`);
    }
    throw err;
  }
  if (!isWithin(root, real, platform)) {
    throw new HostOpsError('outside_project', 'Ce chemin pointe hors du projet.');
  }
  const relReal = toRelative(root, real);
  if (relReal.split('/').some((s) => s.toLowerCase() === '.git')) {
    throw new HostOpsError('forbidden_path', 'Le dossier .git n’est pas accessible par les opérations de fichiers.');
  }
  const st = await fsp.stat(real);
  return { abs: real, rel: segments.join('/'), stat: st };
}

/**
 * Resolve a file to write (it may not exist yet). The final component must not be a symlink.
 * Missing parent folders are reported in `missingDirs` (created by the caller, one by one).
 */
async function resolveWritable(fsp, root, rel, platform = process.platform) {
  const segments = splitRelative(rel, { allowRoot: false });
  for (const s of segments) {
    if (s.length > 255) throw new HostOpsError('invalid_name', 'Nom de fichier trop long.');
  }
  // Deepest existing ancestor, resolved for real: it must be inside the project.
  let existing = segments.length - 1;
  let parentReal = null;
  while (existing >= 0) {
    const candidate = path.join(root, ...segments.slice(0, existing));
    const st = await lstatOrNull(fsp, candidate);
    if (st) {
      parentReal = await fsp.realpath(candidate);
      const parentStat = await fsp.stat(parentReal);
      if (!parentStat.isDirectory()) throw new HostOpsError('parent_not_directory', 'Un élément du chemin est un fichier.');
      break;
    }
    existing -= 1;
  }
  if (!parentReal) parentReal = root;
  if (!isWithin(root, parentReal, platform)) {
    throw new HostOpsError('outside_project', 'Ce chemin pointe hors du projet.');
  }
  const missingDirs = segments.slice(Math.max(existing, 0), segments.length - 1);
  const parentAbs = path.join(parentReal, ...missingDirs);
  const abs = path.join(parentAbs, segments[segments.length - 1]);
  const st = missingDirs.length === 0 ? await lstatOrNull(fsp, abs) : null;
  if (st && st.isSymbolicLink()) throw new HostOpsError('symlink_rejected', 'Lien symbolique refusé pour une écriture.');
  if (st && !st.isFile()) throw new HostOpsError('not_a_file', 'Ce chemin n’est pas un fichier.');
  return {
    abs,
    rel: segments.join('/'),
    parentReal,
    missingDirs,
    exists: Boolean(st),
    stat: st,
  };
}

/** Create the missing folders of a writable target, re-checking each one stays a real folder. */
async function ensureParents(fsp, target) {
  let dir = target.parentReal;
  for (const name of target.missingDirs) {
    dir = path.join(dir, name);
    try {
      await fsp.mkdir(dir);
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
    }
    const st = await fsp.lstat(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) {
      throw new HostOpsError('changed_during_operation', 'Un dossier du chemin a changé pendant l’opération.');
    }
  }
}

module.exports = {
  isSensitiveFile,
  splitRelative,
  toRelative,
  resolveExisting,
  resolveWritable,
  ensureParents,
};
