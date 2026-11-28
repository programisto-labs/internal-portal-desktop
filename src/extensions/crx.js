'use strict';

/**
 * Paquets CRX3 des extensions Chrome (docs/extensions.md, « Paquets vérifiés »).
 *
 * Format : `Cr24`, version 3 (uint32 LE), taille de l'en-tête (uint32 LE), en-tête
 * `CrxFileHeader` (protobuf), puis l'archive zip. Chaque preuve de l'en-tête signe
 * `"CRX3 SignedData\0" + len(signed_header_data) (uint32 LE) + signed_header_data + archive`.
 * L'identifiant de l'extension = 16 premiers octets du SHA-256 de sa clé publique, écrits avec
 * l'alphabet a-p. Comme Chrome (components/crx_file/crx_verifier.cc) :
 * - une preuve doit venir de la clé dont l'identifiant est `signed_header_data.crx_id` ;
 * - un paquet du Chrome Web Store doit aussi porter la preuve de la clé de publication de Google ;
 * - toutes les preuves présentes doivent être valides.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CRX_MAGIC = 'Cr24';
const SIGNATURE_CONTEXT = Buffer.from('CRX3 SignedData\x00', 'binary');
/** SHA-256 de la clé publique de publication du Chrome Web Store (kPublisherKeyHash de Chrome). */
const WEBSTORE_PUBLISHER_KEY_HASH = Buffer.from([
  0x61, 0xf7, 0xf2, 0xa6, 0xbf, 0xcf, 0x74, 0xcd, 0x0b, 0xc1, 0xfe, 0x24, 0x97, 0xcc, 0x9b, 0x04, 0x25, 0x4c, 0x65,
  0x8f, 0x79, 0xf2, 0x14, 0x53, 0x92, 0x86, 0x7e, 0xa8, 0x36, 0x63, 0x67, 0xcf,
]);

/** Limites de décompression : un paquet hors norme est refusé plutôt que d'emplir le disque. */
const MAX_CRX_BYTES = 256 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 20000;

class CrxError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

// --- Protobuf minimal (varint et champs de longueur) ---

function readVarint(buf, state) {
  let result = 0n;
  let shift = 0n;
  for (let i = 0; i < 10; i += 1) {
    if (state.pos >= buf.length) throw new CrxError('crx_header_invalid');
    const byte = buf[state.pos];
    state.pos += 1;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return result;
    shift += 7n;
  }
  throw new CrxError('crx_header_invalid');
}

/** Champs d'un message : `[{ field, wire, value }]` (`value` : Buffer pour wire 2, BigInt sinon). */
function readMessage(buf) {
  const state = { pos: 0 };
  const fields = [];
  while (state.pos < buf.length) {
    const key = readVarint(buf, state);
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (wire === 0) fields.push({ field, wire, value: readVarint(buf, state) });
    else if (wire === 2) {
      const length = Number(readVarint(buf, state));
      if (length < 0 || state.pos + length > buf.length) throw new CrxError('crx_header_invalid');
      fields.push({ field, wire, value: buf.subarray(state.pos, state.pos + length) });
      state.pos += length;
    } else if (wire === 1) state.pos += 8;
    else if (wire === 5) state.pos += 4;
    else throw new CrxError('crx_header_invalid');
    if (state.pos > buf.length) throw new CrxError('crx_header_invalid');
  }
  return fields;
}

function readProof(bytes) {
  let publicKey = null;
  let signature = null;
  for (const { field, wire, value } of readMessage(bytes)) {
    if (wire !== 2) continue;
    if (field === 1) publicKey = value;
    else if (field === 2) signature = value;
  }
  return { publicKey, signature };
}

// --- Identifiants ---

/** Identifiant Chrome d'une clé publique (DER, Buffer ou base64). */
function extensionIdFromPublicKey(publicKey) {
  const der = Buffer.isBuffer(publicKey) ? publicKey : Buffer.from(String(publicKey), 'base64');
  const hex = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
  return hexToExtensionId(hex);
}

