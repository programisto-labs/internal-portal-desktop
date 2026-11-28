'use strict';

/**
 * Branchement des extensions sur les fenêtres de Lasco Desktop (docs/extensions.md) : rappels des
 * gestionnaires d'onglets, onglets et fenêtres demandés par les extensions, pont IPC de la coquille.
 */

const { getExtensionsService } = require('./index');

const DEFAULT_PROFILE_ID = 'default';

/**
 * Profil d'une partition d'onglets web. Profils de navigation (docs/browser-profiles.md) :
 * `persist:bp-<propriétaire>-<profil>-<workspace>` → `<propriétaire>-<profil>` (une installation
 * par profil, chargée dans chaque workspace du profil). Sinon le profil par défaut.
 */
function profileIdForPartition(partition) {
  const match = /^persist:bp-([a-z0-9]+)-(default|bp_[0-9a-f]{16})-/i.exec(String(partition || ''));
  return match ? `${match[1]}-${match[2]}` : DEFAULT_PROFILE_ID;
}
const CHANGE_CHANNEL = 'browser-extensions-changed';

function createExtensionsWiring({ electron, userDataDir, chromeVersion, portalWindows, isProtectedUrl, protectedOrigins }) {
  const { BrowserWindow, ipcMain } = electron;
  const service = getExtensionsService({ electron, userDataDir, chromeVersion, isProtectedUrl, protectedOrigins });
  /** Fenêtres ouvertes par `chrome.windows.create({ type: 'popup' })`. */
  const extensionWindows = new Set();

  function managers() {
    const out = [];
    for (const entry of portalWindows.values()) {
      if (entry.tabManager && entry.win && !entry.win.isDestroyed()) out.push(entry);
    }
    return out;
  }

  function ownerOf(webContents) {
    for (const entry of managers()) {
      const tabId = entry.tabManager.tabIdOfWebContents(webContents);
      if (tabId) return { entry, tabId };
    }
    return null;
  }

  function targetEntry(windowId) {
    const all = managers();
    if (typeof windowId === 'number') {
      const match = all.find((e) => e.win.id === windowId);
      if (match) return match;
    }
    const focused = BrowserWindow.getFocusedWindow();
    return all.find((e) => focused && e.win.id === focused.id) || all.find((e) => e.role === 'main') || all[0] || null;
  }

  function openTab({ url, active = true, windowId } = {}) {
    const entry = targetEntry(windowId);
    if (!entry) return null;
    const webContents = entry.tabManager.openExtensionTab({ url, active });
    return webContents ? { webContents, window: entry.win } : null;
  }

  function tabAction(webContents, action) {
    const owner = ownerOf(webContents);
    if (!owner) {
      // Onglet d'une fenêtre ouverte par une extension : la fenêtre se ferme avec lui.
      const win = BrowserWindow.fromWebContents(webContents);
      if (action === 'close' && win && extensionWindows.has(win)) win.close();
      if (action === 'activate' && win && !win.isDestroyed()) win.focus();
      return;
    }
    const { entry, tabId } = owner;
    if (action === 'activate') entry.win.focus();
    entry.win.webContents.send('tab-window-tab-action', { tabId, action });
  }

  async function createWindow(details = {}) {
    const urls = Array.isArray(details.url) ? details.url : details.url ? [details.url] : [];
    if (details.type === 'popup' || details.type === 'panel') {
      const session = currentSession();
      if (!session) throw new Error('No browser session.');
      const win = new BrowserWindow({
        width: Math.max(200, Number(details.width) || 420),
        height: Math.max(200, Number(details.height) || 600),
        ...(Number.isFinite(details.left) ? { x: details.left } : {}),
        ...(Number.isFinite(details.top) ? { y: details.top } : {}),
        show: details.state !== 'minimized',
        autoHideMenuBar: true,
        webPreferences: { session, sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      extensionWindows.add(win);
      win.on('closed', () => extensionWindows.delete(win));
      service.addTab(session, win.webContents, win);
      win.webContents.setWindowOpenHandler(({ url }) => {
        openTab({ url, active: true });
        return { action: 'deny' };
      });
      if (urls[0]) void win.loadURL(urls[0]).catch(() => {});
      return win;
    }
    // Fenêtre « normale » : les onglets s'ouvrent dans la fenêtre Lasco au premier plan.
    const entry = targetEntry();
    if (!entry) throw new Error('No window.');
    for (const url of urls) entry.tabManager.openExtensionTab({ url, active: true });
    return entry.win;
  }

  function currentSession() {
    const entry = targetEntry();
    return entry ? entry.tabManager.browserSession() : null;
  }

  const sessionHooks = {
    createTab: openTab,
    selectTab: (webContents) => tabAction(webContents, 'activate'),
    removeTab: (webContents) => tabAction(webContents, 'close'),
    createWindow,
    isExtensionWindow: (win) => extensionWindows.has(win),
    windowForWebContents: (webContents) => {
      const owner = ownerOf(webContents);
      if (owner) return owner.entry.win;
      try {
        const win = BrowserWindow.fromWebContents(webContents);
        return win && portalWindows.has(win.id) ? win : null;
      } catch (_) {
        return null;
      }
    },
  };

  /** Rappels du gestionnaire d'onglets d'une fenêtre du portail. */
  function managerHooks(win) {
    return {
      onSession: (browserSession, { partition } = {}) =>
        service.attachSession(browserSession, { profileId: profileIdForPartition(partition), hooks: sessionHooks }),
      onTabCreated: (webContents) => service.addTab(webContents.session, webContents, win),
      onTabSelected: (webContents) => service.selectTab(webContents.session, webContents),
      onTabDestroyed: (webContents) => service.removeTab(webContents.session, webContents),
      contextMenuItems: (webContents, params) => service.contextMenuItems(webContents.session, webContents, params),
    };
  }

  service.onChange(({ profileId }) => {
    for (const entry of portalWindows.values()) {
      if (!entry.win || entry.win.isDestroyed()) continue;
      entry.win.webContents.send(CHANGE_CHANNEL, { profileId });
    }
  });

  /**
   * Pont `lascoDesktop.browserExtensions` (coquille seulement : `isShellSender(event)`).
   * La session visée est celle des onglets web de la fenêtre qui appelle.
   */
  function registerIpc({ isShellSender, tabManagerFor }) {
    const contextOf = (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const manager = win && tabManagerFor(win);
      if (!manager || manager.isPrivate) return null;
      const browserSession = manager.browserSession();
      return { ctx: service.contextFor(browserSession), win, manager };
    };
    const handle = (channel, fn) =>
      ipcMain.handle(channel, async (event, payload) => {
        if (!isShellSender(event)) return { ok: false, error: 'forbidden' };
        const target = contextOf(event);
        if (!target || !target.ctx) return { ok: false, error: 'unavailable' };
        try {
          return await fn(target, payload && typeof payload === 'object' ? payload : {}, event);
        } catch (error) {
          return { ok: false, error: 'failed', message: error && error.message };
        }
      });
    const webContentsIdOf = (manager, tabId) => {
      const wc = typeof tabId === 'string' ? manager.webContentsOf(tabId) : null;
      return wc ? wc.id : null;
    };
    handle('browser-extensions-ready', ({ ctx }, payload, event) => {
      service.setPromptSupport(ctx, event.sender.id, { texts: payload.texts, locales: payload.locales });
      return { ok: true, version: 1 };
    });
    handle('browser-extensions-list', ({ ctx }, payload) => ({ ok: true, ...service.list(ctx, { locales: payload.locales || ctx.locales }) }));
    handle('browser-extensions-get-actions', async ({ ctx, manager }, { tabId }) => ({
      ok: true,
      actions: await service.getActions(ctx, { webContentsId: webContentsIdOf(manager, tabId) }),
    }));
    handle('browser-extensions-activate-action', ({ ctx, manager }, { id, tabId, anchor }) =>
      service.activateAction(ctx, { id, webContentsId: webContentsIdOf(manager, tabId), anchor }),
    );
    handle('browser-extensions-install', ({ ctx, win }, { idOrUrl }) => service.installFromStore(ctx, idOrUrl, { win }));
    handle('browser-extensions-install-unpacked', ({ ctx, win }) => service.installUnpacked(ctx, { win }));
    handle('browser-extensions-uninstall', ({ ctx }, { id }) => service.uninstall(ctx, { id }));
    handle('browser-extensions-set-enabled', ({ ctx }, payload) => service.setEnabled(ctx, payload));
    handle('browser-extensions-set-pinned', ({ ctx }, payload) => service.setPinned(ctx, payload));
    handle('browser-extensions-set-site-access', ({ ctx }, payload) => service.setSiteAccess(ctx, payload));
    handle('browser-extensions-set-developer-mode', ({ ctx }, payload) => service.setDeveloperMode(ctx, payload));
    handle('browser-extensions-set-policy', ({ ctx }, payload) => service.setPolicy(ctx, payload.policy || payload));
    handle('browser-extensions-accept-permissions', ({ ctx }, payload) => service.acceptPendingPermissions(ctx, payload));
    handle('browser-extensions-check-updates', ({ ctx }) => service.checkForUpdates(ctx));
    handle('browser-extensions-open-options', ({ ctx }, payload) => service.openOptions(ctx, payload));
    handle('browser-extensions-respond-install', (_target, payload) => service.respondInstall(payload));
  }

  return { service, managerHooks, registerIpc, extensionWindows };
}

module.exports = { createExtensionsWiring, profileIdForPartition, CHANGE_CHANNEL };
