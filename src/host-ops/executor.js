'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const {
  HostOpsError,
  assertSafeName,
  lstatOrNull,
  sameFingerprint,
  resolveExistingFile,
  resolveTarget,
} = require('./paths');

const OPERATIONS = Object.freeze(['file.move', 'file.copy', 'file.rename', 'folder.create']);

/**
 * Resolve every path of a request against the real filesystem.
 * Called before the confirmation and again right before execution (TOCTOU re-check).
 */
async function buildPlan(fsp, request, platform = process.platform) {
  const { operation } = request;
  const overwrite = request.overwrite === true;
  if (!OPERATIONS.includes(operation)) throw new HostOpsError('unsupported_operation', 'Opération non supportée.');
  if (operation === 'folder.create') {
    const target = await resolveTarget(fsp, request.destination, 'destination', platform);
    if (target.exists) throw new HostOpsError('destination_exists', 'Le dossier existe déjà.');
    return { operation, overwrite: false, source: null, target };
  }
  const source = await resolveExistingFile(fsp, request.source, 'source', platform);
  let destination = request.destination;
  if (operation === 'file.rename') {
    const newName = assertSafeName(request.newName, 'newName');
    destination = path.join(source.dir, newName);
  }
  const target = await resolveTarget(fsp, destination, 'destination', platform);
  if (target.isDirectory) throw new HostOpsError('destination_is_directory', 'La destination est un dossier.');
  if (target.path === source.path) throw new HostOpsError('same_path', 'Source et destination identiques.');
  if (target.exists && !overwrite) throw new HostOpsError('destination_exists', 'La destination existe déjà (écrasement non demandé).');
  if (!target.exists && overwrite) {
    // Explicit overwrite request with nothing to overwrite: treat as normal operation.
    return { operation, overwrite: false, source, target };
  }
  return { operation, overwrite, source, target };
}

function planChanged(a, b) {
  const same = (x, y) => (x === null || y === null ? x === y : x.path === y.path && x.exists === y.exists);
  return (
    !same(a.target, b.target) ||
    (a.source && (!b.source || a.source.path !== b.source.path || !sameFingerprint(a.source.fingerprint, b.source.fingerprint))) ||
    (a.target && !sameFingerprint(a.target.fingerprint, b.target.fingerprint))
  );
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw new HostOpsError(signal.reason === 'timeout' ? 'timeout' : 'cancelled', 'Opération interrompue.');
}

const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

/** Copy source into a temp file next to the destination, then publish it atomically. */
async function copyToTarget(plan, signal, deps) {
  const { source, target, overwrite } = plan;
  const tmp = path.join(target.dir, `.lasco-tmp-${crypto.randomBytes(8).toString('hex')}`);
  let srcHandle;
  let tmpCreated = false;
  try {
    srcHandle = await deps.fsp.open(source.path, fs.constants.O_RDONLY | O_NOFOLLOW);
    const st = await srcHandle.stat();
    if (!st.isFile() || st.dev !== source.fingerprint.dev || st.ino !== source.fingerprint.ino) {
      throw new HostOpsError('source_changed', 'La source a changé pendant le contrôle.');
    }
    const out = await deps.fsp.open(tmp, 'wx', 0o600);
    tmpCreated = true;
    await pipeline(srcHandle.createReadStream({ autoClose: false }), out.createWriteStream(), signal ? { signal } : undefined);
    throwIfAborted(signal);
    if (overwrite) {
      await deps.fsp.rename(tmp, target.path);
    } else {
      try {
        await deps.fsp.link(tmp, target.path); // fails with EEXIST: never clobbers
      } catch (err) {
        if (err && err.code === 'EEXIST') throw new HostOpsError('destination_exists', 'La destination existe déjà.');
        throw err;
      }
      await deps.fsp.unlink(tmp);
    }
    tmpCreated = false;
    try {
      await deps.fsp.chmod(target.path, st.mode & 0o777);
    } catch (_) {
      // best effort
    }
  } finally {
    if (srcHandle) await srcHandle.close().catch(() => {});
    if (tmpCreated) await deps.fsp.unlink(tmp).catch(() => {});
  }
}

async function moveFile(plan, signal, deps) {
  const { source, target, overwrite } = plan;
  // verify source identity immediately before the move
  const st = await lstatOrNull(deps.fsp, source.path);
  if (!st || !st.isFile() || st.dev !== source.fingerprint.dev || st.ino !== source.fingerprint.ino) {
    throw new HostOpsError('source_changed', 'La source a changé pendant le contrôle.');
  }
  if (overwrite) {
    try {
      await deps.fsp.rename(source.path, target.path);
      return;
    } catch (err) {
      if (!(err && err.code === 'EXDEV')) throw err;
    }
  } else {
    try {
      await deps.fsp.link(source.path, target.path); // atomic no-clobber on same volume
      await deps.fsp.unlink(source.path);
      return;
    } catch (err) {
      if (err && err.code === 'EEXIST') throw new HostOpsError('destination_exists', 'La destination existe déjà.');
      if (!(err && (err.code === 'EXDEV' || err.code === 'EPERM' || err.code === 'ENOTSUP'))) throw err;
    }
  }
  // Cross-volume (or no hard-link support): copy, verify, then remove the source.
  await copyToTarget(plan, signal, deps);
  const check = await deps.fsp.stat(target.path);
  if (check.size !== source.fingerprint.size) {
    throw new HostOpsError('verification_failed', 'Copie incomplète, source conservée.');
  }
  await deps.fsp.unlink(source.path);
}

async function verify(plan, deps) {
  const { operation, source, target } = plan;
  const dst = await lstatOrNull(deps.fsp, target.path);
  const verification = { destinationExists: Boolean(dst) };
  if (operation === 'folder.create') {
    verification.destinationIsDirectory = Boolean(dst && dst.isDirectory());
    verification.ok = verification.destinationIsDirectory;
    return verification;
  }
  verification.destinationSize = dst ? dst.size : null;
  const sizeOk = Boolean(dst && dst.isFile() && dst.size === source.fingerprint.size);
  if (operation === 'file.copy') {
    const src = await lstatOrNull(deps.fsp, source.path);
    verification.sourceStillPresent = Boolean(src);
    verification.ok = sizeOk && Boolean(src);
  } else {
    const src = await lstatOrNull(deps.fsp, source.path);
    verification.sourceAbsent = !src;
    verification.ok = sizeOk && !src;
  }
  return verification;
}

/** Run an already confirmed + re-validated plan and return a proven result. */
async function executePlan(plan, { signal, fsp = fs.promises } = {}) {
  const deps = { fsp };
  throwIfAborted(signal);
  switch (plan.operation) {
    case 'folder.create':
      try {
        await fsp.mkdir(plan.target.path, { recursive: false, mode: 0o755 });
      } catch (err) {
        if (err && err.code === 'EEXIST') throw new HostOpsError('destination_exists', 'Le dossier existe déjà.');
        throw err;
      }
      break;
    case 'file.copy':
      await copyToTarget(plan, signal, deps);
      break;
    case 'file.move':
    case 'file.rename':
      await moveFile(plan, signal, deps);
      break;
    default:
      throw new HostOpsError('unsupported_operation', 'Opération non supportée.');
  }
  const verification = await verify(plan, deps);
  if (!verification.ok) throw new HostOpsError('verification_failed', "Le résultat n'a pas pu être vérifié.");
  return verification;
}

module.exports = { OPERATIONS, buildPlan, planChanged, executePlan };
