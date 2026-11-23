'use strict';

/**
 * Synchronisation My Drive → dossier de cet ordinateur (internal-portal#2399).
 *
 * Réglage de Desktop (Réglages > My Drive), jamais du portail : le dossier est choisi nativement
 * et le portail ne peut écrire que dans ce dossier. Le dossier est lié au premier compte qui le
 * synchronise (`ownerUserId`) : un autre compte connecté sur ce Desktop ne s'y mélange pas.
 */
const fs = require('fs');
const path = require('path');

const STATUSES = ['disabled', 'syncing', 'up-to-date', 'error'];
const MAX_LABEL = 200;

function cleanString(value, max = 4096) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0') ? value : null;
}

function normalizeLastRun(raw) {
  if (!raw || typeof raw !== 'object' || !STATUSES.includes(raw.status)) return null;
  const count = (n) => (Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0);
  const kinds = Array.isArray(raw.noticeKinds) ? raw.noticeKinds.filter((k) => typeof k === 'string' && k.length < 64).slice(0, 8) : [];
  return {
    status: raw.status,
    downloaded: count(raw.downloaded),
    skipped: count(raw.skipped),
    error: cleanString(raw.error, 64),
    noticeKinds: [...new Set(kinds)],
    at: Number.isFinite(raw.at) ? raw.at : null,
  };
}

function normalizeConfig(raw) {
  const v = raw && typeof raw === 'object' ? raw : {};
  const rootPath = cleanString(v.rootPath) && path.isAbsolute(v.rootPath) ? v.rootPath : null;
  return {
    // Pas de dossier : jamais actif.
    enabled: v.enabled === true && Boolean(rootPath),
    rootPath,
    ownerUserId: rootPath ? cleanString(v.ownerUserId, 128) : null,
    ownerLabel: rootPath ? cleanString(v.ownerLabel, MAX_LABEL) : null,
    lastRun: rootPath ? normalizeLastRun(v.lastRun) : null,
  };
}

function createDriveSyncStore(filePath, fsImpl = fs) {
  let cache = null;
  /** Compte refusé au dernier essai (autre compte que celui du dossier), en mémoire seulement. */
  let rejected = null;
  const listeners = new Set();

  function load() {
    if (cache) return cache;
    try {
      cache = normalizeConfig(JSON.parse(fsImpl.readFileSync(filePath, 'utf8')));
    } catch (_) {
      cache = normalizeConfig(null);
    }
    return cache;
  }

  function save(next, { notify = true } = {}) {
    const prev = load();
    cache = normalizeConfig(next);
    try {
      fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
      fsImpl.writeFileSync(filePath, JSON.stringify(cache));
    } catch (_) {
      // garde la valeur en mémoire même si l'écriture échoue
    }
    const changed = prev.enabled !== cache.enabled || prev.rootPath !== cache.rootPath || prev.ownerUserId !== cache.ownerUserId;
    if (notify && changed) for (const fn of listeners) fn(publicConfig());
    return { ...cache };
  }

  /** Ce que voit le portail : pas d'historique, pas le libellé du compte. */
  function publicConfig() {
    const c = load();
    return { enabled: c.enabled, rootPath: c.rootPath, ownerUserId: c.ownerUserId };
  }

  return {
    get: () => ({ ...load() }),
    publicConfig,
    rejectedAccount: () => rejected,
    /** Nouveau dossier : il n'appartient encore à aucun compte. */
    setFolder(rootPath) {
      const c = load();
      if (c.rootPath === rootPath) return { ...c };
      rejected = null;
      return save({ enabled: c.enabled, rootPath, ownerUserId: null, ownerLabel: null, lastRun: null });
    },
    setEnabled(enabled) {
      const c = load();
      return save({ ...c, enabled: enabled === true && Boolean(c.rootPath) });
    },
    /**
     * Le portail annonce le compte connecté. Le dossier est lié au premier compte ; un autre compte
     * est refusé jusqu'à ce que l'utilisateur choisisse un autre dossier dans les réglages.
     */
    bind(userId, label) {
      const c = load();
      const id = cleanString(userId, 128);
      if (!c.enabled || !c.rootPath) return { ok: false, error: 'disabled' };
      if (!id) return { ok: false, error: 'account-mismatch' };
      if (c.ownerUserId && c.ownerUserId !== id) {
        rejected = { label: cleanString(label, MAX_LABEL) };
        return { ok: false, error: 'account-mismatch' };
      }
      rejected = null;
      const ownerLabel = cleanString(label, MAX_LABEL) || c.ownerLabel;
      if (c.ownerUserId !== id || c.ownerLabel !== ownerLabel) save({ ...c, ownerUserId: id, ownerLabel });
      return { ok: true };
    },
    /** Vrai si le portail peut lire / écrire `root` pour `userId` maintenant. */
    allows(root, userId) {
      const c = load();
      if (!c.enabled || !c.rootPath || root !== c.rootPath) return false;
      return userId === undefined || (Boolean(c.ownerUserId) && c.ownerUserId === userId);
    },
    reportRun(userId, summary, now = Date.now()) {
      const c = load();
      if (!c.rootPath || !c.ownerUserId || c.ownerUserId !== userId) return false;
      const s = summary && typeof summary === 'object' ? summary : {};
      const noticeKinds = Array.isArray(s.notices) ? s.notices.map((n) => n && n.kind) : [];
      save({ ...c, lastRun: { ...s, noticeKinds, at: now } }, { notify: false });
      return true;
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

module.exports = { createDriveSyncStore, normalizeConfig };
