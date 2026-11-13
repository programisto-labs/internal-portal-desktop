'use strict';

const fs = require('fs');
const path = require('path');
const { HostOpsError, isWithin } = require('./paths');
const { OPERATIONS, buildPlan, planChanged, executePlan } = require('./executor');
const { ID_RE } = require('./store');

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
      if (g.operation !== plan.operation) return false;
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

  return {
    getCapabilities() {
      return {
        available: true,
        enabled: store.isEnabled(),
        deviceId: store.getDeviceId(),
        operations: [...OPERATIONS],
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
      if (!OPERATIONS.includes(operation)) return failure('unsupported_operation', 'Opération non supportée.', { requestId });
      if (!store.isEnabled()) {
        return failure('disabled', "Les opérations sur l'hôte ne sont pas activées dans les options de Lasco Desktop.", { requestId });
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
        request: {
          operation,
          source: request.source,
          destination: request.destination,
          newName: request.newName,
          overwrite: request.overwrite === true,
        },
      };
      pending += 1;
      const job = queue.then(() => run(ctx, controller));
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
