'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyLoadFailure,
  isCertificateError,
  isTabCrash,
  securityStateOf,
  errorPageQuery,
} = require('../src/browser-tabs/page-errors');

describe("pages d'erreur des onglets web", () => {
  it('reconnaît les erreurs de certificat', () => {
    assert.equal(isCertificateError(-202), true);
    assert.equal(isCertificateError(-201), true);
    assert.equal(isCertificateError(-105), false);
  });

  it('classe un échec du document principal', () => {
    assert.deepEqual(
      classifyLoadFailure({
        errorCode: -202,
        errorDescription: 'ERR_CERT_AUTHORITY_INVALID',
        validatedURL: 'https://self-signed.example/',
        isMainFrame: true,
      }),
      { kind: 'certificate', url: 'https://self-signed.example/', code: 'ERR_CERT_AUTHORITY_INVALID' },
    );
    const offline = classifyLoadFailure({
      errorCode: -106,
      errorDescription: 'ERR_INTERNET_DISCONNECTED',
      validatedURL: 'https://news.example/a',
      isMainFrame: true,
    });
    assert.equal(offline.kind, 'network');
    assert.equal(offline.message, "Vous n'êtes pas connecté à Internet.");
    assert.equal(
      classifyLoadFailure({ errorCode: -999, errorDescription: '', validatedURL: 'https://x.example/', isMainFrame: true })
        .message,
      "La page n'a pas pu être chargée.",
    );
  });

  it("ignore l'annulation, les cadres, les téléchargements et les pages non web", () => {
    const base = { errorDescription: 'ERR', validatedURL: 'https://x.example/', isMainFrame: true };
    assert.equal(classifyLoadFailure({ ...base, errorCode: -3 }), null);
    assert.equal(classifyLoadFailure({ ...base, errorCode: -105, isMainFrame: false }), null);
    assert.equal(classifyLoadFailure({ ...base, errorCode: -105, validatedURL: 'file:///x/tab-error.html' }), null);
    assert.equal(classifyLoadFailure({ ...base, errorCode: 0 }), null);
  });

  it("n'affiche « planté » que pour un arrêt anormal", () => {
    assert.equal(isTabCrash({ reason: 'crashed' }), true);
    assert.equal(isTabCrash({ reason: 'oom' }), true);
    assert.equal(isTabCrash({ reason: 'killed' }), true);
    assert.equal(isTabCrash({ reason: 'clean-exit' }), false);
    assert.equal(isTabCrash(null), false);
  });

  it("donne l'état du cadenas", () => {
    assert.equal(securityStateOf('https://bank.example/', null), 'secure');
    assert.equal(securityStateOf('http://blog.example/', null), 'insecure');
    assert.equal(securityStateOf('http://localhost:3001/', null), 'local');
    assert.equal(securityStateOf('http://app.localhost/', null), 'local');
    assert.equal(securityStateOf('http://127.0.0.1:8080/', null), 'local');
    assert.equal(securityStateOf('https://bad.example/', { kind: 'certificate' }), 'dangerous');
    assert.equal(securityStateOf('https://x.example/', { kind: 'crashed' }), null);
    assert.equal(securityStateOf('', null), null);
  });

  it('ne passe que du texte à la page', () => {
    assert.deepEqual(
      errorPageQuery({ kind: 'network', url: 'https://x.example:8443/a', code: 'ERR_X', message: 'msg' }),
      { kind: 'network', url: 'https://x.example:8443/a', host: 'x.example:8443', code: 'ERR_X', message: 'msg' },
    );
    assert.deepEqual(errorPageQuery({ kind: 'crashed', url: '', reason: 'oom' }), {
      kind: 'crashed',
      url: '',
      host: '',
      reason: 'oom',
    });
  });
});
