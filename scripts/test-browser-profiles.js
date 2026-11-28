'use strict';

/** Profils de navigation (docs/browser-profiles.md) : contextes, reprise des anciens cookies, fichiers par profil. */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  LEGACY_BROWSER_PARTITION,
  resolveBrowserContext,
  sameBrowserContext,
  migrateLegacyCookies,
  cookieSetDetails,
  createMigratedPartitionsStore,
} = require('../src/browser-profiles/context');
const { createBrowserProfileRegistry } = require('../src/browser-profiles/registry');
const { createDownloadsStore } = require('../src/downloads/store');

const OWNER = 'a1b2c3d4e5f60718293a';
const OTHER = 'ffffeeeeddddccccbbbb';

function fakeSession(cookies = []) {
  const jar = [...cookies];
  return {
    jar,
    cookies: {
      get: async () => jar.map((c) => ({ ...c })),
      set: async (details) => {
        if (details.name === 'refused') throw new Error('refused');
        jar.push(details);
      },
      flushStore: async () => {},
    },
  };
}

function memoryFs() {
  const files = new Map();
  return {
    files,
    readFileSync: (p) => {
      if (!files.has(p)) throw new Error('ENOENT');
      return files.get(p);
    },
    writeFileSync: (p, data) => files.set(p, data),
    renameSync: (from, to) => {
      files.set(to, files.get(from));
      files.delete(from);
    },
    mkdirSync: () => {},
  };
}

describe('contexte web', () => {
  it('une session par (compte, profil, workspace), fichiers par (compte, profil)', () => {
    const a = resolveBrowserContext({ owner: OWNER, profileId: 'default', workspace: 'Clad' }, { userDataDir: '/u' });
    assert.equal(a.partition, `persist:bp-${OWNER.slice(0, 12)}-default-clad`);
    assert.equal(a.dataDir, null, 'le profil par défaut garde les fichiers d’avant');
    const b = resolveBrowserContext({ owner: OWNER, profileId: 'bp_0123456789abcdef', workspace: 'clad' }, { userDataDir: '/u' });
    assert.notEqual(a.partition, b.partition);
    assert.equal(b.dataDir, `/u/browser-profiles/${OWNER.slice(0, 12)}-bp_0123456789abcdef`);
    const c = resolveBrowserContext({ owner: OWNER, profileId: 'default', workspace: 'autre' }, { userDataDir: '/u' });
    assert.notEqual(a.partition, c.partition);
    assert.equal(a.profileKey, c.profileKey);
    assert.equal(sameBrowserContext(a, { ...a }), true);
    assert.equal(sameBrowserContext(a, c), false);
    assert.equal(sameBrowserContext(null, null), true);
  });

  it('refuse un compte ou un workspace invalide, ramène un profil inconnu au profil par défaut', () => {
    assert.equal(resolveBrowserContext({ owner: 'x', workspace: 'clad' }), null);
    assert.equal(resolveBrowserContext({ owner: OWNER, workspace: '../etc' }), null);
    assert.equal(resolveBrowserContext({ owner: OWNER, profileId: '../../x', workspace: 'clad' }).profileId, 'default');
  });
});

describe('reprise des anciens cookies', () => {
  it('copiée une fois dans chaque workspace du profil par défaut, jamais dans un autre profil', async () => {
    const legacy = fakeSession([
      { name: 'SID', value: '1', domain: '.google.com', path: '/', secure: true, httpOnly: true, expirationDate: 2e9 },
      { name: '__Host-x', value: '2', domain: 'app.example.com', hostOnly: true, path: '/', secure: true, session: true },
      { name: 'refused', value: '3', domain: 'x.com', path: '/' },
    ]);
    const migrated = createMigratedPartitionsStore({});
    const ctx = resolveBrowserContext({ owner: OWNER, profileId: 'default', workspace: 'clad' });
    const target = fakeSession();
    const first = await migrateLegacyCookies({ context: ctx, legacySession: legacy, targetSession: target, migrated });
    assert.equal(first.copied, 2);
    const host = target.jar.find((c) => c.name === '__Host-x');
    assert.equal(host.domain, undefined, 'cookie d’hôte gardé sans Domain');
    assert.equal(host.expirationDate, undefined, 'cookie de session gardé de session');
    const again = await migrateLegacyCookies({ context: ctx, legacySession: legacy, targetSession: target, migrated });
    assert.equal(again.skipped, true);

    const work = resolveBrowserContext({ owner: OWNER, profileId: 'bp_0123456789abcdef', workspace: 'clad' });
    const empty = fakeSession();
    assert.equal((await migrateLegacyCookies({ context: work, legacySession: legacy, targetSession: empty, migrated })).skipped, true);
    assert.equal(empty.jar.length, 0);
  });

  it('l’ancienne session revient au premier compte seulement', async () => {
    const fsImpl = memoryFs();
    const migrated = createMigratedPartitionsStore({ filePath: '/u/m.json', fsImpl });
    const legacy = fakeSession([{ name: 'a', value: '1', domain: 'x.com', path: '/' }]);
    await migrateLegacyCookies({
      context: resolveBrowserContext({ owner: OWNER, workspace: 'clad' }),
      legacySession: legacy,
      targetSession: fakeSession(),
      migrated,
    });
    const other = fakeSession();
    const res = await migrateLegacyCookies({
      context: resolveBrowserContext({ owner: OTHER, workspace: 'clad' }),
      legacySession: legacy,
      targetSession: other,
      migrated,
    });
    assert.equal(res.skipped, true);
    assert.equal(other.jar.length, 0);
    // Relu au redémarrage.
    const reread = createMigratedPartitionsStore({ filePath: '/u/m.json', fsImpl });
    assert.equal(reread.has(`persist:bp-${OWNER.slice(0, 12)}-default-clad`), true);
    assert.equal(reread.claimLegacy(OTHER), false);
  });

  it('détails de cookie : URL déduite du domaine, attributs gardés', () => {
    const d = cookieSetDetails({ name: 'n', value: 'v', domain: '.a.com', path: '/p', secure: true, sameSite: 'lax' });
    assert.equal(d.url, 'https://a.com/p');
    assert.equal(d.domain, '.a.com');
    assert.equal(d.sameSite, 'lax');
    assert.equal(cookieSetDetails({ name: 'n' }), null);
  });
});

