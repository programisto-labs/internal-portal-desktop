'use strict';

/**
 * Mises à jour imposées (docs/updates.md) : dès qu'une version est téléchargée, Lasco redémarre pour l'installer,
 * pour éviter un parc d'applications anciennes. Jamais au milieu d'un travail : un agent qui répond, un harnais
 * qui tourne ou une confirmation en attente repoussent le redémarrage, au plus `maxDeferMs`.
 */

const FORCED_UPDATE_NOTICE_MS = 60 * 1000;
const FORCED_UPDATE_MAX_DEFER_MS = 2 * 60 * 60 * 1000;
const FORCED_UPDATE_TICK_MS = 15 * 1000;

/**
 * @param {{ downloadedAt: number, now: number, busy: boolean, noticeMs?: number, maxDeferMs?: number }} input
 * @returns {'wait' | 'install'}
 */
function decideForcedInstall({ downloadedAt, now, busy, noticeMs = FORCED_UPDATE_NOTICE_MS, maxDeferMs = FORCED_UPDATE_MAX_DEFER_MS }) {
  if (!Number.isFinite(downloadedAt) || !Number.isFinite(now)) return 'wait';
  const elapsed = now - downloadedAt;
  if (elapsed < noticeMs) return 'wait';
  if (busy && elapsed < maxDeferMs) return 'wait';
  return 'install';
}

/**
 * Planifie l'installation d'une version téléchargée. `install` n'est appelé qu'une fois.
 * @param {{ isBusy: () => boolean, install: () => void, notify?: (info: { version: string | null }) => void,
 *   now?: () => number, setInterval?: typeof setInterval, clearInterval?: typeof clearInterval,
 *   tickMs?: number, noticeMs?: number, maxDeferMs?: number | (() => number) }} deps
 */
function createForcedUpdateScheduler(deps) {
  const now = deps.now || Date.now;
  const every = deps.setInterval || setInterval;
  const stop = deps.clearInterval || clearInterval;
  let timer = null;
  let downloadedAt = null;
  let done = false;

  function tick() {
    if (done || downloadedAt === null) return;
    let busy = false;
    try {
      busy = Boolean(deps.isBusy());
    } catch (_) {
      busy = false;
    }
    const decision = decideForcedInstall({
      downloadedAt,
      now: now(),
      busy,
      noticeMs: deps.noticeMs,
      // Nombre, ou fonction relue à chaque tour (plancher de sécurité : docs/security.md).
      maxDeferMs: typeof deps.maxDeferMs === 'function' ? deps.maxDeferMs() : deps.maxDeferMs,
    });
    if (decision !== 'install') return;
    done = true;
    if (timer) stop(timer);
    timer = null;
    deps.install();
  }

  return {
    /** Une version est prête : prévenir, puis installer dès que possible. */
    onDownloaded(info) {
      if (done || downloadedAt !== null) return;
      downloadedAt = now();
      if (deps.notify) deps.notify({ version: (info && info.version) || null });
      timer = every(tick, deps.tickMs || FORCED_UPDATE_TICK_MS);
      if (timer && typeof timer.unref === 'function') timer.unref();
    },
    tick,
    pending: () => downloadedAt !== null && !done,
    cancel() {
      if (timer) stop(timer);
      timer = null;
      done = true;
    },
  };
}

module.exports = {
  FORCED_UPDATE_NOTICE_MS,
  FORCED_UPDATE_MAX_DEFER_MS,
  FORCED_UPDATE_TICK_MS,
  decideForcedInstall,
  createForcedUpdateScheduler,
};
