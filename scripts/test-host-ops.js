'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHostOpsStore, createJournal } = require('../src/host-ops/store');
const { createHostOpsService } = require('../src/host-ops/service');
const { isTrustedHostOpsSender } = require('../src/host-ops/trust');
const { buildConfirmDialog } = require('../src/host-ops/confirm');
const { assertPlainAbsolutePath, isWithin } = require('../src/host-ops/paths');

let tmp;
let home;
let work;
let store;
let journal;
let answers;
let dialogs;
let service;

function mk(overrides = {}) {
  return createHostOpsService({
    store,
    journal,
    homeDir: home,
    confirm: async (req) => {
      dialogs.push(req);
      const a = answers.shift();
      return typeof a === 'function' ? a(req) : a || 'deny';
    },
    ...overrides,
  });
}

let n = 0;
const req = (extra) => ({ requestId: `r${++n}`, agentId: 'agent-1', userId: 'user-1', agentName: 'Agent', ...extra });

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hostops-')));
  home = path.join(tmp, 'home');
  work = path.join(home, 'work');
  fs.mkdirSync(path.join(work, 'a'), { recursive: true });
  fs.mkdirSync(path.join(work, 'b'), { recursive: true });
  store = createHostOpsStore(path.join(tmp, 'host-ops.json'));
  journal = createJournal(path.join(tmp, 'journal.json'));
  store.setEnabled(true);
  answers = [];
  dialogs = [];
  service = mk();
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const write = (p, c = 'hello') => fs.writeFileSync(p, c);

describe('host-ops: activation & sender', () => {
  it('refuse tout quand la capacité est désactivée (pas de repli)', async () => {
    store.setEnabled(false);
    write(path.join(work, 'a/f.txt'));
    const r = await service.execute(req({ operation: 'file.move', source: path.join(work, 'a/f.txt'), destination: path.join(work, 'b/f.txt') }));
    assert.equal(r.error.code, 'disabled');
    assert.ok(fs.existsSync(path.join(work, 'a/f.txt')));
    assert.equal(dialogs.length, 0);
  });
  it('accepte uniquement la frame principale de la fenêtre principale à l’origine exacte', () => {
    const base = { isMainWindow: true, isMainFrame: true, frameUrl: 'https://app.lascoapp.com/x', allowedOrigins: ['https://app.lascoapp.com'] };
    assert.equal(isTrustedHostOpsSender(base), true);
    assert.equal(isTrustedHostOpsSender({ ...base, frameUrl: 'https://evil.lascoapp.com/' }), false);
    assert.equal(isTrustedHostOpsSender({ ...base, frameUrl: 'https://app.lascoapp.com.evil.io/' }), false);
    assert.equal(isTrustedHostOpsSender({ ...base, isMainFrame: false }), false);
    assert.equal(isTrustedHostOpsSender({ ...base, isMainWindow: false }), false);
    assert.equal(isTrustedHostOpsSender({ ...base, frameUrl: 'file:///x' }), false);
  });
  it('capacités : portée hôte et 4 opérations', () => {
    const c = service.getCapabilities();
    assert.deepEqual(c.operations, ['file.move', 'file.copy', 'file.rename', 'folder.create']);
    assert.equal(c.scope, 'host');
  });
});

