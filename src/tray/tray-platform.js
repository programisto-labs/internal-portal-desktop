'use strict';

/**
 * Icône Lasco selon la plateforme (docs/tray.md) :
 * - macOS : barre des menus, image « template » teintée par le système, popover sous l'icône ;
 * - Windows : zone de notification, flamme en couleur, popover au-dessus de la barre des tâches,
 *   clic droit = menu natif ;
 * - Linux : barre système (StatusNotifier / AppIndicator), flamme en couleur. Beaucoup
 *   d'environnements n'envoient pas le clic à l'app : le menu natif est toujours attaché.
 * Pas de dépendance à Electron : testé seul.
 */

/** Fichiers d'icône (dans build/tray), version 1x ; `@2x` est chargé par Electron à côté. */
function trayIconFiles(platform) {
  if (platform === 'darwin') return { plain: 'trayTemplate.png', dot: 'trayDotTemplate.png', template: true };
  return { plain: 'tray.png', dot: 'trayDot.png', template: false };
}

/** Le nombre d'éléments à valider s'écrit à côté de l'icône seulement sur macOS (`setTitle`). */
function supportsTrayTitle(platform) {
  return platform === 'darwin';
}

/** Linux : le menu natif est le seul moyen sûr d'agir sur l'icône. */
function usesAttachedMenu(platform) {
  return platform === 'linux';
}

/** Nom de l'endroit où vit l'icône, pour les textes des Réglages et des notifications. */
function trayPlaceLabel(platform) {
  if (platform === 'darwin') return 'la barre des menus';
  if (platform === 'win32') return 'la zone de notification';
  return 'la barre système';
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

function isEmptyRect(r) {
  return !r || !(r.width > 0 && r.height > 0);
}

/**
 * Position du popover à côté de l'icône, du côté où se trouve la barre (en haut sur macOS,
 * en bas / sur un côté sous Windows). Linux renvoie souvent une icône sans position : on
 * se place alors au pointeur, dans la zone utile de l'écran.
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
function computePopoverBounds({ trayBounds, display, cursor, width, height, margin = 8, gap = 4 }) {
  const area = display.workArea;
  const full = display.bounds || area;
  const h = Math.min(height, area.height - 2 * margin);
  const fit = (x, y) => ({
    x: Math.round(clamp(x, area.x + margin, area.x + area.width - width - margin)),
    // En haut, la zone utile commence déjà sous la barre : pas de marge en plus (popover à 4 px de l'icône).
    y: Math.round(clamp(y, area.y, area.y + area.height - h - margin)),
    width,
    height: Math.round(h),
  });

  if (isEmptyRect(trayBounds)) {
    const p = cursor || { x: area.x + area.width, y: area.y + area.height };
    // Pointeur dans la moitié basse : au-dessus de lui, sinon en dessous.
    const below = p.y < area.y + area.height / 2;
    return fit(p.x - width / 2, below ? p.y + gap : p.y - h - gap);
  }

  const t = trayBounds;
  const centerX = t.x + t.width / 2 - width / 2;
  const centerY = t.y + t.height / 2 - h / 2;
  // Côté de la barre : là où la zone utile est rognée par rapport à l'écran.
  if (area.y > full.y) return fit(centerX, t.y + t.height + gap); // barre en haut (macOS, certains Linux)
  if (area.x > full.x) return fit(t.x + t.width + gap, centerY); // barre à gauche
  if (area.x + area.width < full.x + full.width) return fit(t.x - width - gap, centerY); // à droite
  if (area.y + area.height < full.y + full.height) return fit(centerX, t.y - h - gap); // en bas (Windows)
  // Barre masquée automatiquement : selon la moitié de l'écran où est l'icône.
  return t.y < full.y + full.height / 2 ? fit(centerX, t.y + t.height + gap) : fit(centerX, t.y - h - gap);
}

/**
 * Menu natif de l'icône (clic droit sous Windows, menu attaché sous Linux).
 * Chaque entrée porte une action du popover, revérifiée par `resolveTrayAction`.
 * Aucune décision depuis ce menu : « À valider » ouvre Lasco.
 */
function buildTrayMenuItems(view, { quitLabel = 'Quitter Lasco', askShortcut = '' } = {}) {
  const items = [{ label: 'Ouvrir Lasco', action: { type: 'show-main' } }];
  if (view.canAsk) {
    items.push({ label: 'Demander à Lasco…', action: { type: 'ask' }, accelerator: askShortcut || undefined });
  }
  const pending = view.hostConfirms.length + view.approvals.length;
  const running = view.working.length + view.harnessRuns.length;
  const status = [];
  if (pending) status.push({ label: `${pending} à valider`, action: { type: 'show-main' } });
  if (running) status.push({ label: `${running} en cours`, action: { type: 'show-main' } });
  if (view.unreadTotal) {
    status.push({
      label: `${view.unreadTotal} non lu${view.unreadTotal > 1 ? 's' : ''}`,
      action: { type: 'show-main' },
    });
  }
  if (status.length) items.push({ type: 'separator' }, ...status);
  items.push({ type: 'separator' });
  if (view.hostOpsEnabled) {
    items.push({ label: 'Suspendre les opérations sur cet ordinateur', action: { type: 'pause-host-ops' } });
  }
  items.push({ label: 'Réglages…', action: { type: 'settings' } }, { label: quitLabel, action: { type: 'quit' } });
  return items;
}

module.exports = {
  trayIconFiles,
  supportsTrayTitle,
  usesAttachedMenu,
  trayPlaceLabel,
  computePopoverBounds,
  buildTrayMenuItems,
};
