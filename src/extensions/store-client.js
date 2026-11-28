'use strict';

/**
 * Chrome Web Store : recherche de version (protocole de mise à jour Omaha, JSON), téléchargement
 * et vérification des paquets (docs/extensions.md, « Installation »).
 *
 * Le serveur de mise à jour renvoie l'adresse du paquet, sa taille et son SHA-256 : le fichier
 * téléchargé doit correspondre, puis sa signature CRX3 (développeur + Google) est vérifiée.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { CrxError, parseAndVerifyCrx, unpackArchive, isExtensionId } = require('./crx');

const UPDATE_URL = 'https://update.googleapis.com/service/update2/json';
const LEGACY_CRX_URL = 'https://clients2.google.com/service/update2/crx';
/** Adresse de mise à jour des extensions du store (manifest.update_url). */
const STORE_UPDATE_URLS = new Set([
  'https://clients2.google.com/service/update2/crx',
  'https://update.googleapis.com/service/update2/crx',
]);
/** Hôtes d'où un paquet peut être téléchargé. */
const ALLOWED_DOWNLOAD_HOSTS = [/^clients2\.googleusercontent\.com$/, /^clients2\.google\.com$/, /^[a-z0-9-]+\.gvt1\.com$/, /^edgedl\.me\.gvt1\.com$/];

function omahaPlatform(platform = process.platform) {
  if (platform === 'darwin') return 'mac';
  if (platform === 'win32') return 'win';
  return platform;
}

function omahaArch(arch = process.arch) {
  if (arch === 'ia32') return 'x86';
  return arch;
}

/** Identifiant d'extension depuis un identifiant, une adresse du store ou de l'ancien store. */
function parseStoreReference(input) {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  if (isExtensionId(value)) return value;
  let url;
  try {
    url = new URL(value);
  } catch (_) {
    return null;
  }
  if (!/^(chromewebstore\.google\.com|chrome\.google\.com)$/.test(url.hostname)) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  const id = parts.reverse().find(isExtensionId);
  return id || null;
}

function isStoreUpdateUrl(updateUrl) {
  return typeof updateUrl === 'string' && STORE_UPDATE_URLS.has(updateUrl.replace(/\/$/, ''));
}

function isAllowedDownloadUrl(href) {
  try {
    const url = new URL(href);
    return url.protocol === 'https:' && ALLOWED_DOWNLOAD_HOSTS.some((re) => re.test(url.hostname));
  } catch (_) {
    return false;
  }
}

/**
 * Vérifie les versions disponibles : `apps` = `[{ id, version? }]`. Renvoie
 * `Map(id → { version, url, sha256, size } | { error })`.
 */
