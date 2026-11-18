'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HARNESSES, parseHarnessLine } = require('../src/code-harness/harnesses');
const { createHarnessRunner } = require('../src/code-harness/runner');
const { buildConfirmDialog } = require('../src/host-ops/confirm');
const { createHostOpsStore } = require('../src/host-ops/store');
const { createHostOpsWebSettings } = require('../src/host-ops/web-settings');

/** Faux processus : le test écrit des lignes sur stdout puis termine avec un code. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = undefined;
  child.exitCode = null;
  child.kill = () => {
    child.killed = true;
    setImmediate(() => child.emit('close', 143));
  };
  child.feed = (...lines) => child.stdout.emit('data', Buffer.from(lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n'));
  child.end = (code = 0) => {
    child.exitCode = code;
    child.emit('close', code);
  };
  return child;
}

describe('harnais de code : lecture des événements', () => {
  it('Claude Code / Cursor : session, texte, outil, résultat (format réel stream-json)', () => {
    const lines = [
      { type: 'system', subtype: 'init', session_id: 's-1', cwd: '/p' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Je regarde.' }, { type: 'tool_use', name: 'Edit', input: { file_path: 'src/a.ts' } }] } },
      { type: 'result', subtype: 'success', is_error: false, result: 'Fait.', session_id: 's-1' },
    ];
    const events = lines.flatMap((l) => parseHarnessLine('claude-code', JSON.stringify(l)));
    assert.deepEqual(events, [
      { kind: 'session', id: 's-1' },
      { kind: 'text', text: 'Je regarde.' },
      { kind: 'step', text: 'Edit · src/a.ts' },
      { kind: 'result', text: 'Fait.', error: false },
      { kind: 'session', id: 's-1' },
    ]);
  });

  it('non connecté : détecté dans le résultat', () => {
    const events = parseHarnessLine('claude-code', JSON.stringify({ type: 'result', result: 'Not logged in · Please run /login' }));
    assert.equal(events[0].kind, 'login_required');
  });

  it('Codex : ancien et nouveau format', () => {
    const old = [
      { id: '0', msg: { type: 'session_configured', session_id: 'c-1' } },
      { id: '1', msg: { type: 'exec_command_begin', command: ['npm', 'test'] } },
      { id: '2', msg: { type: 'agent_message', message: 'Tests verts.' } },
      { id: '3', msg: { type: 'task_complete', last_agent_message: 'Tests verts.' } },
    ].flatMap((l) => parseHarnessLine('codex', JSON.stringify(l)));
    assert.deepEqual(old.map((e) => e.kind), ['session', 'step', 'text', 'result']);
    assert.equal(old[1].text, 'Commande · npm test');
    const recent = [
      { type: 'thread.started', thread_id: 't-1' },
      { type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'a.ts' }] } },
      { type: 'turn.failed', error: { message: 'Unauthorized: run codex login' } },
    ].flatMap((l) => parseHarnessLine('codex', JSON.stringify(l)));
    assert.deepEqual(recent.map((e) => e.kind), ['session', 'step', 'login_required']);
  });

  it('Vibe : messages et appels d’outils ; lignes illisibles ignorées', () => {
    const events = parseHarnessLine(
      'vibe',
      JSON.stringify({ role: 'assistant', content: 'ok', tool_calls: [{ function: { name: 'bash', arguments: '{"command":"ls"}' } }] }),
    );
    assert.deepEqual(events, [{ kind: 'text', text: 'ok' }, { kind: 'step', text: 'bash · ls' }]);
    assert.deepEqual(parseHarnessLine('vibe', 'pas du json'), []);
  });

  it('options non interactives de chaque harnais', () => {
    assert.deepEqual(HARNESSES['claude-code'].args({ prompt: 'x', sessionId: 's' }).slice(0, 2), ['-p', 'x']);
    assert.ok(HARNESSES['claude-code'].args({ prompt: 'x' }).includes('acceptEdits'));
    assert.ok(HARNESSES.codex.args({ prompt: 'x', cwd: '/p' }).includes('workspace-write'));
    assert.ok(HARNESSES.cursor.args({ prompt: 'x' }).includes('stream-json'));
    assert.ok(HARNESSES.vibe.args({ prompt: 'x', cwd: '/p' }).includes('/p'));
  });
});

describe('harnais de code : exécutions', () => {
  let child;
  let events;
  let confirmAnswer;
  let confirmed;
  let enabled;

  const project = { id: 'p1', name: 'demo', root: '/tmp/demo' };
  const mk = (overrides = {}) =>
    createHarnessRunner({
      isEnabled: () => enabled,
      getProject: (_u, id) => {
        if (id !== 'p1') throw Object.assign(new Error('Projet introuvable.'), { code: 'project_not_found' });
        return project;
      },
      confirm: async (req) => {
        confirmed.push(req);
        return confirmAnswer;
      },
      emit: (e) => events.push(e),
      spawnImpl: (bin, args, opts) => {
        child = fakeChild();
        child.spawned = { bin, args, opts };
        return child;
      },
      listFiles: async () => [{ status: 'M', path: 'src/a.ts' }],
      checkAuth: async () => ({ state: 'ok' }),
      ...overrides,
    });
  const request = (extra = {}) => ({ requestId: 'call_1', userId: 'u1', agentId: 'a1', agentName: 'Dev', projectId: 'p1', harness: 'claude-code', prompt: 'Ajoute un test', ...extra });
  const tick = () => new Promise((r) => setImmediate(r));

  beforeEach(() => {
    events = [];
    confirmed = [];
    confirmAnswer = 'once';
    enabled = true;
  });

  it('désactivé, harnais inconnu, projet non ouvert : refus sans rien lancer', async () => {
    enabled = false;
    assert.equal((await mk().start(request())).error.code, 'disabled');
    enabled = true;
    assert.equal((await mk().start(request({ harness: 'autre' }))).error.code, 'unsupported_harness');
    assert.equal((await mk().start(request({ projectId: 'p2' }))).error.code, 'project_not_found');
    assert.equal(child, undefined);
  });

  it('refusé dans la confirmation : rien n’est lancé', async () => {
    child = undefined;
    confirmAnswer = 'deny';
    const res = await mk().start(request());
    assert.equal(res.status, 'denied');
    assert.equal(child, undefined);
    assert.equal(confirmed[0].operation, 'code.delegate');
    assert.match(buildConfirmDialog({ ...confirmed[0], allowPersistent: true }).title, /lancer Claude Code/);
  });

  it('lance dans le projet, diffuse les étapes, rend résumé, fichiers et session', async () => {
    const runner = mk();
    const pending = runner.start(request());
    await tick();
    assert.equal(child.spawned.bin, 'claude');
    assert.equal(child.spawned.opts.cwd, '/tmp/demo');
    child.feed(
      { type: 'system', subtype: 'init', session_id: 's-9' },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'test.sh' } }] } },
      { type: 'result', result: 'Script ajouté.', is_error: false, session_id: 's-9' },
    );
    assert.equal((await runner.start(request({ requestId: 'call_2' }))).error.code, 'busy');
    child.end(0);
    const res = await pending;
    assert.equal(res.ok, true);
    assert.equal(res.result.summary, 'Script ajouté.');
    assert.deepEqual(res.result.files, [{ status: 'M', path: 'src/a.ts' }]);
    assert.equal(res.result.sessionId, 's-9');
    assert.deepEqual(events.map((e) => e.type), ['started', 'step', 'done']);
    assert.equal(events[1].text, 'Write · test.sh');
  });

  it('non connecté : statut login_required et commande de connexion', async () => {
    const runner = mk();
    const pending = runner.start(request({ harness: 'cursor' }));
    await tick();
    child.feed({ type: 'result', result: 'Not logged in · Please run /login' });
    child.end(0);
    const res = await pending;
    assert.equal(res.ok, false);
    assert.equal(res.status, 'login_required');
    assert.match(res.error.message, /cursor-agent login/);
  });

  it('arrêt : le processus est tué et l’exécution finit « arrêtée »', async () => {
    const runner = mk();
    const pending = runner.start(request());
    await tick();
    const runId = events[0].run.runId;
    assert.equal(runner.stop(runId).stopped, true);
    const res = await pending;
    assert.equal(res.ok, false);
    assert.equal(res.status, 'stopped');
  });
});

describe('harnais de code : connexion vérifiée avant le lancement', () => {
  it('compte sans abonnement : pas de confirmation, carte « connexion requise », relance possible', async () => {
    const events = [];
    let confirms = 0;
    let auth = { state: 'no_plan', message: 'Compte sans abonnement.' };
    const runner = createHarnessRunner({
      isEnabled: () => true,
      getProject: () => ({ id: 'p1', name: 'demo', root: '/tmp/demo' }),
      confirm: async () => (confirms++, 'deny'),
      emit: (e) => events.push(e),
      checkAuth: async () => auth,
      spawnImpl: () => {
        throw new Error('ne doit pas être lancé');
      },
    });
    const res = await runner.start({ requestId: 'call_1', userId: 'u1', agentId: 'a1', projectId: 'p1', harness: 'claude-code', prompt: 'x' });
    assert.equal(res.status, 'login_required');
    assert.equal(confirms, 0);
    assert.equal(events[0].run.authState, 'no_plan');
    auth = { state: 'ok' };
    const retried = await runner.retry(events[0].run.runId);
    assert.equal(retried.status, 'denied');
    assert.equal(confirms, 1);
  });
});

describe('harnais de code : interrupteur dans les réglages', () => {
  let tmp;
  let store;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-settings-'));
    store = createHostOpsStore(path.join(tmp, 'host-ops.json'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('activer demande aussi l’hôte et les projets ; couper les projets coupe les harnais', async () => {
    const asked = [];
    const web = createHostOpsWebSettings({ store, confirmEnable: async (r) => (asked.push(r), true), now: () => 0 });
    assert.equal(web.status().harnessEnabled, false);
    const res = await web.requestEnable('harness');
    assert.deepEqual(asked[0].features, ['host', 'code', 'harness']);
    assert.equal(res.status.harnessEnabled, true);
    web.disable('code');
    assert.equal(store.isHarnessEnabled(), false);
    store.setCodeEnabled(true);
    assert.equal(store.isHarnessEnabled(), false);
  });
});
