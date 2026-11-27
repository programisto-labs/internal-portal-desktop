'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { canonicalizeUrl, urlExpressions, urlFullHashes } = require('../src/safe-browsing/url-hashes');
const { PrefixSet } = require('../src/safe-browsing/prefix-set');
const { createSafeBrowsingService, parseDuration } = require('../src/safe-browsing/service');
const { resolveEndpoint, methodUrl } = require('../src/safe-browsing/transport');
const { assessDownloadDanger } = require('../src/safe-browsing/downloads');
const {
  ERROR_PAGE,
  securityStateOf,
  errorPageQuery,
  cleanSafeBrowsingTexts,
  safeBrowsingGesture,
  safeBrowsingPageFromUrl,
} = require('../src/browser-tabs/page-errors');

const sha = (expression) => crypto.createHash('sha256').update(expression).digest();
const canonical = (url) => {
  const c = canonicalizeUrl(url);
  return c && `${c.host}${c.path}${c.query !== null ? `?${c.query}` : ''}`;
};

describe('Safe Browsing : canonicalisation (vecteurs de la spécification Google)', () => {
  const vectors = [
    ['http://host/%25%32%35', 'host/%25'],
    ['http://host/%25%32%35%25%32%35', 'host/%25%25'],
    ['http://host/%2525252525252525', 'host/%25'],
    ['http://host/asdf%25%32%35asd', 'host/asdf%25asd'],
    ['http://www.google.com/', 'www.google.com/'],
    [
      'http://%31%36%38%2e%31%38%38%2e%39%39%2e%32%36/%2E%73%65%63%75%72%65/%77%77%77%2E%65%62%61%79%2E%63%6F%6D/',
      '168.188.99.26/.secure/www.ebay.com/',
    ],
    ['http://3279880203/blah', '195.127.0.11/blah'],
    ['http://www.google.com/blah/..', 'www.google.com/'],
    ['www.google.com', 'www.google.com/'],
    ['http://www.evil.com/blah#frag', 'www.evil.com/blah'],
    ['http://www.GOOgle.com/', 'www.google.com/'],
    ['http://www.google.com.../', 'www.google.com/'],
    ['http://www.google.com/foo\tbar\rbaz\n2', 'www.google.com/foobarbaz2'],
    ['http://www.google.com/q?', 'www.google.com/q?'],
    ['http://www.google.com/q?r?s', 'www.google.com/q?r?s'],
    ['http://evil.com/foo#bar#baz', 'evil.com/foo'],
    ['http://notrailingslash.com', 'notrailingslash.com/'],
    ['http://www.gotaport.com:1234/', 'www.gotaport.com/'],
    ['  http://www.google.com/  ', 'www.google.com/'],
    ['https://www.securesite.com/', 'www.securesite.com/'],
    ['http://host.com/ab%23cd', 'host.com/ab%23cd'],
    ['http://host.com//twoslashes?more//slashes', 'host.com/twoslashes?more//slashes'],
  ];
  for (const [input, expected] of vectors) {
    it(JSON.stringify(input), () => assert.equal(canonical(input), expected));
  }

  it('refuse ce qui n’est pas une page web', () => {
    assert.equal(canonicalizeUrl('file:///etc/passwd'), null);
    assert.equal(canonicalizeUrl('javascript:alert(1)'), null);
    assert.equal(canonicalizeUrl(''), null);
  });
});

describe('Safe Browsing : expressions hôte / chemin', () => {
  it('combine suffixes d’hôte et préfixes de chemin', () => {
    assert.deepEqual(urlExpressions('http://a.b.c/1/2.html?param=1'), [
      'a.b.c/1/2.html?param=1',
      'a.b.c/1/2.html',
      'a.b.c/',
      'a.b.c/1/',
      'b.c/1/2.html?param=1',
      'b.c/1/2.html',
      'b.c/',
      'b.c/1/',
    ]);
  });

  it('garde 5 hôtes au plus, jamais le domaine de premier niveau seul', () => {
    const hosts = [...new Set(urlExpressions('http://a.b.c.d.e.f.g/1.html').map((e) => e.split('/')[0]))];
    assert.deepEqual(hosts, ['a.b.c.d.e.f.g', 'c.d.e.f.g', 'd.e.f.g', 'e.f.g', 'f.g']);
  });

  it('une adresse IP n’a pas de suffixe', () => {
    assert.deepEqual(urlExpressions('http://1.2.3.4/1/'), ['1.2.3.4/1/', '1.2.3.4/']);
  });

  it('hache chaque expression en SHA-256', () => {
    const hashes = urlFullHashes('http://evil.example/login');
    assert.equal(hashes.length, urlExpressions('http://evil.example/login').length);
    assert.ok(hashes[0].equals(sha('evil.example/login')));
  });
});

