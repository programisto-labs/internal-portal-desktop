'use strict';

/**
 * Agent operations on Lasco Code projects (internal-portal#2387 continuation): an agent develops in
 * the local git projects the user opened in Lasco Code.
 *
 * - Reading (projects, list, read, search, git status / diff): allowed without a dialog, only inside
 *   the user's registered projects, when « Projets de code » is enabled in Desktop. Environment files
 *   and keys are never read nor returned by a search.
 * - Writing (code.write, code.edit): native dialog showing the file and the change, unless the user
 *   created a « Toujours autoriser les modifications dans ce projet » rule for this agent. Never
 *   remembered for sensitive files or a project root that is the filesystem root or contains the home
 *   folder. The file is re-checked after the dialog and re-read after the write (verification).
 * - Commands (tests, builds, git commit…) stay `shell.run`, with its own consent and prefix rules.
 */

const fs = require('fs');
const path = require('path');
const { HostOpsError, isWithin } = require('../host-ops/paths');
const { maskSecrets } = require('../host-ops/shell');
const { isSensitiveFile, resolveWritable, splitRelative } = require('./paths');
const { parseStatus } = require('./git');

const CODE_READ_OPERATIONS = ['code.projects', 'code.list', 'code.read', 'code.search', 'git.status', 'git.diff'];
const CODE_WRITE_OPERATIONS = ['code.write', 'code.edit'];
const CODE_OPERATIONS = [...CODE_READ_OPERATIONS, ...CODE_WRITE_OPERATIONS];

const READ_DEFAULT_LINES = 2000;
const READ_MAX_CHARS = 22000;
const READ_MAX_LINE_CHARS = 2000;
const LIST_MAX_ENTRIES = 500;
const STATUS_MAX_FILES = 500;
const DIFF_MAX_CHARS = 24000;
const DIFF_MAX_PATHS = 300;
const MAX_WRITE_CHARS = 2 * 1024 * 1024;
const PREVIEW_LINES = 24;

