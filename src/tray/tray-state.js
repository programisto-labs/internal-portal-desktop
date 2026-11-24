'use strict';

/**
 * Icône Lasco de la barre des menus (macOS) : ce que le popover affiche.
 *
 * Deux sources :
 * - le portail (fenêtre principale) envoie un résumé (`tray-set-state`) : validations d'actions
 *   d'agent en attente, agent qui répond, non-lus par agent ;
 * - Desktop ajoute ce qu'il sait lui-même : confirmations « Cet ordinateur » en attente et
 *   harnais de code en cours.
 *
 * Tout est texte borné : le popover n'interprète jamais de HTML. Les identifiants sont des
 * ObjectId (24 hex) : le popover ne renvoie au portail que des identifiants qu'il a reçus.
 * Docs : docs/tray.md.
 */

const { parseAccelerator } = require('../background-mode');

const OBJECT_ID = /^[a-f0-9]{24}$/i;
const CALL_ID = /^[A-Za-z0-9_.:-]{1,120}$/;
const MAX_ITEMS = 6;

/** Commandes que le popover peut relayer au portail. Le reste est ignoré des deux côtés. */
const TRAY_PORTAL_COMMANDS = Object.freeze(['open-conversation', 'approve', 'deny', 'ask', 'open-approvals']);

