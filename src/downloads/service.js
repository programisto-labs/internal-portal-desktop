'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { sanitizeFilename, uniqueSavePath } = require('./naming');

const PROGRESS_THROTTLE_MS = 250;
const RETRY_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Downloads of the web tabs and of the portal pages (exports CSV, PDF…), docs/downloads.md.
 * Electron is injected: `attach(session, source)` listens to `will-download`.
 *
 * deps:
 * - store: createDownloadsStore()
 * - getDirectory(): folder chosen in Réglages > Téléchargements (exists, else the OS one)
 * - shouldAsk(): « Demander où enregistrer chaque fichier »
 * - fileExists(path), ensureDir(path) → boolean
 * - openPath(path), showItemInFolder(path), openFolder(path)
 * - emit(event): to every portal window ({ type: 'upsert', item } | { type: 'remove', ids } | { type: 'clear', ids })
 * - getSession(source): session to retry a download in
 * - onFinished(path): macOS dock bounce on the Downloads stack
 * - setProgress(fraction): -1 when nothing runs (dock / taskbar progress)
 * - onStarted({ webContents, source }): a download began in this page (an empty tab opened
 *   only for it is closed, like Chrome)
 * - writeFile(path, data): file made by Lasco itself (screenshot, docs/page-capture.md)
 */