async function checkVersions(apps, { fetchImpl = fetch, chromeVersion, installSource = 'ondemand' } = {}) {
  const result = new Map();
  if (!Array.isArray(apps) || apps.length === 0) return result;
  const body = {
    request: {
      '@updater': 'lasco-desktop',
      acceptformat: 'crx3',
      app: apps.map(({ id, version }) => ({
        appid: id,
        // Version connue : le serveur ne renvoie un paquet que s'il est plus récent.
        ...(version ? { version } : {}),
        installsource: installSource,
        updatecheck: {},
      })),
      os: { platform: omahaPlatform(), arch: omahaArch() },
      prodversion: chromeVersion,
      protocol: '3.1',
      requestid: `{${crypto.randomUUID()}}`,
      sessionid: `{${crypto.randomUUID()}}`,
    },
  };
  const response = await fetchImpl(UPDATE_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Goog-Update-Interactivity': installSource === 'ondemand' ? 'fg' : 'bg',
      'X-Goog-Update-AppId': apps.map((a) => a.id).join(','),
      'X-Goog-Update-Updater': `chromiumcrx-${chromeVersion}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new CrxError('store_unreachable', `update check HTTP ${response.status}`);
  const text = await response.text();
  const json = JSON.parse(text.replace(/^\)\]\}'\n?/, ''));
  for (const app of (json && json.response && json.response.app) || []) {
    const id = app.appid;
    if (!isExtensionId(id)) continue;
    const check = app.updatecheck || {};
    if (app.status && app.status !== 'ok') {
      result.set(id, { error: app.status === 'error-unknownApplication' ? 'not_found' : app.status });
      continue;
    }
    if (check.status === 'noupdate') {
      result.set(id, { noUpdate: true });
      continue;
    }
    if (check.status !== 'ok') {
      result.set(id, { error: check.status || 'unknown' });
      continue;
    }
    const pkg = check.manifest && check.manifest.packages && check.manifest.packages.package && check.manifest.packages.package[0];
    const base = ((check.urls && check.urls.url) || []).map((u) => u.codebase).find(isAllowedDownloadUrl);
    if (!pkg || !base) {
      result.set(id, { error: 'no_package' });
      continue;
    }
    result.set(id, {
      version: check.manifest.version,
      url: base.endsWith('/') ? base + (pkg.name || '') : base,
      sha256: typeof pkg.hash_sha256 === 'string' ? pkg.hash_sha256.toLowerCase() : null,
      size: Number(pkg.size) || null,
    });
  }
  return result;
}

/** Ancienne adresse de téléchargement direct (repli quand le serveur JSON ne répond pas). */
function legacyCrxUrl(id, chromeVersion) {
  const url = new URL(LEGACY_CRX_URL);
  url.searchParams.set('response', 'redirect');
  url.searchParams.set('acceptformat', 'crx3');
  url.searchParams.set('prodversion', chromeVersion);
  url.searchParams.set('x', `id=${id}&uc`);
  return url.toString();
}

const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;

async function downloadBuffer(url, { fetchImpl = fetch, expectedSha256 = null, expectedSize = null } = {}) {
  const response = await fetchImpl(url, { redirect: 'follow' });
  if (!response.ok) throw new CrxError(response.status === 404 ? 'not_found' : 'download_failed', `HTTP ${response.status}`);
  if (response.url && !isAllowedDownloadUrl(response.url) && !response.url.startsWith(LEGACY_CRX_URL)) {
    throw new CrxError('download_untrusted_host');
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_DOWNLOAD_BYTES) throw new CrxError('crx_too_large');
  if (expectedSize && buffer.length !== expectedSize) throw new CrxError('download_size_mismatch');
  if (expectedSha256) {
    const actual = crypto.createHash('sha256').update(buffer).digest('hex');
    if (actual !== expectedSha256) throw new CrxError('download_hash_mismatch');
  }
  return buffer;
}

/**
 * Télécharge, vérifie et décompresse une extension du store dans `targetDirFor(version)`.
 * Renvoie `{ id, version, dir, manifest }`. Le dossier final n'apparaît qu'une fois complet.
 */
async function downloadStoreExtension(id, { targetDirFor, fetchImpl = fetch, chromeVersion, known = null, fsImpl = fs }) {
  let info = known;
  if (!info) {
    try {
      info = (await checkVersions([{ id }], { fetchImpl, chromeVersion })).get(id) || null;
    } catch (_) {
      info = null;
    }
  }
  if (info && info.error === 'not_found') throw new CrxError('not_found');
  const buffer = info && info.url
    ? await downloadBuffer(info.url, { fetchImpl, expectedSha256: info.sha256, expectedSize: info.size })
    : await downloadBuffer(legacyCrxUrl(id, chromeVersion), { fetchImpl });
  const crx = parseAndVerifyCrx(buffer, { expectedId: id, requirePublisherProof: true });
  const stagingRoot = path.dirname(targetDirFor('staging'));
  const staging = path.join(stagingRoot, `.staging-${crypto.randomUUID()}`);
  try {
    const manifest = unpackArchive(crx.archive, staging, { fsImpl });
    if (typeof manifest.version !== 'string' || !manifest.version) throw new CrxError('manifest_invalid');
    // Clé de l'éditeur gardée dans le manifeste : Electron en déduit le même identifiant que Chrome.
    manifest.key = crx.publicKey;
    fsImpl.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));
    const dir = targetDirFor(manifest.version);
    fsImpl.rmSync(dir, { recursive: true, force: true });
    fsImpl.mkdirSync(path.dirname(dir), { recursive: true });
    fsImpl.renameSync(staging, dir);
    return { id, version: manifest.version, dir, manifest };
  } catch (error) {
    fsImpl.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

module.exports = {
  STORE_UPDATE_URLS,
  checkVersions,
  downloadBuffer,
  downloadStoreExtension,
  isAllowedDownloadUrl,
  isStoreUpdateUrl,
  legacyCrxUrl,
  parseStoreReference,
};
