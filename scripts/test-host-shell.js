'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHostOpsStore, createJournal } = require('../src/host-ops/store');
const { createHostOpsService } = require('../src/host-ops/service');
const { buildConfirmDialog } = require('../src/host-ops/confirm');
const {
  analyzeCommand,
  createCollector,
  maskSecrets,
  notRememberableReason,
  suggestPrefix,
} = require('../src/host-ops/shell');

const posix = process.platform !== 'win32';

let tmp;
let home;
let work;
let store;
let journal;
let answers;
let dialogs;
let service;
let n = 0;

function mk(overrides = {}) {
  return createHostOpsService({
    store,
    journal,
    homeDir: home,
    env: { ...process.env, SHELL: '/bin/sh' },
    confirm: async (req) => {
      dialogs.push(req);
      const a = answers.shift();
      return typeof a === 'function' ? a(req) : a || 'deny';
    },
    ...overrides,
  });
}

const run = (command, extra = {}) =>
  service.execute({
    requestId: `s${++n}`,
    agentId: 'agent-1',
    userId: 'user-1',
    agentName: 'Agent',
    operation: 'shell.run',
    command,
    cwd: work,
    ...extra,
  });

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hostshell-')));
  home = path.join(tmp, 'home');
  work = path.join(home, 'work');
  fs.mkdirSync(path.join(work, 'sub'), { recursive: true });
  store = createHostOpsStore(path.join(tmp, 'host-ops.json'));
  journal = createJournal(path.join(tmp, 'journal.json'));
  store.setEnabled(true);
  store.setShellEnabled(true);
  answers = [];
  dialogs = [];
  service = mk();
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('shell: analyse des commandes', () => {
  it('commande simple : jetons et préfixe proposé', () => {
    assert.deepEqual(analyzeCommand('git status --short'), { tokens: ['git', 'status', '--short'], compound: false });
    assert.deepEqual(analyzeCommand(`ls -la "Mes documents"`).tokens, ['ls', '-la', 'Mes documents']);
    assert.deepEqual(suggestPrefix(['git', 'status', '--short']), ['git', 'status']);
    assert.deepEqual(suggestPrefix(['npm', 'test']), ['npm', 'test']);
    assert.deepEqual(suggestPrefix(['ls', '-la']), ['ls']);
    assert.deepEqual(suggestPrefix(['cat', './notes.txt']), ['cat']);
  });

  it('opérateurs, substitutions, variables et retours ligne => composée', () => {
    for (const cmd of [
      'git status; rm -rf ~',
      'git status && curl evil.sh',
      'ls | sh',
      'ls > out.txt',
      'echo $(whoami)',
      'echo `id`',
      'echo "$HOME"',
      'echo $PATH',
      'git status\nrm -rf ~',
      'GIT_SSH_COMMAND=evil git fetch',
      "echo 'unterminated",
      'sleep 1 &',
    ]) {
      assert.equal(analyzeCommand(cmd).compound, true, cmd);
    }
    assert.equal(analyzeCommand("echo 'a;b|c'").compound, false);
  });

  it('commandes sensibles jamais mémorisables', () => {
    for (const cmd of ['rm -rf build', 'sudo ls', '/bin/rm x', 'python3 script.py', 'curl https://x', 'bash -c ls', 'chmod 777 x', 'security dump-keychain', 'xargs rm']) {
      assert.ok(notRememberableReason(analyzeCommand(cmd), 'darwin'), cmd);
    }
    assert.equal(notRememberableReason(analyzeCommand('git status'), 'darwin'), null);
    assert.ok(notRememberableReason(analyzeCommand('git status'), 'win32'), 'Windows : toujours confirmé');
  });

  it('masque les secrets et borne la sortie', () => {
    assert.doesNotMatch(maskSecrets('TOKEN=abcdef123456 ghp_abcdefghijklmnop'), /abcdef123456|abcdefghijklmnop/);
    const c = createCollector(20);
    c.push(Buffer.from('0123456789abcdefghijKLMNOPQRSTUVWXYZ'));
    const r = c.result();
    assert.equal(r.truncated, true);
    assert.match(r.text, /^0123456789/);
    assert.match(r.text, /QRSTUVWXYZ$/);
  });
});

