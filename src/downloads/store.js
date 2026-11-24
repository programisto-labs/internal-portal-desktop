'use strict';

const fs = require('fs');
const path = require('path');

const MAX_ENTRIES = 1000;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
const SAVE_DELAY_MS = 1000;
const STATES = ['progressing', 'completed', 'cancelled', 'interrupted'];
const SOURCES = ['web', 'portal'];

function clampInt(value, fallback = 0) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function str(value, max = 4096) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** Keep only known fields with valid types (file on disk may be old or hand-edited). */
function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) return null;
  const savePath = str(raw.savePath);
  if (!savePath) return null;
  return {
    id: raw.id.slice(0, 64),
    url: str(raw.url),
    filename: str(raw.filename, 300) || path.basename(savePath),
    savePath,
    mimeType: str(raw.mimeType, 200),
    totalBytes: clampInt(raw.totalBytes),
    receivedBytes: clampInt(raw.receivedBytes),
    state: STATES.includes(raw.state) ? raw.state : 'interrupted',
    paused: raw.paused === true,
    canResume: raw.canResume === true,
    bytesPerSecond: clampInt(raw.bytesPerSecond),
    startTime: clampInt(raw.startTime),
    endTime: clampInt(raw.endTime) || null,
    source: SOURCES.includes(raw.source) ? raw.source : 'web',
    error: str(raw.error, 100) || null,
  };
}

/**
 * Downloads list of this computer (docs/downloads.md). Pure Node: the Electron side
 * (DownloadItem) lives in service.js. File I/O goes through `fsImpl` for tests.
 */
function createDownloadsStore({
  filePath,
  fsImpl = fs,
  maxEntries = MAX_ENTRIES,
  saveDelayMs = SAVE_DELAY_MS,
} = {}) {
  /** @type {Map<string, ReturnType<typeof normalizeRecord>>} */
  const records = new Map();
  let loaded = false;
  let saveTimer = null;

  function load() {
    if (loaded) return;
    loaded = true;
    if (!filePath) return;
    try {
      const raw = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
      for (const item of Array.isArray(raw && raw.items) ? raw.items : []) {
        const rec = normalizeRecord(item);
        if (!rec) continue;
        // Lasco quit while it was downloading: Electron cannot pick it up again.
        if (rec.state === 'progressing') {
          rec.state = 'interrupted';
          rec.paused = false;
          rec.canResume = false;
          rec.error = rec.error || 'shutdown';
          rec.endTime = rec.endTime || rec.startTime;
        }
        records.set(rec.id, rec);
      }
    } catch (_) {
      // Missing or corrupt file: start empty.
    }
  }

  function writeNow() {
    if (!filePath) return;
    try {
      fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      fsImpl.writeFileSync(tmp, JSON.stringify({ version: 1, items: [...records.values()] }));
      fsImpl.renameSync(tmp, filePath);
    } catch (_) {
      // Best effort: a disk error never breaks a download.
    }
  }

  function scheduleSave() {
    if (!filePath || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      writeNow();
    }, saveDelayMs);
    if (saveTimer.unref) saveTimer.unref();
  }

  function flush() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (loaded) writeNow();
  }

  function prune() {
    if (records.size <= maxEntries) return;
    const finished = [...records.values()]
      .filter((r) => r.state !== 'progressing')
      .sort((a, b) => a.startTime - b.startTime);
    for (const rec of finished.slice(0, records.size - maxEntries)) records.delete(rec.id);
  }

  function upsert(raw) {
    load();
    const rec = normalizeRecord(raw);
    if (!rec) return null;
    records.set(rec.id, rec);
    prune();
    scheduleSave();
    return { ...rec };
  }

  function get(id) {
    load();
    const rec = typeof id === 'string' ? records.get(id) : null;
    return rec ? { ...rec } : null;
  }

  /** Newest first. `query` filters on file name and address. */
  function list({ query = '', limit = DEFAULT_LIST_LIMIT, offset = 0 } = {}) {
    load();
    const max = Math.min(MAX_LIST_LIMIT, Math.max(1, clampInt(limit, DEFAULT_LIST_LIMIT) || DEFAULT_LIST_LIMIT));
    const skip = clampInt(offset);
    const needle = String(query || '').trim().toLowerCase();
    const all = [...records.values()]
      .filter((r) => !needle || r.filename.toLowerCase().includes(needle) || r.url.toLowerCase().includes(needle))
      .sort((a, b) => b.startTime - a.startTime);
    return { items: all.slice(skip, skip + max).map((r) => ({ ...r })), total: all.length };
  }

  /** Downloads still running are never removed from the list. */
  function remove(id) {
    load();
    const rec = typeof id === 'string' ? records.get(id) : null;
    if (!rec || rec.state === 'progressing') return false;
    records.delete(id);
    scheduleSave();
    return true;
  }

  /** Removes every finished download; returns their ids. */
  function clear() {
    load();
    const removed = [];
    for (const rec of records.values()) {
      if (rec.state !== 'progressing') removed.push(rec.id);
    }
    for (const id of removed) records.delete(id);
    flush();
    return removed;
  }

  return { upsert, get, list, remove, clear, flush };
}

module.exports = { createDownloadsStore, normalizeRecord, MAX_ENTRIES };
