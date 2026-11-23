'use strict';

/**
 * Écritures disque de la synchronisation My Drive (internal-portal#2399).
 *
 * Non destructif : on crée des fichiers, jamais on n'écrase ni ne supprime. Tout chemin est
 * relatif au dossier choisi dans les réglages et y reste confiné : segments vérifiés, aucun
 * lien symbolique traversé, `realpath` du parent revérifié avant chaque écriture.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const PART_SUFFIX = '.lasco-part';
const MAX_FILE_BYTES = 5 * 1024 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

class DriveSyncError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

/** Même règle que `isConfinedRelativePath` du portail : relatif, POSIX, sans `.` ni `..`. */
function isConfinedRelativePath(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.length > 4096) return false;
  if (relativePath.startsWith('/') || relativePath.includes('\\') || /^[a-zA-Z]:/.test(relativePath)) return false;
  return relativePath
    .split('/')
    .every((p) => p !== '' && p !== '.' && p !== '..' && !p.includes('\0'));
}

function errorCode(err) {
  switch (err && err.code) {
    case 'EACCES':
    case 'EPERM':
      return 'permission-denied';
    case 'ENOENT':
    case 'ENOTDIR':
      return 'folder-not-found';
    case 'EROFS':
      return 'folder-not-writable';
    case 'ENOSPC':
    case 'EDQUOT':
      return 'disk-full';
    default:
      return err instanceof DriveSyncError ? err.code : 'unknown';
  }
}

