'use strict';

/**
 * Extensions Chrome des onglets web (docs/extensions.md).
 *
 * Un service par application ; une « session d'extensions » par session Electron d'onglets web
 * (`attachSession`), jamais pour `persist:portal` ni une session privée. Les extensions sont
 * installées par profil (`registry.js`) et chargées dans chaque session de ce profil.
 */

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { CrxError, extensionIdFromPath, isExtensionId, stripBom } = require('./crx');
const {
  addedWarnings,
  apiPermissions,
  bestIconPath,
  hasAction,
  localizeManifestString,
  optionsPage,
  permissionWarnings,
  readOriginalManifest,
  requestedHostPatterns,
  isAllHostsPattern,
  writeEffectiveManifest,
} = require('./manifest');
const { createExtensionRegistry, normalizeOrigin, normalizePolicy, policyBlockReason, sanitizeProfileId } = require('./registry');
const { checkVersions, downloadStoreExtension, isStoreUpdateUrl, parseStoreReference } = require('./store-client');
const { createDnrService } = require('./dnr/service');
const { launchWebAuthFlow } = require('./identity');

const WEBSTORE_ORIGIN = 'https://chromewebstore.google.com';
const UPDATE_FIRST_DELAY_MS = 30 * 1000;
const UPDATE_INTERVAL_MS = 5 * 60 * 60 * 1000;
const INSTALL_PROMPT_TIMEOUT_MS = 5 * 60 * 1000;

function storeUrl(id) {
  return `${WEBSTORE_ORIGIN}/detail/${id}`;
}

/** L'appel vient-il bien d'un contexte de l'extension annoncée (page ou service worker) ? */
function senderIsExtension(event) {
  const id = event && event.extension && event.extension.id;
  if (!id) return false;
  const prefix = `chrome-extension://${id}/`;
  try {
    const sender = event.sender;
    if (event.type === 'service-worker') return Boolean(sender && String(sender.scope || '').startsWith(prefix));
    return Boolean(sender && !sender.isDestroyed() && String(sender.getURL()).startsWith(prefix));
  } catch (_) {
    return false;
  }
}