function hexToExtensionId(hex) {
  return [...hex].map((char) => String.fromCharCode('a'.charCodeAt(0) + parseInt(char, 16))).join('');
}

/** Identifiant d'une extension décompressée sans clé : SHA-256 de son chemin absolu, comme Chrome. */
function extensionIdFromPath(dirPath) {
  const hex = crypto.createHash('sha256').update(path.resolve(dirPath)).digest('hex').slice(0, 32);
  return hexToExtensionId(hex);
}

function isExtensionId(value) {
  return typeof value === 'string' && /^[a-p]{32}$/.test(value);
}

// --- Vérification ---

function verifyProof(proof, message, algorithm) {
  if (!proof.publicKey || !proof.signature) return false;
  try {
    const key = crypto.createPublicKey({ key: proof.publicKey, format: 'der', type: 'spki' });
    return crypto.verify(algorithm, message, key, proof.signature);
  } catch (_) {
    return false;
  }
}

/**
 * Lit et vérifie un CRX3. `expectedId` : identifiant attendu (installation depuis le store).
 * `requirePublisherProof` : exige la signature de Google (paquet du Chrome Web Store).
 * Renvoie `{ extensionId, publicKey (base64), archive (Buffer) }` ; lève `CrxError` sinon.
 */
function parseAndVerifyCrx(buffer, { expectedId = null, requirePublisherProof = true } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) throw new CrxError('crx_invalid');
  if (buffer.length > MAX_CRX_BYTES) throw new CrxError('crx_too_large');
  if (buffer.toString('binary', 0, 4) !== CRX_MAGIC) throw new CrxError('crx_invalid');
  const version = buffer.readUInt32LE(4);
  // CRX2 (sans preuve de publication) : refusé, comme Chrome depuis la version 75.
  if (version !== 3) throw new CrxError('crx_version_unsupported');
  const headerSize = buffer.readUInt32LE(8);
  if (12 + headerSize > buffer.length) throw new CrxError('crx_header_invalid');
  const header = buffer.subarray(12, 12 + headerSize);
  const archive = buffer.subarray(12 + headerSize);

  const rsa = [];
  const ecdsa = [];
  let signedHeaderData = null;
  for (const { field, wire, value } of readMessage(header)) {
    if (wire !== 2) continue;
    if (field === 2) rsa.push(readProof(value));
    else if (field === 3) ecdsa.push(readProof(value));
    else if (field === 10000) signedHeaderData = value;
  }
  if (!signedHeaderData) throw new CrxError('crx_header_invalid');
  let crxIdBytes = null;
  for (const { field, wire, value } of readMessage(signedHeaderData)) {
    if (field === 1 && wire === 2) crxIdBytes = value;
  }
  if (!crxIdBytes || crxIdBytes.length !== 16) throw new CrxError('crx_header_invalid');
  const declaredId = hexToExtensionId(crxIdBytes.toString('hex'));
  if (expectedId && declaredId !== expectedId) throw new CrxError('crx_id_mismatch');

  const lengthBytes = Buffer.alloc(4);
  lengthBytes.writeUInt32LE(signedHeaderData.length, 0);
  const message = Buffer.concat([SIGNATURE_CONTEXT, lengthBytes, signedHeaderData, archive]);

  let developerKey = null;
  let publisherSigned = false;
  const proofs = [
    ...rsa.map((proof) => ({ proof, algorithm: 'sha256' })),
    ...ecdsa.map((proof) => ({ proof, algorithm: 'sha256' })),
  ];
  if (proofs.length === 0) throw new CrxError('crx_signature_missing');
  for (const { proof, algorithm } of proofs) {
    if (!verifyProof(proof, message, algorithm)) throw new CrxError('crx_signature_invalid');
    const keyHash = crypto.createHash('sha256').update(proof.publicKey).digest();
    if (keyHash.equals(WEBSTORE_PUBLISHER_KEY_HASH)) publisherSigned = true;
    if (extensionIdFromPublicKey(proof.publicKey) === declaredId) developerKey = proof.publicKey;
  }
  // La clé du développeur doit être une preuve RSA (seul algorithme accepté par Chrome pour elle).
  if (!developerKey || !rsa.some((p) => p.publicKey && p.publicKey.equals(developerKey))) {
    throw new CrxError('crx_developer_signature_missing');
  }
  if (requirePublisherProof && !publisherSigned) throw new CrxError('crx_publisher_signature_missing');
  return { extensionId: declaredId, publicKey: developerKey.toString('base64'), archive, publisherSigned };
}

