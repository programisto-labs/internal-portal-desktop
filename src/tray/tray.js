'use strict';

/**
 * Icône Lasco de la barre des menus (macOS) et son popover.
 * - Icône « template » (teintée par macOS), avec un point quand quelque chose attend ;
 *   le nombre d'éléments à valider s'affiche à côté (`setTitle`).
 * - Clic : popover sous l'icône (fenêtre sans cadre, `file:` isolée, fermée quand elle perd le focus).
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

const WIDTH = 360;
const MIN_HEIGHT = 180;
const MAX_HEIGHT = 640;

function createTrayController({ Tray, BrowserWindow, nativeImage, nativeTheme, screen, iconDir, getSources, onPortalCommand, onNativeAction }) {
  const icons = {
    plain: nativeImage.createFromPath(path.join(iconDir, 'trayTemplate.png')),
    dot: nativeImage.createFromPath(path.join(iconDir, 'trayDotTemplate.png')),
  };
  for (const image of Object.values(icons)) image.setTemplateImage(true);

  const tray = new Tray(icons.plain);
  tray.setToolTip('Lasco');
  // Clic droit : même popover (pas de menu séparé à maintenir).
  tray.setIgnoreDoubleClickEvents(true);

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

  /** Icône, compteur et info-bulle ; le popover ouvert se redessine. */
  function refresh() {
    const next = currentView();
    const variant = trayIconVariant(next);
    tray.setImage(icons[variant]);
    const pending = trayPendingCount(next);
    tray.setTitle(pending ? String(pending) : '', { fontType: 'monospacedDigit' });
    tray.setToolTip(trayTooltip(next));
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
      transparent: true,
      hasShadow: true,
      roundedCorners: true,
      vibrancy: 'popover',
      visualEffectState: 'active',
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
    const bounds = tray.getBounds();
    const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
    const area = display.workArea;
    const x = Math.round(Math.min(Math.max(bounds.x + bounds.width / 2 - WIDTH / 2, area.x + 8), area.x + area.width - WIDTH - 8));
    const y = Math.round(bounds.y + bounds.height + 4);
    const h = Math.min(height, area.y + area.height - y - 8);
    popover.setBounds({ x, y, width: WIDTH, height: h });
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
  tray.on('right-click', toggle);
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
    const resolved = resolveTrayAction(view, action);
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
