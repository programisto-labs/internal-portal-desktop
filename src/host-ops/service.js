'use strict';

const fs = require('fs');
const path = require('path');
const { HostOpsError, isWithin } = require('./paths');
const { OPERATIONS, buildPlan, planChanged, executePlan } = require('./executor');
const { ID_RE } = require('./store');
const { buildShellPlan, maskSecrets, runShell, shellGrantCovers } = require('./shell');

const SHELL_OPERATION = 'shell.run';
const ALL_OPERATIONS = [...OPERATIONS, SHELL_OPERATION];

const MAX_QUEUE = 10;
const MAX_SEEN = 1000;

function cleanLabel(value, max) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function failure(code, message, extra = {}) {
  return { ok: false, status: code === 'timeout' ? 'timeout' : code === 'cancelled' ? 'cancelled' : 'error', error: { code, message }, ...extra };
}

function mapError(err, signal) {
  if (err instanceof HostOpsError) return { code: err.code, message: err.message };
  if (err && err.name === 'AbortError') {
    const code = signal && signal.reason === 'timeout' ? 'timeout' : 'cancelled';
    return { code, message: code === 'timeout' ? "Délai dépassé, l'opération a été interrompue." : 'Opération annulée.' };
  }
  if (err && (err.code === 'EACCES' || err.code === 'EPERM')) return { code: 'permission_denied', message: 'Permission refusée par le système.' };
  if (err && err.code === 'ENOSPC') return { code: 'no_space', message: "Espace disque insuffisant." };
  return { code: 'io_error', message: "Erreur système pendant l'opération." };
}

