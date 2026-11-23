'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HARNESSES, parseHarnessLine } = require('../src/code-harness/harnesses');
const { createHarnessRunner } = require('../src/code-harness/runner');
const { createRunHistory } = require('../src/code-harness/history');
const { resolveHarnessCommand } = require('../src/code-harness/command');
const { createHarnessPermissions, PERMISSION_TOOL } = require('../src/code-harness/permissions');
const { handleMessage, askDesktop } = require('../src/code-harness/permission-mcp');
const { buildShellPlan, shellGrantCovers } = require('../src/host-ops/shell');
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
    // Sans relais : pas de serveur MCP ajouté (les commandes restent refusées par Claude Code).
    assert.ok(!HARNESSES['claude-code'].args({ prompt: 'x' }).includes('--permission-prompt-tool'));
    const withRelay = HARNESSES['claude-code'].args({ prompt: 'x', permission: { mcpConfig: '{"mcpServers":{}}', toolName: PERMISSION_TOOL } });
    assert.equal(withRelay[withRelay.indexOf('--permission-prompt-tool') + 1], 'mcp__lasco_desktop__approve');
    assert.equal(withRelay[withRelay.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
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
      probeFlags: async () => null,
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

  it('Cursor ancien : --trust non passé s’il est absent de --help, message de mise à jour si une option est refusée', async () => {
    const runner = mk({ probeFlags: async () => new Set(['--print', '--force', '--output-format']) });
    const pending = runner.start(request({ harness: 'cursor' }));
    await tick();
    await tick();
    assert.ok(child.spawned.args.includes('--force'));
    assert.ok(!child.spawned.args.includes('--trust'));
    child.stderr.emit('data', Buffer.from("error: unknown option '--output-format'\n"));
    child.end(1);
    const res = await pending;
    assert.equal(res.ok, false);
    assert.match(res.error.message, /trop ancienne \(option --output-format inconnue\)/);
    assert.match(res.error.message, /cursor-agent update/);
  });

  it('Cursor récent : --trust passé', async () => {
    const runner = mk({ probeFlags: async () => new Set(['--force', '--trust']) });
    const pending = runner.start(request({ harness: 'cursor' }));
    await tick();
    await tick();
    assert.ok(child.spawned.args.includes('--trust'));
    child.feed({ type: 'result', subtype: 'success', is_error: false, result: 'Fait.' });
    child.end(0);
    assert.equal((await pending).ok, true);
  });

  it('commande résolue (Windows) : programme et script lancés sans shell', async () => {
    const runner = mk({ resolveCommand: () => ({ command: 'C:\\ca\\node.exe', prefixArgs: ['C:\\ca\\index.js'] }) });
    const pending = runner.start(request({ harness: 'cursor' }));
    await tick();
    await tick();
    assert.equal(child.spawned.bin, 'C:\\ca\\node.exe');
    assert.equal(child.spawned.args[0], 'C:\\ca\\index.js');
    assert.equal(child.spawned.args[1], '-p');
    assert.equal(child.spawned.opts.shell, undefined);
    child.end(0);
    await pending;
  });

  it('script Windows illisible : refusé avec un message, jamais lancé par cmd.exe', async () => {
    let spawned = false;
    const runner = mk({
      resolveCommand: () => ({ error: 'unsupported_shim', shim: 'C:\\x\\cursor-agent.cmd' }),
      spawnImpl: () => ((spawned = true), fakeChild()),
    });
    const res = await runner.start(request({ harness: 'cursor' }));
    assert.equal(spawned, false);
    assert.equal(res.ok, false);
    assert.match(res.error.message, /ne sait pas lancer ce script sous Windows/);
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

  it('environnement du shell de connexion (promesse) : PATH transmis à la vérification et au lancement', async () => {
    const seen = [];
    const runner = mk({
      getEnv: async () => ({ PATH: '/Users/x/.local/bin:/usr/bin', CLAUDECODE: '1' }),
      checkAuth: async (_h, env) => (seen.push(env), { state: 'ok' }),
    });
    const pending = runner.start(request());
    await tick();
    await tick();
    assert.equal(seen[0].PATH, '/Users/x/.local/bin:/usr/bin');
    assert.equal(child.spawned.opts.env.PATH, '/Users/x/.local/bin:/usr/bin');
    assert.equal(child.spawned.opts.env.CLAUDECODE, undefined);
    child.end(0);
    await pending;
  });

  it('suite depuis la carte : même session, origine « card », fil du chat conservé', async () => {
    const runner = mk();
    const conversationId = 'a'.repeat(24);
    const first = runner.start(request({ conversationId }));
    await tick();
    child.feed({ type: 'result', result: 'Script créé.', is_error: false, session_id: 's-1' });
    child.end(0);
    await first;
    const done = events.find((e) => e.type === 'done').run;
    assert.equal(done.origin, 'tool');
    assert.equal(done.conversationId, conversationId);
    assert.equal((await runner.followUp(done.runId, '  ')).error.code, 'invalid_request');
    events = [];
    const next = runner.followUp(done.runId, 'Ajoute un test');
    await tick();
    await tick();
    assert.deepEqual(child.spawned.args.slice(0, 2), ['-p', 'Ajoute un test']);
    assert.ok(child.spawned.args.includes('s-1'));
    assert.equal(events[0].type, 'removed');
    const started = events.find((e) => e.type === 'started').run;
    assert.equal(started.origin, 'card');
    assert.equal(started.conversationId, conversationId);
    assert.equal(started.requestId, 'call_1-f1');
    child.end(0);
    await next;
  });

  it('suite sans session (Codex) : la demande et le résultat précédents sont rappelés', async () => {
    const runner = mk();
    const first = runner.start(request({ harness: 'codex' }));
    await tick();
    child.feed({ type: 'item.completed', item: { type: 'agent_message', text: 'Fait.' } });
    child.end(0);
    await first;
    const done = events.find((e) => e.type === 'done').run;
    const next = runner.followUp(done.runId, 'Et un README');
    await tick();
    await tick();
    const prompt = child.spawned.args.find((a) => a.includes('Nouvelle demande'));
    assert.match(prompt, /Ajoute un test[\s\S]*Nouvelle demande :\nEt un README/);
    child.end(0);
    await next;
  });

  it('Claude Code : relais d’autorisation préparé, transmis au CLI et retiré à la fin', async () => {
    const prepared = [];
    let disposed = 0;
    const runner = mk({
      permissions: {
        prepare: async (ctx) => {
          prepared.push(ctx);
          return { mcpConfig: '{"mcpServers":{}}', toolName: PERMISSION_TOOL, env: { MCP_TOOL_TIMEOUT: '1' }, dispose: () => disposed++ };
        },
      },
    });
    const pending = runner.start(request());
    await tick();
    await tick();
    assert.ok(child.spawned.args.includes('--permission-prompt-tool'));
    assert.equal(child.spawned.opts.env.MCP_TOOL_TIMEOUT, '1');
    assert.equal(prepared[0].root, '/tmp/demo');
    assert.equal(prepared[0].agentId, 'a1');
    prepared[0].onDecision({ command: 'npx create-next-app', decision: 'deny' });
    child.end(0);
    await pending;
    assert.equal(disposed, 1);
    assert.ok(events.some((e) => e.type === 'step' && e.text === 'Refusé · npx create-next-app'));
  });

  it('autres harnais : pas de relais (ils ont leurs propres règles)', async () => {
    let calls = 0;
    const runner = mk({ permissions: { prepare: async () => (calls++, null) } });
    const pending = runner.start(request({ harness: 'cursor' }));
    await tick();
    await tick();
    child.end(0);
    await pending;
    assert.equal(calls, 0);
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

describe('harnais de code : cartes gardées après un redémarrage', () => {
  it('les exécutions sont relues ; une exécution coupée par la fermeture est « interrompue »', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-history-'));
    const file = path.join(tmp, 'runs.json');
    let child;
    const deps = (history) => ({
      isEnabled: () => true,
      getProject: () => ({ id: 'p1', name: 'demo', root: '/tmp/demo' }),
      confirm: async () => 'once',
      emit: () => undefined,
      checkAuth: async () => ({ state: 'ok' }),
      listFiles: async () => [],
      spawnImpl: () => (child = fakeChild()),
      history,
    });
    const first = createHarnessRunner(deps(createRunHistory(file)));
    const req = { requestId: 'call_1', userId: 'u1', agentId: 'a1', projectId: 'p1', harness: 'claude-code', prompt: 'x', conversationId: 'c'.repeat(24) };
    const done = first.start(req);
    await new Promise((r) => setImmediate(r));
    child.feed({ type: 'result', result: 'Fait.', is_error: false, session_id: 's-1' });
    child.end(0);
    await done;
    // Deuxième exécution laissée en cours : on fige le fichier tel qu'à une fermeture brutale de l'app.
    const pending = first.start({ ...req, requestId: 'call_2' });
    await new Promise((r) => setTimeout(r, 400));
    const snapshot = fs.readFileSync(file, 'utf8');
    first.stop(first.list().find((r) => r.status === 'running').runId);
    await pending;
    fs.writeFileSync(file, snapshot);
    const saved = JSON.parse(snapshot);
    assert.equal(saved.runs.length, 2);
    assert.ok(saved.runs.every((r) => !('child' in r)));

    const second = createHarnessRunner(deps(createRunHistory(file)));
    const runs = second.list();
    assert.equal(runs.length, 2);
    assert.equal(runs[0].status, 'done');
    assert.equal(runs[0].conversationId, 'c'.repeat(24));
    assert.equal(runs[1].status, 'error');
    assert.match(runs[1].result.summary, /interrompu/);
    // Une suite reste possible sur une exécution relue.
    const next = second.followUp(runs[0].runId, 'Encore');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    child.end(0);
    await next;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('harnais de code : autorisations remontées dans le chat (Claude Code)', () => {
  let tmp;
  let root;
  let permissions;
  let asked;
  let answer;
  let grants;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lasco-perm-'));
    root = fs.realpathSync(tmp);
    asked = [];
    answer = 'once';
    grants = [];
    permissions = createHarnessPermissions({
      confirm: async (req) => {
        asked.push(req);
        return typeof answer === 'function' ? answer(req) : answer;
      },
      buildPlan: (request) => buildShellPlan(fs.promises, request, { homeDir: os.homedir() }),
      findShellGrant: (ctx, plan) =>
        grants.find((g) => g.userId === ctx.userId && g.agentId === ctx.agentId && shellGrantCovers(g, plan)) || null,
      addShellGrant: (g) => grants.push({ operation: 'shell.run', userId: g.userId, agentId: g.agentId, commandPrefix: g.commandPrefix, cwdRoots: g.cwdRoots }),
      confirmTimeoutMs: 5000,
    });
  });

  afterEach(() => {
    permissions.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const runCtx = () => ({
    requestId: 'call_1',
    userId: 'u1',
    agentId: 'a1',
    agentName: 'Dev',
    harness: 'claude-code',
    harnessLabel: 'Claude Code',
    projectName: 'demo',
    root,
  });
  const relayOf = (prepared) => JSON.parse(prepared.mcpConfig).mcpServers.lasco_desktop.env;
  const askVia = (prepared, toolName, input) => {
    const env = relayOf(prepared);
    return askDesktop({
      socketPath: env.LASCO_HARNESS_PERMISSION_SOCKET,
      token: env.LASCO_HARNESS_PERMISSION_TOKEN,
      request: { toolName, input },
      timeoutMs: 5000,
    });
  };

  it('serveur MCP : initialise, liste l’outil, relaie l’appel et renvoie la décision en texte JSON', async () => {
    const init = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, null);
    assert.equal(init.result.protocolVersion, '2025-06-18');
    const list = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, null);
    assert.equal(list.result.tools[0].name, 'approve');
    assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, null), null);
    const call = await handleMessage(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'npm i' } } } },
      async (req) => ({ behavior: 'allow', updatedInput: req.input }),
    );
    assert.deepEqual(JSON.parse(call.result.content[0].text), { behavior: 'allow', updatedInput: { command: 'npm i' } });
  });

  it('commande : carte dans le chat, « Exécuter une fois » autorise avec l’entrée inchangée', async () => {
    const prepared = await permissions.prepare(runCtx());
    assert.equal(prepared.toolName, 'mcp__lasco_desktop__approve');
    const reply = await askVia(prepared, 'Bash', { command: 'npx create-next-app@latest demo --yes', description: 'Crée le projet' });
    assert.deepEqual(reply, { behavior: 'allow', updatedInput: { command: 'npx create-next-app@latest demo --yes', description: 'Crée le projet' } });
    assert.equal(asked.length, 1);
    assert.equal(asked[0].operation, 'code.harness_command');
    assert.equal(asked[0].cwd, undefined);
    assert.equal(asked[0].projectRoot, root);
    assert.deepEqual(asked[0].scope.commandPrefix, ['npx']);
    const dialog = buildConfirmDialog(asked[0]);
    assert.equal(dialog.title, 'Claude Code demande à exécuter une commande');
    assert.match(dialog.message, /npx create-next-app@latest demo --yes/);
    assert.deepEqual(dialog.decisions, ['deny', 'once', 'always']);
    prepared.dispose();
  });

  it('« Toujours autoriser » : règle shell.run du projet, la commande suivante passe sans carte', async () => {
    answer = 'always';
    const prepared = await permissions.prepare(runCtx());
    assert.equal((await askVia(prepared, 'Bash', { command: 'npm install' })).behavior, 'allow');
    assert.deepEqual(grants[0].commandPrefix, ['npm', 'install']);
    assert.deepEqual(grants[0].cwdRoots, [root]);
    answer = 'deny';
    assert.equal((await askVia(prepared, 'Bash', { command: 'npm install next' })).behavior, 'allow');
    assert.equal(asked.length, 1);
    // Commande composée : jamais couverte par une règle, toujours demandée.
    const composed = await askVia(prepared, 'Bash', { command: 'npm install && rm -rf /' });
    assert.equal(composed.behavior, 'deny');
    assert.equal(asked.length, 2);
    assert.equal(asked[1].allowPersistent, false);
    prepared.dispose();
  });

  it('refus, autre outil, jeton inconnu, exécution terminée : refusé', async () => {
    answer = 'deny';
    const prepared = await permissions.prepare(runCtx());
    const denied = await askVia(prepared, 'Bash', { command: 'npm run dev' });
    assert.equal(denied.behavior, 'deny');
    assert.match(denied.message, /Refusé/);
    answer = 'once';
    assert.equal((await askVia(prepared, 'WebFetch', { url: 'https://nextjs.org/docs' })).behavior, 'allow');
    const toolReq = asked[asked.length - 1];
    assert.equal(toolReq.operation, 'code.harness_tool');
    assert.deepEqual(buildConfirmDialog(toolReq).decisions, ['deny', 'once']);
    const env = relayOf(prepared);
    const forged = await askDesktop({ socketPath: env.LASCO_HARNESS_PERMISSION_SOCKET, token: 'x', request: { toolName: 'Bash', input: { command: 'ls' } }, timeoutMs: 5000 });
    assert.equal(forged.behavior, 'deny');
    prepared.dispose();
    const after = await askVia(prepared, 'Bash', { command: 'ls' });
    assert.equal(after.behavior, 'deny');
  });

  it('fin d’exécution pendant une carte ouverte : la demande est refusée', async () => {
    let release;
    answer = (req) =>
      new Promise((resolve) => {
        release = resolve;
        req.signal.addEventListener('abort', () => resolve('deny'));
      });
    const prepared = await permissions.prepare(runCtx());
    const pending = askVia(prepared, 'Bash', { command: 'npm run dev' });
    while (!release) await new Promise((r) => setTimeout(r, 5));
    prepared.dispose();
    assert.equal((await pending).behavior, 'deny');
  });
});

describe('harnais de code : commande sous Windows', () => {
  /** Faux disque : chemins Windows → contenu (fichier) ou liste (dossier). */
  function fakeFs(tree) {
    const norm = (p) => p.toLowerCase();
    const files = new Map(Object.entries(tree).map(([k, v]) => [norm(k), v]));
    return {
      statSync(p) {
        const v = files.get(norm(p));
        if (v === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return { isFile: () => typeof v === 'string' };
      },
      readFileSync(p) {
        const v = files.get(norm(p));
        if (typeof v !== 'string') throw new Error('ENOENT');
        return v;
      },
      readdirSync(p) {
        const v = files.get(norm(p));
        if (!Array.isArray(v)) throw new Error('ENOENT');
        return v;
      },
    };
  }
  const env = { Path: 'C:\\Windows\\System32;C:\\Users\\r\\AppData\\Roaming\\npm', LOCALAPPDATA: 'C:\\Users\\r\\AppData\\Local', APPDATA: 'C:\\Users\\r\\AppData\\Roaming', USERPROFILE: 'C:\\Users\\r' };

  it('hors Windows : le nom du binaire', () => {
    assert.deepEqual(resolveHarnessCommand('cursor-agent', { platform: 'darwin' }), { command: 'cursor-agent', prefixArgs: [] });
  });

  it('.exe trouvé dans le PATH (clé Path) : lancé tel quel', () => {
    const fs = fakeFs({ 'C:\\Users\\r\\.local\\bin\\claude.exe': 'MZ' });
    assert.deepEqual(resolveHarnessCommand('claude', { platform: 'win32', env, fs }), { command: 'C:\\Users\\r\\.local\\bin\\claude.exe', prefixArgs: [] });
  });

  it('raccourci npm (codex.cmd) : node + script JS, sans cmd.exe', () => {
    const shim = [
      '@ECHO off',
      'GOTO start',
      ':find_dp0',
      'SET dp0=%~dp0',
      'EXIT /b',
      ':start',
      'SETLOCAL',
      'CALL :find_dp0',
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ') ELSE (',
      '  SET "_prog=node"',
      ')',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
    ].join('\r\n');
    const fs = fakeFs({
      'C:\\Users\\r\\AppData\\Roaming\\npm\\codex.cmd': shim,
      'C:\\Program Files\\nodejs\\node.exe': 'MZ',
    });
    const res = resolveHarnessCommand('codex', { platform: 'win32', env: { ...env, Path: `${env.Path};C:\\Program Files\\nodejs` }, fs });
    assert.deepEqual(res, {
      command: 'C:\\Program Files\\nodejs\\node.exe',
      prefixArgs: ['C:\\Users\\r\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'],
    });
  });

  it('Cursor installé après le lancement de Desktop (hors PATH) : node.exe + index.js de la version la plus récente', () => {
    const root = 'C:\\Users\\r\\AppData\\Local\\cursor-agent';
    const fs = fakeFs({
      [`${root}\\cursor-agent.cmd`]: '@echo off\r\nsetlocal\r\ncall "%~dp0versions\\%CURSOR_V%\\cursor-agent.cmd" %*',
      [`${root}\\versions`]: ['2026.08.11-e8db854', '2026.11.05-86047df', '2026.11.06-aaaa.staged'],
      [`${root}\\versions\\2026.08.11-e8db854\\node.exe`]: 'MZ',
      [`${root}\\versions\\2026.08.11-e8db854\\index.js`]: '',
      [`${root}\\versions\\2026.11.05-86047df\\node.exe`]: 'MZ',
      [`${root}\\versions\\2026.11.05-86047df\\index.js`]: '',
    });
    assert.deepEqual(resolveHarnessCommand('cursor-agent', { platform: 'win32', env, fs }), {
      command: `${root}\\versions\\2026.11.05-86047df\\node.exe`,
      prefixArgs: [`${root}\\versions\\2026.11.05-86047df\\index.js`],
    });
  });

  it('.exe préféré au .cmd ; script inconnu refusé ; absent = not_installed', () => {
    const root = 'C:\\Users\\r\\AppData\\Local\\cursor-agent';
    const both = fakeFs({ [`${root}\\cursor-agent.exe`]: 'MZ', [`${root}\\cursor-agent.cmd`]: '' });
    assert.equal(resolveHarnessCommand('cursor-agent', { platform: 'win32', env, fs: both }).command, `${root}\\cursor-agent.exe`);
    const unknown = fakeFs({ 'C:\\Windows\\System32\\vibe.cmd': '@echo off\r\npython -m vibe %*' });
    assert.equal(resolveHarnessCommand('vibe', { platform: 'win32', env, fs: unknown }).error, 'unsupported_shim');
    assert.deepEqual(resolveHarnessCommand('vibe', { platform: 'win32', env, fs: fakeFs({}) }), { error: 'not_installed' });
  });
});