// --- Décompression ---

/** Chemin d'une entrée d'archive, ou null s'il sort du dossier (absolu, `..`, lecteur Windows). */
function safeEntryPath(destDir, entryName) {
  if (typeof entryName !== 'string' || !entryName) return null;
  const normalized = entryName.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return null;
  const parts = normalized.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.some((part) => part === '..' || part.includes('\0'))) return null;
  if (parts.length === 0) return null;
  const target = path.resolve(destDir, ...parts);
  const root = path.resolve(destDir) + path.sep;
  return target.startsWith(root) ? target : null;
}

/** Lien symbolique dans l'archive (attributs Unix S_IFLNK) : jamais extrait. */
function isSymlinkEntry(entry) {
  const attr = entry && entry.header && typeof entry.header.attr === 'number' ? entry.header.attr : 0;
  const mode = (attr >>> 16) & 0o170000;
  return mode === 0o120000;
}

/**
 * Décompresse l'archive d'un CRX dans `destDir` (créé, doit être vide). Refuse tout chemin qui sort
 * du dossier, les liens symboliques et les archives démesurées. Renvoie le manifeste lu.
 */
function unpackArchive(archive, destDir, { AdmZip = require('adm-zip'), fsImpl = fs } = {}) {
  let zip;
  try {
    zip = new AdmZip(archive);
  } catch (_) {
    throw new CrxError('crx_archive_invalid');
  }
  const entries = zip.getEntries();
  if (entries.length > MAX_ENTRIES) throw new CrxError('crx_archive_too_large');
  let total = 0;
  const plan = [];
  for (const entry of entries) {
    const target = safeEntryPath(destDir, entry.entryName);
    if (!target) throw new CrxError('crx_archive_unsafe_path', entry.entryName);
    if (isSymlinkEntry(entry)) throw new CrxError('crx_archive_symlink', entry.entryName);
    total += Number(entry.header && entry.header.size) || 0;
    if (total > MAX_UNPACKED_BYTES) throw new CrxError('crx_archive_too_large');
    plan.push({ entry, target });
  }
  fsImpl.mkdirSync(destDir, { recursive: true });
  for (const { entry, target } of plan) {
    if (entry.isDirectory) {
      fsImpl.mkdirSync(target, { recursive: true });
      continue;
    }
    fsImpl.mkdirSync(path.dirname(target), { recursive: true });
    const data = entry.getData();
    fsImpl.writeFileSync(target, data, { flag: 'wx' });
  }
  const manifestPath = path.join(destDir, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(stripBom(fsImpl.readFileSync(manifestPath, 'utf8')));
  } catch (_) {
    throw new CrxError('manifest_invalid');
  }
  if (!manifest || typeof manifest !== 'object') throw new CrxError('manifest_invalid');
  return manifest;
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

module.exports = {
  CrxError,
  WEBSTORE_PUBLISHER_KEY_HASH,
  extensionIdFromPublicKey,
  extensionIdFromPath,
  hexToExtensionId,
  isExtensionId,
  parseAndVerifyCrx,
  readMessage,
  safeEntryPath,
  stripBom,
  unpackArchive,
};
