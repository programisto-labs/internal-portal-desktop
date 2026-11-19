'use strict';

/**
 * Code projects registered in Lasco Desktop, per signed-in user.
 *
 * A project is only ever added natively (folder picker or clone destination picker): the web page
 * cannot register an arbitrary path, it only names projects by id. State: `userData/code-projects.json`
 * (mode 0600).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HostOpsError, normKey } = require('../host-ops/paths');
const { ID_RE } = require('../host-ops/store');

const MAX_PROJECTS_PER_USER = 50;
const PROJECT_ID_RE = /^p_[a-f0-9]{16}$/;

function normalizeProject(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !PROJECT_ID_RE.test(raw.id)) return null;
  if (typeof raw.userId !== 'string' || !ID_RE.test(raw.userId)) return null;
  if (typeof raw.root !== 'string' || !path.isAbsolute(raw.root) || raw.root.includes('\0')) return null;
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 200) : path.basename(raw.root);
  return {
    id: raw.id,
    userId: raw.userId,
    root: raw.root,
    name,
    addedAt: Number(raw.addedAt) || 0,
    lastOpenedAt: Number(raw.lastOpenedAt) || 0,
  };
}

function publicProject(p) {
  return { id: p.id, name: p.name, root: p.root, addedAt: p.addedAt, lastOpenedAt: p.lastOpenedAt };
}

function createProjectStore(filePath, { fsImpl = fs, platform = process.platform } = {}) {
  let state = null;

  function load() {
    if (state) return state;
    let raw = null;
    try {
      raw = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
    } catch (_) {
      raw = null;
    }
    const projects = raw && Array.isArray(raw.projects) ? raw.projects.map(normalizeProject).filter(Boolean) : [];
    state = { projects };
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

  function assertUser(userId) {
    if (typeof userId !== 'string' || !ID_RE.test(userId)) {
      throw new HostOpsError('invalid_request', 'Utilisateur invalide.');
    }
  }

  return {
    list(userId) {
      assertUser(userId);
      return load()
        .projects.filter((p) => p.userId === userId)
        .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt || a.name.localeCompare(b.name))
        .map(publicProject);
    },

    get(userId, projectId) {
      assertUser(userId);
      const project = load().projects.find((p) => p.userId === userId && p.id === projectId);
      if (!project) throw new HostOpsError('project_not_found', 'Projet introuvable. Ouvrez-le dans Lasco Code.');
      return publicProject(project);
    },

    /** `root` must already be the real path of the repository top level. */
    add(userId, root) {
      assertUser(userId);
      if (typeof root !== 'string' || !path.isAbsolute(root)) throw new HostOpsError('invalid_path', 'Dossier invalide.');
      const s = load();
      const existing = s.projects.find((p) => p.userId === userId && normKey(p.root, platform) === normKey(root, platform));
      const now = Date.now();
      if (existing) {
        existing.lastOpenedAt = now;
        save();
        return publicProject(existing);
      }
      if (s.projects.filter((p) => p.userId === userId).length >= MAX_PROJECTS_PER_USER) {
        throw new HostOpsError('too_many_projects', `Au plus ${MAX_PROJECTS_PER_USER} projets : retirez-en un de la liste.`);
      }
      const project = {
        id: `p_${crypto.randomBytes(8).toString('hex')}`,
        userId,
        root,
        name: path.basename(root) || root,
        addedAt: now,
        lastOpenedAt: now,
      };
      s.projects.push(project);
      if (!save()) {
        s.projects.pop();
        throw new HostOpsError('io_error', 'Impossible d’enregistrer la liste des projets.');
      }
      return publicProject(project);
    },

    touch(userId, projectId) {
      assertUser(userId);
      const project = load().projects.find((p) => p.userId === userId && p.id === projectId);
      if (!project) return false;
      project.lastOpenedAt = Date.now();
      save();
      return true;
    },

    /** Forget a project. Nothing is deleted on disk. */
    remove(userId, projectId) {
      assertUser(userId);
      const s = load();
      const before = s.projects.length;
      s.projects = s.projects.filter((p) => !(p.userId === userId && p.id === projectId));
      if (s.projects.length !== before) save();
      return s.projects.length !== before;
    },
  };
}

module.exports = { createProjectStore, PROJECT_ID_RE, MAX_PROJECTS_PER_USER };
