'use strict';

/**
 * Git for the Lasco Code workspace. Always `execFile('git', [...])`: no shell, arguments are never
 * interpreted, user values are passed after `--` or through validated options. Prompts are
 * disabled (GIT_TERMINAL_PROMPT=0): a command that needs credentials fails instead of hanging.
 */

const { execFile, spawn } = require('child_process');
const { HostOpsError } = require('../host-ops/paths');
const { maskSecrets } = require('../host-ops/shell');

const DEFAULT_TIMEOUT_MS = 30000;
const NETWORK_TIMEOUT_MS = 120000;
const MAX_BUFFER = 32 * 1024 * 1024;
const MAX_MESSAGE_OUTPUT = 4000;

function gitEnv(baseEnv) {
  return {
    ...baseEnv,
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GIT_EDITOR: 'true',
    GCM_INTERACTIVE: 'never',
    // Untranslated git messages (shown as is), without forcing a C locale on hooks.
    LANGUAGE: 'en_US:en',
  };
}

function tail(text, max = MAX_MESSAGE_OUTPUT) {
  const s = maskSecrets(String(text || '')).trim();
  return s.length > max ? `…${s.slice(-max)}` : s;
}

/**
 * Run git in `root`. Resolves { code, stdout, stderr } for any exit code; rejects only when git
 * cannot start (ENOENT) or the timeout fires.
 */
function createGitRunner({ getEnv, execFileImpl = execFile, spawnImpl = spawn }) {
  async function run(root, args, { timeoutMs = DEFAULT_TIMEOUT_MS, encoding = 'utf8', optionalLocks = false, input } = {}) {
    const env = gitEnv(await getEnv());
    if (!optionalLocks) env.GIT_OPTIONAL_LOCKS = '0';
    const fullArgs = ['-c', 'core.quotepath=off', '-c', 'color.ui=false', '-C', root, ...args];
    if (input !== undefined) {
      return new Promise((resolve, reject) => {
        const child = spawnImpl('git', fullArgs, { env, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          reject(new HostOpsError('timeout', 'Git ne répond pas (délai dépassé).'));
        }, timeoutMs);
        child.stdout.on('data', (d) => {
          stdout += d;
        });
        child.stderr.on('data', (d) => {
          stderr += d;
        });
        child.on('error', (err) => {
          clearTimeout(timer);
          reject(err && err.code === 'ENOENT' ? new HostOpsError('git_unavailable', 'Git est introuvable sur cet ordinateur.') : err);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve({ code: code === null ? 1 : code, stdout, stderr });
        });
        child.stdin.end(input);
      });
    }
    return new Promise((resolve, reject) => {
      execFileImpl('git', fullArgs, { env, timeout: timeoutMs, maxBuffer: MAX_BUFFER, encoding }, (err, stdout, stderr) => {
        if (err && err.code === 'ENOENT') {
          reject(new HostOpsError('git_unavailable', 'Git est introuvable sur cet ordinateur.'));
          return;
        }
        if (err && err.killed) {
          reject(new HostOpsError('timeout', 'Git ne répond pas (délai dépassé).'));
          return;
        }
        if (err && err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          reject(new HostOpsError('too_large', 'Sortie de git trop volumineuse.'));
          return;
        }
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ code, stdout, stderr: String(stderr || '') });
      });
    });
  }

  async function ok(root, args, options) {
    const res = await run(root, args, options);
    if (res.code !== 0) {
      throw new HostOpsError('git_failed', tail(res.stderr || res.stdout) || `git ${args[0]} a échoué.`);
    }
    return res.stdout;
  }

  return { run, ok };
}

/** `git status --porcelain=v2 --branch -z` */
function parseStatus(raw) {
  const tokens = String(raw || '').split('\0');
  const branch = { oid: null, head: null, upstream: null, ahead: 0, behind: 0, detached: false };
  const files = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const line = tokens[i];
    if (!line) continue;
    if (line.startsWith('# ')) {
      const [key, ...rest] = line.slice(2).split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') branch.oid = value === '(initial)' ? null : value;
      else if (key === 'branch.head') {
        branch.detached = value === '(detached)';
        branch.head = branch.detached ? null : value;
      } else if (key === 'branch.upstream') branch.upstream = value;
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value);
        if (m) {
          branch.ahead = Number(m[1]);
          branch.behind = Number(m[2]);
        }
      }
      continue;
    }
    const type = line[0];
    if (type === '?') {
      files.push({ path: line.slice(2), index: '?', worktree: '?', staged: false, unstaged: true, untracked: true, conflicted: false });
      continue;
    }
    if (type === '!') continue;
    if (type === '1' || type === '2' || type === 'u') {
      // Fields before the path: 1 → 8, 2 → 9, u → 10 (space separated).
      const fieldCount = type === '1' ? 8 : type === '2' ? 9 : 10;
      const parts = line.split(' ');
      const xy = parts[1] || '..';
      const filePath = parts.slice(fieldCount).join(' ');
      const entry = {
        path: filePath,
        index: xy[0],
        worktree: xy[1],
        staged: type !== 'u' && xy[0] !== '.',
        unstaged: type === 'u' || xy[1] !== '.',
        untracked: false,
        conflicted: type === 'u',
      };
      if (type === '2') {
        entry.origPath = tokens[i + 1] || null;
        i += 1;
      }
      files.push(entry);
    }
  }
  return { branch, files };
}

