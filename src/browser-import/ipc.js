'use strict';

const { createBrowserImport } = require('./index');

const FULL_DISK_ACCESS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';

/**
 * IPC of the browser import (docs/browser-import.md). `resolveWindow(event)` returns the sender's
 * BrowserWindow when it is a portal window, else null: every channel refuses other senders.
 */
function registerBrowserImportIpc({ ipcMain, dialog, shell, home, history, resolveWindow, platform = process.platform }) {
  let progressTarget = null;
  const controller = createBrowserImport({
    home,
    platform,
    history,
    emit: (payload) => {
      const win = progressTarget;
      if (win && !win.isDestroyed()) win.webContents.send('browser-import-progress', payload);
    },
  });

  const guard = (handler) => async (event, payload) => {
    const win = resolveWindow(event);
    if (!win) return { ok: false, error: 'forbidden' };
    return handler(win, payload && typeof payload === 'object' ? payload : {});
  };

  ipcMain.handle('browser-import-list', guard(() => controller.list()));
  ipcMain.handle(
    'browser-import-run',
    guard(async (win, payload) => {
      progressTarget = win;
      try {
        return await controller.run(payload);
      } finally {
        progressTarget = null;
      }
    }),
  );
  ipcMain.handle(
    'browser-import-passwords-csv',
    guard(async (win) => {
      const res = await dialog.showOpenDialog(win, {
        properties: ['openFile'],
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      });
      if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false, error: 'canceled' };
      return controller.importPasswordsCsv({ filePath: res.filePaths[0] });
    }),
  );
  ipcMain.handle('browser-import-take-passwords', guard((_win, payload) => controller.takePasswords(payload)));
  ipcMain.handle('browser-import-discard-passwords', guard((_win, payload) => controller.discardPasswords(payload)));
  ipcMain.handle(
    'browser-import-open-full-disk-access',
    guard(async () => {
      if (platform !== 'darwin') return { ok: false, error: 'unsupported' };
      await shell.openExternal(FULL_DISK_ACCESS_URL);
      return { ok: true };
    }),
  );
  return controller;
}

module.exports = { registerBrowserImportIpc, FULL_DISK_ACCESS_URL };
