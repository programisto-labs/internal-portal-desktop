'use strict';

/**
 * Icône Lasco (barre des menus macOS, zone de notification Windows, barre système Linux) et son popover.
 * - Icône avec un point quand quelque chose attend ; macOS : image « template » et nombre à valider
 *   à côté (`setTitle`) ; Windows / Linux : flamme en couleur.
 * - Clic : popover à côté de l'icône (fenêtre sans cadre, `file:` isolée, fermée quand elle perd le focus).
 * - Windows : clic droit = menu natif. Linux : menu natif attaché (le clic n'arrive pas toujours à l'app).
 * Voir docs/tray.md.
 */
const path = require('path');
const {
  buildTrayView,
  trayPendingCount,
  trayIconVariant,
  trayTooltip,
  resolveTrayAction,
} = require('./tray-state');
const {
  trayIconFiles,
  supportsTrayTitle,
  usesAttachedMenu,
  computePopoverBounds,
  buildTrayMenuItems,
} = require('./tray-platform');

const WIDTH = 360;
const MIN_HEIGHT = 180;
const MAX_HEIGHT = 640;

function createTrayController({
  Tray,
  BrowserWindow,
  Menu,
  nativeImage,
  nativeTheme,
  screen,
  iconDir,
  platform = process.platform,
  getSources,
  onPortalCommand,
  onNativeAction,
}) {
  const isMac = platform === 'darwin';
  const files = trayIconFiles(platform);
  const icons = {
    plain: nativeImage.createFromPath(path.join(iconDir, files.plain)),
    dot: nativeImage.createFromPath(path.join(iconDir, files.dot)),
  };
  if (files.template) for (const image of Object.values(icons)) image.setTemplateImage(true);

  const tray = new Tray(icons.plain);
  tray.setToolTip('Lasco');
  if (isMac) tray.setIgnoreDoubleClickEvents(true);

  let popover = null;
  let ready = false;
  let view = null;
  let height = 320;
  let hiddenAt = 0;

  function currentView() {
    return buildTrayView(getSources());
  }

  function renderView() {
    view = currentView();
    if (popover && ready && !popover.isDestroyed()) {
      popover.webContents.send('tray-popover-render', { ...view, dark: nativeTheme.shouldUseDarkColors });
    }
  }

  /** Menu natif construit sur la vue courante ; chaque entrée repasse par `resolveTrayAction`. */
  function buildMenu(forView) {
    const items = buildTrayMenuItems(forView, { askShortcut: forView.askAccelerator });
    return Menu.buildFromTemplate(
      items.map((item) =>
        item.type === 'separator'
          ? { type: 'separator' }
          : {
              label: item.label,
              ...(item.accelerator ? { accelerator: item.accelerator, registerAccelerator: false } : {}),
              click: () => runAction(forView, item.action),
            },
      ),
    );
  }

  /** Icône, compteur et info-bulle ; le popover ouvert se redessine. */
  function refresh() {
    const next = currentView();
    const variant = trayIconVariant(next);
    tray.setImage(icons[variant]);
    const pending = trayPendingCount(next);
    if (supportsTrayTitle(platform)) tray.setTitle(pending ? String(pending) : '', { fontType: 'monospacedDigit' });
    tray.setToolTip(trayTooltip(next));
    // Linux : le menu attaché suit l'état (compteurs, « Demander à Lasco »).
    if (usesAttachedMenu(platform)) tray.setContextMenu(buildMenu(next));
    if (popover && popover.isVisible()) renderView();
  }

  function createPopover() {
    popover = new BrowserWindow({
      width: WIDTH,
      height,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      // Linux : la transparence dépend du compositeur ; fenêtre opaque, le panneau garde son fond.
      transparent: platform !== 'linux',
      backgroundColor: platform === 'linux' ? (nativeTheme.shouldUseDarkColors ? '#202020' : '#f6f6f6') : undefined,
      hasShadow: true,
      roundedCorners: true,
      ...(isMac ? { vibrancy: 'popover', visualEffectState: 'active' } : {}),
      webPreferences: {
        preload: path.join(__dirname, 'tray-popover-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    popover.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    const wc = popover.webContents;
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    popover.on('blur', () => hide());
    popover.on('closed', () => {
      popover = null;
      ready = false;
    });
    wc.loadFile(path.join(__dirname, 'tray-popover.html'));
  }

  function position() {
    let trayBounds = null;
    try {
      trayBounds = tray.getBounds();
    } catch (_) {
      trayBounds = null;
    }
    const cursor = screen.getCursorScreenPoint();
    const anchor = trayBounds && trayBounds.width > 0 ? { x: trayBounds.x, y: trayBounds.y } : cursor;
    const display = screen.getDisplayNearestPoint(anchor);
    popover.setBounds(
      computePopoverBounds({
        trayBounds,
        display: { bounds: display.bounds, workArea: display.workArea },
        cursor,
        width: WIDTH,
        height,
      }),
    );
  }

  function show() {
    if (!popover) createPopover();
    renderView();
    position();
    popover.show();
    popover.focus();
  }

  function hide() {
    if (popover && popover.isVisible()) {
      popover.hide();
      hiddenAt = Date.now();
    }
  }

  function toggle() {
    // Le clic sur l'icône fait d'abord perdre le focus au popover (blur → hide) : ne pas le rouvrir aussitôt.
    if (popover && popover.isVisible()) return hide();
    if (Date.now() - hiddenAt < 250) return undefined;
    return show();
  }

  tray.on('click', toggle);
  if (isMac) {
    // Clic droit : même popover (pas de menu séparé à maintenir).
    tray.on('right-click', toggle);
  } else if (!usesAttachedMenu(platform)) {
    // Windows : clic droit = menu natif, comme les autres icônes de la zone de notification.
    tray.on('right-click', () => {
      hide();
      tray.popUpContextMenu(buildMenu(currentView()));
    });
  }
  nativeTheme.on('updated', () => {
    if (popover && popover.isVisible()) renderView();
  });

  /** Messages du popover : l'expéditeur doit être la page du popover. */
  function isPopoverSender(event) {
    return Boolean(popover && !popover.isDestroyed() && event.sender === popover.webContents);
  }

  function handleReady(event) {
    if (!isPopoverSender(event)) return;
    ready = true;
    renderView();
  }

  function handleSize(event, value) {
    if (!isPopoverSender(event)) return;
    const next = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.floor(Number(value) || 0)));
    if (next === height) return;
    height = next;
    if (popover.isVisible()) position();
  }

  function handleAction(event, action) {
    if (!isPopoverSender(event) || !view) return;
    runAction(view, action);
  }

  /** Action du popover ou du menu natif, revérifiée contre la vue qui l'a affichée. */
  function runAction(shownView, action) {
    const resolved = resolveTrayAction(shownView, action);
    if (!resolved) return;
    if (resolved.kind === 'portal') {
      // Approuver / refuser laisse le popover ouvert (la ligne disparaît au prochain état) ; le reste ouvre Lasco.
      const stay = resolved.command === 'approve' || resolved.command === 'deny';
      if (!stay) hide();
      onPortalCommand(resolved.command, resolved.payload, { focus: !stay });
      return;
    }
    hide();
    if (resolved.action !== 'close') onNativeAction(resolved.action);
  }

  function destroy() {
    if (popover && !popover.isDestroyed()) popover.destroy();
    tray.destroy();
  }

  return { refresh, show, hide, handleReady, handleSize, handleAction, destroy };
}

module.exports = { createTrayController };