describe('host-ops: opérations avec consentement', () => {
  it('déplace réellement un fichier après « Autoriser une fois » et le prouve', async () => {
    const src = path.join(work, 'a/f.txt');
    const dst = path.join(work, 'b/f.txt');
    write(src);
    answers = ['once'];
    const r = await service.execute(req({ operation: 'file.move', source: src, destination: dst }));
    assert.equal(r.ok, true);
    assert.equal(r.status, 'completed');
    assert.equal(r.verification.destinationExists, true);
    assert.equal(r.verification.sourceAbsent, true);
    assert.equal(fs.readFileSync(dst, 'utf8'), 'hello');
    assert.ok(!fs.existsSync(src));
    assert.equal(store.listGrants().length, 0);
  });
  it('refus : rien ne change', async () => {
    const src = path.join(work, 'a/f.txt');
    write(src);
    answers = ['deny'];
    const r = await service.execute(req({ operation: 'file.move', source: src, destination: path.join(work, 'b/f.txt') }));
    assert.equal(r.status, 'denied');
    assert.ok(fs.existsSync(src));
    assert.ok(!fs.existsSync(path.join(work, 'b/f.txt')));
  });
  it('copie, renomme et crée un dossier', async () => {
    const src = path.join(work, 'a/f.txt');
    write(src);
    answers = ['once', 'once', 'once'];
    let r = await service.execute(req({ operation: 'file.copy', source: src, destination: path.join(work, 'b/c.txt') }));
    assert.equal(r.ok, true);
    assert.ok(fs.existsSync(src));
    r = await service.execute(req({ operation: 'file.rename', source: src, newName: 'g.txt' }));
    assert.equal(r.ok, true);
    assert.ok(fs.existsSync(path.join(work, 'a/g.txt')) && !fs.existsSync(src));
    r = await service.execute(req({ operation: 'folder.create', destination: path.join(work, 'new') }));
    assert.equal(r.verification.destinationIsDirectory, true);
    assert.equal(fs.readdirSync(work).filter((f) => f.startsWith('.lasco-tmp')).length, 0);
  });
  it('le dialogue présente agent, opération, chemins et effet', () => {
    const d = buildConfirmDialog({ agentName: 'Mon agent', operation: 'file.move', source: '/s/a', destination: '/d/a', overwrite: false, allowPersistent: true, scope: { sourceRoots: ['/s'], destinationRoots: ['/d'] } });
    assert.deepEqual(d.buttons, ['Refuser', 'Autoriser une fois', 'Toujours autoriser ce type d’opération']);
    assert.match(d.message, /Mon agent/);
    assert.match(d.message, /\/s\/a/);
    assert.match(d.message, /déplacé/);
    const o = buildConfirmDialog({ agentName: 'A', operation: 'file.copy', source: '/s', destination: '/d', overwrite: true, allowPersistent: true, scope: {} });
    assert.equal(o.decisions.includes('always'), false);
  });
});

describe('host-ops: conflits et écrasement', () => {
  it('refuse sans écrasement explicite et ne demande pas de confirmation', async () => {
    const src = path.join(work, 'a/f.txt');
    const dst = path.join(work, 'b/f.txt');
    write(src, 'new');
    write(dst, 'old');
    const r = await service.execute(req({ operation: 'file.move', source: src, destination: dst }));
    assert.equal(r.error.code, 'destination_exists');
    assert.equal(fs.readFileSync(dst, 'utf8'), 'old');
    assert.ok(fs.existsSync(src));
  });
  it('écrasement : confirmation spécifique à chaque fois, jamais couvert par une règle', async () => {
    const src = path.join(work, 'a/f.txt');
    const dst = path.join(work, 'b/f.txt');
    write(src, 'new');
    answers = ['always']; // règle créée sur une opération sans conflit
    let r = await service.execute(req({ operation: 'file.copy', source: src, destination: path.join(work, 'b/other.txt') }));
    assert.equal(r.ok, true);
    assert.equal(store.listGrants().length, 1);
    write(dst, 'old');
    answers = ['deny'];
    r = await service.execute(req({ operation: 'file.copy', source: src, destination: dst, overwrite: true }));
    assert.equal(dialogs.at(-1).overwrite, true);
    assert.equal(dialogs.at(-1).allowPersistent, false);
    assert.equal(r.status, 'denied');
    assert.equal(fs.readFileSync(dst, 'utf8'), 'old');
    answers = ['once'];
    r = await service.execute(req({ operation: 'file.copy', source: src, destination: dst, overwrite: true }));
    assert.equal(r.ok, true);
    assert.equal(fs.readFileSync(dst, 'utf8'), 'new');
  });
  it('un dossier existant est refusé', async () => {
    const r = await service.execute(req({ operation: 'folder.create', destination: path.join(work, 'a') }));
    assert.equal(r.error.code, 'destination_exists');
  });
});

