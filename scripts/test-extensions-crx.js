'use strict';

/** Paquets CRX3 (docs/extensions.md, « Paquets vérifiés ») : signatures, identifiant, archive. */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');
const {
  extensionIdFromPublicKey,
  parseAndVerifyCrx,
  safeEntryPath,
  unpackArchive,
  WEBSTORE_PUBLISHER_KEY_HASH,
} = require('../src/extensions/crx');

// --- Écriture protobuf minimale (champs de longueur) ---
function varint(n) {
  const out = [];
  let v = BigInt(n);
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return Buffer.from(out);
}
function field(number, bytes) {
  return Buffer.concat([varint((number << 3) | 2), varint(bytes.length), bytes]);
}

function makeKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { der: publicKey.export({ type: 'spki', format: 'der' }), privateKey };
}

function makeZip(files) {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) zip.addFile(name, Buffer.from(content));
  return zip.toBuffer();
}

/** CRX3 signé par `keys` ; `idKey` donne l'identifiant déclaré. */
function buildCrx({ archive, keys, idKey, tamper = null }) {
  const crxId = crypto.createHash('sha256').update(idKey.der).digest().subarray(0, 16);
  const signedHeaderData = field(1, crxId);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(signedHeaderData.length, 0);
  const message = Buffer.concat([Buffer.from('CRX3 SignedData\x00', 'binary'), len, signedHeaderData, archive]);
  const proofs = keys.map((key) =>
    field(2, Buffer.concat([field(1, key.der), field(2, crypto.sign('sha256', message, key.privateKey))])),
  );
  const header = Buffer.concat([...proofs, field(10000, signedHeaderData)]);
  const prefix = Buffer.alloc(12);
  prefix.write('Cr24', 0, 'binary');
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(header.length, 8);
  return Buffer.concat([prefix, header, tamper ? tamper(archive) : archive]);
}

const developer = makeKey();
const other = makeKey();
const archive = makeZip({ 'manifest.json': JSON.stringify({ manifest_version: 3, name: 'Test', version: '1.0' }), 'bg.js': '//' });

describe('CRX3 : vérification', () => {
  it("accepte un paquet signé par la clé de l'identifiant (sans preuve du store quand elle n'est pas exigée)", () => {
    const crx = buildCrx({ archive, keys: [developer], idKey: developer });
    const result = parseAndVerifyCrx(crx, { requirePublisherProof: false });
    assert.equal(result.extensionId, extensionIdFromPublicKey(developer.der));
    assert.match(result.extensionId, /^[a-p]{32}$/);
    assert.equal(result.publisherSigned, false);
  });

  it('exige la preuve de publication du Chrome Web Store par défaut', () => {
    const crx = buildCrx({ archive, keys: [developer], idKey: developer });
    assert.throws(() => parseAndVerifyCrx(crx), { code: 'crx_publisher_signature_missing' });
    assert.equal(WEBSTORE_PUBLISHER_KEY_HASH.length, 32);
  });

  it('refuse une archive modifiée après signature', () => {
    const crx = buildCrx({ archive, keys: [developer], idKey: developer, tamper: (a) => Buffer.concat([a, Buffer.from('x')]) });
    assert.throws(() => parseAndVerifyCrx(crx, { requirePublisherProof: false }), { code: 'crx_signature_invalid' });
  });

  it("refuse un paquet sans signature de la clé de l'identifiant déclaré", () => {
    const crx = buildCrx({ archive, keys: [other], idKey: developer });
    assert.throws(() => parseAndVerifyCrx(crx, { requirePublisherProof: false }), { code: 'crx_developer_signature_missing' });
  });

  it("refuse un identifiant différent de celui demandé", () => {
    const crx = buildCrx({ archive, keys: [developer], idKey: developer });
    assert.throws(
      () => parseAndVerifyCrx(crx, { expectedId: 'a'.repeat(32), requirePublisherProof: false }),
      { code: 'crx_id_mismatch' },
    );
  });

  it('refuse CRX2, un fichier tronqué ou étranger', () => {
    const crx2 = Buffer.alloc(16);
    crx2.write('Cr24', 0, 'binary');
    crx2.writeUInt32LE(2, 4);
    assert.throws(() => parseAndVerifyCrx(crx2), { code: 'crx_version_unsupported' });
    assert.throws(() => parseAndVerifyCrx(Buffer.from('PK\x03\x04 not a crx')), { code: 'crx_invalid' });
    const crx = buildCrx({ archive, keys: [developer], idKey: developer });
    assert.throws(() => parseAndVerifyCrx(crx.subarray(0, 40)), (e) => /crx_/.test(e.code));
  });

  it('vérifie un vrai paquet du Chrome Web Store quand il est fourni (LASCO_TEST_CRX)', { skip: !process.env.LASCO_TEST_CRX }, () => {
    const result = parseAndVerifyCrx(fs.readFileSync(process.env.LASCO_TEST_CRX));
    assert.equal(result.publisherSigned, true);
  });
});

describe('CRX3 : décompression', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lasco-crx-'));

  it('rejette les chemins qui sortent du dossier', () => {
    const dest = '/tmp/x';
    assert.equal(safeEntryPath(dest, '../evil'), null);
    assert.equal(safeEntryPath(dest, 'a/../../evil'), null);
    assert.equal(safeEntryPath(dest, '/etc/passwd'), null);
    assert.equal(safeEntryPath(dest, 'C:\\evil'), null);
    assert.equal(safeEntryPath(dest, 'js\\..\\..\\evil'), null);
    assert.equal(safeEntryPath(dest, 'js/app.js'), path.resolve(dest, 'js', 'app.js'));
  });

  it('décompresse une archive saine et lit son manifeste', () => {
    const dest = path.join(tmp(), 'ext');
    const manifest = unpackArchive(archive, dest);
    assert.equal(manifest.name, 'Test');
    assert.ok(fs.existsSync(path.join(dest, 'bg.js')));
  });

  it("n'écrit rien d'une archive contenant un chemin sortant", () => {
    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from('{}'));
    zip.addFile('ok.txt', Buffer.from('x'));
    zip.getEntries()[1].entryName = '../evil.txt';
    const root = tmp();
    const dest = path.join(root, 'ext');
    assert.throws(() => unpackArchive(zip.toBuffer(), dest), { code: 'crx_archive_unsafe_path' });
    assert.equal(fs.existsSync(path.join(root, 'evil.txt')), false);
    assert.equal(fs.existsSync(dest), false);
  });

  it('refuse un lien symbolique dans l’archive', () => {
    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from('{}'));
    zip.addFile('link', Buffer.from('/etc/passwd'));
    zip.getEntries()[1].header.attr = (0o120777 << 16) >>> 0;
    assert.throws(() => unpackArchive(zip.toBuffer(), path.join(tmp(), 'ext')), { code: 'crx_archive_symlink' });
  });
});
