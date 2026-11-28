'use strict';

/** Moteur declarativeNetRequest (docs/extensions.md) : règles de Chrome reprises. */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  applyHeaderRules,
  buildRequest,
  createExtensionRules,
  evaluateAll,
  isRegexSupported,
  isValidRule,
  urlFilterToRegExp,
} = require('../src/extensions/dnr/engine');

function setWith(rules, { id = 'ext', installedAt = 1, ruleset = true } = {}) {
  const set = createExtensionRules({ extensionId: id, installedAt });
  if (ruleset) set.setStaticRuleset('main', rules, true);
  return set;
}

const req = (url, type = 'script', initiator = 'https://page.example') => buildRequest({ url, resourceType: type, initiator });
const block = (id, condition, priority) => ({ id, priority, action: { type: 'block' }, condition });

describe('urlFilter', () => {
  it('ancre de domaine, séparateur, joker, début et fin', () => {
    const re = urlFilterToRegExp('||ads.example.com^', false);
    assert.ok(re.test('https://ads.example.com/x.js'));
    assert.ok(re.test('https://cdn.ads.example.com/x.js'));
    assert.ok(!re.test('https://notads.example.com/x.js'));
    assert.ok(!re.test('https://ads.example.com.evil.org/'));
    assert.ok(urlFilterToRegExp('|https://a.com/*.js|', false).test('https://a.com/x/y.js'));
    assert.ok(!urlFilterToRegExp('|https://a.com/*.js|', false).test('https://a.com/x/y.js?v=1'));
    assert.ok(urlFilterToRegExp('/banner/', false).test('https://x.com/img/BANNER/1.png'));
    assert.ok(!urlFilterToRegExp('/banner/', true).test('https://x.com/img/BANNER/1.png'));
  });
});