function createDownloadService({
  store,
  getDirectory,
  shouldAsk = () => false,
  fileExists,
  ensureDir = () => true,
  openPath,
  showItemInFolder,
  openFolder,
  emit,
  getSession,
  onFinished = () => undefined,
  setProgress = () => undefined,
  onStarted = () => undefined,
  now = () => Date.now(),
  randomId = () => crypto.randomUUID(),
  writeFile = (p, data) => fs.writeFileSync(p, data, { flag: 'wx' }),
}) {
  /** id → { item, record, timer } */
  const live = new Map();
  /** Paths given to downloads still being written (the file may not exist yet). */
  const reserved = new Set();
  /** id of a record being retried → removed once the new download starts. */
  const retrying = new Map();

  function publicRecord(rec) {
    if (!rec) return null;
    return { ...rec, exists: rec.state === 'completed' ? fileExists(rec.savePath) : null };
  }

  function updateProgress() {
    let total = 0;
    let received = 0;
    let running = 0;
    for (const { record } of live.values()) {
      if (record.state !== 'progressing') continue;
      running += 1;
      if (record.totalBytes > 0) {
        total += record.totalBytes;
        received += Math.min(record.receivedBytes, record.totalBytes);
      }
    }
    if (!running) setProgress(-1);
    // Unknown sizes: indeterminate (Electron draws it for a value > 1).
    else setProgress(total > 0 ? received / total : 2);
  }

  function snapshot(item, record) {
    const state = item.getState();
    return {
      ...record,
      savePath: item.getSavePath() || record.savePath,
      filename: record.filename,
      totalBytes: item.getTotalBytes(),
      receivedBytes: item.getReceivedBytes(),
      mimeType: item.getMimeType() || record.mimeType,
      state,
      paused: state === 'progressing' && item.isPaused(),
      canResume: item.canResume(),
      bytesPerSecond: typeof item.getCurrentBytesPerSecond === 'function' ? item.getCurrentBytesPerSecond() : 0,
    };
  }

  function publish(id, { immediate = false } = {}) {
    const entry = live.get(id);
    if (!entry) return;
    const send = () => {
      entry.timer = null;
      const saved = store.upsert(entry.record);
      if (saved) emit({ type: 'upsert', item: publicRecord(saved) });
      updateProgress();
    };
    if (immediate) {
      if (entry.timer) clearTimeout(entry.timer);
      send();
      return;
    }
    if (!entry.timer) {
      entry.timer = setTimeout(send, PROGRESS_THROTTLE_MS);
      if (entry.timer.unref) entry.timer.unref();
    }
  }

  function chooseDirectory() {
    const dir = getDirectory();
    return dir && ensureDir(dir) ? dir : null;
  }

  /** `will-download` of one session. */
  function handleDownload(item, source) {
    const id = randomId();
    const filename = sanitizeFilename(item.getFilename());
    const dir = chooseDirectory();
    let savePath = '';
    if (shouldAsk() || !dir) {
      // Native « Enregistrer sous » ; the path is known once the person has chosen.
      item.setSaveDialogOptions({ defaultPath: dir ? path.join(dir, filename) : filename });
    } else {
      savePath = uniqueSavePath(dir, filename, (p) => reserved.has(p) || fileExists(p));
      reserved.add(savePath);
      item.setSavePath(savePath);
    }
    const retryOf = retrying.get(item.getURL());
    if (retryOf) retrying.delete(item.getURL());

    const entry = {
      item,
      timer: null,
      announced: false,
      record: {
        id,
        url: item.getURL(),
        filename,
        savePath,
        mimeType: item.getMimeType(),
        totalBytes: item.getTotalBytes(),
        receivedBytes: 0,
        state: 'progressing',
        paused: false,
        canResume: false,
        bytesPerSecond: 0,
        startTime: now(),
        endTime: null,
        source,
        error: null,
      },
    };
    live.set(id, entry);

    const announce = () => {
      // Shown in the list only once it has a path (a cancelled « Enregistrer sous » never shows).
      if (entry.announced || !entry.record.savePath) return;
      entry.announced = true;
      entry.record.filename = path.basename(entry.record.savePath);
      if (retryOf && store.remove(retryOf)) emit({ type: 'remove', ids: [retryOf] });
    };

    item.on('updated', (_event, state) => {
      entry.record = snapshot(item, entry.record);
      if (state === 'interrupted') entry.record.error = 'network';
      else entry.record.error = null;
      announce();
      if (entry.announced) publish(id);
    });
    item.once('done', (_event, state) => {
      entry.record = { ...snapshot(item, entry.record), state, paused: false, endTime: now(), bytesPerSecond: 0 };
      if (state === 'interrupted') entry.record.error = entry.record.error || 'failed';
      if (state === 'completed') entry.record.error = null;
      reserved.delete(savePath);
      announce();
      if (entry.announced) {
        publish(id, { immediate: true });
        if (state === 'completed') onFinished(entry.record.savePath);
      }
      if (entry.timer) clearTimeout(entry.timer);
      live.delete(id);
      updateProgress();
    });

    announce();
    if (entry.announced) publish(id, { immediate: true });
  }

  function attach(targetSession, source) {
    targetSession.on('will-download', (_event, item, webContents) => {
      handleDownload(item, source);
      try {
        onStarted({ webContents, source });
      } catch (_) {
        // Never let the tab bookkeeping break a download.
      }
    });
  }

  /**
   * File made by Lasco (screenshot) : written in the downloads folder with the same naming
   * (never overwrites) and added to the list as a finished download.
   */
  function saveFile({ name, data, mimeType = '', url = '', source = 'web' } = {}) {
    const dir = chooseDirectory();
    if (!dir || !data) return { ok: false, error: 'no-directory' };
    const savePath = uniqueSavePath(dir, sanitizeFilename(name), (p) => reserved.has(p) || fileExists(p));
    try {
      writeFile(savePath, data);
    } catch (_) {
      return { ok: false, error: 'write-failed' };
    }
    const at = now();
    const saved = store.upsert({
      id: randomId(),
      url,
      filename: path.basename(savePath),
      savePath,
      mimeType,
      totalBytes: data.length,
      receivedBytes: data.length,
      state: 'completed',
      paused: false,
      canResume: false,
      bytesPerSecond: 0,
      startTime: at,
      endTime: at,
      source,
      error: null,
    });
    if (!saved) return { ok: false, error: 'write-failed' };
    const item = publicRecord(saved);
    emit({ type: 'upsert', item });
    onFinished(savePath);
    return { ok: true, item };
  }

  // --- Actions of the page (by id: the page never names a path) ---

  function list(payload = {}) {
    const res = store.list(payload);
    return { ok: true, items: res.items.map(publicRecord), total: res.total, directory: getDirectory() };
  }

  function liveItem(id) {
    const entry = typeof id === 'string' ? live.get(id) : null;
    return entry ? entry.item : null;
  }

  function pause({ id } = {}) {
    const item = liveItem(id);
    if (!item || item.isPaused()) return { ok: false };
    item.pause();
    live.get(id).record.paused = true;
    publish(id, { immediate: true });
    return { ok: true };
  }

  function resume({ id } = {}) {
    const item = liveItem(id);
    if (!item || !item.canResume()) return { ok: false };
    item.resume();
    live.get(id).record.paused = false;
    publish(id, { immediate: true });
    return { ok: true };
  }

  function cancel({ id } = {}) {
    const item = liveItem(id);
    if (!item) return { ok: false };
    item.cancel();
    return { ok: true };
  }

  function retry({ id } = {}) {
    const rec = store.get(id);
    if (!rec || rec.state === 'completed' || rec.state === 'progressing') return { ok: false };
    let url;
    try {
      url = new URL(rec.url);
    } catch (_) {
      return { ok: false, error: 'not-retryable' };
    }
    // Exports built in the page (blob:, data:) cannot be fetched again.
    if (!RETRY_PROTOCOLS.has(url.protocol)) return { ok: false, error: 'not-retryable' };
    const targetSession = getSession(rec.source);
    if (!targetSession) return { ok: false };
    retrying.set(url.href, rec.id);
    targetSession.downloadURL(url.href);
    return { ok: true };
  }

  function open({ id } = {}) {
    const rec = store.get(id);
    if (!rec || rec.state !== 'completed' || !fileExists(rec.savePath)) return { ok: false, error: 'missing' };
    openPath(rec.savePath);
    return { ok: true };
  }

  function show({ id } = {}) {
    const rec = store.get(id);
    if (!rec) return { ok: false };
    if (fileExists(rec.savePath)) showItemInFolder(rec.savePath);
    else openFolder(path.dirname(rec.savePath));
    return { ok: true };
  }

  function remove({ id } = {}) {
    if (!store.remove(id)) return { ok: false };
    emit({ type: 'remove', ids: [id] });
    return { ok: true };
  }

  function clear() {
    const ids = store.clear();
    emit({ type: 'clear', ids });
    return { ok: true, removed: ids.length };
  }

  function openDirectory() {
    const dir = getDirectory();
    if (!dir) return { ok: false };
    openFolder(dir);
    return { ok: true };
  }

  return {
    attach,
    handleDownload,
    saveFile,
    list,
    pause,
    resume,
    cancel,
    retry,
    open,
    show,
    remove,
    clear,
    openDirectory,
    activeCount: () => live.size,
    flush: () => store.flush(),
  };
}

module.exports = { createDownloadService };
