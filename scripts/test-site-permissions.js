'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  permissionPolicy,
  siteOrigin,
  createSitePermissionStore,
  createSitePermissionHandlers,
  installSitePermissions,
  describeSitePermissions,
} = require('../src/browser-tabs/site-permissions');

function memoryFs(initial = {}) {
  const files = { ...initial };
  return {
    files,
    readFileSync: (p) => {
      if (!(p in files)) throw new Error('ENOENT');
      return files[p];
    },
    writeFileSync: (p, data) => (files[p] = data),
    renameSync: (from, to) => {
      files[to] = files[from];
      delete files[from];
    },
    mkdirSync: () => {},
  };
}

const tab = (url) => ({ id: 7, isDestroyed: () => false, getURL: () => url });
const request = (handlers, wc, permission, details = {}) =>
  new Promise((resolve) => handlers.request(wc, permission, resolve, details));

describe('autorisations des sites', () => {
  it('classe les permissions comme Chrome', () => {
    assert.equal(permissionPolicy('fullscreen'), 'allow');
    assert.equal(permissionPolicy('clipboard-sanitized-write'), 'allow');
    assert.equal(permissionPolicy('geolocation'), 'ask');
    assert.equal(permissionPolicy('notifications'), 'ask');
    assert.equal(permissionPolicy('clipboard-read'), 'ask');
    assert.equal(permissionPolicy('microphone'), 'ask');
    assert.equal(permissionPolicy('camera'), 'ask');
    // `media` n'est jamais retenu tel quel : il se traduit en micro / caméra.
    assert.equal(permissionPolicy('media'), 'deny');
    assert.equal(permissionPolicy('openExternal'), 'deny');
    assert.equal(permissionPolicy('hid'), 'deny');
    assert.equal(permissionPolicy('unknown'), 'deny');
  });

  it("ne reconnaît que les origines http(s)", () => {
    assert.equal(siteOrigin('https://maps.example.com/a?b'), 'https://maps.example.com');
    assert.equal(siteOrigin('file:///tmp/x.html'), null);
    assert.equal(siteOrigin(''), null);
  });

  it('pose la question une fois, retient la réponse et ne la repose pas', async () => {
    const store = createSitePermissionStore({});
    const asked = [];
    const handlers = createSitePermissionHandlers({
      store,
      ask: async (q) => {
        asked.push(q);
        return 'allow';
      },
    });
    const wc = tab('https://maps.example.com/route');
    assert.equal(await request(handlers, wc, 'geolocation'), true);
    assert.equal(await request(handlers, wc, 'geolocation'), true);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].origin, 'https://maps.example.com');
    assert.equal(asked[0].label, 'connaître votre position');
    assert.equal(store.get('https://maps.example.com', 'geolocation'), 'allow');
    assert.equal(handlers.check(wc, 'geolocation', 'https://maps.example.com', {}), true);
  });

  it('Bloquer est retenu, Ignorer refuse sans retenir', async () => {
    const store = createSitePermissionStore({});
    let answer = 'block';
    const handlers = createSitePermissionHandlers({ store, ask: async () => answer });
    const wc = tab('https://news.example/');
    assert.equal(await request(handlers, wc, 'notifications'), false);
    assert.equal(store.get('https://news.example', 'notifications'), 'block');
    answer = 'dismiss';
    assert.equal(await request(handlers, wc, 'clipboard-read'), false);
    assert.equal(store.get('https://news.example', 'clipboard-read'), null);
  });

  it("Ignorer ne repose pas la question en boucle, jusqu'à une décision ou une réinitialisation", async () => {
    const store = createSitePermissionStore({});
    let calls = 0;
    const handlers = createSitePermissionHandlers({
      store,
      ask: async () => {
        calls += 1;
        return 'dismiss';
      },
    });
    const wc = tab('https://www.lequipe.fr/');
    assert.equal(await request(handlers, wc, 'geolocation'), false);
    assert.equal(await request(handlers, wc, 'geolocation'), false);
    assert.equal(await request(handlers, wc, 'geolocation'), false);
    assert.equal(calls, 1);
    assert.equal(store.get('https://www.lequipe.fr', 'geolocation'), null);
    // Une autre permission du même site pose encore sa question.
    await request(handlers, wc, 'notifications');
    assert.equal(calls, 2);
    // Réinitialiser depuis les informations du site : la question revient.
    store.clearOrigin('https://www.lequipe.fr');
    await request(handlers, wc, 'geolocation');
    assert.equal(calls, 3);
    // Une décision (Autoriser depuis le cadenas) efface l'ignoré.
    store.set('https://www.lequipe.fr', 'geolocation', 'allow');
    assert.equal(await request(handlers, wc, 'geolocation'), true);
    store.set('https://www.lequipe.fr', 'geolocation', null);
    await request(handlers, wc, 'geolocation');
    assert.equal(calls, 4);
  });

  it('une seule question pour des demandes simultanées du même site', async () => {
    const store = createSitePermissionStore({});
    let calls = 0;
    let release;
    const handlers = createSitePermissionHandlers({
      store,
      ask: () => {
        calls += 1;
        return new Promise((resolve) => (release = () => resolve('allow')));
      },
    });
    const wc = tab('https://a.example/');
    const first = request(handlers, wc, 'geolocation');
    const second = request(handlers, wc, 'geolocation');
    await new Promise((r) => setImmediate(r));
    release();
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.equal(calls, 1);
  });

  it('demande micro et caméra en une question, retenus séparément, puis accès système', async () => {
    const store = createSitePermissionStore({});
    const asked = [];
    const system = [];
    let answer = 'allow';
    const handlers = createSitePermissionHandlers({
      store,
      ask: async (q) => {
        asked.push(q);
        return answer;
      },
      ensureSystemMediaAccess: async (media) => {
        system.push(media);
        return true;
      },
    });
    const meet = tab('https://meet.google.com/abc');
    // Noms des appareils (enumerateDevices, sans embeddingOrigin) : cachés avant « Autoriser ».
    assert.equal(handlers.check(meet, 'media', 'https://meet.google.com', { mediaType: 'audio' }), false);
    // navigator.permissions.query : « accordé » tant que rien n'est décidé, pour que le site
    // appelle getUserMedia (sinon Meet conclut à un blocage et ne demande jamais).
    const query = (wc, mediaType) =>
      handlers.check(wc, 'media', 'https://meet.google.com', { mediaType, embeddingOrigin: 'https://meet.google.com/' });
    assert.equal(query(meet, 'audio'), true);
    assert.equal(query(meet, 'video'), true);
    // Caméra avec pan/tilt/zoom (`{ name: 'camera', panTiltZoom: true }`, sans mediaType) :
    // Meet l'interroge aussi ; « refusé » lui faisait croire la caméra bloquée.
    assert.equal(query(meet, undefined), true);
    assert.equal(asked.length, 0);
    assert.equal(await request(handlers, meet, 'media', { mediaTypes: ['audio', 'video'] }), true);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].label, 'utiliser votre micro et votre caméra');
    assert.deepEqual(asked[0].permissions, ['microphone', 'camera']);
    assert.deepEqual(store.list('https://meet.google.com'), { microphone: 'allow', camera: 'allow' });
    assert.deepEqual(system, ['microphone', 'camera']);
    // Retenu : plus de question.
    assert.equal(await request(handlers, meet, 'media', { mediaTypes: ['audio'] }), true);
    assert.equal(asked.length, 1);
    assert.equal(handlers.check(meet, 'media', 'https://meet.google.com', { mediaType: 'video' }), true);
    assert.equal(handlers.check(meet, 'media', 'https://meet.google.com', { mediaType: 'unknown' }), true);

    // Caméra bloquée sur un autre site : la demande micro + caméra est refusée, le micro seul reste demandable.
    const other = tab('https://visio.example/');
    store.set('https://visio.example', 'camera', 'block');
    assert.equal(await request(handlers, other, 'media', { mediaTypes: ['audio', 'video'] }), false);
    assert.equal(asked.length, 1);
    const visioQuery = (mediaType) =>
      handlers.check(other, 'media', 'https://visio.example', { mediaType, embeddingOrigin: 'https://visio.example/' });
    assert.equal(visioQuery('video'), false);
    assert.equal(visioQuery('audio'), true);
    answer = 'block';
    assert.equal(await request(handlers, other, 'media', { mediaTypes: ['audio'] }), false);
    assert.equal(asked.length, 2);
    assert.equal(asked[1].label, 'utiliser votre micro');
    assert.equal(store.get('https://visio.example', 'microphone'), 'block');
    assert.equal(visioQuery('audio'), false);
    // Pan/tilt/zoom suit la caméra, jamais le micro.
    assert.equal(visioQuery(undefined), false);
    store.set('https://visio.example', 'camera', 'allow');
    assert.equal(visioQuery(undefined), true);
    store.set('https://visio.example', 'camera', 'block');

    // « Ignorer » : refusé jusqu'au redémarrage, la lecture synchrone aussi.
    answer = 'dismiss';
    const third = tab('https://call.example/');
    assert.equal(await request(handlers, third, 'media', { mediaTypes: ['audio'] }), false);
    assert.equal(
      handlers.check(third, 'media', 'https://call.example', { mediaType: 'audio', embeddingOrigin: 'https://call.example/' }),
      false,
    );
  });

  it("refuse le micro si macOS le refuse à l'app, et une demande média sans type", async () => {
    const store = createSitePermissionStore({});
    store.set('https://meet.example', 'microphone', 'allow');
    let asked = 0;
    const handlers = createSitePermissionHandlers({
      store,
      ask: async () => {
        asked += 1;
        return 'allow';
      },
      ensureSystemMediaAccess: async () => false,
    });
    assert.equal(await request(handlers, tab('https://meet.example/'), 'media', { mediaTypes: ['audio'] }), false);
    assert.equal(await request(handlers, tab('https://meet.example/'), 'media', {}), false);
    assert.equal(asked, 0);
  });

  it("refuse sans question ce qui n'est pas demandable (appareils, pages non web)", async () => {
    let calls = 0;
    const handlers = createSitePermissionHandlers({
      store: createSitePermissionStore({}),
      ask: async () => {
        calls += 1;
        return 'allow';
      },
    });
    assert.equal(await request(handlers, tab('https://x.example/'), 'hid'), false);
    assert.equal(await request(handlers, tab('file:///tmp/a.html'), 'media', { mediaTypes: ['audio'] }), false);
    assert.equal(await request(handlers, tab('https://x.example/'), 'fullscreen'), true);
    assert.equal(await request(handlers, tab('file:///tmp/a.html'), 'geolocation'), false);
    assert.equal(calls, 0);
    assert.equal(handlers.check(tab('https://x.example/'), 'media', 'https://x.example', {}), false);
    // Sans décision, la lecture synchrone répond « non » (aucune notification sans accord).
    assert.equal(handlers.check(tab('https://x.example/'), 'notifications', 'https://x.example', {}), false);
  });

  it("rattache la décision au site affiché, pas au cadre intégré", async () => {
    const store = createSitePermissionStore({});
    const asked = [];
    const handlers = createSitePermissionHandlers({
      store,
      ask: async (q) => {
        asked.push(q.origin);
        return 'allow';
      },
    });
    await request(handlers, tab('https://shop.example/'), 'geolocation', {
      requestingUrl: 'https://maps.widget.example/embed',
    });
    assert.deepEqual(asked, ['https://shop.example']);
  });

  it('persiste les décisions et ignore un fichier altéré', () => {
    const fsImpl = memoryFs();
    const store = createSitePermissionStore({ filePath: '/p.json', fsImpl });
    store.set('https://a.example', 'geolocation', 'allow');
    store.set('https://a.example', 'notifications', 'block');
    assert.equal(store.set('https://a.example', 'media', 'allow'), false);
    assert.equal(store.set('https://a.example', 'geolocation', 'maybe'), false);
    const reloaded = createSitePermissionStore({ filePath: '/p.json', fsImpl });
    assert.deepEqual(reloaded.list('https://a.example'), { geolocation: 'allow', notifications: 'block' });
    assert.deepEqual(describeSitePermissions(reloaded, 'https://a.example'), [
      { permission: 'geolocation', decision: 'allow' },
      { permission: 'notifications', decision: 'block' },
    ]);
    reloaded.set('https://a.example', 'geolocation', null);
    assert.deepEqual(reloaded.list('https://a.example'), { notifications: 'block' });
    reloaded.clearOrigin('https://a.example');
    assert.deepEqual(reloaded.list('https://a.example'), {});

    const tampered = memoryFs({
      '/t.json': JSON.stringify({
        version: 1,
        origins: { 'https://ok.example': { geolocation: 'allow', media: 'allow' }, 'javascript:x': { geolocation: 'allow' } },
      }),
    });
    const fromTampered = createSitePermissionStore({ filePath: '/t.json', fsImpl: tampered });
    assert.deepEqual(fromTampered.list('https://ok.example'), { geolocation: 'allow' });
    assert.deepEqual(fromTampered.list('javascript:x'), {});
  });

  it('installe les gestionnaires une seule fois par session', () => {
    const calls = [];
    const fakeSession = {
      setPermissionRequestHandler: () => calls.push('request'),
      setPermissionCheckHandler: () => calls.push('check'),
    };
    const deps = { store: createSitePermissionStore({}), ask: async () => 'dismiss' };
    assert.equal(installSitePermissions(fakeSession, deps), true);
    assert.equal(installSitePermissions(fakeSession, deps), false);
    assert.deepEqual(calls, ['request', 'check']);
  });
});
