'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizePortalTrayState,
  buildTrayView,
  trayPendingCount,
  trayIconVariant,
  trayTooltip,
  resolveTrayAction,
  mainWindowNeedsFullPace,
} = require('../src/tray/tray-state');

const A = 'a'.repeat(24);
const B = 'b'.repeat(24);
const C = 'c'.repeat(24);

const portal = normalizePortalTrayState({
  approvals: [
    { conversationId: A, callId: 'call_1', agentId: B, agentName: 'Rédacteur', label: 'Envoyer un e-mail' },
    { conversationId: 'nope', callId: 'call_2' },
  ],
  working: [{ conversationId: C, agentId: B, agentName: 'Rédacteur', status: 'writing' }],
  unread: [
    { conversationId: B, agentId: A, agentName: 'Lasco AI', preview: '  Voici   le résumé  ', count: 2, at: '2026-11-20T09:00:00Z' },
    { conversationId: C, count: 0 },
  ],
  unreadTotal: 1,
  canAsk: true,
});

describe('tray state from the portal', () => {
  it('returns null when no portal reported', () => {
    assert.equal(normalizePortalTrayState(null), null);
    assert.equal(normalizePortalTrayState('x'), null);
  });

  it('keeps only valid items, with bounded text', () => {
    assert.equal(portal.approvals.length, 1);
    assert.equal(portal.unread.length, 1);
    assert.equal(portal.unread[0].preview, 'Voici le résumé');
    assert.equal(portal.working[0].status, 'writing');
    // Total never below the visible rows.
    assert.equal(portal.unreadTotal, 2);
  });

  it('clips long labels and caps lists', () => {
    const many = normalizePortalTrayState({
      unread: Array.from({ length: 20 }, (_, i) => ({ conversationId: A, count: 1, preview: 'x'.repeat(500), agentName: String(i) })),
    });
    assert.equal(many.unread.length, 6);
    assert.ok(many.unread[0].preview.length <= 160);
  });
});

describe('tray view', () => {
  const view = buildTrayView({
    portal,
    hostConfirms: [{ id: 'req-1', title: 'Exécuter npm test', agentName: 'Dev' }],
    harnessRuns: [
      { runId: 'r1', status: 'running', harnessLabel: 'Claude Code', projectName: 'portal' },
      { runId: 'r2', status: 'done' },
    ],
    hostOpsEnabled: true,
  });

  it('merges native confirmations and running harnesses', () => {
    assert.equal(view.hostConfirms.length, 1);
    assert.equal(view.harnessRuns.length, 1);
    assert.equal(trayPendingCount(view), 2);
    assert.equal(trayIconVariant(view), 'dot');
    assert.match(trayTooltip(view), /2 à valider/);
  });

  it('shows the plain icon when nothing waits', () => {
    const empty = buildTrayView({ portal: null });
    assert.equal(empty.connected, false);
    assert.equal(trayIconVariant(empty), 'plain');
    assert.equal(trayTooltip(empty), 'Lasco');
  });

  it('hides agent actions in no-agents mode', () => {
    const v = buildTrayView({ portal, hostOpsEnabled: true, noAgents: true });
    assert.equal(v.canAsk, false);
    assert.equal(v.hostOpsEnabled, false);
  });

  it('shows the « Demander à Lasco » shortcut as bounded text', () => {
    assert.equal(buildTrayView({ portal, askShortcut: '⌥⇧ Espace' }).askShortcut, '⌥⇧ Espace');
    assert.equal(buildTrayView({ portal }).askShortcut, '');
    assert.equal(buildTrayView({ portal, askShortcut: { x: 1 } }).askShortcut, '');
  });
});

describe('tray actions', () => {
  const view = buildTrayView({ portal, hostConfirms: [{ id: 'req-1', title: 't' }], hostOpsEnabled: true });

  it('relays approvals only for an approval shown in the popover', () => {
    assert.deepEqual(resolveTrayAction(view, { type: 'approve', conversationId: A, callId: 'call_1' }), {
      kind: 'portal',
      command: 'approve',
      payload: { conversationId: A, callId: 'call_1' },
    });
    assert.equal(resolveTrayAction(view, { type: 'approve', conversationId: A, callId: 'other' }), null);
    assert.equal(resolveTrayAction(view, { type: 'deny', conversationId: C, callId: 'call_1' }), null);
  });

  it('opens only listed conversations', () => {
    const hit = resolveTrayAction(view, { type: 'open-conversation', conversationId: B });
    assert.equal(hit.command, 'open-conversation');
    assert.equal(hit.payload.agentId, A);
    assert.equal(resolveTrayAction(view, { type: 'open-conversation', conversationId: 'f'.repeat(24) }), null);
  });

  it('never decides a host confirmation from the popover', () => {
    assert.deepEqual(resolveTrayAction(view, { type: 'show-host-confirm', id: 'req-1' }), { kind: 'native', action: 'show-main' });
    assert.equal(resolveTrayAction(view, { type: 'show-host-confirm', id: 'other' }), null);
  });

  it('pauses host operations only when they are on', () => {
    assert.ok(resolveTrayAction(view, { type: 'pause-host-ops' }));
    const off = buildTrayView({ portal });
    assert.equal(resolveTrayAction(off, { type: 'pause-host-ops' }), null);
  });

  it('ignores unknown actions', () => {
    assert.equal(resolveTrayAction(view, { type: 'eval' }), null);
    assert.equal(resolveTrayAction(view, null), null);
  });
});

describe('mainWindowNeedsFullPace', () => {
  it('lets Chromium throttle the hidden main window when nothing is going on', () => {
    assert.equal(mainWindowNeedsFullPace(buildTrayView({ portal: null })), false);
    const idle = normalizePortalTrayState({ unread: [{ conversationId: B, count: 3 }], unreadTotal: 3 });
    assert.equal(mainWindowNeedsFullPace(buildTrayView({ portal: idle })), false);
  });
  it('keeps full pace while an agent works, a harness runs or an answer is awaited', () => {
    const working = normalizePortalTrayState({ working: [{ conversationId: C, agentId: B, status: 'writing' }] });
    assert.equal(mainWindowNeedsFullPace(buildTrayView({ portal: working })), true);
    const approval = normalizePortalTrayState({ approvals: [{ conversationId: A, callId: 'call_1', agentId: B }] });
    assert.equal(mainWindowNeedsFullPace(buildTrayView({ portal: approval })), true);
    assert.equal(mainWindowNeedsFullPace(buildTrayView({ portal: null, harnessRuns: [{ runId: 'r1', status: 'running' }] })), true);
    assert.equal(mainWindowNeedsFullPace(buildTrayView({ portal: null, harnessRuns: [{ runId: 'r1', status: 'done' }] })), false);
    assert.equal(mainWindowNeedsFullPace(buildTrayView({ portal: null, hostConfirms: [{ id: 'h1' }] })), true);
  });
});