describe('host-ops: validation des chemins', () => {
  it('rejette relatif, traversée, NUL, symlink source et symlink destination', async () => {
    assert.throws(() => assertPlainAbsolutePath('rel/x', 'p'), { code: 'path_not_absolute' });
    assert.throws(() => assertPlainAbsolutePath('/a/../b', 'p'), { code: 'path_traversal' });
    assert.throws(() => assertPlainAbsolutePath('/a\0b', 'p'), { code: 'invalid_path' });
    const src = path.join(work, 'a/f.txt');
    write(src);
    const outside = path.join(tmp, 'secret.txt');
    write(outside, 's');
    fs.symlinkSync(outside, path.join(work, 'a/link.txt'));
    let r = await service.execute(req({ operation: 'file.move', source: path.join(work, 'a/link.txt'), destination: path.join(work, 'b/x') }));
    assert.equal(r.error.code, 'symlink_rejected');
    fs.symlinkSync(outside, path.join(work, 'b/dlink'));
    r = await service.execute(req({ operation: 'file.copy', source: src, destination: path.join(work, 'b/dlink'), overwrite: true }));
    assert.equal(r.error.code, 'symlink_rejected');
    assert.equal(fs.readFileSync(outside, 'utf8'), 's');
    r = await service.execute(req({ operation: 'file.move', source: `${work}/a/../a/f.txt`, destination: path.join(work, 'b/x') }));
    assert.equal(r.error.code, 'path_traversal');
    r = await service.execute(req({ operation: 'file.rename', source: src, newName: '../evil' }));
    assert.equal(r.error.code, 'invalid_name');
    assert.equal(dialogs.length, 0);
  });
  it('un dossier parent symlinké est résolu : la confirmation montre le chemin réel', async () => {
    const src = path.join(work, 'a/f.txt');
    write(src);
    fs.symlinkSync(path.join(work, 'b'), path.join(work, 'viaLink'));
    answers = ['once'];
    const r = await service.execute(req({ operation: 'file.copy', source: src, destination: path.join(work, 'viaLink/f.txt') }));
    assert.equal(r.ok, true);
    assert.equal(dialogs[0].destination, path.join(work, 'b/f.txt'));
  });
  it('contenance réelle (préfixes frères non confondus)', () => {
    assert.equal(isWithin('/h/work', '/h/work/a'), true);
    assert.equal(isWithin('/h/work', '/h/work2'), false);
    assert.equal(isWithin('/h/work', '/h'), false);
  });
  it('TOCTOU : chemin remplacé par un symlink pendant la confirmation => annulé', async () => {
    const src = path.join(work, 'a/f.txt');
    write(src);
    const outside = path.join(tmp, 'secret.txt');
    write(outside, 's');
    answers = [() => {
      fs.rmSync(src);
      fs.symlinkSync(outside, src);
      return 'once';
    }];
    const r = await service.execute(req({ operation: 'file.move', source: src, destination: path.join(work, 'b/f.txt') }));
    assert.equal(r.ok, false);
    assert.ok(!fs.existsSync(path.join(work, 'b/f.txt')));
    assert.equal(fs.readFileSync(outside, 'utf8'), 's');
  });
  it('TOCTOU : destination apparue pendant la confirmation => aucun écrasement', async () => {
    const src = path.join(work, 'a/f.txt');
    const dst = path.join(work, 'b/f.txt');
    write(src, 'new');
    answers = [() => {
      write(dst, 'intrus');
      return 'once';
    }];
    const r = await service.execute(req({ operation: 'file.move', source: src, destination: dst }));
    assert.equal(r.ok, false);
    assert.equal(fs.readFileSync(dst, 'utf8'), 'intrus');
    assert.ok(fs.existsSync(src));
  });
});