describe('règles', () => {
  it('bloque, mais pas la page principale sans type explicite', () => {
    const set = setWith([block(1, { urlFilter: '||tracker.io^' })]);
    assert.deepEqual(evaluateAll([set], req('https://tracker.io/t.js')).cancel, true);
    assert.equal(evaluateAll([set], req('https://tracker.io/', 'main_frame', null)), null);
  });

  it('allow l’emporte à priorité égale, la priorité plus haute l’emporte sinon', () => {
    const rules = [block(1, { urlFilter: 'ads' }), { id: 2, action: { type: 'allow' }, condition: { urlFilter: 'ads', requestDomains: ['good.com'] } }];
    assert.equal(evaluateAll([setWith(rules)], req('https://good.com/ads.js')), null);
    assert.equal(evaluateAll([setWith(rules)], req('https://bad.com/ads.js')).cancel, true);
    const prioritized = [block(1, { urlFilter: 'ads' }, 2), { id: 2, priority: 1, action: { type: 'allow' }, condition: { urlFilter: 'ads' } }];
    assert.equal(evaluateAll([setWith(prioritized)], req('https://good.com/ads.js')).cancel, true);
  });

  it('domaines de la requête et de l’initiateur, tiers et première partie', () => {
    const set = setWith([
      block(1, { urlFilter: 'pixel', initiatorDomains: ['news.fr'] }),
      block(2, { urlFilter: 'beacon', domainType: 'thirdParty' }),
      block(3, { urlFilter: 'widget', excludedRequestDomains: ['cdn.ok.com'] }),
    ]);
    assert.equal(evaluateAll([set], req('https://x.com/pixel.gif', 'image', 'https://www.news.fr/')).cancel, true);
    assert.equal(evaluateAll([set], req('https://x.com/pixel.gif', 'image', 'https://other.fr/')), null);
    assert.equal(evaluateAll([set], req('https://cdn.site.co.uk/beacon', 'ping', 'https://www.site.co.uk/')), null);
    assert.equal(evaluateAll([set], req('https://stats.io/beacon', 'ping', 'https://www.site.co.uk/')).cancel, true);
    assert.equal(evaluateAll([set], req('https://cdn.ok.com/widget.js')), null);
  });

  it('types de ressources et méthodes', () => {
    const set = setWith([block(1, { urlFilter: 'api', resourceTypes: ['xmlhttprequest'], requestMethods: ['post'] })]);
    assert.equal(evaluateAll([set], buildRequest({ url: 'https://a.com/api', resourceType: 'xmlhttprequest', method: 'POST' })).cancel, true);
    assert.equal(evaluateAll([set], buildRequest({ url: 'https://a.com/api', resourceType: 'xmlhttprequest', method: 'GET' })), null);
    assert.equal(evaluateAll([set], buildRequest({ url: 'https://a.com/api', resourceType: 'script', method: 'POST' })), null);
  });

  it('redirections : url, extensionPath, transform, regexSubstitution ; upgradeScheme', () => {
    const set = setWith([
      { id: 1, action: { type: 'redirect', redirect: { extensionPath: '/war/noop.js' } }, condition: { urlFilter: '||ads.com/lib.js' } },
      { id: 2, action: { type: 'redirect', redirect: { transform: { queryTransform: { removeParams: ['utm_source'] } } } }, condition: { urlFilter: 'utm_source=', resourceTypes: ['main_frame'] } },
      { id: 3, action: { type: 'redirect', redirect: { regexSubstitution: 'https://\\1.mirror.org/' } }, condition: { regexFilter: '^https://([a-z]+)\\.slow\\.org/', resourceTypes: ['image'] } },
      { id: 4, action: { type: 'upgradeScheme' }, condition: { requestDomains: ['plain.com'] } },
    ], { id: 'abc' });
    assert.equal(evaluateAll([set], req('https://ads.com/lib.js')).redirectURL, 'chrome-extension://abc/war/noop.js');
    assert.equal(evaluateAll([set], req('https://n.fr/a?utm_source=x&id=2', 'main_frame', null)).redirectURL, 'https://n.fr/a?id=2');
    assert.equal(evaluateAll([set], req('https://img.slow.org/a.png', 'image')).redirectURL, 'https://img.mirror.org/');
    assert.equal(evaluateAll([set], req('http://plain.com/x.js')).redirectURL, 'https://plain.com/x.js');
  });

  it('entre extensions : un blocage l’emporte sur une redirection et sur un allow d’une autre', () => {
    const a = setWith([{ id: 1, action: { type: 'allow' }, condition: { urlFilter: 'x.js' } }], { id: 'a', installedAt: 1 });
    const b = setWith([block(1, { urlFilter: 'x.js' })], { id: 'b', installedAt: 2 });
    assert.equal(evaluateAll([a, b], req('https://site.com/x.js')).cancel, true);
  });

  it('allowAllRequests d’une page autorise ses requêtes de moindre priorité', () => {
    const set = setWith([
      { id: 1, priority: 2, action: { type: 'allowAllRequests' }, condition: { requestDomains: ['trusted.com'], resourceTypes: ['main_frame'] } },
      block(2, { urlFilter: 'ads' }, 1),
    ]);
    evaluateAll([set], buildRequest({ url: 'https://trusted.com/', resourceType: 'main_frame', frameKey: '7:main' }));
    const sub = buildRequest({ url: 'https://cdn.com/ads.js', resourceType: 'script', initiator: 'https://trusted.com', frameKeys: ['7:main'] });
    assert.equal(evaluateAll([set], sub), null);
    const elsewhere = buildRequest({ url: 'https://cdn.com/ads.js', resourceType: 'script', frameKeys: ['8:main'] });
    assert.equal(evaluateAll([set], elsewhere).cancel, true);
  });

  it('modifyHeaders : set, remove, append, plus prioritaire d’abord, bloqué par un allow plus prioritaire', () => {
    const set = setWith([
      { id: 1, priority: 2, action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Referer', operation: 'remove' }] }, condition: { urlFilter: 'api' } },
      { id: 2, priority: 1, action: { type: 'modifyHeaders', requestHeaders: [{ header: 'referer', operation: 'set', value: 'x' }, { header: 'X-A', operation: 'append', value: '2' }] }, condition: { urlFilter: 'api' } },
    ]);
    const decision = evaluateAll([set], req('https://a.com/api'));
    const out = applyHeaderRules(decision.headers, { Referer: 'https://p/', 'X-A': '1' }, 'requestHeaders');
    assert.equal(out.Referer, undefined);
    assert.equal(out.referer, undefined);
    assert.equal(out['X-A'], '1, 2');
    const allowed = setWith([
      { id: 1, priority: 1, action: { type: 'modifyHeaders', responseHeaders: [{ header: 'CSP', operation: 'remove' }] }, condition: { urlFilter: 'a' } },
      { id: 2, priority: 5, action: { type: 'allow' }, condition: { urlFilter: 'a' } },
    ]);
    assert.equal(evaluateAll([allowed], req('https://a.com/a')), null);
  });

  it('règles dynamiques et de session : identifiants uniques, validation, limites', () => {
    const set = createExtensionRules({ extensionId: 'x' });
    set.updateDynamicRules({ addRules: [block(5, { urlFilter: 'evil' })] });
    assert.equal(evaluateAll([set], req('https://a.com/evil.js')).cancel, true);
    assert.throws(() => set.updateDynamicRules({ addRules: [block(5, { urlFilter: 'again' })] }), /unique/);
    assert.throws(() => set.updateDynamicRules({ addRules: [{ id: 0, action: { type: 'block' }, condition: {} }] }), /invalid/);
    set.updateDynamicRules({ removeRuleIds: [5] });
    assert.equal(evaluateAll([set], req('https://a.com/evil.js')), null);
    set.updateSessionRules({ addRules: [block(1, { urlFilter: 'tmp' })] });
    assert.equal(set.getSessionRules().length, 1);
  });

  it('jeux statiques : activation, refus d’un jeu inconnu', () => {
    const set = createExtensionRules({ extensionId: 'x' });
    set.setStaticRuleset('a', [block(1, { urlFilter: 'aaa' })], false);
    assert.equal(evaluateAll([set], req('https://x.com/aaa')), null);
    set.updateEnabledRulesets({ enableRulesetIds: ['a'] });
    assert.equal(evaluateAll([set], req('https://x.com/aaa')).cancel, true);
    assert.throws(() => set.updateEnabledRulesets({ enableRulesetIds: ['zzz'] }), /Invalid ruleset/);
  });

  it('regex prises en charge comme RE2 (sans références arrière ni assertions)', () => {
    assert.equal(isRegexSupported('^https://[a-z]+\\.com/'), true);
    assert.equal(isRegexSupported('(a)\\1'), false);
    assert.equal(isRegexSupported('(?=x)'), false);
    assert.equal(isRegexSupported('('), false);
    assert.equal(isValidRule({ id: 1, action: { type: 'block' }, condition: { urlFilter: 'a', regexFilter: 'b' } }), false);
  });
});
