'use strict';

/**
 * Registre des extensions d'un profil (docs/extensions.md) :
 * `userData/extensions/<profil>/registry.json`, fichiers dans `userData/extensions/<profil>/<id>/`.
 *
 * Entrée : `{ id, source: 'store' | 'unpacked', path, version, enabled, disabledReason, pinned,
 * siteAccess: 'all' | 'specific' | 'click', sites: [origine], installedAt, updatedAt,
 * pendingPermissions?, pendingPath?, rulesets?: { [id]: bool } }`.
 */

const fs = require('fs');
const path = require('path');

const REGISTRY_VERSION = 1;
const SITE_ACCESS = new Set(['all', 'specific', 'click']);

function sanitizeProfileId(profileId) {
  const value = typeof profileId === 'string' && profileId.trim() ? profileId.trim() : 'default';
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'default';
}

function normalizeOrigin(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch (_) {
    return null;
  }
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null;
  if (!/^[a-p]{32}$/.test(raw.id)) return null;
  const source = raw.source === 'unpacked' ? 'unpacked' : 'store';
  if (typeof raw.path !== 'string' || !raw.path) return null;
  return {
    id: raw.id,
    source,
    path: raw.path,
    version: typeof raw.version === 'string' ? raw.version : '',
    enabled: raw.enabled !== false,
    disabledReason: typeof raw.disabledReason === 'string' ? raw.disabledReason : null,
    pinned: raw.pinned === true,
    siteAccess: SITE_ACCESS.has(raw.siteAccess) ? raw.siteAccess : 'all',
    sites: Array.isArray(raw.sites) ? [...new Set(raw.sites.map(normalizeOrigin).filter(Boolean))] : [],
    installedAt: Number(raw.installedAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Number(raw.installedAt) || Date.now(),
    pendingPermissions: Array.isArray(raw.pendingPermissions) ? raw.pendingPermissions : null,
    pendingPath: typeof raw.pendingPath === 'string' ? raw.pendingPath : null,
    pendingVersion: typeof raw.pendingVersion === 'string' ? raw.pendingVersion : null,
    rulesets: raw.rulesets && typeof raw.rulesets === 'object' ? { ...raw.rulesets } : null,
    lastUpdateCheckAt: Number(raw.lastUpdateCheckAt) || 0,
  };
}

function createExtensionRegistry({ rootDir, profileId, fsImpl = fs }) {
  const profile = sanitizeProfileId(profileId);
  const dir = path.join(rootDir, profile);
  const file = path.join(dir, 'registry.json');
  let state = null;
  const listeners = new Set();

  function load() {
    if (state) return state;
    state = { developerMode: false, extensions: new Map() };
    try {
      const raw = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
      state.developerMode = raw && raw.developerMode === true;
      for (const item of Array.isArray(raw && raw.extensions) ? raw.extensions : []) {
        const entry = normalizeEntry(item);
        if (entry) state.extensions.set(entry.id, entry);
      }
    } catch (_) {
      // Pas encore de registre : profil sans extension.
    }
    return state;
  }

  function save() {
    try {
      fsImpl.mkdirSync(dir, { recursive: true });
      const tmp = `${file}.tmp`;
      fsImpl.writeFileSync(
        tmp,
        JSON.stringify(
          {
            version: REGISTRY_VERSION,
            developerMode: state.developerMode,
            extensions: [...state.extensions.values()].sort((a, b) => a.installedAt - b.installedAt),
          },
          null,
          2,
        ),
      );
      fsImpl.renameSync(tmp, file);
    } catch (error) {
      console.warn('[extensions] registry not saved:', error && error.message);
    }
  }

  function changed() {
    save();
    for (const listener of listeners) {
      try {
        listener();
      } catch (_) {
        // Un abonné en erreur ne bloque pas les autres.
      }
    }
  }

  return {
    profileId: profile,
    dir,
    /** Dossier d'une version installée depuis le store. */
    versionDir: (id, version) => path.join(dir, id, `${String(version).replace(/[^0-9a-zA-Z._-]/g, '_')}_0`),
    /** Données propres à une extension (règles dynamiques…), hors du dossier de sa version. */
    dataDir: (id) => path.join(dir, '_data', id),
    list: () => [...load().extensions.values()],
    get: (id) => load().extensions.get(id) || null,
    has: (id) => load().extensions.has(id),
    put(entry) {
      const normalized = normalizeEntry({ ...entry, updatedAt: Date.now() });
      if (!normalized) throw new Error('invalid-extension-entry');
      load().extensions.set(normalized.id, normalized);
      changed();
      return normalized;
    },
    update(id, patch) {
      const current = load().extensions.get(id);
      if (!current) return null;
      const next = normalizeEntry({ ...current, ...patch, updatedAt: Date.now() });
      if (!next) return null;
      state.extensions.set(id, next);
      changed();
      return next;
    },
    remove(id) {
      if (!load().extensions.delete(id)) return false;
      changed();
      return true;
    },
    get developerMode() {
      return load().developerMode;
    },
    setDeveloperMode(value) {
      load().developerMode = value === true;
      changed();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Politique du workspace : `{ mode: 'any' | 'allowlist', allowedIds: [], blockedIds: [] }`.
 * Renvoie la raison du refus (`blocked` | `not_allowed`) ou null.
 */
function policyBlockReason(policy, id) {
  if (!policy || typeof policy !== 'object') return null;
  const blocked = Array.isArray(policy.blockedIds) ? policy.blockedIds : [];
  if (blocked.includes(id)) return 'blocked';
  if (policy.mode === 'allowlist') {
    const allowed = Array.isArray(policy.allowedIds) ? policy.allowedIds : [];
    if (!allowed.includes(id)) return 'not_allowed';
  }
  return null;
}

function normalizePolicy(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const ids = (list) => (Array.isArray(list) ? [...new Set(list.filter((id) => /^[a-p]{32}$/.test(id)))] : []);
  return {
    mode: raw.mode === 'allowlist' ? 'allowlist' : 'any',
    allowedIds: ids(raw.allowedIds),
    blockedIds: ids(raw.blockedIds),
    // L'administrateur peut interdire le mode développeur (extensions décompressées).
    allowDeveloperMode: raw.allowDeveloperMode !== false,
  };
}

module.exports = {
  createExtensionRegistry,
  normalizeOrigin,
  normalizePolicy,
  policyBlockReason,
  sanitizeProfileId,
};
