'use strict';

/**
 * Fenêtre d'incrustation native d'un onglet web (docs/picture-in-picture.md) : petite fenêtre sans cadre,
 * toujours au premier plan, sur tous les bureaux et au-dessus des apps en plein écran. La vue de l'onglet
 * (sa `WebContentsView`, jamais rechargée) y est déplacée, au-dessus d'une barre : nom de l'onglet, micro,
 * caméra, raccrocher (quand la page les expose), retour à l'onglet, fermer.
 *
 * La vue de l'onglet n'appartient pas à cette fenêtre : elle en est retirée avant toute fermeture, pour que
 * le gestionnaire d'onglets la remette dans la fenêtre du portail.
 */
const path = require('path');
const { BrowserWindow, WebContentsView, ipcMain, screen } = require('electron');
const { floatBounds, FLOAT_MIN_SIZE } = require('./picture-in-picture');

const BAR_HEIGHT = 44;
const ACTION_CHANNEL = 'lasco-call-float';
const STATE_CHANNEL = 'lasco-call-float-state';
const ACTIONS = new Set(['ready', 'microphone', 'camera', 'hangup', 'back', 'close']);

/** Barres ouvertes, par webContents de la barre : une seule écoute IPC pour toutes. */
const floatsByBarId = new Map();
let ipcInstalled = false;

function installIpc() {
  if (ipcInstalled) return;
  ipcInstalled = true;
  ipcMain.on(ACTION_CHANNEL, (event, payload) => {
    const float = floatsByBarId.get(event.sender.id);
    const action = payload && typeof payload.action === 'string' ? payload.action : '';
    if (float && ACTIONS.has(action)) float.handleAction(action);
  });
}

/** Dernière place choisie par la personne (déplacée, redimensionnée), le temps de la session. */
let lastBounds = null;

/**
 * @param {object} options
 * @param {import('electron').WebContentsView} options.view vue de l'onglet
 * @param {import('electron').BrowserWindow | null} options.parentWindow fenêtre du portail (écran de départ)
 * @param {(action: string) => void} options.onAction micro, caméra, raccrocher, back, close
 * @param {() => void} options.onClosed fenêtre fermée (vue déjà retirée)
 */
function createCallFloat({ view, parentWindow, onAction, onClosed }) {
  installIpc();
  const display = parentWindow && !parentWindow.isDestroyed()
    ? screen.getDisplayMatching(parentWindow.getBounds())
    : screen.getPrimaryDisplay();
  const bounds = floatBounds(display.workArea, lastBounds);
  const win = new BrowserWindow({
    ...bounds,
    minWidth: FLOAT_MIN_SIZE.width,
    minHeight: FLOAT_MIN_SIZE.height,
    frame: false,
    show: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    backgroundColor: '#1b1b1d',
    title: 'Lasco',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.setAlwaysOnTop(true, 'floating');
  try {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch (_) {
    // Linux sans gestionnaire compatible.
  }

  const bar = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'call-float-preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  const barId = bar.webContents.id;
  bar.webContents.on('will-navigate', (event) => event.preventDefault());
  bar.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  void bar.webContents.loadFile(path.join(__dirname, 'call-float.html'));

  let tabView = view;
  let closed = false;
  let state = {};

  function layout() {
    if (win.isDestroyed()) return;
    const [width, height] = win.getContentSize();
    // Méthodes du prototype : le gestionnaire d'onglets neutralise celles de la vue tant qu'elle est ici.
    if (tabView) WebContentsView.prototype.setBounds.call(tabView, { x: 0, y: 0, width, height: Math.max(0, height - BAR_HEIGHT) });
    bar.setBounds({ x: 0, y: Math.max(0, height - BAR_HEIGHT), width, height: BAR_HEIGHT });
  }

  function sendState() {
    if (!bar.webContents.isDestroyed()) bar.webContents.send(STATE_CHANNEL, state);
  }

  /** Retire la vue de l'onglet (avant fermeture, ou pour la rendre au portail). */
  function releaseView() {
    if (!tabView) return null;
    const released = tabView;
    tabView = null;
    try {
      win.contentView.removeChildView(released);
    } catch (_) {
      // Déjà retirée.
    }
    return released;
  }

  win.contentView.addChildView(view);
  win.contentView.addChildView(bar);
  WebContentsView.prototype.setVisible.call(view, true);
  layout();
  win.on('resize', layout);
  win.on('moved', () => {
    if (!win.isDestroyed()) lastBounds = win.getBounds();
  });
  win.on('resized', () => {
    if (!win.isDestroyed()) lastBounds = win.getBounds();
  });
  // Toute fermeture (bouton, ⌘W, fin de l'app) : la vue de l'onglet sort d'abord, jamais détruite ici.
  win.on('close', () => {
    releaseView();
  });
  win.on('closed', () => {
    floatsByBarId.delete(barId);
    if (!bar.webContents.isDestroyed()) bar.webContents.close();
    if (!closed) {
      closed = true;
      onClosed();
    }
  });

  const api = {
    window: win,
    handleAction(action) {
      if (action === 'ready') {
        sendState();
        return;
      }
      onAction(action);
    },
    /** `{ kind, title, controls, texts }` affichés par la barre. */
    update(next) {
      state = { ...state, ...next };
      if (!win.isDestroyed()) win.setTitle(state.title || 'Lasco');
      sendState();
    },
    show() {
      // Sans prendre le focus : la personne vient de passer à une autre app ou un autre onglet.
      if (!win.isDestroyed()) win.showInactive();
    },
    /** Ferme la fenêtre et rend la vue (null si déjà rendue). */
    close() {
      const released = releaseView();
      if (!win.isDestroyed()) win.close();
      return released;
    },
    isOpen: () => !win.isDestroyed(),
    isFocused: () => !win.isDestroyed() && win.isFocused(),
  };
  floatsByBarId.set(barId, api);
  return api;
}

module.exports = { createCallFloat, BAR_HEIGHT };