/** Lines `name\0upstream\0*` from for-each-ref. */
function parseBranches(raw) {
  return String(raw || '')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, upstream, head] = line.split('\0');
      return { name, upstream: upstream || null, current: head === '*' };
    })
    .filter((b) => b.name);
}

function parseLog(raw) {
  return String(raw || '')
    .split('\x1e')
    .map((s) => s.replace(/^\n/, ''))
    .filter(Boolean)
    .map((record) => {
      const [hash, short, author, relative, subject] = record.split('\x1f');
      return { hash, short, author, relative, subject };
    })
    .filter((c) => c.hash);
}

/**
 * Web links from a remote URL. Only github.com and gitlab.com are recognised; the raw URL is never
 * returned (it may carry a token: https://user:token@host/…).
 */
function parseRemoteUrl(url) {
  if (typeof url !== 'string') return null;
  const s = url.trim();
  let host;
  let repoPath;
  let m = /^(?:git\+)?(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(s);
  if (m) {
    host = m[1];
    repoPath = m[2];
  } else {
    m = /^(?:[^@\s]+@)?([^:/\s]+):(.+)$/.exec(s);
    if (!m) return null;
    host = m[1];
    repoPath = m[2];
  }
  host = host.toLowerCase();
  repoPath = repoPath.replace(/\.git\/?$/i, '').replace(/^\/+|\/+$/g, '');
  const provider = host === 'github.com' ? 'github' : host === 'gitlab.com' ? 'gitlab' : null;
  if (!provider) return null;
  const parts = repoPath.split('/');
  if (parts.length < 2 || parts.some((p) => !/^[A-Za-z0-9_.-]+$/.test(p))) return null;
  if (provider === 'github' && parts.length !== 2) return null;
  return { provider, host, owner: parts.slice(0, -1).join('/'), repo: parts[parts.length - 1], webUrl: `https://${host}/${parts.join('/')}` };
}

function encodeRef(ref) {
  return String(ref).split('/').map(encodeURIComponent).join('/');
}

/** Links shown in the IDE: repository, branch, compare / new pull request, file, commit. */
function buildRemoteLinks(remote, { branch, defaultBranch }) {
  if (!remote) return null;
  const base = remote.webUrl;
  const links = { repository: base };
  if (remote.provider === 'github') {
    links.pulls = `${base}/pulls`;
    if (branch) {
      links.branch = `${base}/tree/${encodeRef(branch)}`;
      links.newPullRequest =
        defaultBranch && defaultBranch !== branch
          ? `${base}/compare/${encodeRef(defaultBranch)}...${encodeRef(branch)}?expand=1`
          : `${base}/pull/new/${encodeRef(branch)}`;
    }
    links.commitPrefix = `${base}/commit/`;
    links.filePrefix = branch ? `${base}/blob/${encodeRef(branch)}/` : null;
  } else {
    links.pulls = `${base}/-/merge_requests`;
    if (branch) {
      links.branch = `${base}/-/tree/${encodeRef(branch)}`;
      links.newPullRequest = `${base}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(branch)}`;
    }
    links.commitPrefix = `${base}/-/commit/`;
    links.filePrefix = branch ? `${base}/-/blob/${encodeRef(branch)}/` : null;
  }
  return links;
}

/** Same rules as `git check-ref-format --branch`, checked again by git itself. */
function isValidBranchName(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 200 &&
    !name.startsWith('-') &&
    !name.startsWith('/') &&
    !name.endsWith('/') &&
    !name.endsWith('.lock') &&
    !name.endsWith('.') &&
    !name.includes('..') &&
    !name.includes('@{') &&
    !name.includes('//') &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000- \u007f~^:?*[\\]/.test(name)
  );
}

/** Clone URLs: https, ssh (scp-like or ssh://) and git:// only. Never an option, never a local path. */
function isValidCloneUrl(url) {
  if (typeof url !== 'string') return false;
  const s = url.trim();
  if (!s || s.length > 2000 || s.startsWith('-') || /\s/.test(s)) return false;
  if (/^(https?|ssh|git):\/\/[^/\s]+\/.+/i.test(s)) return true;
  return /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^/\s].*$/.test(s);
}

/** Folder name derived from a clone URL (`…/repo.git` → `repo`). */
function cloneFolderName(url) {
  const last = String(url).trim().replace(/\/+$/, '').split(/[/:]/).pop() || '';
  const name = last.replace(/\.git$/i, '');
  return /^[A-Za-z0-9._-]{1,100}$/.test(name) && name !== '.' && name !== '..' ? name : null;
}

module.exports = {
  createGitRunner,
  parseStatus,
  parseBranches,
  parseLog,
  parseRemoteUrl,
  buildRemoteLinks,
  isValidBranchName,
  isValidCloneUrl,
  cloneFolderName,
  tail,
  DEFAULT_TIMEOUT_MS,
  NETWORK_TIMEOUT_MS,
};
