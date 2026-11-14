'use strict';

/**
 * File operations inside a code project, shared by the IDE and the agent operations.
 * Paths are project-relative and resolved by ./paths (real root, no `..`, no `.git`).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HostOpsError, isWithin, lstatOrNull } = require('../host-ops/paths');
const { resolveExisting, resolveWritable, ensureParents, splitRelative, toRelative, isSensitiveFile } = require('./paths');

/** Editor limit: larger files open read-only through the terminal or another editor. */
const MAX_EDITOR_BYTES = 5 * 1024 * 1024;
const MAX_LIST_ENTRIES = 5000;
const MAX_QUICK_OPEN = 50000;
const MAX_SEARCH_RESULTS = 2000;
const MAX_SEARCH_LINE = 400;

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** `null` for binary or non UTF-8 content. */
function decodeText(buffer) {
  const probe = buffer.subarray(0, Math.min(buffer.length, 8000));
  if (probe.includes(0)) return null;
  try {
    return utf8Decoder.decode(buffer);
  } catch (_) {
    return null;
  }
}

function compareEntries(a, b) {
  const ad = a.type === 'dir' ? 0 : 1;
  const bd = b.type === 'dir' ? 0 : 1;
  if (ad !== bd) return ad - bd;
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

function createFileOps({ git, fsp = fs.promises, platform = process.platform, trashItem = null }) {
  async function ignoredSet(root, relPaths) {
    if (!relPaths.length) return new Set();
    try {
      const res = await git.run(root, ['check-ignore', '-z', '--stdin'], { input: relPaths.join('\0') + '\0' });
      if (res.code !== 0 && res.code !== 1) return new Set();
      return new Set(String(res.stdout).split('\0').filter(Boolean));
    } catch (_) {
      return new Set();
    }
  }

  async function listDir(root, rel) {
    const dir = await resolveExisting(fsp, root, rel, platform);
    if (!dir.stat.isDirectory()) throw new HostOpsError('not_a_directory', 'Ce chemin n’est pas un dossier.');
    const dirents = await fsp.readdir(dir.abs, { withFileTypes: true });
    const relDir = toRelative(root, dir.abs);
    const entries = [];
    for (const d of dirents) {
      if (d.name === '.git') continue;
      if (entries.length >= MAX_LIST_ENTRIES) break;
      const entryRel = relDir ? `${relDir}/${d.name}` : d.name;
      const abs = path.join(dir.abs, d.name);
      if (d.isSymbolicLink()) {
        let type = 'external';
        try {
          const real = await fsp.realpath(abs);
          if (isWithin(root, real, platform)) {
            const st = await fsp.stat(real);
            type = st.isDirectory() ? 'dir' : 'file';
          }
        } catch (_) {
          type = 'broken';
        }
        entries.push({ name: d.name, path: entryRel, type, symlink: true });
      } else if (d.isDirectory()) {
        entries.push({ name: d.name, path: entryRel, type: 'dir' });
      } else if (d.isFile()) {
        entries.push({ name: d.name, path: entryRel, type: 'file' });
      }
    }
    const ignored = await ignoredSet(
      root,
      entries.map((e) => (e.type === 'dir' ? `${e.path}/` : e.path))
    );
    for (const e of entries) {
      if (ignored.has(e.path) || ignored.has(`${e.path}/`)) e.ignored = true;
    }
    entries.sort(compareEntries);
    return { path: relDir, entries, truncated: dirents.length > MAX_LIST_ENTRIES };
  }

  async function readFile(root, rel, { maxBytes = MAX_EDITOR_BYTES } = {}) {
    const file = await resolveExisting(fsp, root, rel, platform);
    if (!file.stat.isFile()) throw new HostOpsError('not_a_file', 'Ce chemin n’est pas un fichier.');
    const base = { path: toRelative(root, file.abs), size: file.stat.size, mtimeMs: file.stat.mtimeMs };
    if (file.stat.size > maxBytes) return { ...base, tooLarge: true, binary: false, content: null };
    const buffer = await fsp.readFile(file.abs);
    const content = decodeText(buffer);
    if (content === null) return { ...base, binary: true, content: null };
    return { ...base, binary: false, content, sha256: sha256(buffer) };
  }

  /**
   * Atomic write: temp file in the same folder, then rename. `expectedMtimeMs` (from the last read)
   * detects a change on disk made meanwhile (another editor, an agent, git checkout).
   */
  async function writeFile(root, rel, content, { expectedMtimeMs, createOnly = false } = {}) {
    if (typeof content !== 'string') throw new HostOpsError('invalid_request', 'Contenu invalide.');
    const data = Buffer.from(content, 'utf8');
    if (data.length > MAX_EDITOR_BYTES * 2) throw new HostOpsError('too_large', 'Fichier trop volumineux.');
    const target = await resolveWritable(fsp, root, rel, platform);
    if (createOnly && target.exists) throw new HostOpsError('destination_exists', 'Ce fichier existe déjà.');
    if (target.exists && expectedMtimeMs !== undefined && expectedMtimeMs !== null) {
      if (Math.abs(target.stat.mtimeMs - Number(expectedMtimeMs)) > 1) {
        throw new HostOpsError('changed_on_disk', 'Le fichier a été modifié sur le disque depuis son ouverture.');
      }
    }
    if (!target.exists && expectedMtimeMs !== undefined && expectedMtimeMs !== null) {
      throw new HostOpsError('changed_on_disk', 'Le fichier a été supprimé ou déplacé depuis son ouverture.');
    }
    await ensureParents(fsp, target);
    const dir = path.dirname(target.abs);
    const tmp = path.join(dir, `.${path.basename(target.abs)}.lasco-${crypto.randomBytes(4).toString('hex')}.tmp`);
    const mode = target.exists ? target.stat.mode & 0o7777 : 0o666;
    try {
      await fsp.writeFile(tmp, data, { flag: 'wx', mode });
      if (target.exists) await fsp.chmod(tmp, mode).catch(() => {});
      if (createOnly) {
        // No clobber: link fails if the name appeared meanwhile.
        await fsp.link(tmp, target.abs);
        await fsp.unlink(tmp);
      } else {
        const now = await lstatOrNull(fsp, target.abs);
        if (now && now.isSymbolicLink()) throw new HostOpsError('symlink_rejected', 'Lien symbolique refusé pour une écriture.');
        await fsp.rename(tmp, target.abs);
      }
    } catch (err) {
      await fsp.unlink(tmp).catch(() => {});
      if (err && err.code === 'EEXIST') throw new HostOpsError('destination_exists', 'Ce fichier existe déjà.');
      throw err;
    }
    const st = await fsp.stat(target.abs);
    const written = await fsp.readFile(target.abs);
    if (!written.equals(data)) throw new HostOpsError('verification_failed', 'Le contenu relu ne correspond pas au contenu écrit.');
    return { path: target.rel, size: st.size, mtimeMs: st.mtimeMs, sha256: sha256(written), created: !target.exists };
  }

  async function createFolder(root, rel) {
    const segments = splitRelative(rel, { allowRoot: false });
    const target = await resolveWritable(fsp, root, `${segments.join('/')}/.lasco-probe`, platform);
    if (target.missingDirs.length === 0) throw new HostOpsError('destination_exists', 'Ce dossier existe déjà.');
    await ensureParents(fsp, target);
    const abs = path.dirname(target.abs);
    return { path: toRelative(root, abs) };
  }

  async function rename(root, fromRel, toRel) {
    const from = await resolveExisting(fsp, root, fromRel, platform);
    const fromLst = await fsp.lstat(path.join(root, ...splitRelative(fromRel)));
    if (fromLst.isSymbolicLink()) throw new HostOpsError('symlink_rejected', 'Renommez les liens symboliques depuis le terminal.');
    const to = await resolveWritable(fsp, root, toRel, platform);
    if (to.exists || (await lstatOrNull(fsp, to.abs))) throw new HostOpsError('destination_exists', 'Un élément porte déjà ce nom.');
    if (from.stat.isDirectory() && isWithin(from.abs, path.dirname(to.abs), platform)) {
      throw new HostOpsError('invalid_path', 'Impossible de déplacer un dossier dans lui-même.');
    }
    await ensureParents(fsp, to);
    await fsp.rename(from.abs, to.abs);
    return { from: toRelative(root, from.abs), to: to.rel };
  }

  /** Move to the system trash (recoverable). */
  async function trash(root, rel) {
    if (!trashItem) throw new HostOpsError('unsupported_operation', 'Corbeille indisponible.');
    const segments = splitRelative(rel, { allowRoot: false });
    const abs = path.join(root, ...segments);
    const st = await lstatOrNull(fsp, abs);
    if (!st) throw new HostOpsError('not_found', 'Introuvable.');
    const parentReal = await fsp.realpath(path.dirname(abs));
    if (!isWithin(root, parentReal, platform)) {
      throw new HostOpsError('outside_project', 'Ce chemin pointe hors du projet.');
    }
    const real = path.join(parentReal, path.basename(abs));
    if (real === root) throw new HostOpsError('forbidden_path', 'Impossible de supprimer la racine du projet.');
    await trashItem(real);
    return { path: toRelative(root, real) };
  }

  async function quickOpen(root) {
    const res = await git.run(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    if (res.code !== 0) throw new HostOpsError('git_failed', 'Liste des fichiers indisponible (ce dossier est-il encore un dépôt git ?).');
    const seen = new Set();
    for (const p of String(res.stdout).split('\0')) {
      if (p && !seen.has(p)) seen.add(p);
      if (seen.size >= MAX_QUICK_OPEN) break;
    }
    return { files: [...seen], truncated: seen.size >= MAX_QUICK_OPEN };
  }

  /**
   * `git grep` over tracked and untracked (non ignored) text files.
   * `excludeSensitive` drops environment files and keys (agent searches).
   */
  async function search(root, query, { regex = false, caseSensitive = false, pathspec, maxResults = 500, excludeSensitive = false } = {}) {
    if (typeof query !== 'string' || !query || query.length > 1000) throw new HostOpsError('invalid_request', 'Recherche invalide.');
    const limit = Math.max(1, Math.min(Number(maxResults) || 500, MAX_SEARCH_RESULTS));
    const args = ['grep', '-n', '-I', '-z', '--untracked', '--exclude-standard', '--max-count=200', regex ? '-E' : '-F'];
    if (!caseSensitive) args.push('-i');
    args.push('-e', query, '--');
    if (pathspec !== undefined && pathspec !== null && pathspec !== '') {
      if (typeof pathspec !== 'string' || pathspec.length > 500 || pathspec.includes('\0') || pathspec.startsWith('/') || pathspec.split('/').includes('..')) {
        throw new HostOpsError('invalid_path', 'Filtre de chemin invalide.');
      }
      args.push(pathspec);
    }
    const res = await git.run(root, args);
    if (res.code === 1) return { results: [], truncated: false };
    if (res.code !== 0) {
      throw new HostOpsError('search_failed', String(res.stderr || '').includes('regex') ? 'Expression régulière invalide.' : 'Recherche impossible.');
    }
    const results = [];
    let truncated = false;
    for (const line of String(res.stdout).split('\n')) {
      if (!line) continue;
      const [file, lineNo, ...rest] = line.split('\0');
      if (!file || !lineNo) continue;
      if (excludeSensitive && isSensitiveFile(file)) continue;
      if (results.length >= limit) {
        truncated = true;
        break;
      }
      const text = rest.join('\0');
      results.push({ path: file, line: Number(lineNo), text: text.length > MAX_SEARCH_LINE ? `${text.slice(0, MAX_SEARCH_LINE)}…` : text });
    }
    return { results, truncated };
  }

  return { listDir, readFile, writeFile, createFolder, rename, trash, quickOpen, search, decodeText, sha256 };
}

module.exports = { createFileOps, decodeText, sha256, MAX_EDITOR_BYTES };