describe('Safe Browsing : préfixes', () => {
  it('trie toutes tailles confondues, retire par position, contrôle le checksum', () => {
    const set = new PrefixSet();
    set.addRaw(4, Buffer.from('bbbbaaaa', 'latin1'));
    set.addRaw(5, Buffer.from('abcde', 'latin1'));
    assert.deepEqual([...set.entries()].map((e) => e.bytes.toString('latin1')), ['aaaa', 'abcde', 'bbbb']);
    const expected = crypto.createHash('sha256').update('aaaaabcdebbbb').digest();
    assert.ok(set.checksum().equals(expected));
    set.removeIndices([1]);
    assert.deepEqual([...set.entries()].map((e) => e.bytes.toString('latin1')), ['aaaa', 'bbbb']);
  });

  it('trouve le préfixe d’un hachage complet', () => {
    const full = sha('evil.example/');
    const set = new PrefixSet();
    set.addRaw(4, Buffer.concat([Buffer.from('zzzz'), full.subarray(0, 4), Buffer.from('aaaa')]));
    assert.ok(set.match(full).equals(full.subarray(0, 4)));
    assert.equal(set.match(sha('good.example/')), null);
  });

  it('survit à l’enregistrement', () => {
    const set = new PrefixSet();
    set.addRaw(4, Buffer.from('abcdwxyz'));
    set.addRaw(6, Buffer.from('qwerty'));
    const copy = PrefixSet.deserialize(JSON.parse(JSON.stringify(set.serialize())));
    assert.ok(copy.checksum().equals(set.checksum()));
  });

  it('refuse des préfixes mal formés', () => {
    assert.throws(() => new PrefixSet().addRaw(4, Buffer.from('abc')));
    assert.throws(() => new PrefixSet().addRaw(2, Buffer.from('ab')));
  });
});

/** Faux serveur v4 : une liste de logiciels malveillants contenant `evil.example/`. */
function fakeServer({ fail = false } = {}) {
  const full = sha('evil.example/');
  const prefix = full.subarray(0, 4);
  const calls = [];
  async function transport(method, body) {
    calls.push({ method, body });
    if (fail) throw new Error('offline');
    if (method === 'threatListUpdates:fetch') {
      return {
        listUpdateResponses: body.listUpdateRequests.map((req) => {
          const prefixes = req.threatType === 'MALWARE' ? prefix : Buffer.alloc(0);
          return {
            ...req,
            responseType: 'FULL_UPDATE',
            additions: prefixes.length ? [{ compressionType: 'RAW', rawHashes: { prefixSize: 4, rawHashes: prefixes.toString('base64') } }] : [],
            newClientState: 'state-1',
            checksum: { sha256: crypto.createHash('sha256').update(prefixes).digest('base64') },
          };
        }),
        minimumWaitDuration: '1800s',
      };
    }
    const asked = body.threatInfo.threatEntries.map((e) => e.hash);
    return {
      matches: asked.includes(prefix.toString('base64'))
        ? [{ threatType: 'MALWARE', platformType: 'ANY_PLATFORM', threatEntryType: 'URL', threat: { hash: full.toString('base64') }, cacheDuration: '300s' }]
        : [],
      negativeCacheDuration: '300s',
    };
  }
  return { transport, calls, prefix };
}

function memoryStorage() {
  let data = null;
  return { load: () => data, save: (d) => { data = JSON.parse(JSON.stringify(d)); }, peek: () => data };
}