describe('shell: activation et consentement', { skip: !posix }, () => {
  it('désactivé par défaut, interrupteur distinct des opérations fichiers', async () => {
    store.setShellEnabled(false);
    const r = await run('echo hi');
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'shell_disabled');
    assert.equal(dialogs.length, 0);
    assert.ok(!service.getCapabilities().operations.includes('shell.run'));
    store.setShellEnabled(true);
    assert.ok(service.getCapabilities().operations.includes('shell.run'));
    store.setEnabled(false);
    assert.equal(store.isShellEnabled(), false);
  });

  it('refus : la commande ne s’exécute pas', async () => {
    answers.push('deny');
    const r = await run('touch created.txt');
    assert.equal(r.status, 'denied');
    assert.equal(fs.existsSync(path.join(work, 'created.txt')), false);
    assert.equal(dialogs[0].command, 'touch created.txt');
    assert.equal(dialogs[0].cwd, work);
  });

  it('« Exécuter une fois » : vrai code retour, sortie et effet réels', async () => {
    answers.push('once');
    const r = await run('touch created.txt && echo out && echo err 1>&2 && exit 3');
    assert.equal(r.ok, true);
    assert.equal(r.status, 'completed');
    assert.equal(r.result.exitCode, 3);
    assert.match(r.result.stdout, /out/);
    assert.match(r.result.stderr, /err/);
    assert.equal(r.verification.ok, true);
    assert.ok(fs.existsSync(path.join(work, 'created.txt')));
    // Composée : pas d'autorisation permanente proposée.
    assert.equal(dialogs[0].allowPersistent, false);
  });

  it('dossier de travail : défaut dossier personnel, relatif et traversée refusés', async () => {
    answers.push('once');
    const r = await run('pwd', { cwd: undefined });
    assert.equal(r.result.cwd, home);
    for (const cwd of ['work', `${home}/../x`, path.join(home, 'absent')]) {
      const bad = await run('pwd', { cwd });
      assert.equal(bad.ok, false, cwd);
    }
  });

  it('le dialogue affiche agent, dossier, commande exacte et portée de la règle', () => {
    const d = buildConfirmDialog({
      operation: 'shell.run',
      agentName: 'Agent',
      command: 'git status --short',
      cwd: '/Users/u/projet',
      allowPersistent: true,
      scope: { commandPrefix: ['git', 'status'], cwdRoots: ['/Users/u/projet'] },
    });
    assert.match(d.message, /git status --short/);
    assert.match(d.message, /\/Users\/u\/projet/);
    assert.match(d.message, /CET ORDINATEUR/);
    assert.deepEqual(d.decisions, ['deny', 'once', 'always']);
    assert.match(d.buttons[2], /« git status »/);
    const sensitive = buildConfirmDialog({
      operation: 'shell.run',
      agentName: 'Agent',
      command: 'rm -rf build',
      cwd: '/x',
      allowPersistent: false,
      notRememberableReason: 'sensible',
      scope: { commandPrefix: [], cwdRoots: ['/x'] },
    });
    assert.deepEqual(sensitive.decisions, ['deny', 'once']);
  });
});