describe('registre des profils', () => {
  function registry() {
    const sessions = new Map();
    const attached = [];
    const reg = createBrowserProfileRegistry({
      fromPartition: (p) => {
        if (!sessions.has(p)) sessions.set(p, fakeSession(p === LEGACY_BROWSER_PARTITION ? [{ name: 'a', value: '1', domain: 'x.com', path: '/' }] : []));
        return sessions.get(p);
      },
      legacy: { history: () => 'legacy-history', sitePermissions: () => 'legacy-perms', externalAppPermissions: () => 'legacy-apps' },
      createHistoryStore: ({ filePath }) => ({ filePath, flush() {} }),
      createSitePermissionStore: ({ filePath }) => ({ filePath }),
      createExternalAppPermissionStore: ({ filePath }) => ({ filePath }),
      migrated: createMigratedPartitionsStore({}),
      attachDownloads: (ses, meta) => attached.push(meta),
    });
    return { reg, sessions, attached };
  }

  it('profil par défaut : fichiers d’avant ; autre profil : ses fichiers ; ancien portail : session d’avant', async () => {
    const { reg, sessions, attached } = registry();
    const def = resolveBrowserContext({ owner: OWNER, workspace: 'clad' }, { userDataDir: '/u' });
    const opts = reg.managerOptions(def);
    assert.equal(opts.history, 'legacy-history');
    assert.equal(opts.partition, def.partition);
    await opts.sessionReady;
    assert.equal(sessions.get(def.partition).jar.length, 1, 'cookies repris avant la première page');

    const work = resolveBrowserContext({ owner: OWNER, profileId: 'bp_0123456789abcdef', workspace: 'clad' }, { userDataDir: '/u' });
    const workOpts = reg.managerOptions(work);
    assert.match(workOpts.history.filePath, /bp_0123456789abcdef\/history\.json$/);
    assert.equal(workOpts.sessionReady, null);
    assert.equal(reg.managerOptions(work).history, workOpts.history, 'mêmes fichiers pour deux fenêtres');

    const old = reg.managerOptions(null);
    assert.equal(old.partition, LEGACY_BROWSER_PARTITION);

    const ses = sessions.get(def.partition);
    opts.onSessionCreated(ses);
    reg.managerOptions(def).onSessionCreated(ses);
    assert.equal(attached.length, 1, 'téléchargements suivis une fois par session');
    assert.deepEqual(attached[0], { profileId: 'default', partition: def.partition });
  });
});

describe('téléchargements : profil gardé dans la liste', () => {
  it('garde profileId et partition valides, ignore le reste', () => {
    const fsImpl = memoryFs();
    const store = createDownloadsStore({ filePath: '/u/d.json', fsImpl });
    const saved = store.upsert({ id: 'a', savePath: '/x/a.pdf', profileId: 'bp_0123456789abcdef', partition: 'persist:bp-a1b2c3d4e5f6-default-clad' });
    assert.equal(saved.profileId, 'bp_0123456789abcdef');
    assert.equal(saved.partition, 'persist:bp-a1b2c3d4e5f6-default-clad');
    const bad = store.upsert({ id: 'b', savePath: '/x/b.pdf', profileId: '../x', partition: 'file:/etc' });
    assert.equal(bad.profileId, undefined);
    assert.equal(bad.partition, undefined);
  });
});