describe('Safe Browsing : décision', () => {
  it('ne bloque rien tant que les listes ne sont pas là', () => {
    const service = createSafeBrowsingService({ transport: fakeServer().transport, storage: memoryStorage(), log: () => {} });
    assert.deepEqual(service.classify('http://evil.example/'), { verdict: 'safe' });
  });

  it('un préfixe trouvé se vérifie, puis le verdict est en cache', async () => {
    const server = fakeServer();
    const service = createSafeBrowsingService({ transport: server.transport, storage: memoryStorage(), log: () => {} });
    await service.update();
    assert.equal(service.classify('https://evil.example/page').verdict, 'check');
    assert.deepEqual(await service.check('https://evil.example/page'), { verdict: 'dangerous', threat: 'malware' });
    assert.deepEqual(service.classify('https://evil.example/autre'), { verdict: 'dangerous', threat: 'malware' });
    const fullHashCalls = server.calls.filter((c) => c.method === 'fullHashes:find');
    assert.equal(fullHashCalls.length, 1);
    // Seul le préfixe de 4 octets part, jamais l'adresse.
    assert.equal(JSON.stringify(fullHashCalls[0].body).includes('evil.example'), false);
    assert.deepEqual(fullHashCalls[0].body.threatInfo.threatEntries, [{ hash: server.prefix.toString('base64') }]);
    assert.deepEqual(service.classify('https://good.example/'), { verdict: 'safe' });
  });

  it('« Continuer » vaut pour le site jusqu’à la fin de la session', async () => {
    const service = createSafeBrowsingService({ transport: fakeServer().transport, storage: memoryStorage(), log: () => {} });
    await service.update();
    await service.check('https://evil.example/');
    service.allowForSession('https://www.evil.example/x');
    assert.deepEqual(service.classify('https://evil.example/'), { verdict: 'safe' });
  });

  it('protection coupée : rien n’est bloqué', async () => {
    let enabled = true;
    const service = createSafeBrowsingService({ transport: fakeServer().transport, storage: memoryStorage(), isEnabled: () => enabled, log: () => {} });
    await service.update();
    enabled = false;
    assert.deepEqual(service.classify('https://evil.example/'), { verdict: 'safe' });
  });

  it('serveur injoignable : la page s’ouvre (jamais bloquant)', async () => {
    const server = fakeServer();
    const storage = memoryStorage();
    const service = createSafeBrowsingService({ transport: server.transport, storage, log: () => {} });
    await service.update();
    const offline = createSafeBrowsingService({ transport: fakeServer({ fail: true }).transport, storage, log: () => {} });
    offline.start();
    offline.stop();
    assert.equal(offline.classify('https://evil.example/').verdict, 'check');
    assert.deepEqual(await offline.check('https://evil.example/'), { verdict: 'safe', unverified: true });
  });

  it('listes indisponibles : journalisé, nouvel essai plus tard', async () => {
    const logs = [];
    const service = createSafeBrowsingService({ transport: fakeServer({ fail: true }).transport, storage: memoryStorage(), log: (...a) => logs.push(a.join(' ')) });
    await service.update();
    assert.equal(service.status().failures, 1);
    assert.ok(service.status().nextUpdateAt > Date.now());
    assert.ok(logs.some((l) => l.includes('indisponibles')));
  });

  it('checksum faux : la liste est vidée et redemandée en entier', async () => {
    const server = fakeServer();
    const bad = async (method, body) => {
      const res = await server.transport(method, body);
      if (method === 'threatListUpdates:fetch') for (const r of res.listUpdateResponses) r.checksum = { sha256: 'AAAA' };
      return res;
    };
    const service = createSafeBrowsingService({ transport: bad, storage: memoryStorage(), log: () => {} });
    await service.update();
    assert.equal(service.status().ready, false);
  });

  it('relit les listes enregistrées au démarrage', async () => {
    const storage = memoryStorage();
    await createSafeBrowsingService({ transport: fakeServer().transport, storage, log: () => {} }).update();
    const next = createSafeBrowsingService({ transport: fakeServer().transport, storage, log: () => {} });
    next.start();
    next.stop();
    assert.equal(next.status().ready, true);
    assert.equal(next.status().prefixes, 1);
  });

  it('lit les durées du protocole', () => {
    assert.equal(parseDuration('1800s', 0), 1_800_000);
    assert.equal(parseDuration('12.5s', 0), 12_500);
    assert.equal(parseDuration('nope', 42), 42);
  });
});