describe('host-ops: autorisations persistantes', () => {
  it('« Toujours autoriser » : s’applique dans le périmètre, survit au redémarrage, bornée', async () => {
    const src = path.join(work, 'a/f.txt');
    write(src);
    write(path.join(work, 'a/g.txt'));
    answers = ['always'];
    let r = await service.execute(req({ operation: 'file.copy', source: src, destination: path.join(work, 'b/f.txt') }));
    assert.equal(r.persistentGrantCreated, true);
    // redémarrage : nouveau store + service
    store = createHostOpsStore(path.join(tmp, 'host-ops.json'));
    service = mk();
    dialogs = [];
    r = await service.execute(req({ operation: 'file.copy', source: path.join(work, 'a/g.txt'), destination: path.join(work, 'b/g.txt') }));
    assert.equal(r.ok, true);
    assert.equal(r.decision, 'grant');
    assert.equal(dialogs.length, 0);
    // hors périmètre : dialogue requis
    fs.mkdirSync(path.join(work, 'c'));
    write(path.join(work, 'c/h.txt'));
    answers = ['deny'];
    r = await service.execute(req({ operation: 'file.copy', source: path.join(work, 'c/h.txt'), destination: path.join(work, 'b/h.txt') }));
    assert.equal(dialogs.length, 1);
    assert.equal(r.status, 'denied');
    // autre opération : dialogue requis
    answers = ['deny'];
    await service.execute(req({ operation: 'file.move', source: path.join(work, 'a/g.txt'), destination: path.join(work, 'b/g2.txt') }));
    assert.equal(dialogs.length, 2);
  });
  it('mauvais agent / utilisateur / appareil : la règle ne s’applique pas ou la requête est rejetée', async () => {
    const src = path.join(work, 'a/f.txt');
    write(src);
    answers = ['always'];
    await service.execute(req({ operation: 'file.copy', source: src, destination: path.join(work, 'b/f.txt') }));
    for (const who of [{ agentId: 'agent-2' }, { userId: 'user-2' }]) {
      answers = ['deny'];
      dialogs = [];
      const r = await service.execute(req({ operation: 'file.copy', source: src, destination: path.join(work, 'b/z.txt'), ...who }));
      assert.equal(dialogs.length, 1);
      assert.equal(r.status, 'denied');
    }
    const r = await service.execute(req({ operation: 'file.copy', source: src, destination: path.join(work, 'b/z.txt'), deviceId: 'other-device' }));
    assert.equal(r.error.code, 'wrong_device');
    assert.ok(!fs.existsSync(path.join(work, 'b/z.txt')));
  });
  it('révocation immédiatement effective', async () => {
    const src = path.join(work, 'a/f.txt');
    write(src);
    answers = ['always'];
    await service.execute(req({ operation: 'file.copy', source: src, destination: path.join(work, 'b/f.txt') }));
    store.revokeGrant(store.listGrants()[0].id);
    answers = ['deny'];
    dialogs = [];
    const r = await service.execute(req({ operation: 'file.copy', source: src, destination: path.join(work, 'b/f2.txt') }));
    assert.equal(dialogs.length, 1);
    assert.equal(r.status, 'denied');
  });
  it('périmètre trop large (home, racine) : pas de règle persistante proposée', async () => {
    write(path.join(home, 'f.txt'));
    answers = ['always'];
    const r = await service.execute(req({ operation: 'file.copy', source: path.join(home, 'f.txt'), destination: path.join(work, 'b/f.txt') }));
    assert.equal(dialogs[0].allowPersistent, false);
    assert.equal(r.ok, true);
    assert.equal(store.listGrants().length, 0);
  });
});

