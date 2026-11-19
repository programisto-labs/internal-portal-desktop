'use strict';

/**
 * Real terminals (pseudo-terminals through node-pty) for the Lasco Code workspace.
 *
 * The user's interactive login shell, started in the project root with the user's rights. Output is
 * batched (~60 fps) and kept in a bounded scrollback so the IDE can re-attach after its view is
 * remounted. Sessions belong to the web contents that created them and are killed with it.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HostOpsError } = require('../host-ops/paths');

const MAX_SESSIONS = 12;
const SCROLLBACK_CHARS = 256 * 1024;
const FLUSH_MS = 16;
const MAX_INPUT_CHARS = 64 * 1024;
const SESSION_ID_RE = /^t_[a-f0-9]{12}$/;

let ptyModule;
let ptyLoadError = null;

/** npm drops the exec bit of node-pty's spawn-helper (macOS/Linux): restore it when we can. */
function ensureSpawnHelperExecutable(ptyDir, platform = process.platform) {
  if (platform === 'win32' || !ptyDir) return;
  const candidates = [
    path.join(ptyDir, 'build', 'Release', 'spawn-helper'),
    path.join(ptyDir, 'prebuilds', `${platform}-${process.arch}`, 'spawn-helper'),
  ].map((p) => p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`));
  for (const helper of candidates) {
    try {
      const st = fs.statSync(helper);
      if ((st.mode & 0o111) === 0) fs.chmodSync(helper, st.mode | 0o755);
    } catch (_) {
      // missing candidate or read-only bundle (packaged builds ship it executable)
    }
  }
}

function loadPty() {
  if (ptyModule || ptyLoadError) return ptyModule || null;
  try {
    const pkg = require.resolve('node-pty/package.json');
    ensureSpawnHelperExecutable(path.dirname(pkg));
    ptyModule = require('node-pty');
  } catch (err) {
    ptyLoadError = err;
    ptyModule = null;
  }
  return ptyModule;
}

function defaultShell(env, platform) {
  if (platform === 'win32') return { file: env.COMSPEC && /powershell|pwsh/i.test(env.COMSPEC) ? env.COMSPEC : 'powershell.exe', args: ['-NoLogo'] };
  const shell = env.SHELL && path.isAbsolute(env.SHELL) ? env.SHELL : platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
  return { file: shell, args: ['-l'] };
}

function clampSize(value, min, max, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function createTerminalManager({ getEnv, platform = process.platform, ptyImpl } = {}) {
  /** id -> session */
  const sessions = new Map();

  function pty() {
    return ptyImpl || loadPty();
  }

  function isAvailable() {
    return Boolean(pty());
  }

  function emit(session, channel, payload) {
    const wc = session.webContents;
    if (wc && !wc.isDestroyed()) wc.send(channel, payload);
  }

  function flush(session) {
    session.flushTimer = null;
    if (!session.pending) return;
    const data = session.pending;
    session.pending = '';
    emit(session, 'code-terminal-data', { id: session.id, data });
  }

  function owned(webContents, id) {
    if (typeof id !== 'string' || !SESSION_ID_RE.test(id)) return null;
    const session = sessions.get(id);
    return session && session.webContents === webContents ? session : null;
  }

  async function create(webContents, { project, cols, rows, title } = {}) {
    const lib = pty();
    if (!lib) {
      throw new HostOpsError('terminal_unavailable', 'Terminal indisponible dans cette version de Lasco Desktop.');
    }
    if (sessions.size >= MAX_SESSIONS) throw new HostOpsError('busy', `Au plus ${MAX_SESSIONS} terminaux ouverts.`);
    const env = { ...(await getEnv()) };
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';
    env.TERM_PROGRAM = 'Lasco';
    env.LASCO_TERMINAL = '1';
    const { file, args } = defaultShell(env, platform);
    const c = clampSize(cols, 10, 500, 100);
    const r = clampSize(rows, 3, 300, 30);
    let proc;
    try {
      proc = lib.spawn(file, args, { name: 'xterm-256color', cols: c, rows: r, cwd: project.root, env });
    } catch (err) {
      throw new HostOpsError('terminal_unavailable', `Impossible de démarrer le shell (${path.basename(file)}).`);
    }
    const id = `t_${crypto.randomBytes(6).toString('hex')}`;
    const session = {
      id,
      projectId: project.id,
      title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 60) : path.basename(file),
      webContents,
      proc,
      scrollback: '',
      pending: '',
      flushTimer: null,
      exited: false,
      exitCode: null,
      createdAt: Date.now(),
    };
    sessions.set(id, session);
    proc.onData((data) => {
      session.scrollback += data;
      if (session.scrollback.length > SCROLLBACK_CHARS) session.scrollback = session.scrollback.slice(-SCROLLBACK_CHARS);
      session.pending += data;
      if (!session.flushTimer) session.flushTimer = setTimeout(() => flush(session), FLUSH_MS);
    });
    proc.onExit(({ exitCode, signal }) => {
      if (session.flushTimer) clearTimeout(session.flushTimer);
      flush(session);
      session.exited = true;
      session.exitCode = exitCode;
      sessions.delete(id);
      emit(session, 'code-terminal-exit', { id, exitCode, signal: signal || null });
    });
    return { id, projectId: project.id, title: session.title, pid: proc.pid };
  }

  return {
    isAvailable,
    create,

    list(webContents, projectId) {
      return [...sessions.values()]
        .filter((s) => s.webContents === webContents && (!projectId || s.projectId === projectId))
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((s) => ({ id: s.id, projectId: s.projectId, title: s.title }));
    },

    /**
     * Scrollback to replay when the IDE (re-)attaches. Pending output is flushed first: every data
     * event received before this reply is part of the scrollback, every later one is new output.
     */
    attach(webContents, id) {
      const session = owned(webContents, id);
      if (!session) throw new HostOpsError('not_found', 'Terminal introuvable.');
      if (session.flushTimer) clearTimeout(session.flushTimer);
      flush(session);
      // Current pty size: the IDE replays the scrollback at this width, so zsh's end-of-line mark
      // (`%` + COLUMNS-1 spaces + `\r \r`) never wraps in a narrower xterm and leaves a stray `%`.
      return { id: session.id, data: session.scrollback, cols: session.proc.cols, rows: session.proc.rows };
    },

    write(webContents, id, data) {
      const session = owned(webContents, id);
      if (!session || typeof data !== 'string' || !data || data.length > MAX_INPUT_CHARS) return false;
      session.proc.write(data);
      return true;
    },

    resize(webContents, id, cols, rows) {
      const session = owned(webContents, id);
      if (!session) return false;
      try {
        session.proc.resize(clampSize(cols, 10, 500, 100), clampSize(rows, 3, 300, 30));
      } catch (_) {
        return false;
      }
      return true;
    },

    kill(webContents, id) {
      const session = owned(webContents, id);
      if (!session) return false;
      try {
        session.proc.kill();
      } catch (_) {
        // already gone
      }
      sessions.delete(id);
      return true;
    },

    killForWebContents(webContents) {
      for (const session of [...sessions.values()]) {
        if (session.webContents !== webContents) continue;
        try {
          session.proc.kill();
        } catch (_) {
          // already gone
        }
        sessions.delete(session.id);
      }
    },

    killAll() {
      for (const session of sessions.values()) {
        try {
          session.proc.kill();
        } catch (_) {
          // already gone
        }
      }
      sessions.clear();
    },

    size: () => sessions.size,
  };
}

module.exports = { createTerminalManager, ensureSpawnHelperExecutable, defaultShell, SESSION_ID_RE };