describe('Safe Browsing : téléchargements', () => {
  it('le fichier ou sa page signalés suffisent', async () => {
    const service = createSafeBrowsingService({ transport: fakeServer().transport, storage: memoryStorage(), log: () => {} });
    await service.update();
    const first = assessDownloadDanger(service, ['https://cdn.example/file.zip', 'https://evil.example/download']);
    assert.equal(first.verdict, 'check');
    assert.deepEqual(await first.check(), { verdict: 'dangerous', threat: 'malware' });
    assert.deepEqual(assessDownloadDanger(service, ['https://evil.example/x']), { verdict: 'dangerous', threat: 'malware' });
    assert.deepEqual(assessDownloadDanger(service, ['blob:https://x/1', '']), { verdict: 'safe' });
  });
});

describe('Safe Browsing : transport', () => {
  it('passe par le relais de l’API Lasco par défaut', () => {
    const endpoint = resolveEndpoint({ portalOrigin: 'https://app.lascoapp.com', env: {} });
    assert.equal(methodUrl(endpoint, 'fullHashes:find'), 'https://app.lascoapp.com/__proxy_api/safe-browsing/v4/full-hashes');
    assert.equal(
      methodUrl(endpoint, 'threatListUpdates:fetch'),
      'https://app.lascoapp.com/__proxy_api/safe-browsing/v4/threat-list-updates',
    );
  });

  it('parle directement à Google avec une clé de développement', () => {
    const endpoint = resolveEndpoint({ portalOrigin: 'https://app.lascoapp.com', env: { LASCO_SAFE_BROWSING_API_KEY: 'k' } });
    assert.equal(methodUrl(endpoint, 'fullHashes:find'), 'https://safebrowsing.googleapis.com/v4/fullHashes:find?key=k');
  });
});

describe('Safe Browsing : page d’avertissement', () => {
  const page = { kind: 'safe-browsing', url: 'https://evil.example/login', threat: 'phishing', token: 'abc-123' };

  it('cadenas rouge et paramètres de la page', () => {
    assert.equal(securityStateOf(page.url, page), 'dangerous');
    const query = errorPageQuery({ ...page, texts: { back: 'Back to safety', evil: '<b>x</b>' } });
    assert.equal(query.threat, 'phishing');
    assert.equal(query.token, 'abc-123');
    assert.deepEqual(JSON.parse(query.texts), { back: 'Back to safety' });
  });

  it('ne garde que les textes connus', () => {
    assert.equal(cleanSafeBrowsingTexts(null), null);
    assert.deepEqual(cleanSafeBrowsingTexts({ proceed: ' Go ', other: 'x', back: 3 }), { proceed: 'Go' });
  });

  it('lit le geste de la page seulement avec son jeton', () => {
    const file = pathToFileURL(ERROR_PAGE).href;
    assert.equal(safeBrowsingGesture(`${file}?kind=safe-browsing#proceed-abc-123`, page), 'proceed');
    assert.equal(safeBrowsingGesture(`${file}#back-abc-123`, page), 'back');
    assert.equal(safeBrowsingGesture(`${file}#proceed-autre`, page), null);
    assert.equal(safeBrowsingGesture('https://evil.example/#proceed-abc-123', page), null);
    assert.equal(safeBrowsingGesture(`${file}#proceed-abc-123`, { ...page, kind: 'network' }), null);
  });

  it('relit une page d’avertissement de l’historique', () => {
    const url = new URL(pathToFileURL(ERROR_PAGE).href);
    for (const [k, v] of Object.entries(errorPageQuery(page))) url.searchParams.set(k, v);
    assert.deepEqual(safeBrowsingPageFromUrl(url.href), { ...page, title: 'evil.example' });
    const other = new URL(pathToFileURL(path.join(path.dirname(ERROR_PAGE), 'autre.html')).href);
    other.search = url.search;
    assert.equal(safeBrowsingPageFromUrl(other.href), null);
  });
});
