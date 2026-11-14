'use strict';

/**
 * Change notifications for an open project: the explorer, open editors and the git panel refresh
 * when files change on disk (an agent edit, a `git checkout` in the terminal, another editor).
 * Recursive fs.watch, debounced; dependency and build folders are ignored, and `.git` only reports
 * that the repository state moved (HEAD, index, refs).
 */

const fs = require('fs');

const DEBOUNCE_MS = 250;
const MAX_PATHS = 300;
const MAX_WATCHERS = 6;

const IGNORED_SEGMENTS = new Set(['node_modules', '.next', '.turbo', '.cache', '.parcel-cache', '__pycache__', '.venv', 'venv', '.gradle', 'target', '.idea', '.DS_Store']);

function classifyChange(rel) {
  const p = String(rel || '').split('\\').join('/');
  if (!p) return { kind: 'unknown' };
  if (p === '.git' || p.startsWith('.git/')) {
    const gitPath = p.slice(5);
    if (gitPath === 'HEAD' || gitPath === 'index' || gitPath.startsWith('refs/') || gitPath === 'MERGE_HEAD' || gitPath === 'FETCH_HEAD') {
      return { kind: 'git' };
    }
    return { kind: 'ignored' };
  }
  if (p.split('/').some((segment) => IGNORED_SEGMENTS.has(segment))) return { kind: 'ignored' };
  return { kind: 'file', path: p };
}

function createWatcherManager({ watchImpl = fs.watch } = {}) {
  /** key `${webContentsId}:${projectId}` -> watcher */
  const watchers = new Map();

  function stopEntry(key) {
    const entry = watchers.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    try {
      entry.handle.close();
    } catch (_) {
      // already closed
    }
    watchers.delete(key);
  }

  return {
    watch(webContents, project) {
      const key = `${webContents.id}:${project.id}`;
      if (watchers.has(key)) {
        // Most recently shown last: eviction drops the project not shown for the longest time.
        const existing = watchers.get(key);
        watchers.delete(key);
        watchers.set(key, existing);
        return true;
      }
      if (watchers.size >= MAX_WATCHERS) {
        // Oldest watcher first: the IDE watches only the projects it shows.
        stopEntry(watchers.keys().next().value);
      }
      const entry = { paths: new Set(), git: false, overflow: false, timer: null, handle: null };
      const flush = () => {
        entry.timer = null;
        if (webContents.isDestroyed()) {
          stopEntry(key);
          return;
        }
        const payload = {
          projectId: project.id,
          paths: entry.overflow ? [] : [...entry.paths],
          overflow: entry.overflow,
          git: entry.git,
        };
        entry.paths.clear();
        entry.git = false;
        entry.overflow = false;
        webContents.send('code-fs-changed', payload);
      };
      try {
        entry.handle = watchImpl(project.root, { recursive: true, persistent: false }, (_event, filename) => {
          const change = classifyChange(filename ? String(filename) : '');
          if (change.kind === 'ignored') return;
          if (change.kind === 'git') entry.git = true;
          else if (change.kind === 'file') {
            if (entry.paths.size >= MAX_PATHS) entry.overflow = true;
            else entry.paths.add(change.path);
            // Any file change may change `git status`.
            entry.git = true;
          } else entry.overflow = true;
          if (!entry.timer) entry.timer = setTimeout(flush, DEBOUNCE_MS);
        });
        entry.handle.on('error', () => stopEntry(key));
      } catch (_) {
        return false;
      }
      watchers.set(key, entry);
      return true;
    },

    unwatch(webContents, projectId) {
      stopEntry(`${webContents.id}:${projectId}`);
    },

    unwatchWebContents(webContents) {
      for (const key of [...watchers.keys()]) {
        if (key.startsWith(`${webContents.id}:`)) stopEntry(key);
      }
    },

    stopAll() {
      for (const key of [...watchers.keys()]) stopEntry(key);
    },
  };
}

module.exports = { createWatcherManager, classifyChange };