describe('host-ops: annulation, timeout, concurrence', () => {
  it('annulation pendant la confirmation : rien ne change', async () => {
    const src = path.join(work, 'a/f.txt');
    write(src);
    const id = 'cancel-1';
    answers = [(r) => new Promise((resolve) => r.signal.addEventListener('abort', () => resolve('once')))];
    const p = service.execute({ ...req({ operation: 'file.move', source: src, destination: path.join(work, 'b/f.txt') }), requestId: id });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(service.cancel(id).ok, true);
    const r = await p;
    assert.equal(r.status, 'cancelled');
    assert.ok(fs.existsSync(src));
  });
  it('timeout de confirmation : rien ne change', async () => {
    const src = path.join(work, 'a/f.txt');
    write(src);
    service = mk({ confirmTimeoutMs: 30 });
    answers = [(r) => new Promise((resolve) => r.signal.addEventListener('abort', () => resolve('once')))];
    const r = await service.execute(req({ operation: 'file.move', source: src, destination: path.join(work, 'b/f.txt') }));
    assert.equal(r.status, 'timeout');
    assert.ok(fs.existsSync(src));
  });
  it('requestId rejoué refusé ; requêtes concurrentes sérialisées, une seule gagne', async () => {
    const src = path.join(work, 'a/f.txt');
    write(src);
    const dst = path.join(work, 'b/f.txt');
    answers = ['once', 'once'];
    const a = service.execute({ ...req({ operation: 'file.move', source: src, destination: dst }), requestId: 'same' });
    const dup = await service.execute({ ...req({ operation: 'file.move', source: src, destination: dst }), requestId: 'same' });
    assert.equal(dup.error.code, 'duplicate_request');
    const b = service.execute(req({ operation: 'file.move', source: src, destination: path.join(work, 'b/other.txt') }));
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.ok, true);
    assert.equal(rb.ok, false);
    assert.equal(rb.error.code, 'source_missing');
    assert.ok(fs.existsSync(dst));
  });
  it('erreur de permission explicite, sans succès annoncé', async () => {
    const src = path.join(work, 'a/f.txt');
    write(src);
    const fsp = { ...fs.promises, link: async () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } };
    service = mk({ fsp });
    answers = ['once'];
    const r = await service.execute(req({ operation: 'file.move', source: src, destination: path.join(work, 'b/f.txt') }));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'permission_denied');
    assert.ok(fs.existsSync(src));
  });
  it('requêtes invalides rejetées', async () => {
    assert.equal((await service.execute(null)).error.code, 'invalid_request');
    assert.equal((await service.execute({ ...req({ operation: 'file.move' }), agentId: 'bad id!' })).error.code, 'invalid_request');
    assert.equal((await service.execute(req({ operation: 'shell.exec' }))).error.code, 'unsupported_operation');
  });
});

describe('host-ops: stockage et journal', () => {
  it('journal borné, sans contenu, consultable', async () => {
    for (let i = 0; i < 250; i += 1) journal.add({ requestId: `x${i}`, operation: 'file.copy', outcome: 'completed', source: 's'.repeat(1000) });
    const list = journal.list();
    assert.equal(list.length, 200);
    assert.equal(list[0].requestId, 'x249');
    assert.equal(list[0].source.length, 300);
  });
  it('journalise refus et réussites', async () => {
    const src = path.join(work, 'a/f.txt');
    write(src);
    answers = ['deny'];
    await service.execute(req({ operation: 'file.move', source: src, destination: path.join(work, 'b/f.txt') }));
    assert.equal(journal.list()[0].outcome, 'denied');
  });
  it('fichier d’état corrompu : désactivé et sans règles', () => {
    fs.writeFileSync(path.join(tmp, 'bad.json'), '{{{');
    const s = createHostOpsStore(path.join(tmp, 'bad.json'));
    assert.equal(s.isEnabled(), false);
    assert.deepEqual(s.listGrants(), []);
  });
  it('désactivé par défaut et deviceId stable', () => {
    const s1 = createHostOpsStore(path.join(tmp, 'fresh.json'));
    assert.equal(s1.isEnabled(), false);
    const s2 = createHostOpsStore(path.join(tmp, 'fresh.json'));
    assert.equal(s1.getDeviceId(), s2.getDeviceId());
  });
});
