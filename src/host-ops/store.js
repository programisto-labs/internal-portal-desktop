'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_GRANTS = 200;
const MAX_JOURNAL = 200;
const MAX_FIELD = 300;

const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

function clip(value) {
  return typeof value === 'string' ? value.slice(0, MAX_FIELD) : null;
}

function normalizeGrant(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const strOk = (v) => typeof v === 'string' && ID_RE.test(v);
  if (!strOk(raw.id) || !strOk(raw.userId) || !strOk(raw.deviceId) || !strOk(raw.agentId)) return null;
  const roots = (v) => (Array.isArray(v) ? v.filter((r) => typeof r === 'string' && path.isAbsolute(r)).slice(0, 4) : []);
  if (raw.operation === 'shell.run') {
    // Command prefix (1-3 tokens) in a folder: never a global shell permission.
    const prefix = Array.isArray(raw.commandPrefix) ? raw.commandPrefix : [];
    const prefixOk =
      prefix.length >= 1 &&
      prefix.length <= 3 &&
      prefix.every((t) => typeof t === 'string' && t.length > 0 && t.length <= 200 && !/[\0\s]/.test(t));
    const cwdRoots = roots(raw.cwdRoots);
    if (!prefixOk || !cwdRoots.length) return null;
    return {
      id: raw.id,
      userId: raw.userId,
      deviceId: raw.deviceId,
      agentId: raw.agentId,
      agentName: clip(raw.agentName),
      operation: 'shell.run',
      commandPrefix: prefix.slice(),
      cwdRoots,
      sourceRoots: [],
      destinationRoots: [],
      createdAt: Number(raw.createdAt) || 0,
    };
  }
  if (!['file.move', 'file.copy', 'file.rename', 'folder.create'].includes(raw.operation)) return null;
  const sourceRoots = roots(raw.sourceRoots);
  const destinationRoots = roots(raw.destinationRoots);
  const needsSource = raw.operation !== 'folder.create';
  const needsDest = raw.operation !== 'file.rename';
  if ((needsSource && !sourceRoots.length) || (needsDest && !destinationRoots.length)) return null;
  return {
    id: raw.id,
    userId: raw.userId,
    deviceId: raw.deviceId,
    agentId: raw.agentId,
    agentName: clip(raw.agentName),
    operation: raw.operation,
    sourceRoots: needsSource ? sourceRoots : [],
    destinationRoots: needsDest ? destinationRoots : [],
    createdAt: Number(raw.createdAt) || 0,
  };
}

/** Persistent state: capability switch, device id, bounded revocable grants. */
function createHostOpsStore(filePath, fsImpl = fs) {
  let state = null;

  function load() {
    if (state) return state;
    let raw = null;
    try {
      raw = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
    } catch (_) {
      raw = null;
    }
    const deviceId = raw && typeof raw.deviceId === 'string' && ID_RE.test(raw.deviceId) ? raw.deviceId : crypto.randomUUID();
    state = {
      enabled: Boolean(raw && raw.enabled === true),
      // Shell commands are a separate switch, off by default even when file operations are on.
      shellEnabled: Boolean(raw && raw.shellEnabled === true),
      deviceId,
      grants: raw && Array.isArray(raw.grants) ? raw.grants.map(normalizeGrant).filter(Boolean).slice(0, MAX_GRANTS) : [],
    };
    return state;
  }

  function save() {
    try {
      fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${process.pid}.tmp`;
      fsImpl.writeFileSync(tmp, JSON.stringify(load()), { mode: 0o600 });
      fsImpl.renameSync(tmp, filePath);
      return true;
    } catch (_) {
      return false;
    }
  }

  load();
  save();

  return {
    isEnabled: () => load().enabled,
    setEnabled(value) {
      load().enabled = value === true;
      save();
      return load().enabled;
    },
    isShellEnabled: () => load().enabled && load().shellEnabled,
    setShellEnabled(value) {
      load().shellEnabled = value === true;
      save();
      return load().shellEnabled;
    },
    getDeviceId: () => load().deviceId,
    listGrants: () => load().grants.map((g) => ({ ...g })),
    addGrant(grant) {
      const g = normalizeGrant({ ...grant, id: crypto.randomUUID(), createdAt: Date.now() });
      if (!g) return null;
      const s = load();
      if (s.grants.length >= MAX_GRANTS) return null;
      s.grants.push(g);
      // A grant that cannot be persisted must not silently live in memory only.
      if (!save()) {
        s.grants.pop();
        return null;
      }
      return { ...g };
    },
    revokeGrant(id) {
      const s = load();
      const before = s.grants.length;
      s.grants = s.grants.filter((g) => g.id !== id);
      if (s.grants.length !== before) save();
      return s.grants.length !== before;
    },
    revokeAll() {
      load().grants = [];
      save();
    },
  };
}

/** Bounded activity journal. Stores paths and ids only — never file contents or tokens. */
function createJournal(filePath, fsImpl = fs) {
  let entries = null;
  function load() {
    if (entries) return entries;
    try {
      const raw = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
      entries = Array.isArray(raw) ? raw.filter((e) => e && typeof e === 'object').slice(-MAX_JOURNAL) : [];
    } catch (_) {
      entries = [];
    }
    return entries;
  }
  return {
    add(entry) {
      const list = load();
      list.push({
        ts: Date.now(),
        requestId: clip(entry.requestId),
        agentId: clip(entry.agentId),
        agentName: clip(entry.agentName),
        operation: clip(entry.operation),
        source: clip(entry.source),
        destination: clip(entry.destination),
        decision: clip(entry.decision),
        outcome: clip(entry.outcome),
        errorCode: clip(entry.errorCode),
      });
      while (list.length > MAX_JOURNAL) list.shift();
      try {
        fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
        const tmp = `${filePath}.${process.pid}.tmp`;
        fsImpl.writeFileSync(tmp, JSON.stringify(list), { mode: 0o600 });
        fsImpl.renameSync(tmp, filePath);
      } catch (_) {
        // journaling must never break the operation outcome report
      }
    },
    list: () => load().slice().reverse(),
    clear() {
      entries = [];
      try {
        fsImpl.writeFileSync(filePath, '[]', { mode: 0o600 });
      } catch (_) {
        // ignore
      }
    },
  };
}

module.exports = { createHostOpsStore, createJournal, ID_RE, MAX_JOURNAL };