function createExtensionsService({ electron, userDataDir, chromeVersion, isProtectedUrl = () => false, protectedOrigins = () => [] }) {
  const { session: sessionApi, BrowserWindow, dialog, ipcMain, nativeImage } = electron;
  const rootDir = path.join(userDataDir, 'extensions');
  /** profilId → registre (partagé par les sessions du profil). */
  const registries = new Map();
  /** session → contexte. */
  const contexts = new Map();
  /** profilId → politique du workspace (envoyée par la coquille). */
  const policies = new Map();
  /** Demandes d'autorisation en attente : requestId → resolve. */
  const pendingPrompts = new Map();
  const changeListeners = new Set();
  let updateTimer = null;
  let webstoreHandlersInstalled = false;

  function registryFor(profileId) {
    const key = sanitizeProfileId(profileId);
    let registry = registries.get(key);
    if (!registry) {
      registry = createExtensionRegistry({ rootDir, profileId: key });
      registries.set(key, registry);
    }
    return registry;
  }

  function contextsOfProfile(profileId) {
    const key = sanitizeProfileId(profileId);
    return [...contexts.values()].filter((ctx) => ctx.profileId === key);
  }

  function emitChange(profileId) {
    for (const listener of changeListeners) {
      try {
        listener({ profileId: sanitizeProfileId(profileId) });
      } catch (_) {
        // Abonné en erreur : ignoré.
      }
    }
  }

  function policyFor(profileId) {
    return policies.get(sanitizeProfileId(profileId)) || null;
  }

  function blockedReasonFor(profileId, entry) {
    const policy = policyFor(profileId);
    if (!policy) return null;
    if (entry && entry.source === 'unpacked' && policy.allowDeveloperMode === false) return 'developer_mode_disabled';
    return policyBlockReason(policy, entry ? entry.id : null);
  }

  // --- Accès aux sites ---

  function hostAllowed(profileId, extensionId, url) {
    const entry = registryFor(profileId).get(extensionId);
    if (!entry) return false;
    if (isProtectedUrl(url)) return false;
    if (entry.siteAccess === 'all') return true;
    const origin = normalizeOrigin(url);
    if (!origin) return false;
    if (entry.siteAccess === 'click') return false;
    const host = new URL(origin).hostname;
    return entry.sites.some((site) => {
      const siteHost = new URL(site).hostname;
      return host === siteHost || host.endsWith(`.${siteHost}`);
    });
  }

  function effectiveOptions(entry) {
    return { siteAccess: entry.siteAccess, sites: entry.sites, protectedOrigins: protectedOrigins() };
  }

  // --- Chargement dans les sessions ---

  async function loadInto(ctx, entry) {
    const extensions = ctx.session.extensions;
    if (extensions.getExtension(entry.id)) return extensions.getExtension(entry.id);
    if (entry.source === 'store') writeEffectiveManifest(entry.path, effectiveOptions(entry));
    const extension = await extensions.loadExtension(entry.path, { allowFileAccess: false });
    ctx.managed.add(extension.id);
    if (extension.id !== entry.id) {
      extensions.removeExtension(extension.id);
      throw new CrxError('extension_id_mismatch');
    }
    return extension;
  }

  function unloadFrom(ctx, id) {
    try {
      if (ctx.session.extensions.getExtension(id)) ctx.session.extensions.removeExtension(id);
    } catch (_) {
      // Déjà retirée.
    }
    ctx.dnr.removeExtension(id);
    ctx.errors.delete(id);
    ctx.managed.delete(id);
  }

  async function syncContext(ctx) {
    const registry = registryFor(ctx.profileId);
    for (const entry of registry.list()) {
      const shouldRun = entry.enabled && !blockedReasonFor(ctx.profileId, entry) && fs.existsSync(entry.path);
      const loaded = Boolean(ctx.session.extensions.getExtension(entry.id));
      if (shouldRun && !loaded) {
        try {
          await loadInto(ctx, entry);
          ctx.errors.delete(entry.id);
        } catch (error) {
          ctx.errors.set(entry.id, (error && error.message) || String(error));
          console.warn(`[extensions] ${entry.id} not loaded:`, error && error.message);
        }
      } else if (!shouldRun && loaded) unloadFrom(ctx, entry.id);
    }
    // Extension retirée du registre (autre session du profil) : retirée ici aussi.
    // Les extensions internes de Lasco (mode responsive des DevTools) ne sont jamais touchées.
    for (const id of [...ctx.managed]) {
      if (!registry.has(id)) unloadFrom(ctx, id);
    }
  }

  async function syncProfile(profileId) {
    for (const ctx of contextsOfProfile(profileId)) await syncContext(ctx);
    emitChange(profileId);
  }

  async function reloadEverywhere(profileId, id) {
    for (const ctx of contextsOfProfile(profileId)) unloadFrom(ctx, id);
    await syncProfile(profileId);
  }

  // --- Informations ---

  function readManifestSafe(entry) {
    try {
      return readOriginalManifest(entry.path);
    } catch (_) {
      return null;
    }
  }

  function iconDataUrl(entry, manifest, size = 32) {
    const relative = manifest && bestIconPath(manifest, size);
    if (!relative) return null;
    const file = path.resolve(entry.path, relative);
    if (!file.startsWith(path.resolve(entry.path) + path.sep)) return null;
    try {
      const image = nativeImage.createFromPath(file);
      if (image.isEmpty()) return null;
      return image.resize({ width: size, height: size, quality: 'best' }).toDataURL();
    } catch (_) {
      return null;
    }
  }

  function describe(profileId, entry, locales) {
    const manifest = readManifestSafe(entry) || {};
    const name = localizeManifestString(entry.path, manifest, manifest.name, locales) || entry.id;
    const blocked = blockedReasonFor(profileId, entry);
    const errors = contextsOfProfile(profileId).map((ctx) => ctx.errors.get(entry.id)).filter(Boolean);
    const hosts = requestedHostPatterns(manifest);
    const options = optionsPage(manifest);
    return {
      id: entry.id,
      name,
      shortName: localizeManifestString(entry.path, manifest, manifest.short_name, locales) || name,
      version: manifest.version || entry.version,
      description: localizeManifestString(entry.path, manifest, manifest.description, locales) || '',
      manifestVersion: manifest.manifest_version || null,
      icon: iconDataUrl(entry, manifest, 48),
      source: entry.source,
      path: entry.source === 'unpacked' ? entry.path : null,
      enabled: entry.enabled && !blocked,
      userEnabled: entry.enabled,
      disabledReason: blocked ? 'policy' : entry.pendingPermissions ? 'permissions' : !entry.enabled ? entry.disabledReason || 'user' : errors.length > 0 ? 'error' : null,
      policyReason: blocked,
      pinned: entry.pinned,
      hasAction: hasAction(manifest),
      permissions: apiPermissions(manifest),
      hostPermissions: hosts,
      requestsAllSites: hosts.some(isAllHostsPattern),
      permissionWarnings: permissionWarnings(manifest),
      pendingPermissions: entry.pendingPermissions,
      pendingVersion: entry.pendingVersion,
      siteAccess: entry.siteAccess,
      sites: entry.sites,
      // Accès aux sites réglable seulement pour une extension gérée par Lasco (dossier réécrit).
      siteAccessConfigurable: entry.source === 'store' && hosts.length > 0,
      optionsUrl: options ? `chrome-extension://${entry.id}/${options}` : null,
      homepageUrl: typeof manifest.homepage_url === 'string' ? manifest.homepage_url : null,
      storeUrl: entry.source === 'store' ? storeUrl(entry.id) : null,
      installedAt: entry.installedAt,
      updatedAt: entry.updatedAt,
      error: errors[0] || null,
    };
  }

  function list(profileId, { locales = [] } = {}) {
    const registry = registryFor(profileId);
    const policy = policyFor(profileId);
    return {
      profile: registry.profileId,
      developerMode: registry.developerMode && !(policy && policy.allowDeveloperMode === false),
      developerModeAllowed: !(policy && policy.allowDeveloperMode === false),
      policy,
      extensions: registry
        .list()
        .map((entry) => describe(profileId, entry, locales))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  // --- Demande d'autorisation ---

  /**
   * Demande l'accord de la personne. `promptWindow` : coquille qui affiche la demande (pont
   * `onInstallRequest`) ; sans coquille qui la prend, boîte de dialogue native.
   */
  async function askConsent({ ctx, win, request }) {
    const target = win && !win.isDestroyed() ? win : BrowserWindow.getFocusedWindow();
    if (target && ctx.promptSupport.has(target.webContents.id)) {
      const requestId = randomUUID();
      const answer = new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingPrompts.delete(requestId);
          resolve(false);
        }, INSTALL_PROMPT_TIMEOUT_MS);
        pendingPrompts.set(requestId, (value) => {
          clearTimeout(timer);
          resolve(value === true);
        });
      });
      target.webContents.send('browser-extensions-install-request', { requestId, ...request });
      if (target.isMinimized()) target.restore();
      target.focus();
      return answer;
    }
    const texts = ctx.texts || {};
    const detail = request.warnings.map((w) => `• ${w.fallback}`).join('\n');
    const { response } = await dialog.showMessageBox(target || undefined, {
      type: 'question',
      buttons: [texts.add || 'Ajouter l’extension', texts.cancel || 'Annuler'],
      defaultId: 1,
      cancelId: 1,
      message: (texts.title || 'Ajouter « {name} » ?').replace('{name}', request.name),
      detail: detail ? `${texts.canLabel || 'Elle peut :'}\n${detail}` : undefined,
    });
    return response === 0;
  }

  function respondInstall({ requestId, accept } = {}) {
    const resolve = pendingPrompts.get(requestId);
    if (!resolve) return { ok: false, error: 'unknown-request' };
    pendingPrompts.delete(requestId);
    resolve(accept === true);
    return { ok: true };
  }

  // --- Installation ---

  const installing = new Set();

  async function installFromStore(ctx, input, { win = null, consent = true } = {}) {
    const id = parseStoreReference(input);
    if (!id) return { ok: false, error: 'invalid_id' };
    const registry = registryFor(ctx.profileId);
    const blocked = blockedReasonFor(ctx.profileId, { id, source: 'store' });
    if (blocked) return { ok: false, error: 'blocked_by_policy', reason: blocked };
    const existing = registry.get(id);
    if (existing && existing.source === 'store') {
      if (!existing.enabled) registry.update(id, { enabled: true, disabledReason: null });
      await syncProfile(ctx.profileId);
      return { ok: true, id, alreadyInstalled: true };
    }
    if (installing.has(`${ctx.profileId}:${id}`)) return { ok: false, error: 'install_in_progress' };
    installing.add(`${ctx.profileId}:${id}`);
    let downloaded = null;
    try {
      downloaded = await downloadStoreExtension(id, {
        targetDirFor: (version) => registry.versionDir(id, version),
        chromeVersion,
      });
      const manifest = downloaded.manifest;
      if (manifest.manifest_version !== 3 && manifest.manifest_version !== 2) throw new CrxError('manifest_invalid');
      if (manifest.app || manifest.theme) throw new CrxError('unsupported_extension_type');
      const name = localizeManifestString(downloaded.dir, manifest, manifest.name, ctx.locales) || id;
      if (consent) {
        const accepted = await askConsent({
          ctx,
          win,
          request: {
            id,
            name,
            icon: iconDataUrl({ path: downloaded.dir }, manifest, 64),
            warnings: permissionWarnings(manifest),
            source: 'store',
          },
        });
        if (!accepted) {
          fs.rmSync(downloaded.dir, { recursive: true, force: true });
          return { ok: false, error: 'user_cancelled' };
        }
      }
      registry.put({
        id,
        source: 'store',
        path: downloaded.dir,
        version: downloaded.version,
        enabled: true,
        pinned: hasAction(manifest),
        siteAccess: 'all',
        sites: [],
        installedAt: Date.now(),
      });
      await syncProfile(ctx.profileId);
      const error = ctx.errors.get(id);
      return error ? { ok: false, id, error: 'load_failed', message: error } : { ok: true, id, name };
    } catch (error) {
      if (downloaded && !registry.has(id)) fs.rmSync(downloaded.dir, { recursive: true, force: true });
      console.warn(`[extensions] install of ${id} failed:`, error && (error.code || error.message));
      return { ok: false, id, error: (error && error.code) || 'install_error', message: error && error.message };
    } finally {
      installing.delete(`${ctx.profileId}:${id}`);
    }
  }

  async function installUnpacked(ctx, { win = null, dir = null } = {}) {
    const registry = registryFor(ctx.profileId);
    const policy = policyFor(ctx.profileId);
    if (policy && policy.allowDeveloperMode === false) return { ok: false, error: 'blocked_by_policy' };
    if (!registry.developerMode) return { ok: false, error: 'developer_mode_off' };
    let folder = dir;
    if (!folder) {
      const picked = await dialog.showOpenDialog(win || undefined, {
        properties: ['openDirectory'],
        title: (ctx.texts && ctx.texts.pickFolder) || 'Choisir le dossier de l’extension',
      });
      if (picked.canceled || !picked.filePaths[0]) return { ok: false, error: 'cancelled' };
      folder = picked.filePaths[0];
    }
    let manifest;
    try {
      manifest = JSON.parse(stripBom(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8')));
    } catch (_) {
      return { ok: false, error: 'manifest_invalid' };
    }
    const id = manifest.key ? require('./crx').extensionIdFromPublicKey(manifest.key) : extensionIdFromPath(folder);
    const blocked = blockedReasonFor(ctx.profileId, { id, source: 'unpacked' });
    if (blocked) return { ok: false, error: 'blocked_by_policy', reason: blocked };
    const existing = registry.get(id);
    if (existing && existing.source === 'store') return { ok: false, error: 'already_installed' };
    registry.put({
      id,
      source: 'unpacked',
      path: folder,
      version: manifest.version || '',
      enabled: true,
      pinned: existing ? existing.pinned : hasAction(manifest),
      siteAccess: 'all',
      installedAt: existing ? existing.installedAt : Date.now(),
    });
    for (const c of contextsOfProfile(ctx.profileId)) unloadFrom(c, id);
    await syncProfile(ctx.profileId);
    const error = ctx.errors.get(id);
    return error ? { ok: false, id, error: 'load_failed', message: error } : { ok: true, id };
  }

  async function uninstall(ctx, { id } = {}) {
    const registry = registryFor(ctx.profileId);
    const entry = registry.get(id);
    if (!entry) return { ok: false, error: 'unknown-extension' };
    for (const c of contextsOfProfile(ctx.profileId)) {
      unloadFrom(c, id);
      void c.session.clearStorageData({ origin: `chrome-extension://${id}` }).catch(() => {});
    }
    registry.remove(id);
    if (entry.source === 'store') fs.rmSync(path.join(registry.dir, id), { recursive: true, force: true });
    if (entry.pendingPath) fs.rmSync(entry.pendingPath, { recursive: true, force: true });
    fs.rmSync(registry.dataDir(id), { recursive: true, force: true });
    emitChange(ctx.profileId);
    return { ok: true };
  }

  async function setEnabled(ctx, { id, enabled } = {}) {
    const registry = registryFor(ctx.profileId);
    const entry = registry.get(id);
    if (!entry) return { ok: false, error: 'unknown-extension' };
    if (enabled === true && entry.pendingPermissions) return acceptPendingPermissions(ctx, { id });
    registry.update(id, { enabled: enabled === true, disabledReason: enabled === true ? null : 'user' });
    await syncProfile(ctx.profileId);
    return { ok: true };
  }

  function setPinned(ctx, { id, pinned } = {}) {
    const entry = registryFor(ctx.profileId).update(id, { pinned: pinned === true });
    if (!entry) return { ok: false, error: 'unknown-extension' };
    emitChange(ctx.profileId);
    return { ok: true };
  }

  async function setSiteAccess(ctx, { id, mode, sites, addSite } = {}) {
    const registry = registryFor(ctx.profileId);
    const entry = registry.get(id);
    if (!entry) return { ok: false, error: 'unknown-extension' };
    if (entry.source !== 'store') return { ok: false, error: 'not_configurable' };
    const next = { siteAccess: ['all', 'specific', 'click'].includes(mode) ? mode : entry.siteAccess };
    let list = Array.isArray(sites) ? sites.map(normalizeOrigin).filter(Boolean) : entry.sites;
    const extra = addSite ? normalizeOrigin(addSite) : null;
    if (extra && !isProtectedUrl(extra)) {
      list = [...new Set([...list, extra])];
      if (next.siteAccess !== 'all') next.siteAccess = 'specific';
    }
    next.sites = list.filter((site) => !isProtectedUrl(site)).slice(0, 200);
    registry.update(id, next);
    await reloadEverywhere(ctx.profileId, id);
    return { ok: true };
  }

  function setDeveloperMode(ctx, { enabled } = {}) {
    const policy = policyFor(ctx.profileId);
    if (enabled === true && policy && policy.allowDeveloperMode === false) return { ok: false, error: 'blocked_by_policy' };
    registryFor(ctx.profileId).setDeveloperMode(enabled === true);
    emitChange(ctx.profileId);
    return { ok: true };
  }

  async function setPolicy(ctx, raw) {
    const policy = normalizePolicy(raw);
    const key = ctx.profileId;
    const before = JSON.stringify(policies.get(key) || null);
    if (policy) policies.set(key, policy);
    else policies.delete(key);
    if (JSON.stringify(policy || null) !== before) await syncProfile(key);
    return { ok: true };
  }

  // --- Mises à jour ---

  async function acceptPendingPermissions(ctx, { id } = {}) {
    const registry = registryFor(ctx.profileId);
    const entry = registry.get(id);
    if (!entry || !entry.pendingPath) return { ok: false, error: 'nothing-pending' };
    const oldPath = entry.path;
    registry.update(id, {
      path: entry.pendingPath,
      version: entry.pendingVersion || entry.version,
      pendingPath: null,
      pendingVersion: null,
      pendingPermissions: null,
      enabled: true,
      disabledReason: null,
    });
    await reloadEverywhere(ctx.profileId, id);
    if (oldPath !== entry.pendingPath) fs.rmSync(oldPath, { recursive: true, force: true });
    return { ok: true };
  }

  /** Vérifie et installe les mises à jour des extensions du store d'un profil. */
  async function checkForUpdates(profileId, { force = false } = {}) {
    const registry = registryFor(profileId);
    const storeEntries = registry.list().filter((entry) => {
      if (entry.source !== 'store') return false;
      const manifest = readManifestSafe(entry);
      return manifest && isStoreUpdateUrl(manifest.update_url);
    });
    if (storeEntries.length === 0) return { ok: true, updated: [] };
    let versions;
    try {
      versions = await checkVersions(
        storeEntries.map((entry) => ({ id: entry.id, version: entry.version })),
        { chromeVersion, installSource: force ? 'ondemand' : 'scheduler' },
      );
    } catch (error) {
      console.warn('[extensions] update check failed:', error && error.message);
      return { ok: false, error: 'store_unreachable' };
    }
    const updated = [];
    for (const entry of storeEntries) {
      const info = versions.get(entry.id);
      if (!info || !info.url || !info.version || info.version === entry.version) continue;
      if (compareVersions(info.version, entry.version) <= 0) continue;
      try {
        const downloaded = await downloadStoreExtension(entry.id, {
          targetDirFor: (version) => registry.versionDir(entry.id, version),
          chromeVersion,
          known: info,
        });
        const before = readManifestSafe(entry) || {};
        const added = addedWarnings(before, downloaded.manifest);
        if (added.length > 0) {
          // Nouvelles autorisations : l'extension est désactivée jusqu'à l'accord (comme Chrome).
          if (entry.pendingPath && entry.pendingPath !== downloaded.dir) fs.rmSync(entry.pendingPath, { recursive: true, force: true });
          registry.update(entry.id, {
            pendingPath: downloaded.dir,
            pendingVersion: downloaded.version,
            pendingPermissions: added,
            enabled: false,
            disabledReason: 'permissions',
          });
        } else {
          const oldPath = entry.path;
          registry.update(entry.id, { path: downloaded.dir, version: downloaded.version });
          await reloadEverywhere(profileId, entry.id);
          if (oldPath !== downloaded.dir) fs.rmSync(oldPath, { recursive: true, force: true });
        }
        updated.push({ id: entry.id, version: downloaded.version, permissions: added.length > 0 });
      } catch (error) {
        console.warn(`[extensions] update of ${entry.id} failed:`, error && (error.code || error.message));
      }
    }
    if (updated.length > 0) await syncProfile(profileId);
    return { ok: true, updated };
  }

  function scheduleUpdates() {
    if (updateTimer) return;
    const run = async () => {
      for (const profileId of new Set([...contexts.values()].map((ctx) => ctx.profileId))) {
        await checkForUpdates(profileId).catch(() => {});
      }
    };
    const first = setTimeout(() => void run(), UPDATE_FIRST_DELAY_MS);
    if (first.unref) first.unref();
    updateTimer = setInterval(() => void run(), UPDATE_INTERVAL_MS);
    if (updateTimer.unref) updateTimer.unref();
  }

  // --- Boutons d'action ---

  function api(ctx) {
    return ctx.extensions.api;
  }

  async function actionIcon(ctx, id, tabWebContentsId) {
    try {
      const query = tabWebContentsId ? `?tabId=${tabWebContentsId}` : '';
      const response = api(ctx).browserAction.handleCRXRequest({ url: `crx://extension-icon/${id}/32/2${query}` });
      if (!response || response.status !== 200) return null;
      const bytes = Buffer.from(await response.arrayBuffer());
      return `data:image/png;base64,${bytes.toString('base64')}`;
    } catch (_) {
      return null;
    }
  }

  async function getActions(ctx, { webContentsId = null } = {}) {
    const registry = registryFor(ctx.profileId);
    const state = api(ctx).browserAction.getState();
    const out = [];
    for (const action of state.actions || []) {
      const entry = registry.get(action.id);
      const extension = ctx.session.extensions.getExtension(action.id);
      if (!entry || !extension || !ctx.managed.has(action.id)) continue;
      const tab = (webContentsId && action.tabs && action.tabs[webContentsId]) || {};
      const pick = (key) => (tab[key] !== undefined ? tab[key] : action[key]);
      out.push({
        id: action.id,
        name: localizeManifestString(entry.path, extension.manifest, extension.manifest.name, ctx.locales) || extension.name,
        title: pick('title') || extension.name,
        badgeText: pick('text') || '',
        badgeColor: pick('color') || null,
        hasPopup: Boolean(pick('popup')),
        pinned: entry.pinned,
        icon: await actionIcon(ctx, action.id, webContentsId),
        siteAccess: entry.siteAccess,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  function activateAction(ctx, { id, webContentsId, anchor } = {}) {
    const extension = ctx.session.extensions.getExtension(id);
    if (!extension) return { ok: false, error: 'unknown-extension' };
    const rect = anchor && typeof anchor === 'object' ? anchor : { x: 0, y: 0, width: 0, height: 0 };
    try {
      api(ctx).browserAction.activate(
        { type: 'frame', sender: null },
        {
          eventType: 'click',
          extensionId: id,
          tabId: typeof webContentsId === 'number' ? webContentsId : -1,
          anchorRect: {
            x: Math.round(Number(rect.x) || 0),
            y: Math.round(Number(rect.y) || 0),
            width: Math.round(Number(rect.width) || 0),
            height: Math.round(Number(rect.height) || 0),
          },
          alignment: 'bottom left',
        },
      );
      return { ok: true };
    } catch (error) {
      return { ok: false, error: 'activate_failed', message: error && error.message };
    }
  }

  function openOptions(ctx, { id } = {}) {
    const extension = ctx.session.extensions.getExtension(id);
    const page = extension && optionsPage(extension.manifest);
    if (!page) return { ok: false, error: 'no-options' };
    return ctx.openTab({ url: `chrome-extension://${id}/${page}`, active: true });
  }

  // --- Page du Chrome Web Store ---

  function installWebstoreHandlers() {
    if (webstoreHandlersInstalled) return;
    webstoreHandlersInstalled = true;
    const contextFor = (event) => {
      const frame = event.senderFrame;
      if (!frame || !String(frame.origin || frame.url || '').startsWith(WEBSTORE_ORIGIN)) return null;
      return contexts.get(event.sender.session) || null;
    };
    const statusOf = (ctx, id) => {
      if (!isExtensionId(id)) return 'installable';
      if (blockedReasonFor(ctx.profileId, { id, source: 'store' })) return 'blocked_by_policy';
      const entry = registryFor(ctx.profileId).get(id);
      if (!entry) return 'installable';
      return entry.enabled ? 'enabled' : 'disabled';
    };
    const handle = (channel, fn) =>
      ipcMain.handle(channel, async (event, ...args) => {
        const ctx = contextFor(event);
        if (!ctx) return undefined;
        return fn(ctx, event, ...args);
      });
    handle('chromeWebstore.beginInstall', async (ctx, event, details = {}) => {
      const id = details && details.id;
      if (!isExtensionId(id)) return { result: 'invalid_id' };
      if (statusOf(ctx, id) === 'blocked_by_policy') return { result: 'blocked_by_policy' };
      const result = await installFromStore(ctx, id, { win: ctx.windowForWebContents(event.sender) });
      if (result.ok) {
        const extension = ctx.session.extensions.getExtension(id);
        if (extension && !event.sender.isDestroyed()) {
          try {
            event.sender.send('chrome.management.onInstalled', managementInfo(extension));
          } catch (_) {
            // Page fermée entre-temps.
          }
        }
        return { result: 'success' };
      }
      if (result.error === 'user_cancelled') return { result: 'user_cancelled' };
      if (result.error === 'blocked_by_policy') return { result: 'blocked_by_policy' };
      if (result.error === 'install_in_progress') return { result: 'install_in_progress' };
      return { result: 'install_error', message: result.message || result.error };
    });
    handle('chromeWebstore.completeInstall', () => 'success');
    handle('chromeWebstore.enableAppLauncher', () => true);
    handle('chromeWebstore.getBrowserLogin', () => '');
    handle('chromeWebstore.getExtensionStatus', (ctx, _event, id) => statusOf(ctx, id));
    handle('chromeWebstore.getFullChromeVersion', () => ({ version_number: chromeVersion, app_name: 'Lasco' }));
    handle('chromeWebstore.getIsLauncherEnabled', () => true);
    handle('chromeWebstore.getMV2DeprecationStatus', () => 'soft_disable');
    handle('chromeWebstore.getReferrerChain', () => 'EgIIAA==');
    handle('chromeWebstore.getStoreLogin', () => '');
    handle('chromeWebstore.getWebGLStatus', () => 'webgl_allowed');
    handle('chromeWebstore.install', () => 'success');
    handle('chromeWebstore.isInIncognitoMode', () => false);
    handle('chromeWebstore.isPendingCustodianApproval', () => false);
    handle('chromeWebstore.setStoreLogin', () => true);
    handle('chrome.runtime.getManifest', () => ({}));
    handle('chrome.management.getAll', (ctx) =>
      ctx.session.extensions.getAllExtensions().filter((e) => registryFor(ctx.profileId).has(e.id)).map(managementInfo),
    );
    handle('chrome.management.setEnabled', async (ctx, _event, id, enabled) => {
      await setEnabled(ctx, { id, enabled });
      return true;
    });
    handle('chrome.management.uninstall', async (ctx, event, id) => {
      const result = await uninstall(ctx, { id });
      if (result.ok && !event.sender.isDestroyed()) event.sender.send('chrome.management.onUninstalled', id);
      return result.ok ? 'success' : 'unknown_error';
    });
  }

  function managementInfo(extension) {
    const manifest = extension.manifest || {};
    return {
      description: manifest.description || '',
      enabled: true,
      homepageUrl: manifest.homepage_url || '',
      hostPermissions: manifest.host_permissions || [],
      icons: [],
      id: extension.id,
      installType: 'normal',
      isApp: false,
      mayDisable: true,
      name: extension.name,
      offlineEnabled: false,
      optionsUrl: '',
      permissions: manifest.permissions || [],
      shortName: manifest.short_name || extension.name,
      type: 'extension',
      updateUrl: manifest.update_url || '',
      version: manifest.version,
    };
  }

  // --- Sessions ---

  /**
   * Branche les extensions sur une session d'onglets web. `hooks` : `{ createTab, selectTab,
   * removeTab, windowForWebContents, tabIdFor }` (gestionnaires d'onglets des fenêtres).
   */
  function attachSession(browserSession, { profileId = 'default', hooks }) {
    if (contexts.has(browserSession)) return contexts.get(browserSession);
    if (!browserSession || !browserSession.isPersistent || !browserSession.isPersistent()) return null;
    const { ElectronChromeExtensions } = require('electron-chrome-extensions');
    const key = sanitizeProfileId(profileId);
    const ctx = {
      session: browserSession,
      profileId: key,
      errors: new Map(),
      promptSupport: new Set(),
      texts: null,
      locales: [],
      managed: new Set(),
      hooks,
    };
    ctx.windowForWebContents = (wc) => hooks.windowForWebContents(wc);
    ctx.openTab = ({ url, active }) => {
      const result = hooks.createTab({ url, active: active !== false });
      return result ? { ok: true } : { ok: false, error: 'no-window' };
    };
    // Préchargement des APIs ajoutées par Lasco (DNR, identity), contextes d'extension seulement.
    // Inscrit AVANT celui de la bibliothèque, qui gèle `chrome` à la fin du sien.
    browserSession.registerPreloadScript({ id: 'lasco-ext-frame', type: 'frame', filePath: path.join(__dirname, 'runtime-preload.js') });
    browserSession.registerPreloadScript({ id: 'lasco-ext-sw', type: 'service-worker', filePath: path.join(__dirname, 'runtime-preload.js') });
    ctx.extensions = new ElectronChromeExtensions({
      session: browserSession,
      createTab: async (details) => {
        const result = hooks.createTab({ url: details.url || 'about:blank', active: details.active !== false, windowId: details.windowId });
        if (!result) throw new Error('No window to open the tab.');
        return [result.webContents, result.window];
      },
      selectTab: (webContents) => hooks.selectTab(webContents),
      removeTab: (webContents) => hooks.removeTab(webContents),
      createWindow: async (details) => hooks.createWindow(details),
      removeWindow: (win) => {
        if (win && !win.isDestroyed() && hooks.isExtensionWindow(win)) win.close();
      },
      assignTabDetails: (details, webContents) => {
        const extra = hooks.tabDetails ? hooks.tabDetails(webContents) : null;
        if (extra) Object.assign(details, extra);
      },
      // `chrome.permissions.request` : hôtes facultatifs. Demandé à la personne comme à l'installation.
      requestPermissions: async (extension, permissions) => {
        const fake = { permissions: permissions.permissions || [], host_permissions: permissions.origins || [], manifest_version: 3 };
        return askConsent({
          ctx,
          win: null,
          request: { id: extension.id, name: extension.name, icon: null, warnings: permissionWarnings(fake), source: 'permissions' },
        });
      },
    });
    ctx.dnr = createDnrService({
      browserSession,
      isProtectedUrl,
      hostAllowed: (extensionId, url) => hostAllowed(key, extensionId, url),
      dataDirFor: (id) => registryFor(key).dataDir(id),
      tabIdFor: (webContentsId) => webContentsId,
    });
    const router = ctx.extensions.ctx && ctx.extensions.ctx.router;
    if (router && typeof router.handle === 'function') {
      // L'identifiant d'extension vient de l'appelant : il doit être celui de son contexte.
      const own = (fn) => (event, ...args) => {
        if (!senderIsExtension(event)) throw new Error('Unknown extension context.');
        return fn(event, ...args);
      };
      for (const [name, fn] of Object.entries(ctx.dnr.api)) router.handle(name, own(fn));
      router.handle(
        'identity.launchWebAuthFlow',
        own((event, details = {}) => launchWebAuthFlow({ electron, session: browserSession, extension: event.extension, details })),
        { permission: 'identity' },
      );
    } else {
      console.warn('[extensions] electron-chrome-extensions router not found: DNR and identity unavailable');
    }
    // Page du Chrome Web Store : « Ajouter à Lasco » (script de page d'electron-chrome-web-store).
    browserSession.registerPreloadScript({ id: 'lasco-webstore', type: 'frame', filePath: require.resolve('electron-chrome-web-store/preload') });
    installWebstoreHandlers();

    browserSession.extensions.on('extension-loaded', (_event, extension) => {
      const entry = registryFor(key).get(extension.id);
      ctx.dnr.addExtension(extension, { installedAt: entry ? entry.installedAt : Date.now() });
      emitChange(key);
    });
    browserSession.extensions.on('extension-unloaded', (_event, extension) => {
      ctx.dnr.removeExtension(extension.id);
      emitChange(key);
    });
    // Mises à jour de l'état des boutons (badge, icône, titre) : observateur du module d'action.
    const observers = ctx.extensions.api && ctx.extensions.api.browserAction && ctx.extensions.api.browserAction.observers;
    if (observers && typeof observers.add === 'function') {
      let queued = false;
      observers.add({
        isDestroyed: () => false,
        send: () => {
          if (queued) return;
          queued = true;
          setTimeout(() => {
            queued = false;
            emitChange(key);
          }, 50);
        },
      });
    }
    ctx.extensions.on('browser-action-popup-created', (popup) => {
      if (hooks.onPopup) hooks.onPopup(popup);
    });
    contexts.set(browserSession, ctx);
    void syncContext(ctx).then(() => emitChange(key));
    scheduleUpdates();
    return ctx;
  }

  function contextFor(browserSession) {
    return contexts.get(browserSession) || null;
  }

  function compareVersions(a, b) {
    const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d !== 0) return d;
    }
    return 0;
  }

  return {
    attachSession,
    contextFor,
    list: (ctx, options) => list(ctx.profileId, options),
    getActions,
    activateAction,
    installFromStore,
    installUnpacked,
    uninstall,
    setEnabled,
    setPinned,
    setSiteAccess,
    setDeveloperMode,
    setPolicy,
    openOptions,
    acceptPendingPermissions,
    checkForUpdates: (ctx, options) => checkForUpdates(ctx.profileId, { force: true, ...options }),
    respondInstall,
    contextMenuItems(browserSession, webContents, params) {
      const ctx = contexts.get(browserSession);
      if (!ctx) return [];
      try {
        return ctx.extensions.getContextMenuItems(webContents, params) || [];
      } catch (_) {
        return [];
      }
    },
    /** Onglets web : suivis par `chrome.tabs` (jamais une page du portail). */
    addTab(browserSession, webContents, win) {
      const ctx = contexts.get(browserSession);
      if (!ctx || !win || win.isDestroyed()) return;
      try {
        ctx.extensions.addTab(webContents, win);
      } catch (error) {
        console.warn('[extensions] addTab failed:', error && error.message);
      }
    },
    selectTab(browserSession, webContents) {
      const ctx = contexts.get(browserSession);
      if (!ctx || webContents.isDestroyed()) return;
      try {
        ctx.extensions.selectTab(webContents);
      } catch (_) {
        // Onglet pas encore suivi.
      }
    },
    removeTab(browserSession, webContents) {
      const ctx = contexts.get(browserSession);
      if (!ctx || webContents.isDestroyed()) return;
      try {
        ctx.extensions.removeTab(webContents);
      } catch (_) {
        // Déjà retiré.
      }
    },
    /** La coquille de `webContentsId` affiche les demandes d'autorisation, dans sa langue. */
    setPromptSupport(ctx, webContentsId, { texts, locales } = {}) {
      ctx.promptSupport.add(webContentsId);
      if (texts && typeof texts === 'object') ctx.texts = texts;
      if (Array.isArray(locales)) ctx.locales = locales.filter((l) => typeof l === 'string').slice(0, 5);
    },
    onChange(listener) {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    profileOf: (ctx) => ctx.profileId,
  };
}

let shared = null;

function getExtensionsService(options) {
  if (!shared) shared = createExtensionsService(options);
  return shared;
}

module.exports = { createExtensionsService, getExtensionsService, senderIsExtension, storeUrl };