function text(value, max) {
  if (typeof value !== 'string') return '';
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function objectId(value) {
  return typeof value === 'string' && OBJECT_ID.test(value) ? value : '';
}

function isoDate(value) {
  if (typeof value !== 'string') return '';
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : '';
}

/** Résumé envoyé par le portail. `null` = aucun portail connecté (connexion, ancien portail). */
function normalizePortalTrayState(input) {
  if (!input || typeof input !== 'object') return null;
  const list = (value) => (Array.isArray(value) ? value : []);

  const approvals = [];
  for (const raw of list(input.approvals)) {
    if (!raw || typeof raw !== 'object') continue;
    const conversationId = objectId(raw.conversationId);
    const callId = typeof raw.callId === 'string' && CALL_ID.test(raw.callId) ? raw.callId : '';
    if (!conversationId || !callId) continue;
    approvals.push({
      conversationId,
      callId,
      agentId: objectId(raw.agentId),
      agentName: text(raw.agentName, 60) || 'Agent',
      label: text(raw.label, 140) || 'Action à valider',
    });
    if (approvals.length >= MAX_ITEMS) break;
  }

  const working = [];
  for (const raw of list(input.working)) {
    if (!raw || typeof raw !== 'object') continue;
    const conversationId = objectId(raw.conversationId);
    if (!conversationId) continue;
    working.push({
      conversationId,
      agentId: objectId(raw.agentId),
      agentName: text(raw.agentName, 60) || 'Agent',
      status: raw.status === 'writing' ? 'writing' : 'thinking',
    });
    if (working.length >= MAX_ITEMS) break;
  }

  const unread = [];
  for (const raw of list(input.unread)) {
    if (!raw || typeof raw !== 'object') continue;
    const conversationId = objectId(raw.conversationId);
    const count = Math.floor(Number(raw.count));
    if (!conversationId || !Number.isFinite(count) || count <= 0) continue;
    unread.push({
      conversationId,
      agentId: objectId(raw.agentId),
      agentName: text(raw.agentName, 60) || 'Agent',
      preview: text(raw.preview, 160),
      count: Math.min(count, 999),
      at: isoDate(raw.at),
    });
    if (unread.length >= MAX_ITEMS) break;
  }

  const unreadTotal = Math.max(0, Math.min(99999, Math.floor(Number(input.unreadTotal) || 0)));
  return {
    approvals,
    working,
    unread,
    unreadTotal: Math.max(unreadTotal, unread.reduce((n, u) => n + u.count, 0)),
    canAsk: input.canAsk === true,
  };
}

/**
 * Vue complète du popover.
 * @param {{ portal: ReturnType<typeof normalizePortalTrayState>, hostConfirms?: Array<{id: string, title?: string, agentName?: string}>,
 *   harnessRuns?: Array<{runId: string, status: string, harnessLabel?: string, projectName?: string, agentName?: string}>,
 *   hostOpsEnabled?: boolean, noAgents?: boolean }} input
 */
function buildTrayView({ portal, hostConfirms = [], harnessRuns = [], hostOpsEnabled = false, noAgents = false, askShortcut = '', askAccelerator = '' }) {
  const confirms = (Array.isArray(hostConfirms) ? hostConfirms : []).slice(0, MAX_ITEMS).map((c) => ({
    id: text(c && c.id, 80),
    title: text(c && c.title, 140) || 'Opération sur cet ordinateur',
    agentName: text(c && c.agentName, 60),
  }));
  const runs = (Array.isArray(harnessRuns) ? harnessRuns : [])
    .filter((r) => r && r.status === 'running')
    .slice(0, MAX_ITEMS)
    .map((r) => ({
      runId: text(r.runId, 80),
      label: text(r.harnessLabel, 40) || 'Harnais de code',
      detail: text([r.projectName, r.agentName].filter(Boolean).join(' · '), 100),
    }));
  const p = portal || { approvals: [], working: [], unread: [], unreadTotal: 0, canAsk: false };
  return {
    connected: Boolean(portal),
    noAgents: noAgents === true,
    hostConfirms: confirms,
    approvals: p.approvals,
    working: p.working,
    harnessRuns: runs,
    unread: p.unread,
    unreadTotal: p.unreadTotal,
    canAsk: p.canAsk && !noAgents,
    // Libellé du raccourci global « Demander à Lasco » (ex. « ⌥⇧ Espace »), '' sans raccourci.
    askShortcut: text(askShortcut, 24),
    // Même raccourci en accelerator Electron, affiché dans le menu natif (Windows / Linux).
    askAccelerator: parseAccelerator(askAccelerator) || '',
    hostOpsEnabled: hostOpsEnabled === true && !noAgents,
  };
}

/** Nombre affiché à côté de l'icône : ce qui attend une réponse de la personne. */
function trayPendingCount(view) {
  return view.hostConfirms.length + view.approvals.length;
}

/**
 * Nombre affiché sur l'icône (comme Cursor) : à valider + non lus. Même total que le badge
 * du Dock pour les non-lus, plus ce qui attend une réponse de la personne.
 */
function trayBadgeCount(view) {
  return trayPendingCount(view) + view.unreadTotal;
}

/** Variante d'icône : point quand quelque chose attend ou n'est pas lu. */
function trayIconVariant(view) {
  return trayPendingCount(view) > 0 || view.unreadTotal > 0 ? 'dot' : 'plain';
}

function trayTooltip(view) {
  const parts = [];
  const pending = trayPendingCount(view);
  if (pending) parts.push(`${pending} à valider`);
  if (view.working.length + view.harnessRuns.length) parts.push(`${view.working.length + view.harnessRuns.length} en cours`);
  if (view.unreadTotal) parts.push(`${view.unreadTotal} non lu${view.unreadTotal > 1 ? 's' : ''}`);
  return parts.length ? `Lasco — ${parts.join(', ')}` : 'Lasco';
}

/**
 * Fenêtre principale masquée : Chromium ralentit ses minuteurs et arrête ses images (économie de CPU,
 * de GPU et de batterie), sauf tant qu'un agent travaille ou attend une réponse. Le tour, son flux et
 * le résumé de l'icône gardent alors leur rythme.
 */
function mainWindowNeedsFullPace(view) {
  return view.working.length + view.harnessRuns.length + trayPendingCount(view) > 0;
}

/**
 * Action choisie dans le popover, revérifiée contre la vue affichée : on ne relaie au portail
 * qu'un identifiant présent dans la vue (pas d'identifiant inventé par la page du popover).
 * @returns {{ kind: 'portal', command: string, payload: object } | { kind: 'native', action: string, id?: string } | null}
 */
function resolveTrayAction(view, action) {
  if (!action || typeof action !== 'object' || typeof action.type !== 'string') return null;
  const { type } = action;
  if (type === 'open-conversation') {
    const hit =
      view.unread.find((u) => u.conversationId === action.conversationId) ||
      view.working.find((w) => w.conversationId === action.conversationId);
    if (!hit) return null;
    return { kind: 'portal', command: 'open-conversation', payload: { conversationId: hit.conversationId, agentId: hit.agentId } };
  }
  if (type === 'approve' || type === 'deny') {
    const hit = view.approvals.find((a) => a.conversationId === action.conversationId && a.callId === action.callId);
    if (!hit) return null;
    return { kind: 'portal', command: type, payload: { conversationId: hit.conversationId, callId: hit.callId } };
  }
  if (type === 'open-approval') {
    const hit = view.approvals.find((a) => a.conversationId === action.conversationId && a.callId === action.callId);
    if (!hit) return null;
    return { kind: 'portal', command: 'open-conversation', payload: { conversationId: hit.conversationId, agentId: hit.agentId } };
  }
  if (type === 'ask') return view.canAsk ? { kind: 'portal', command: 'ask', payload: {} } : null;
  if (type === 'show-host-confirm') {
    // Les confirmations « Cet ordinateur » se décident dans Lasco (carte du chat ou dialogue) : jamais depuis le popover.
    return view.hostConfirms.some((c) => c.id === action.id) ? { kind: 'native', action: 'show-main' } : null;
  }
  if (type === 'show-harness') {
    return view.harnessRuns.some((r) => r.runId === action.runId) ? { kind: 'native', action: 'show-main' } : null;
  }
  if (['show-main', 'settings', 'quit', 'close'].includes(type)) return { kind: 'native', action: type };
  if (type === 'pause-host-ops') return view.hostOpsEnabled ? { kind: 'native', action: 'pause-host-ops' } : null;
  return null;
}

module.exports = {
  TRAY_PORTAL_COMMANDS,
  normalizePortalTrayState,
  buildTrayView,
  trayPendingCount,
  trayBadgeCount,
  trayIconVariant,
  trayTooltip,
  resolveTrayAction,
  mainWindowNeedsFullPace,
};
