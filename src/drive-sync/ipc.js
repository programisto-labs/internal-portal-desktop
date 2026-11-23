'use strict';

/**
 * Canaux IPC de la synchronisation My Drive (docs/drive-sync.md).
 *
 * - Le portail (cadre principal de la fenêtre principale, origine du portail) lit la config, lie
 *   le dossier à son compte, lit / écrit dans CE dossier seulement et remonte l'état.
 * - Les Réglages de Desktop (vue `file:`) choisissent le dossier et activent la synchro.
 * Le portail ne choisit jamais de chemin : `root` doit être le dossier des réglages, activé et lié.
 */
const { sanitizeManifest } = require('./fs-ops');

const MAX_LABEL = 200;

function registerDriveSyncIpc({
  ipcMain,
  store,
  fsOps,
  isTrustedPortalSender,
  isFromSettings,
  pickFolder,
  openFolder,
  openSettings,
  refreshSettings,
  notifyPortal,
}) {
  const denied = { ok: false, error: 'desktop-unavailable' };
  const bound = () => {
    const c = store.get();
    return c.enabled && c.rootPath && c.ownerUserId ? c : null;
  };
  const isBoundRoot = (root) => {
    const c = bound();
    return Boolean(c && typeof root === 'string' && root === c.rootPath);
  };
  const obj = (v) => (v && typeof v === 'object' ? v : {});

  store.onChange((config) => notifyPortal(config));

  // --- Portail ---
  ipcMain.handle('drive-sync-get-config', (event) => {
    if (!isTrustedPortalSender(event)) return null;
    return store.publicConfig();
  });
  ipcMain.handle('drive-sync-bind', (event, payload) => {
    if (!isTrustedPortalSender(event)) return denied;
    const p = obj(payload);
    const label = typeof p.label === 'string' ? p.label.slice(0, MAX_LABEL) : null;
    const res = store.bind(p.userId, label);
    refreshSettings();
    return res;
  });
  ipcMain.handle('drive-sync-report', (event, payload) => {
    if (!isTrustedPortalSender(event)) return false;
    const p = obj(payload);
    const ok = store.reportRun(p.userId, p.summary);
    if (ok) refreshSettings();
    return ok;
  });
  ipcMain.handle('drive-sync-open-settings', (event) => {
    if (!isTrustedPortalSender(event)) return false;
    openSettings();
    return true;
  });
  // Le choix du dossier se fait dans les Réglages de Desktop, jamais depuis la page.
  ipcMain.handle('drive-sync-choose-folder', (event) => {
    if (!isTrustedPortalSender(event)) return denied;
    openSettings();
    return { ok: false, cancelled: true };
  });
  ipcMain.handle('drive-sync-validate-folder', async (event, payload) => {
    if (!isTrustedPortalSender(event)) return denied;
    const root = obj(payload).path;
    const c = store.get();
    if (!c.enabled || root !== c.rootPath) return { ok: false, error: 'no-folder' };
    return fsOps.validateFolder(root);
  });
  ipcMain.handle('drive-sync-read-manifest', (event, payload) => {
    if (!isTrustedPortalSender(event)) return null;
    const p = obj(payload);
    const c = bound();
    if (!c || p.root !== c.rootPath || p.userId !== c.ownerUserId) return null;
    return fsOps.readManifest(c.ownerUserId, c.rootPath);
  });
  ipcMain.handle('drive-sync-write-manifest', (event, payload) => {
    if (!isTrustedPortalSender(event)) return { ok: false };
    const c = bound();
    if (!c) return { ok: false };
    const manifest = sanitizeManifest(obj(payload).manifest, { userId: c.ownerUserId, rootPath: c.rootPath });
    return manifest ? fsOps.writeManifest(manifest) : { ok: false };
  });
  ipcMain.handle('drive-sync-stat', (event, payload) => {
    const p = obj(payload);
    // Refus : présenté comme occupé, la page ne choisira jamais ce chemin.
    if (!isTrustedPortalSender(event) || !isBoundRoot(p.root)) return { exists: true, isSymlink: true, isFile: false };
    return fsOps.stat(p.root, p.relativePath);
  });
  ipcMain.handle('drive-sync-write-file', (event, payload) => {
    if (!isTrustedPortalSender(event)) return denied;
    const p = obj(payload);
    if (!isBoundRoot(p.root)) return { ok: false, error: 'account-mismatch' };
    return fsOps.writeFile({ root: p.root, relativePath: p.relativePath, url: p.url, expectedSize: p.expectedSize });
  });

  // --- Réglages de Desktop ---
  async function chooseFolder() {
    const picked = await pickFolder(store.get().rootPath);
    if (!picked) return { ok: false, cancelled: true };
    const check = await fsOps.validateFolder(picked);
    if (!check.ok) return check;
    store.setFolder(picked);
    return { ok: true, path: picked };
  }
  ipcMain.handle('settings-modal-drive-choose-folder', async (event) => {
    if (!isFromSettings(event)) return denied;
    return chooseFolder();
  });
  ipcMain.handle('settings-modal-drive-set-enabled', async (event, enabled) => {
    if (!isFromSettings(event) || typeof enabled !== 'boolean') return denied;
    if (!enabled) {
      store.setEnabled(false);
      return { ok: true };
    }
    if (!store.get().rootPath) {
      // Activer sans dossier : on le demande tout de suite.
      const res = await chooseFolder();
      if (!res.ok) return res;
    } else {
      const check = await fsOps.validateFolder(store.get().rootPath);
      if (!check.ok) return check;
    }
    store.setEnabled(true);
    return { ok: true };
  });
  ipcMain.handle('settings-modal-drive-open-folder', (event) => {
    if (!isFromSettings(event)) return false;
    const { rootPath } = store.get();
    if (!rootPath) return false;
    openFolder(rootPath);
    return true;
  });
}

/** Ce que voient les Réglages (jamais le portail). */
function driveSyncSettingsState(store) {
  const c = store.get();
  return { enabled: c.enabled, rootPath: c.rootPath, ownerLabel: c.ownerLabel, bound: Boolean(c.ownerUserId), lastRun: c.lastRun, rejected: store.rejectedAccount() };
}

module.exports = { registerDriveSyncIpc, driveSyncSettingsState };