function isWithin(root, target) {
  const norm = (p) => (process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p);
  const rel = path.relative(norm(root), norm(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function createDriveSyncFsOps({ manifestDir, fsp = fs.promises, fetchImpl = globalThis.fetch, allowHttp = false } = {}) {
  async function realRoot(root) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw new DriveSyncError('folder-not-found');
    const real = await fsp.realpath(root);
    const st = await fsp.stat(real);
    if (!st.isDirectory()) throw new DriveSyncError('folder-not-found');
    return real;
  }

  /** Dossier existant, accessible en écriture (vérifié par un fichier témoin, aussitôt retiré). */
  async function validateFolder(root) {
    try {
      const real = await realRoot(root);
      const probe = path.join(real, `.lasco-write-test-${crypto.randomBytes(6).toString('hex')}`);
      const handle = await fsp.open(probe, 'wx');
      await handle.close();
      await fsp.unlink(probe);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errorCode(err) };
    }
  }

  /**
   * Parcourt les dossiers de `relativePath` sous la racine. Aucun lien symbolique ni fichier à la
   * place d'un dossier. `create` crée les dossiers manquants (un à un, jamais au travers d'un lien).
   */
  async function walkParents(root, relativePath, { create }) {
    if (!isConfinedRelativePath(relativePath)) throw new DriveSyncError('path-escape');
    const base = await realRoot(root);
    const segments = relativePath.split('/');
    let dir = base;
    for (const segment of segments.slice(0, -1)) {
      dir = path.join(dir, segment);
      let st = null;
      try {
        st = await fsp.lstat(dir);
      } catch (err) {
        if (!err || err.code !== 'ENOENT') throw err;
      }
      if (!st) {
        if (!create) return { base, dir: null, name: segments[segments.length - 1] };
        try {
          await fsp.mkdir(dir);
        } catch (err) {
          if (!err || err.code !== 'EEXIST') throw err;
        }
        st = await fsp.lstat(dir);
      }
      if (st.isSymbolicLink() || !st.isDirectory()) throw new DriveSyncError('path-escape');
    }
    const realDir = await fsp.realpath(dir);
    if (!isWithin(base, realDir)) throw new DriveSyncError('path-escape');
    return { base, dir: realDir, name: segments[segments.length - 1] };
  }

  async function stat(root, relativePath) {
    try {
      const { dir, name } = await walkParents(root, relativePath, { create: false });
      if (!dir) return { exists: false };
      const st = await fsp.lstat(path.join(dir, name));
      return { exists: true, size: st.size, isSymlink: st.isSymbolicLink(), isFile: st.isFile() };
    } catch (err) {
      if (err && err.code === 'ENOENT') return { exists: false };
      // Chemin refusé : présenté comme occupé, jamais écrit.
      return { exists: true, isSymlink: true, isFile: false };
    }
  }

  function checkUrl(raw) {
    let url;
    try {
      url = new URL(raw);
    } catch (_) {
      throw new DriveSyncError('network');
    }
    if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) throw new DriveSyncError('network');
    if (url.username || url.password) throw new DriveSyncError('network');
    return url;
  }

  /** Télécharge vers `<nom>.lasco-part`, puis crée le fichier final en exclusif : jamais d'écrasement. */
  async function writeFile({ root, relativePath, url, expectedSize }) {
    let part = null;
    try {
      const target = checkUrl(url);
      const { dir, name } = await walkParents(root, relativePath, { create: true });
      const finalPath = path.join(dir, name);
      try {
        await fsp.lstat(finalPath);
        return { ok: false, error: 'exists' };
      } catch (err) {
        if (!err || err.code !== 'ENOENT') throw err;
      }
      part = path.join(dir, `${name}.${crypto.randomBytes(4).toString('hex')}${PART_SUFFIX}`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
      let size = 0;
      try {
        const res = await fetchImpl(target.toString(), { redirect: 'follow', signal: controller.signal });
        if (!res.ok || !res.body) throw new DriveSyncError(res.status === 401 || res.status === 403 ? 'unauthorized' : 'network');
        const out = await fsp.open(part, 'wx');
        try {
          const counter = async function* (source) {
            for await (const chunk of source) {
              size += chunk.length;
              if (size > MAX_FILE_BYTES) throw new DriveSyncError('disk-full');
              yield chunk;
            }
          };
          await pipeline(Readable.fromWeb(res.body), counter, out.createWriteStream());
        } finally {
          await out.close().catch(() => undefined);
        }
      } catch (err) {
        if (err && err.name === 'AbortError') throw new DriveSyncError('network');
        if (err && (err.name === 'TypeError' || err.code === 'ECONNRESET')) throw new DriveSyncError('network');
        throw err;
      } finally {
        clearTimeout(timer);
      }
      if (Number.isFinite(expectedSize) && expectedSize >= 0 && size !== expectedSize) throw new DriveSyncError('network');
      // Création exclusive : `copyFile` en COPYFILE_EXCL échoue si le nom a été pris entre-temps.
      try {
        await fsp.link(part, finalPath);
      } catch (err) {
        if (err && err.code === 'EEXIST') return { ok: false, error: 'exists' };
        // Système de fichiers sans liens physiques (exFAT, certains volumes réseau).
        try {
          await fsp.copyFile(part, finalPath, fs.constants.COPYFILE_EXCL);
        } catch (copyErr) {
          if (copyErr && copyErr.code === 'EEXIST') return { ok: false, error: 'exists' };
          throw copyErr;
        }
      }
      return { ok: true, size };
    } catch (err) {
      return { ok: false, error: errorCode(err) };
    } finally {
      if (part) await fsp.unlink(part).catch(() => undefined);
    }
  }

  /** Manifeste rangé dans les données de Lasco, pas dans le dossier de l'utilisateur. */
  function manifestPath(userId, root) {
    const key = crypto.createHash('sha256').update(`${userId}\0${root}`).digest('hex').slice(0, 32);
    return path.join(manifestDir, `${key}.json`);
  }

  async function readManifest(userId, root) {
    try {
      const data = JSON.parse(await fsp.readFile(manifestPath(userId, root), 'utf8'));
      if (!data || data.version !== 1 || data.userId !== userId || data.rootPath !== root) return null;
      if (!data.entries || typeof data.entries !== 'object') return null;
      return data;
    } catch (_) {
      return null;
    }
  }

  async function writeManifest(manifest) {
    try {
      const file = manifestPath(manifest.userId, manifest.rootPath);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(manifest));
      await fsp.rename(tmp, file);
      return { ok: true };
    } catch (_) {
      return { ok: false };
    }
  }

  return { validateFolder, stat, writeFile, readManifest, writeManifest };
}

/** Ne garde du manifeste envoyé par la page que des entrées bien formées et confinées. */
function sanitizeManifest(raw, { userId, rootPath }) {
  if (!raw || typeof raw !== 'object' || raw.version !== 1) return null;
  if (raw.userId !== userId || raw.rootPath !== rootPath) return null;
  const entries = {};
  const src = raw.entries && typeof raw.entries === 'object' ? raw.entries : {};
  for (const [refId, e] of Object.entries(src).slice(0, 200000)) {
    if (typeof refId !== 'string' || refId.length > 64 || !e || typeof e !== 'object') continue;
    if (typeof e.fileId !== 'string' || e.fileId.length > 64 || !isConfinedRelativePath(e.relativePath)) continue;
    entries[refId] = { fileId: e.fileId, relativePath: e.relativePath, localSize: Number.isFinite(e.localSize) ? e.localSize : 0 };
  }
  return { version: 1, userId, rootPath, entries };
}

module.exports = { createDriveSyncFsOps, sanitizeManifest, isConfinedRelativePath, DriveSyncError, PART_SUFFIX };
