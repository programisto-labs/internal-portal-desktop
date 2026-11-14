'use strict';

/**
 * Lasco Code workspace: the IDE page of the portal (local git projects, editor, git, terminals).
 *
 * The page calls `invoke(method, payload)` through the preload bridge; only the methods of
 * METHODS exist. Every call names a project by id; the project's root was chosen natively (folder
 * picker) and every path is resolved inside it. This is the user's own IDE: no consent dialog for
 * the user's actions. Agent operations live in host-ops (consent, rules, journal).
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { HostOpsError } = require('../host-ops/paths');
const { maskSecrets } = require('../host-ops/shell');
const { splitRelative } = require('./paths');
const {
  parseStatus,
  parseBranches,
  parseLog,
  parseRemoteUrl,
  buildRemoteLinks,
  isValidBranchName,
  isValidCloneUrl,
  cloneFolderName,
  tail,
  NETWORK_TIMEOUT_MS,
} = require('./git');

const CLONE_TIMEOUT_MS = 10 * 60 * 1000;
const COMMIT_TIMEOUT_MS = 180000;
const MAX_COMMIT_MESSAGE = 20000;
const MAX_PATHS_PER_CALL = 500;

function mapError(err) {
  if (err instanceof HostOpsError) return { code: err.code, message: err.message };
  if (err && (err.code === 'EACCES' || err.code === 'EPERM')) return { code: 'permission_denied', message: 'Permission refusée par le système.' };
  if (err && err.code === 'ENOSPC') return { code: 'no_space', message: 'Espace disque insuffisant.' };
  if (err && err.code === 'ENOENT') return { code: 'not_found', message: 'Introuvable.' };
  if (err && err.code === 'EISDIR') return { code: 'not_a_file', message: 'Ce chemin est un dossier.' };
  return { code: 'io_error', message: 'Erreur système pendant l’opération.' };
}

function relPaths(list) {
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_PATHS_PER_CALL) {
    throw new HostOpsError('invalid_request', 'Liste de fichiers invalide.');
  }
  return list.map((p) => splitRelative(p, { allowRoot: false }).join('/'));
}

function createCodeWorkspaceService({
  projects,
  files,
  git,
  terminals,
  watchers,
  getEnv,
  pickFolder,
  confirmInitRepository,
  openAgentSettings,
  getAgentAccess,
  fsp = fs.promises,
  execFileImpl = execFile,
  platform = process.platform,
}) {
  async function project(payload) {
    return projects.get(payload && payload.userId, payload && payload.projectId);
  }

  async function topLevel(dir) {
    const res = await git.run(dir, ['rev-parse', '--show-toplevel']);
    if (res.code !== 0) return null;
    const top = String(res.stdout).trim();
    return top ? fsp.realpath(top) : null;
  }

  async function status(root) {
    const res = await git.run(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
    if (res.code !== 0) throw new HostOpsError('not_a_repository', 'Ce dossier n’est plus un dépôt git.');
    return parseStatus(res.stdout);
  }

  async function remoteName(root) {
    const res = await git.run(root, ['remote']);
    const names = String(res.stdout).split('\n').map((s) => s.trim()).filter(Boolean);
    if (names.includes('origin')) return 'origin';
    return names[0] || null;
  }

  async function defaultBranch(root, remote) {
    if (!remote) return null;
    const sym = await git.run(root, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`]);
    const name = String(sym.stdout).trim();
    if (sym.code === 0 && name.startsWith(`${remote}/`)) return name.slice(remote.length + 1);
    for (const candidate of ['main', 'master', 'develop']) {
      const res = await git.run(root, ['show-ref', '--verify', '--quiet', `refs/remotes/${remote}/${candidate}`]);
      if (res.code === 0) return candidate;
    }
    return null;
  }

  async function addRoot(userId, dir) {
    let top = await topLevel(dir);
    if (!top) {
      const answer = await confirmInitRepository(dir);
      if (answer !== 'init') return { ok: false, cancelled: true };
      const init = await git.run(dir, ['init']);
      if (init.code !== 0) throw new HostOpsError('git_failed', tail(init.stderr) || 'git init a échoué.');
      top = await topLevel(dir);
      if (!top) throw new HostOpsError('git_failed', 'Dépôt git introuvable après git init.');
    }
    return { ok: true, project: projects.add(userId, top) };
  }

  const METHODS = {
    async capabilities(payload) {
      return {
        available: true,
        terminal: terminals.isAvailable(),
        platform,
        agents: getAgentAccess ? getAgentAccess(payload && payload.userId) : { enabled: false },
      };
    },

    // --- Projects -------------------------------------------------------------------------
    async 'projects.list'({ userId }) {
      const list = projects.list(userId);
      return {
        projects: await Promise.all(
          list.map(async (p) => ({ ...p, missing: !(await fsp.stat(p.root).then((s) => s.isDirectory()).catch(() => false)) }))
        ),
      };
    },

    async 'projects.add'({ userId }) {
      const dir = await pickFolder({ title: 'Ouvrir un projet git', buttonLabel: 'Ouvrir' });
      if (!dir) return { cancelled: true };
      const real = await fsp.realpath(dir);
      const res = await addRoot(userId, real);
      return res.ok ? { project: res.project } : { cancelled: true };
    },

    async 'projects.clone'({ userId, url }) {
      if (!isValidCloneUrl(url)) throw new HostOpsError('invalid_url', 'URL de dépôt invalide (https://… ou git@hôte:chemin).');
      const name = cloneFolderName(url);
      if (!name) throw new HostOpsError('invalid_url', 'Nom de dépôt introuvable dans l’URL.');
      const parent = await pickFolder({ title: `Où cloner « ${name} » ?`, buttonLabel: 'Cloner ici' });
      if (!parent) return { cancelled: true };
      const parentReal = await fsp.realpath(parent);
      const dest = path.join(parentReal, name);
      if (await fsp.lstat(dest).then(() => true).catch(() => false)) {
        throw new HostOpsError('destination_exists', `Le dossier ${dest} existe déjà.`);
      }
      const res = await git.run(parentReal, ['clone', '--', url.trim(), dest], { timeoutMs: CLONE_TIMEOUT_MS, optionalLocks: true });
      if (res.code !== 0) throw new HostOpsError('git_failed', tail(res.stderr) || 'Le clonage a échoué.');
      const top = await topLevel(dest);
      if (!top) throw new HostOpsError('git_failed', 'Dépôt cloné introuvable.');
      return { project: projects.add(userId, top) };
    },

    async 'projects.remove'({ userId, projectId }) {
      const removed = projects.remove(userId, projectId);
      return { removed };
    },

    async 'projects.open'(payload) {
      const p = await project(payload);
      projects.touch(payload.userId, p.id);
      return { project: p };
    },

    // --- Files ------------------------------------------------------------------------------
    async 'fs.list'(payload) {
      const p = await project(payload);
      return files.listDir(p.root, payload.path);
    },
    async 'fs.read'(payload) {
      const p = await project(payload);
      return files.readFile(p.root, payload.path);
    },
    async 'fs.write'(payload) {
      const p = await project(payload);
      return files.writeFile(p.root, payload.path, payload.content, { expectedMtimeMs: payload.expectedMtimeMs });
    },
    async 'fs.createFile'(payload) {
      const p = await project(payload);
      return files.writeFile(p.root, payload.path, '', { createOnly: true });
    },
    async 'fs.createFolder'(payload) {
      const p = await project(payload);
      return files.createFolder(p.root, payload.path);
    },
    async 'fs.rename'(payload) {
      const p = await project(payload);
      return files.rename(p.root, payload.from, payload.to);
    },
    async 'fs.trash'(payload) {
      const p = await project(payload);
      return files.trash(p.root, payload.path);
    },
    async 'fs.quickOpen'(payload) {
      const p = await project(payload);
      return files.quickOpen(p.root);
    },
    async 'fs.search'(payload) {
      const p = await project(payload);
      return files.search(p.root, payload.query, {
        regex: payload.regex === true,
        caseSensitive: payload.caseSensitive === true,
        pathspec: payload.pathspec,
        maxResults: payload.maxResults,
      });
    },

    // --- Git --------------------------------------------------------------------------------
    async 'git.status'(payload) {
      const p = await project(payload);
      return status(p.root);
    },

    /** Content of a file at HEAD (left side of the diff). Empty when the file is new. */
    async 'git.show'(payload) {
      const p = await project(payload);
      const rel = splitRelative(payload.path, { allowRoot: false }).join('/');
      const res = await git.run(p.root, ['show', `HEAD:${rel}`], { encoding: 'buffer' });
      if (res.code !== 0) return { path: rel, content: '', missing: true };
      const buffer = Buffer.isBuffer(res.stdout) ? res.stdout : Buffer.from(res.stdout);
      const content = files.decodeText(buffer);
      return content === null ? { path: rel, content: null, binary: true } : { path: rel, content };
    },

    async 'git.stage'(payload) {
      const p = await project(payload);
      const list = relPaths(payload.paths);
      await git.ok(p.root, ['add', '-A', '--', ...list], { optionalLocks: true });
      return { staged: list.length };
    },

    async 'git.unstage'(payload) {
      const p = await project(payload);
      const list = relPaths(payload.paths);
      const head = await git.run(p.root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
      if (head.code === 0) await git.ok(p.root, ['restore', '--staged', '--', ...list], { optionalLocks: true });
      else await git.ok(p.root, ['rm', '--cached', '-r', '-q', '--', ...list], { optionalLocks: true });
      return { unstaged: list.length };
    },

    /** Restore tracked files from the index; untracked files go to the system trash. */
    async 'git.discard'(payload) {
      const p = await project(payload);
      const list = relPaths(payload.paths);
      const { files: entries } = await status(p.root);
      const byPath = new Map(entries.map((e) => [e.path, e]));
      const tracked = list.filter((rel) => byPath.has(rel) && !byPath.get(rel).untracked);
      const untracked = list.filter((rel) => byPath.has(rel) && byPath.get(rel).untracked);
      if (tracked.length) await git.ok(p.root, ['restore', '--worktree', '--', ...tracked], { optionalLocks: true });
      for (const rel of untracked) await files.trash(p.root, rel);
      return { restored: tracked.length, trashed: untracked.length };
    },

    async 'git.commit'(payload) {
      const p = await project(payload);
      const message = typeof payload.message === 'string' ? payload.message.trim() : '';
      if (!message) throw new HostOpsError('invalid_request', 'Message de commit requis.');
      if (message.length > MAX_COMMIT_MESSAGE) throw new HostOpsError('invalid_request', 'Message de commit trop long.');
      const args = ['commit', '-F', '-'];
      if (payload.amend === true) args.push('--amend');
      const res = await git.run(p.root, args, { input: `${message}\n`, timeoutMs: COMMIT_TIMEOUT_MS, optionalLocks: true });
      if (res.code !== 0) throw new HostOpsError('git_failed', tail(`${res.stdout}\n${res.stderr}`) || 'Le commit a échoué.');
      const hash = String((await git.ok(p.root, ['rev-parse', 'HEAD'])) || '').trim();
      return { hash, output: tail(res.stdout) };
    },

    async 'git.branches'(payload) {
      const p = await project(payload);
      const local = await git.ok(p.root, ['for-each-ref', '--format=%(refname:short)%00%(upstream:short)%00%(HEAD)', '--sort=-committerdate', 'refs/heads']);
      const remote = await git.ok(p.root, ['for-each-ref', '--format=%(refname:short)', '--sort=-committerdate', 'refs/remotes']);
      return {
        local: parseBranches(local),
        remote: String(remote)
          .split('\n')
          .map((s) => s.trim())
          .filter((s) => s && !s.endsWith('/HEAD'))
          .slice(0, 300),
      };
    },

    async 'git.switch'(payload) {
      const p = await project(payload);
      if (!isValidBranchName(payload.branch)) throw new HostOpsError('invalid_branch', 'Nom de branche invalide.');
      await git.ok(p.root, ['switch', payload.branch], { optionalLocks: true });
      return { branch: payload.branch };
    },

    async 'git.createBranch'(payload) {
      const p = await project(payload);
      if (!isValidBranchName(payload.branch)) throw new HostOpsError('invalid_branch', 'Nom de branche invalide.');
      const check = await git.run(p.root, ['check-ref-format', '--branch', payload.branch]);
      if (check.code !== 0) throw new HostOpsError('invalid_branch', 'Nom de branche invalide.');
      await git.ok(p.root, ['switch', '-c', payload.branch], { optionalLocks: true });
      return { branch: payload.branch };
    },

    async 'git.fetch'(payload) {
      const p = await project(payload);
      const res = await git.run(p.root, ['fetch', '--prune'], { timeoutMs: NETWORK_TIMEOUT_MS, optionalLocks: true });
      if (res.code !== 0) throw new HostOpsError('git_failed', tail(res.stderr) || 'git fetch a échoué.');
      return { output: tail(res.stderr || res.stdout) };
    },

    async 'git.pull'(payload) {
      const p = await project(payload);
      const res = await git.run(p.root, ['pull', '--ff-only'], { timeoutMs: NETWORK_TIMEOUT_MS, optionalLocks: true });
      if (res.code !== 0) throw new HostOpsError('git_failed', tail(`${res.stdout}\n${res.stderr}`) || 'git pull a échoué.');
      return { output: tail(res.stdout || res.stderr) };
    },

    async 'git.push'(payload) {
      const p = await project(payload);
      const st = await status(p.root);
      if (!st.branch.head) throw new HostOpsError('detached_head', 'Aucune branche active (HEAD détachée).');
      let args;
      if (st.branch.upstream) args = ['push'];
      else {
        const remote = await remoteName(p.root);
        if (!remote) throw new HostOpsError('no_remote', 'Aucun dépôt distant configuré.');
        args = ['push', '-u', remote, 'HEAD'];
      }
      const res = await git.run(p.root, args, { timeoutMs: NETWORK_TIMEOUT_MS, optionalLocks: true });
      if (res.code !== 0) throw new HostOpsError('git_failed', tail(res.stderr) || 'git push a échoué.');
      return { output: tail(res.stderr || res.stdout) };
    },

    async 'git.log'(payload) {
      const p = await project(payload);
      const limit = Math.max(1, Math.min(Number(payload.limit) || 50, 200));
      const res = await git.run(p.root, ['log', `-n${limit}`, '--format=%H%x1f%h%x1f%an%x1f%ar%x1f%s%x1e']);
      if (res.code !== 0) return { commits: [] };
      return { commits: parseLog(res.stdout) };
    },

    /** Web links (GitHub / GitLab) derived from the remote; the raw remote URL never leaves. */
    async 'git.remote'(payload) {
      const p = await project(payload);
      const remote = await remoteName(p.root);
      if (!remote) return { remote: null, links: null, defaultBranch: null };
      const url = await git.run(p.root, ['remote', 'get-url', remote]);
      const parsed = url.code === 0 ? parseRemoteUrl(String(url.stdout).trim()) : null;
      const st = await status(p.root).catch(() => null);
      const branch = st ? st.branch.head : null;
      const base = await defaultBranch(p.root, remote);
      return {
        remote: parsed ? { name: remote, provider: parsed.provider, owner: parsed.owner, repo: parsed.repo, webUrl: parsed.webUrl } : { name: remote, provider: null },
        defaultBranch: base,
        links: buildRemoteLinks(parsed, { branch, defaultBranch: base }),
      };
    },

    /** Pull request of the current branch through the GitHub CLI, when installed and signed in. */
    async 'git.pullRequest'(payload) {
      const p = await project(payload);
      const env = await getEnv();
      return new Promise((resolve) => {
        execFileImpl(
          'gh',
          ['pr', 'view', '--json', 'number,url,state,title,isDraft,headRefName,reviewDecision'],
          { cwd: p.root, env: { ...env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1' }, timeout: 15000, maxBuffer: 1024 * 1024 },
          (err, stdout) => {
            if (err) {
              resolve({ pullRequest: null, ghAvailable: !(err && err.code === 'ENOENT') });
              return;
            }
            try {
              const pr = JSON.parse(String(stdout));
              const safeUrl = typeof pr.url === 'string' && /^https:\/\/[^\s]+$/.test(pr.url) ? pr.url : null;
              resolve({
                ghAvailable: true,
                pullRequest: {
                  number: Number(pr.number) || null,
                  url: safeUrl,
                  state: String(pr.state || ''),
                  title: maskSecrets(String(pr.title || '')).slice(0, 300),
                  isDraft: pr.isDraft === true,
                  reviewDecision: pr.reviewDecision ? String(pr.reviewDecision) : null,
                },
              });
            } catch (_) {
              resolve({ pullRequest: null, ghAvailable: true });
            }
          }
        );
      });
    },

    // --- Terminals ----------------------------------------------------------------------------
    async 'terminal.create'(payload, ctx) {
      const p = await project(payload);
      return terminals.create(ctx.webContents, { project: p, cols: payload.cols, rows: payload.rows });
    },
    async 'terminal.list'(payload, ctx) {
      const p = await project(payload);
      return { terminals: terminals.list(ctx.webContents, p.id) };
    },
    async 'terminal.attach'(payload, ctx) {
      return terminals.attach(ctx.webContents, payload.id);
    },
    async 'terminal.kill'(payload, ctx) {
      return { killed: terminals.kill(ctx.webContents, payload.id) };
    },

    // --- Watch ------------------------------------------------------------------------------
    async watch(payload, ctx) {
      const p = await project(payload);
      return { watching: watchers.watch(ctx.webContents, p) };
    },
    async unwatch(payload, ctx) {
      const p = await project(payload);
      watchers.unwatch(ctx.webContents, p.id);
      return { watching: false };
    },

    async openAgentSettings() {
      if (openAgentSettings) openAgentSettings();
      return { opened: Boolean(openAgentSettings) };
    },
  };

  return {
    methods: Object.keys(METHODS),
    async invoke(method, payload, ctx) {
      if (typeof method !== 'string' || !Object.prototype.hasOwnProperty.call(METHODS, method)) {
        return { ok: false, error: { code: 'unsupported_operation', message: 'Méthode inconnue.' } };
      }
      try {
        const data = await METHODS[method](payload && typeof payload === 'object' ? payload : {}, ctx || {});
        return { ok: true, ...(data || {}) };
      } catch (err) {
        return { ok: false, error: mapError(err) };
      }
    },
  };
}

module.exports = { createCodeWorkspaceService, mapError };