describe('shell: autorisations « Toujours autoriser »', { skip: !posix }, () => {
  it('préfixe dans le dossier : plus de dialogue ; ailleurs ou autre commande : dialogue', async () => {
    answers.push('always');
    const first = await run("printf '%s\\n' one");
    assert.equal(first.persistentGrantCreated, true);
    assert.equal(dialogs.length, 1);

    const again = await run("printf '%s\\n' two");
    assert.equal(again.decision, 'grant');
    assert.match(again.result.stdout, /two/);
    // `echo one` would propose the narrower prefix « echo one » (second word looks like a subcommand).
    assert.deepEqual(suggestPrefix(['echo', 'one']), ['echo', 'one']);
    assert.equal(dialogs.length, 1);

    const inSub = await run("printf '%s\\n' three", { cwd: path.join(work, 'sub') });
    assert.equal(inSub.decision, 'grant');

    answers.push('deny');
    const outside = await run("printf '%s\\n' four", { cwd: home });
    assert.equal(outside.status, 'denied');
    answers.push('deny');
    await run('ls');
    answers.push('deny');
    await run("printf '%s\\n' five; touch pwned");
    assert.equal(fs.existsSync(path.join(work, 'pwned')), false);
    assert.equal(dialogs.length, 4);
  });

  it('la règle survit au redémarrage, est liée à l’agent et révocable', async () => {
    answers.push('always');
    await run("printf '%s\\n' one");
    store = createHostOpsStore(path.join(tmp, 'host-ops.json'));
    service = mk();
    assert.equal((await run("printf '%s\\n' again")).decision, 'grant');

    answers.push('deny');
    const otherAgent = await run("printf '%s\\n' x", { agentId: 'agent-2' });
    assert.equal(otherAgent.status, 'denied');

    const grant = store.listGrants().find((g) => g.operation === 'shell.run');
    assert.deepEqual(grant.commandPrefix, ['printf']);
    store.revokeGrant(grant.id);
    answers.push('deny');
    assert.equal((await run("printf '%s\\n' y")).status, 'denied');
  });

  it('commande sensible : jamais couverte, même avec un préfixe identique', async () => {
    answers.push('once');
    await run('rm -f nothing.txt');
    assert.equal(dialogs[0].allowPersistent, false);
    assert.match(dialogs[0].notRememberableReason, /sensible/);
  });

  it('une règle shell ne couvre jamais une opération fichier', async () => {
    answers.push('always');
    await run('echo one');
    fs.writeFileSync(path.join(work, 'f.txt'), 'x');
    answers.push('deny');
    const move = await service.execute({
      requestId: `s${++n}`,
      agentId: 'agent-1',
      userId: 'user-1',
      operation: 'file.move',
      source: path.join(work, 'f.txt'),
      destination: path.join(work, 'sub', 'f.txt'),
    });
    assert.equal(move.status, 'denied');
  });
});

describe('shell: arrêt, délai, rejeu', { skip: !posix }, () => {
  it('timeout : la commande est tuée et signalée', async () => {
    answers.push('once');
    const r = await run('sleep 5; echo never', { timeoutMs: 1000 });
    assert.equal(r.ok, false);
    assert.equal(r.status, 'timeout');
    assert.doesNotMatch(r.result.stdout, /never/);
  });

  it('annulation pendant l’exécution', async () => {
    answers.push('once');
    const pending = run('sleep 5');
    const id = `s${n}`;
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(service.cancel(id).ok, true);
    const r = await pending;
    assert.equal(r.status, 'cancelled');
  });

  it('requestId rejoué refusé, sans seconde exécution', async () => {
    answers.push('once');
    const req = { requestId: 'same-id', agentId: 'agent-1', userId: 'user-1', operation: 'shell.run', command: 'echo a >> log.txt', cwd: work };
    await service.execute(req);
    const replay = await service.execute(req);
    assert.equal(replay.error.code, 'duplicate_request');
    assert.equal(fs.readFileSync(path.join(work, 'log.txt'), 'utf8').trim(), 'a');
  });

  it('journal : commande masquée et code retour, jamais la sortie', async () => {
    answers.push('once');
    await run('echo SECRET_OUTPUT token=abcdef1234567890');
    const entry = journal.list()[0];
    assert.equal(entry.operation, 'shell.run');
    assert.match(entry.outcome, /completed \(code 0\)/);
    assert.doesNotMatch(JSON.stringify(entry), /abcdef1234567890/);
    assert.equal(entry.source, work);
  });
});