function createHostOpsService({
  store,
  journal,
  confirm,
  fsp = fs.promises,
  platform = process.platform,
  homeDir = require('os').homedir(),
  confirmTimeoutMs = 120000,
  execTimeoutMs = 60000,
  env = process.env,
  spawnImpl,
}) {
  const inflight = new Map(); // requestId -> AbortController
  const seen = new Set();
  let queue = Promise.resolve();
  let pending = 0;

  function persistentScope(plan) {
    const op = plan.operation;
    return {
      sourceRoots: op === 'folder.create' ? [] : [plan.source.dir],
      destinationRoots: op === 'file.rename' ? [] : [plan.target.dir],
    };
  }

  function tooBroad(root) {
    const parsed = path.parse(root);
    return root === parsed.root || isWithin(root, homeDir, platform);
  }

  function findGrant(ctx, plan) {
    return store.listGrants().find((g) => {
      if (g.userId !== ctx.userId || g.deviceId !== store.getDeviceId() || g.agentId !== ctx.agentId) return false;
      if (g.operation !== plan.operation || g.operation === SHELL_OPERATION) return false;
      const inRoots = (roots, dir) => roots.some((r) => isWithin(r, dir, platform));
      if (plan.operation !== 'folder.create' && !inRoots(g.sourceRoots, plan.source.dir)) return false;
      if (plan.operation !== 'file.rename' && !inRoots(g.destinationRoots, plan.target.dir)) return false;
      return true;
    });
  }

  function log(ctx, plan, decision, outcome, errorCode) {
    journal.add({
      requestId: ctx.requestId,
      agentId: ctx.agentId,
      agentName: ctx.agentName,
      operation: ctx.operation,
      source: plan && plan.source ? plan.source.path : ctx.rawSource,
      destination: plan ? plan.target.path : ctx.rawDestination,
      decision,
      outcome,
      errorCode,
    });
  }

  async function run(ctx, controller) {
    const { signal } = controller;
    const base = { requestId: ctx.requestId, operation: ctx.operation };
    let plan = null;
    let decision = 'none';
    try {
      if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      plan = await buildPlan(fsp, ctx.request, platform);

      let grant = plan.overwrite ? null : findGrant(ctx, plan);
      if (grant) {
        decision = 'grant';
      } else {
        const scope = persistentScope(plan);
        const allowPersistent =
          !plan.overwrite && [...scope.sourceRoots, ...scope.destinationRoots].every((r) => !tooBroad(r));
        const timer = setTimeout(() => controller.abort('timeout'), confirmTimeoutMs);
        let answer;
        try {
          answer = await confirm({
            agentId: ctx.agentId,
            agentName: ctx.agentName,
            operation: plan.operation,
            source: plan.source ? plan.source.path : null,
            destination: plan.target.path,
            overwrite: plan.overwrite,
            allowPersistent,
            scope,
            signal,
          });
        } finally {
          clearTimeout(timer);
        }
        if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        if (answer !== 'once' && answer !== 'always') {
          decision = 'denied';
          log(ctx, plan, decision, 'denied');
          return { ...base, ok: false, status: 'denied', decision, error: { code: 'denied', message: 'Refusé par l’utilisateur.' } };
        }
        decision = answer;
        if (answer === 'always' && allowPersistent) {
          const created = store.addGrant({
            userId: ctx.userId,
            deviceId: store.getDeviceId(),
            agentId: ctx.agentId,
            agentName: ctx.agentName,
            operation: plan.operation,
            ...scope,
          });
          base.persistentGrantCreated = Boolean(created);
        }
      }

      // Everything may have moved while the dialog was open (or the grant revoked).
      if (!store.isEnabled()) throw new HostOpsError('disabled', 'Capacité désactivée.');
      if (decision === 'grant' && !store.listGrants().some((g) => g.id === grant.id)) {
        throw new HostOpsError('grant_revoked', 'Autorisation révoquée.');
      }
      const fresh = await buildPlan(fsp, ctx.request, platform);
      if (planChanged(plan, fresh)) {
        throw new HostOpsError('changed_during_confirmation', 'Les chemins ont changé après le contrôle, opération annulée.');
      }

      const execTimer = setTimeout(() => controller.abort('timeout'), execTimeoutMs);
      let verification;
      try {
        verification = await executePlan(fresh, { signal, fsp });
      } finally {
        clearTimeout(execTimer);
      }
      log(ctx, fresh, decision, 'completed');
      return {
        ...base,
        ok: true,
        status: 'completed',
        decision,
        result: { source: fresh.source ? fresh.source.path : null, destination: fresh.target.path },
        verification,
      };
    } catch (err) {
      const { code, message } = mapError(err, signal);
      log(ctx, plan, decision, code === 'cancelled' || code === 'timeout' ? code : 'error', code);
      return { ...base, ...failure(code, message), decision };
    }
  }

  function findShellGrant(ctx, plan) {
    return store.listGrants().find(
      (g) =>
        g.userId === ctx.userId &&
        g.deviceId === store.getDeviceId() &&
        g.agentId === ctx.agentId &&
        shellGrantCovers(g, plan, platform)
    );
  }

  function logShell(ctx, plan, decision, outcome, errorCode, exitCode) {
    journal.add({
      requestId: ctx.requestId,
      agentId: ctx.agentId,
      agentName: ctx.agentName,
      operation: SHELL_OPERATION,
      // Journal: folder and masked command only, never the output.
      source: plan ? plan.cwd : ctx.rawCwd,
      destination: maskSecrets(plan ? plan.command : ctx.rawCommand || ''),
      decision,
      outcome: exitCode === undefined || exitCode === null ? outcome : `${outcome} (code ${exitCode})`,
      errorCode,
    });
  }

  async function runShellRequest(ctx, controller) {
    const { signal } = controller;
    const base = { requestId: ctx.requestId, operation: SHELL_OPERATION };
    let plan = null;
    let decision = 'none';
    try {
      if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      plan = await buildShellPlan(fsp, ctx.request, { platform, homeDir });
      const grant = findShellGrant(ctx, plan);
      if (grant) {
        decision = 'grant';
      } else {
        const allowPersistent = !plan.notRememberableReason && plan.prefix.length > 0 && path.parse(plan.cwd).root !== plan.cwd;
        const timer = setTimeout(() => controller.abort('timeout'), confirmTimeoutMs);
        let answer;
        try {
          answer = await confirm({
            agentId: ctx.agentId,
            agentName: ctx.agentName,
            operation: SHELL_OPERATION,
            command: plan.command,
            cwd: plan.cwd,
            timeoutMs: plan.timeoutMs,
            allowPersistent,
            notRememberableReason: plan.notRememberableReason,
            scope: { commandPrefix: plan.prefix, cwdRoots: [plan.cwd] },
            signal,
          });
        } finally {
          clearTimeout(timer);
        }
        if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        if (answer !== 'once' && answer !== 'always') {
          decision = 'denied';
          logShell(ctx, plan, decision, 'denied');
          return { ...base, ok: false, status: 'denied', decision, error: { code: 'denied', message: 'Refusé par l’utilisateur.' } };
        }
        decision = answer;
        if (answer === 'always' && allowPersistent) {
          const created = store.addGrant({
            userId: ctx.userId,
            deviceId: store.getDeviceId(),
            agentId: ctx.agentId,
            agentName: ctx.agentName,
            operation: SHELL_OPERATION,
            commandPrefix: plan.prefix,
            cwdRoots: [plan.cwd],
          });
          base.persistentGrantCreated = Boolean(created);
        }
      }

      if (!store.isShellEnabled()) throw new HostOpsError('shell_disabled', 'Commandes shell désactivées.');
      if (decision === 'grant' && !findShellGrant(ctx, plan)) {
        throw new HostOpsError('grant_revoked', 'Autorisation révoquée.');
      }
      // The folder may have been replaced (symlink swap) while the dialog was open.
      const fresh = await buildShellPlan(fsp, ctx.request, { platform, homeDir });
      if (fresh.cwd !== plan.cwd || fresh.command !== plan.command) {
        throw new HostOpsError('changed_during_confirmation', 'Le dossier de travail a changé après le contrôle, commande annulée.');
      }

      const execTimer = setTimeout(() => controller.abort('timeout'), fresh.timeoutMs);
      let out;
      try {
        out = await runShell({ command: fresh.command, cwd: fresh.cwd, signal, platform, env, ...(spawnImpl ? { spawnImpl } : {}) });
      } finally {
        clearTimeout(execTimer);
      }
      const result = {
        command: fresh.command,
        cwd: fresh.cwd,
        exitCode: out.exitCode,
        signal: out.signal,
        stdout: out.stdout,
        stderr: out.stderr,
        truncated: out.truncated,
        durationMs: out.durationMs,
      };
      if (out.aborted) {
        const code = signal.reason === 'timeout' ? 'timeout' : 'cancelled';
        logShell(ctx, fresh, decision, code, code, out.exitCode);
        return {
          ...base,
          ...failure(code, code === 'timeout' ? 'Délai dépassé, la commande a été arrêtée.' : 'Commande arrêtée.'),
          decision,
          result,
        };
      }
      logShell(ctx, fresh, decision, 'completed', undefined, out.exitCode);
      // The proof is the real exit status reported by the OS; a non-zero code is a real result too.
      return {
        ...base,
        ok: true,
        status: 'completed',
        decision,
        result,
        verification: { ok: true, exitCode: out.exitCode, signal: out.signal },
      };
    } catch (err) {
      const mapped =
        err && err.code === 'ENOENT' && !(err instanceof HostOpsError)
          ? { code: 'shell_unavailable', message: 'Shell introuvable sur cet ordinateur.' }
          : mapError(err, signal);
      logShell(ctx, plan, decision, mapped.code === 'cancelled' || mapped.code === 'timeout' ? mapped.code : 'error', mapped.code);
      return { ...base, ...failure(mapped.code, mapped.message), decision };
    }
  }

  return {
    getCapabilities() {
      return {
        available: true,
        enabled: store.isEnabled(),
        shellEnabled: store.isShellEnabled(),
        deviceId: store.getDeviceId(),
        operations: store.isShellEnabled() ? [...ALL_OPERATIONS] : [...OPERATIONS],
        scope: 'host',
        // Lets the agent turn "~/Downloads/x.pdf" into an absolute path; never sent to the model unless asked.
        platform,
        homeDir,
      };
    },

    cancel(requestId) {
      const c = typeof requestId === 'string' ? inflight.get(requestId) : null;
      if (!c) return { ok: false, error: { code: 'unknown_request', message: 'Requête inconnue.' } };
      c.abort('cancelled');
      return { ok: true };
    },

    async execute(request) {
      if (!request || typeof request !== 'object') return failure('invalid_request', 'Requête invalide.');
      const { requestId, agentId, userId, operation } = request;
      if (![requestId, agentId, userId].every((v) => typeof v === 'string' && ID_RE.test(v))) {
        return failure('invalid_request', 'Identité de requête invalide.');
      }
      if (!ALL_OPERATIONS.includes(operation)) return failure('unsupported_operation', 'Opération non supportée.', { requestId });
      if (!store.isEnabled()) {
        return failure('disabled', "Les opérations sur l'hôte ne sont pas activées dans les options de Lasco Desktop.", { requestId });
      }
      if (operation === SHELL_OPERATION && !store.isShellEnabled()) {
        return failure(
          'shell_disabled',
          "Les commandes shell ne sont pas activées dans Lasco Desktop (Fichier > Opérations sur l'hôte).",
          { requestId }
        );
      }
      if (request.deviceId !== undefined && request.deviceId !== store.getDeviceId()) {
        return failure('wrong_device', 'Appareil non concerné par cette requête.', { requestId });
      }
      if (seen.has(requestId) || inflight.has(requestId)) {
        return failure('duplicate_request', 'Requête déjà traitée.', { requestId });
      }
      if (pending >= MAX_QUEUE) return failure('busy', 'Trop de requêtes en attente.', { requestId });
      seen.add(requestId);
      if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value);

      const controller = new AbortController();
      inflight.set(requestId, controller);
      const ctx = {
        requestId,
        agentId,
        userId,
        operation,
        agentName: cleanLabel(request.agentName, 80) || agentId,
        rawSource: typeof request.source === 'string' ? request.source : null,
        rawDestination: typeof request.destination === 'string' ? request.destination : null,
        rawCommand: typeof request.command === 'string' ? request.command.slice(0, 300) : null,
        rawCwd: typeof request.cwd === 'string' ? request.cwd : null,
        request:
          operation === SHELL_OPERATION
            ? { command: request.command, cwd: request.cwd, timeoutMs: request.timeoutMs }
            : {
                operation,
                source: request.source,
                destination: request.destination,
                newName: request.newName,
                overwrite: request.overwrite === true,
              },
      };
      pending += 1;
      const job = queue.then(() => (operation === SHELL_OPERATION ? runShellRequest(ctx, controller) : run(ctx, controller)));
      queue = job.catch(() => {});
      try {
        return await job;
      } finally {
        pending -= 1;
        inflight.delete(requestId);
      }
    },
  };
}

module.exports = { createHostOpsService, cleanLabel };
