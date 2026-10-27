'use strict';

const fs = require('fs');
const path = require('path');
const { sanitizeBrowserUrl } = require('./url');

const MAX_ENTRIES = 5000;
const DEFAULT_SUGGEST_LIMIT = 8;
const MAX_SUGGEST_LIMIT = 20;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
const SAVE_DELAY_MS = 1000;
const MAX_TITLE_LENGTH = 300;

/** Strip scheme and leading www. so "https://www.a.com/x" matches "a.com/x". */
function normalizeForMatch(url) {
  return String(url || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '');
}

/** Visits are keyed without the fragment so in-page anchors don't create duplicates. */
function historyKey(urlString) {
  const safe = sanitizeBrowserUrl(urlString);
  if (!safe) return null;
  const parsed = new URL(safe);
  parsed.hash = '';
  return parsed.href;
}

function frecency(entry, now) {
  const ageDays = Math.max(0, (now - entry.lastVisit) / 86400000);
  const recency = 1 / (1 + ageDays / 7);
  return Math.log2(1 + entry.visitCount) * (0.5 + recency);
}

function scoreEntry(entry, query, now) {
  const needle = normalizeForMatch(query).trim();
  if (!needle) return -1;
  const target = normalizeForMatch(entry.url);
  const title = String(entry.title || '').toLowerCase();
  const tokens = needle.split(/\s+/).filter(Boolean);

  let match = 0;
  if (target.startsWith(needle)) match = 100;
  else if (target.includes(`.${needle}`) || target.includes(`/${needle}`)) match = 60;
  else if (tokens.every((t) => target.includes(t) || title.includes(t))) match = 30;
  else return -1;

  return match + frecency(entry, now);
}

/**
 * Persistent browsing history for the desktop browser tabs.
 * Pure Node (no Electron) so it can be unit-tested; file I/O goes through `fsImpl`.
 */
function createHistoryStore({
  filePath,
  fsImpl = fs,
  now = () => Date.now(),
  maxEntries = MAX_ENTRIES,
  saveDelayMs = SAVE_DELAY_MS,
} = {}) {
  /** @type {Map<string, { url: string, title: string, visitCount: number, lastVisit: number }>} */
  const entries = new Map();
  let loaded = false;
  let saveTimer = null;

  function load() {
    if (loaded) return;
    loaded = true;
    if (!filePath) return;
    try {
      const raw = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
      const list = Array.isArray(raw) ? raw : raw && raw.entries;
      for (const item of Array.isArray(list) ? list : []) {
        const key = item && historyKey(item.url);
        if (!key) continue;
        entries.set(key, {
          url: key,
          title: String(item.title || '').slice(0, MAX_TITLE_LENGTH),
          visitCount: Math.max(1, Number(item.visitCount) || 1),
          lastVisit: Number(item.lastVisit) || 0,
        });
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
      fsImpl.writeFileSync(tmp, JSON.stringify({ version: 1, entries: [...entries.values()] }));
      fsImpl.renameSync(tmp, filePath);
    } catch (_) {
      // History is best-effort; never break navigation on disk errors.
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
    if (entries.size <= maxEntries) return;
    const sorted = [...entries.values()].sort((a, b) => a.lastVisit - b.lastVisit);
    for (const entry of sorted.slice(0, entries.size - maxEntries)) {
      entries.delete(entry.url);
    }
  }

  /** Record a main-frame visit. Returns true when the URL was stored. */
  function recordVisit(urlString, title) {
    load();
    const key = historyKey(urlString);
    if (!key) return false;
    const existing = entries.get(key);
    const cleanTitle = String(title || '').slice(0, MAX_TITLE_LENGTH);
    if (existing) {
      existing.visitCount += 1;
      existing.lastVisit = now();
      if (cleanTitle) existing.title = cleanTitle;
    } else {
      entries.set(key, { url: key, title: cleanTitle, visitCount: 1, lastVisit: now() });
      prune();
    }
    scheduleSave();
    return true;
  }

  /** Update the title of an already recorded page (titles often arrive after navigation). */
  function updateTitle(urlString, title) {
    load();
    const key = historyKey(urlString);
    const existing = key && entries.get(key);
    const cleanTitle = String(title || '').slice(0, MAX_TITLE_LENGTH);
    if (!existing || !cleanTitle || existing.title === cleanTitle) return false;
    existing.title = cleanTitle;
    scheduleSave();
    return true;
  }

  function suggest(query, limit = DEFAULT_SUGGEST_LIMIT) {
    load();
    const max = Math.min(MAX_SUGGEST_LIMIT, Math.max(1, Math.floor(Number(limit)) || DEFAULT_SUGGEST_LIMIT));
    const t = now();
    return [...entries.values()]
      .map((entry) => ({ entry, score: scoreEntry(entry, query, t) }))
      .filter((r) => r.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, max)
      .map(({ entry }) => ({ ...entry }));
  }

  /** Most recent first. `query` optionally filters by URL/title substring. */
  function list({ query = '', limit = DEFAULT_LIST_LIMIT, offset = 0 } = {}) {
    load();
    const max = Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(Number(limit)) || DEFAULT_LIST_LIMIT));
    const skip = Math.max(0, Math.floor(Number(offset)) || 0);
    const needle = String(query || '').trim().toLowerCase();
    const all = [...entries.values()]
      .filter((e) => !needle || e.url.toLowerCase().includes(needle) || e.title.toLowerCase().includes(needle))
      .sort((a, b) => b.lastVisit - a.lastVisit);
    return { items: all.slice(skip, skip + max).map((e) => ({ ...e })), total: all.length };
  }

  function remove(urlString) {
    load();
    const key = historyKey(urlString);
    if (!key || !entries.delete(key)) return false;
    scheduleSave();
    return true;
  }

  function clear() {
    load();
    entries.clear();
    flush();
  }

  return { recordVisit, updateTitle, suggest, list, remove, clear, flush };
}

module.exports = { createHistoryStore, historyKey, normalizeForMatch, MAX_ENTRIES };