function splitLines(text) {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Changed region between two texts (common prefix / suffix lines trimmed). */
function changedRegion(before, after) {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  return { startLine: start + 1, removed: a.slice(start, endA), added: b.slice(start, endB) };
}

function clip(line, max = 160) {
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** Short, masked excerpt of the change for the consent dialog. */
function previewChange(region) {
  const out = [];
  const half = Math.floor(PREVIEW_LINES / 2);
  const removed = region.removed.slice(0, region.added.length ? half : PREVIEW_LINES);
  const added = region.added.slice(0, PREVIEW_LINES - removed.length);
  for (const l of removed) out.push(`- ${clip(l)}`);
  if (region.removed.length > removed.length) out.push(`- … (${region.removed.length - removed.length} lignes de plus)`);
  for (const l of added) out.push(`+ ${clip(l)}`);
  if (region.added.length > added.length) out.push(`+ … (${region.added.length - added.length} lignes de plus)`);
  return maskSecrets(out.join('\n'));
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function createCodeAgentOps({ projects, files, git, fsp = fs.promises, platform = process.platform, homeDir = require('os').homedir() }) {
  function findProject(userId, projectId) {
    if (typeof projectId !== 'string' || !projectId) throw new HostOpsError('invalid_request', 'project_id requis (voir host_code_projects).');
    return projects.get(userId, projectId);
  }

  function rootTooBroad(root) {
    return path.parse(root).root === root || isWithin(root, homeDir, platform);
  }

  async function statusOf(root) {
    const res = await git.run(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
    if (res.code !== 0) throw new HostOpsError('not_a_repository', 'Ce dossier n’est plus un dépôt git.');
    return parseStatus(res.stdout);
  }

  // --- Reads ------------------------------------------------------------------------------------
  const READERS = {
    async 'code.projects'({ userId }) {
      const list = projects.list(userId);
      const out = [];
      for (const p of list) {
        const st = await statusOf(p.root).catch(() => null);
        out.push({
          id: p.id,
          name: p.name,
          root: p.root,
          ...(st ? { branch: st.branch.head, changedFiles: st.files.length } : { missing: true }),
        });
      }
      return { projects: out };
    },

    async 'code.list'({ userId, request }) {
      const p = findProject(userId, request.projectId);
      const listing = await files.listDir(p.root, request.path);
      return {
        project: p.name,
        path: listing.path || '.',
        entries: listing.entries.slice(0, LIST_MAX_ENTRIES).map((e) => ({
          name: e.name,
          type: e.type,
          ...(e.ignored ? { ignored: true } : {}),
          ...(e.type === 'file' && isSensitiveFile(e.path) ? { sensitive: true } : {}),
        })),
        truncated: listing.truncated || listing.entries.length > LIST_MAX_ENTRIES,
      };
    },

    async 'code.read'({ userId, request }) {
      const p = findProject(userId, request.projectId);
      const rel = splitRelative(request.path, { allowRoot: false }).join('/');
      if (isSensitiveFile(rel)) {
        throw new HostOpsError('sensitive_file', 'Fichier sensible (secrets, clés) : non lisible par un agent.');
      }
      const file = await files.readFile(p.root, rel);
      if (file.tooLarge) throw new HostOpsError('too_large', 'Fichier trop volumineux : lis-le par morceaux avec host_shell_run (sed -n, head).');
      if (file.binary) throw new HostOpsError('binary_file', 'Fichier binaire ou non UTF-8.');
      const lines = splitLines(file.content);
      const offset = Math.max(1, Math.floor(Number(request.offset) || 1));
      const limit = Math.max(1, Math.min(Math.floor(Number(request.limit) || READ_DEFAULT_LINES), 5000));
      const out = [];
      let chars = 0;
      let line = offset;
      for (; line <= lines.length && line < offset + limit; line += 1) {
        let text = lines[line - 1];
        if (text.length > READ_MAX_LINE_CHARS) text = `${text.slice(0, READ_MAX_LINE_CHARS)}… (ligne tronquée)`;
        // + line number and tab added for the model (portal formatting): the whole stays < 30 000 chars.
        if (chars + text.length + 8 > READ_MAX_CHARS && out.length > 0) break;
        out.push(text);
        chars += text.length + 8;
      }
      const endLine = offset + out.length - 1;
      return {
        project: p.name,
        path: file.path,
        content: out.join('\n'),
        startLine: offset,
        endLine: Math.max(endLine, offset - 1),
        totalLines: lines.length,
        truncated: endLine < lines.length,
        ...(endLine < lines.length ? { nextOffset: endLine + 1 } : {}),
      };
    },

    async 'code.search'({ userId, request }) {
      const p = findProject(userId, request.projectId);
      const res = await files.search(p.root, request.query, {
        regex: request.regex === true,
        caseSensitive: request.caseSensitive === true,
        pathspec: request.pathspec,
        maxResults: 200,
        excludeSensitive: true,
      });
      return { project: p.name, results: res.results.map((r) => ({ ...r, text: maskSecrets(r.text) })), truncated: res.truncated };
    },

    async 'git.status'({ userId, request }) {
      const p = findProject(userId, request.projectId);
      const st = await statusOf(p.root);
      return {
        project: p.name,
        branch: st.branch.head,
        detached: st.branch.detached,
        upstream: st.branch.upstream,
        ahead: st.branch.ahead,
        behind: st.branch.behind,
        files: st.files.slice(0, STATUS_MAX_FILES).map((f) => ({
          path: f.path,
          ...(f.origPath ? { from: f.origPath } : {}),
          index: f.index,
          worktree: f.worktree,
          ...(f.untracked ? { untracked: true } : {}),
          ...(f.conflicted ? { conflicted: true } : {}),
        })),
        truncated: st.files.length > STATUS_MAX_FILES,
      };
    },

    /** Unified diff of the work in progress (vs HEAD, or the index with `staged`). */
    async 'git.diff'({ userId, request }) {
      const p = findProject(userId, request.projectId);
      const head = await git.run(p.root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
      const base = request.staged === true ? ['--cached'] : head.code === 0 ? ['HEAD'] : [];
      const scope = request.path ? ['--', splitRelative(request.path, { allowRoot: false }).join('/')] : [];
      const names = await git.run(p.root, ['diff', ...base, '--name-only', '-z', ...scope]);
      if (names.code !== 0) throw new HostOpsError('git_failed', 'git diff a échoué.');
      const all = String(names.stdout).split('\0').filter(Boolean);
      const skipped = all.filter(isSensitiveFile);
      const paths = all.filter((f) => !isSensitiveFile(f)).slice(0, DIFF_MAX_PATHS);
      let diff = '';
      if (paths.length) {
        const res = await git.run(p.root, ['diff', ...base, '--no-color', '--no-ext-diff', '--', ...paths]);
        if (res.code !== 0) throw new HostOpsError('git_failed', 'git diff a échoué.');
        diff = maskSecrets(String(res.stdout));
      }
      const st = request.staged === true ? null : await statusOf(p.root).catch(() => null);
      const untracked = st ? st.files.filter((f) => f.untracked && !isSensitiveFile(f.path)).map((f) => f.path).slice(0, 200) : [];
      return {
        project: p.name,
        diff: diff.length > DIFF_MAX_CHARS ? `${diff.slice(0, DIFF_MAX_CHARS)}\n…(diff tronqué)` : diff,
        truncated: diff.length > DIFF_MAX_CHARS || all.length - skipped.length > DIFF_MAX_PATHS,
        ...(untracked.length ? { untracked } : {}),
        ...(skipped.length ? { sensitiveFilesNotShown: skipped.length } : {}),
      };
    },
  };

  // --- Writes -----------------------------------------------------------------------------------
  /**
   * Plan of a write: the target, its current content and the new content. Rebuilt after the dialog
   * and compared (`sameSource`) so a file changed meanwhile is never overwritten.
   */
  async function buildWritePlan(userId, operation, request) {
    const p = findProject(userId, request.projectId);
    const rel = splitRelative(request.path, { allowRoot: false }).join('/');
    const target = await resolveWritable(fsp, p.root, rel, platform);
    let before = null;
    let beforeSha = null;
    let mtimeMs = null;
    if (target.exists) {
      const current = await files.readFile(p.root, rel);
      if (current.tooLarge || current.binary) throw new HostOpsError('binary_file', 'Fichier binaire ou trop volumineux : modification refusée.');
      before = current.content;
      beforeSha = current.sha256;
      mtimeMs = current.mtimeMs;
    }
    let after;
    if (operation === 'code.write') {
      if (typeof request.content !== 'string') throw new HostOpsError('invalid_request', 'Contenu requis.');
      after = request.content;
    } else {
      if (!target.exists) throw new HostOpsError('not_found', 'Fichier introuvable : utilise host_code_write pour le créer.');
      const oldString = request.oldString;
      const newString = request.newString;
      if (typeof oldString !== 'string' || oldString === '') throw new HostOpsError('invalid_request', 'old_string requis (texte exact à remplacer).');
      if (typeof newString !== 'string') throw new HostOpsError('invalid_request', 'new_string requis.');
      if (oldString === newString) throw new HostOpsError('invalid_request', 'old_string et new_string sont identiques.');
      const count = countOccurrences(before, oldString);
      if (count === 0) throw new HostOpsError('no_match', 'old_string introuvable dans le fichier : relis le fichier (host_code_read) et copie le texte exact.');
      if (count > 1 && request.replaceAll !== true) {
        throw new HostOpsError('multiple_matches', `old_string apparaît ${count} fois : ajoute du contexte pour le rendre unique, ou replace_all: true.`);
      }
      after = request.replaceAll === true ? before.split(oldString).join(newString) : before.replace(oldString, () => newString);
    }
    if (after.length > MAX_WRITE_CHARS) throw new HostOpsError('too_large', 'Contenu trop volumineux.');
    if (before !== null && before === after) throw new HostOpsError('no_change', 'Le contenu est identique : aucune modification.');
    return { project: p, rel, abs: target.abs, exists: target.exists, before, beforeSha, mtimeMs, after, sensitive: isSensitiveFile(rel) };
  }

  function sameSource(a, b) {
    return a.abs === b.abs && a.exists === b.exists && a.beforeSha === b.beforeSha && a.after === b.after;
  }

  function findWriteGrant(store, ctx, plan) {
    if (plan.sensitive) return null;
    return store
      .listGrants()
      .find(
        (g) =>
          g.operation === 'code.write' &&
          g.userId === ctx.userId &&
          g.deviceId === store.getDeviceId() &&
          g.agentId === ctx.agentId &&
          (g.destinationRoots || []).some((r) => isWithin(r, plan.abs, platform))
      );
  }

  function describe(plan) {
    const region = changedRegion(plan.before || '', plan.after);
    const summary = !plan.exists
      ? `Nouveau fichier (${splitLines(plan.after).length} lignes)`
      : `Modification à partir de la ligne ${region.startLine} : −${region.removed.length} / +${region.added.length} lignes`;
    return { summary, preview: previewChange(region), region };
  }

  /**
   * Runs a code operation. `deps` comes from the host-ops service (store, journal, confirm, timeouts).
   * Reads return directly; writes go through consent → re-check → write → verification.
   */
  async function execute(ctx, controller, deps) {
    const { store, journal, confirm, confirmTimeoutMs } = deps;
    const { signal } = controller;
    const operation = ctx.operation;
    const base = { requestId: ctx.requestId, operation };

    if (READERS[operation]) {
      const result = await READERS[operation]({ userId: ctx.userId, request: ctx.request });
      return { ...base, ok: true, status: 'completed', decision: 'none', result, verification: { ok: true } };
    }

    let plan = null;
    let decision = 'none';
    const log = (outcome, errorCode) =>
      journal.add({
        requestId: ctx.requestId,
        agentId: ctx.agentId,
        agentName: ctx.agentName,
        operation,
        source: plan ? plan.project.root : null,
        destination: plan ? plan.rel : typeof ctx.request.path === 'string' ? ctx.request.path : null,
        decision,
        outcome,
        errorCode,
      });
    try {
      plan = await buildWritePlan(ctx.userId, operation, ctx.request);
      const info = describe(plan);
      const grant = findWriteGrant(store, ctx, plan);
      if (grant) {
        decision = 'grant';
      } else {
        const allowPersistent = !plan.sensitive && !rootTooBroad(plan.project.root);
        const timer = setTimeout(() => controller.abort('timeout'), confirmTimeoutMs);
        let answer;
        try {
          answer = await confirm({
            agentId: ctx.agentId,
            agentName: ctx.agentName,
            operation,
            project: plan.project.name,
            projectRoot: plan.project.root,
            file: plan.rel,
            created: !plan.exists,
            summary: info.summary,
            preview: info.preview,
            sensitive: plan.sensitive,
            allowPersistent,
            scope: { destinationRoots: [plan.project.root] },
            signal,
          });
        } finally {
          clearTimeout(timer);
        }
        if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        if (answer !== 'once' && answer !== 'always') {
          decision = 'denied';
          log('denied');
          return { ...base, ok: false, status: 'denied', decision, error: { code: 'denied', message: 'Refusé par l’utilisateur.' } };
        }
        decision = answer;
        if (answer === 'always' && allowPersistent) {
          const created = store.addGrant({
            userId: ctx.userId,
            deviceId: store.getDeviceId(),
            agentId: ctx.agentId,
            agentName: ctx.agentName,
            operation: 'code.write',
            destinationRoots: [plan.project.root],
          });
          base.persistentGrantCreated = Boolean(created);
        }
      }

      if (!store.isCodeEnabled()) throw new HostOpsError('code_disabled', 'Projets de code désactivés pour les agents.');
      if (decision === 'grant' && !findWriteGrant(store, ctx, plan)) throw new HostOpsError('grant_revoked', 'Autorisation révoquée.');
      const fresh = await buildWritePlan(ctx.userId, operation, ctx.request);
      if (!sameSource(plan, fresh)) {
        throw new HostOpsError('changed_during_confirmation', 'Le fichier a changé pendant la confirmation : modification annulée. Relis-le.');
      }
      if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const written = await files.writeFile(fresh.project.root, fresh.rel, fresh.after, {
        createOnly: !fresh.exists,
        ...(fresh.exists ? { expectedMtimeMs: fresh.mtimeMs } : {}),
      });
      const expectedSha = files.sha256(Buffer.from(fresh.after, 'utf8'));
      const ok = written.sha256 === expectedSha;
      log(ok ? 'completed' : 'error', ok ? undefined : 'verification_failed');
      return {
        ...base,
        ok,
        status: ok ? 'completed' : 'error',
        decision,
        result: {
          project: fresh.project.name,
          path: fresh.rel,
          created: !fresh.exists,
          summary: info.summary,
          startLine: info.region.startLine,
          linesRemoved: info.region.removed.length,
          linesAdded: info.region.added.length,
        },
        verification: { ok, sha256: written.sha256, size: written.size },
        ...(ok ? {} : { error: { code: 'verification_failed', message: 'Le contenu relu ne correspond pas.' } }),
      };
    } catch (err) {
      if (err && err.name === 'AbortError') {
        const code = signal.reason === 'timeout' ? 'timeout' : 'cancelled';
        log(code, code);
      } else {
        log('error', err instanceof HostOpsError ? err.code : 'io_error');
      }
      throw err;
    }
  }

  return { execute, CODE_OPERATIONS, CODE_READ_OPERATIONS, CODE_WRITE_OPERATIONS };
}

module.exports = {
  createCodeAgentOps,
  CODE_OPERATIONS,
  CODE_READ_OPERATIONS,
  CODE_WRITE_OPERATIONS,
  changedRegion,
  countOccurrences,
  previewChange,
};
