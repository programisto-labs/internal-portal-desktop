'use strict';

/**
 * Saved tab session (docs/tab-model.md): the tab model written to `<userData>/tab-session.json`,
 * debounced, atomically (temporary file then rename), and flushed at quit. A corrupt or missing
 * file starts an empty session. Never in a private window (no model there).
 */

const fs = require('fs');
const path = require('path');

const WRITE_DELAY_MS = 400;

function createTabSessionStore({ dir, fileName = 'tab-session.json', fsImpl = fs } = {}) {
  const file = path.join(dir, fileName);
  let timer = null;
  let getData = null;

  function read() {
    try {
      return JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    } catch (_) {
      return null;
    }
  }

  function writeNow() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!getData) return;
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fsImpl.mkdirSync(dir, { recursive: true });
      fsImpl.writeFileSync(tmp, JSON.stringify(getData()), { mode: 0o600 });
      fsImpl.renameSync(tmp, file);
    } catch (err) {
      try {
        fsImpl.unlinkSync(tmp);
      } catch (_) {
        // Nothing to clean.
      }
      console.warn('[tab-session] write failed:', err && err.message);
    }
  }

  return {
    file,
    read,
    /** `source()` returns the data to save. */
    bind(source) {
      getData = source;
    },
    schedule() {
      if (timer) return;
      timer = setTimeout(writeNow, WRITE_DELAY_MS);
      if (timer && typeof timer.unref === 'function') timer.unref();
    },
    flush: writeNow,
  };
}

module.exports = { createTabSessionStore, WRITE_DELAY_MS };
