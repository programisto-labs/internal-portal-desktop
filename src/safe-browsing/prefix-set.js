'use strict';

/**
 * Préfixes de hachage d'une liste Safe Browsing (protocole v4 « Update API »), triés comme le
 * serveur les compte : ordre lexicographique de tous les préfixes, toutes tailles confondues.
 *
 * Presque tous les préfixes font 4 octets : ils sont gardés dans un Uint32Array trié (4 Mo pour un
 * million de préfixes). Les autres tailles (5 à 32 octets, rares) dans un tableau de Buffer.
 */

const crypto = require('crypto');

function compareBuffers(a, b) {
  return Buffer.compare(a, b);
}

class PrefixSet {
  constructor() {
    /** @type {Uint32Array} */
    this.short = new Uint32Array(0);
    /** @type {Buffer[]} préfixes de 5 à 32 octets, triés */
    this.long = [];
  }

  get size() {
    return this.short.length + this.long.length;
  }

  clear() {
    this.short = new Uint32Array(0);
    this.long = [];
  }

  /** Préfixes dans l'ordre du serveur (fusion des deux tableaux triés). */
  *entries() {
    let i = 0;
    let j = 0;
    const word = Buffer.alloc(4);
    while (i < this.short.length || j < this.long.length) {
      if (i < this.short.length) word.writeUInt32BE(this.short[i], 0);
      const takeShort = j >= this.long.length || (i < this.short.length && compareBuffers(word, this.long[j]) <= 0);
      if (takeShort) {
        yield { kind: 'short', index: i, bytes: Buffer.from(word) };
        i += 1;
      } else {
        yield { kind: 'long', index: j, bytes: this.long[j] };
        j += 1;
      }
    }
  }

  /** Retire les préfixes aux positions données (indices de l'ordre du serveur). */
  removeIndices(indices) {
    if (!indices || !indices.length) return;
    const wanted = new Set(indices.map(Number));
    const keepShort = [];
    const keepLong = [];
    let position = 0;
    for (const entry of this.entries()) {
      if (!wanted.has(position)) {
        if (entry.kind === 'short') keepShort.push(this.short[entry.index]);
        else keepLong.push(entry.bytes);
      }
      position += 1;
    }
    this.short = Uint32Array.from(keepShort);
    this.long = keepLong;
  }

  /** Ajoute des préfixes bruts (`prefixSize` octets chacun, concaténés). */
  addRaw(prefixSize, raw) {
    const size = Number(prefixSize);
    if (!Buffer.isBuffer(raw) || !Number.isInteger(size) || size < 4 || size > 32 || raw.length % size !== 0) {
      throw new Error('invalid-raw-hashes');
    }
    const count = raw.length / size;
    if (size === 4) {
      const next = new Uint32Array(this.short.length + count);
      next.set(this.short, 0);
      for (let k = 0; k < count; k += 1) next[this.short.length + k] = raw.readUInt32BE(k * 4);
      next.sort();
      this.short = next;
      return;
    }
    for (let k = 0; k < count; k += 1) this.long.push(Buffer.from(raw.subarray(k * size, (k + 1) * size)));
    this.long.sort(compareBuffers);
  }

  /** SHA-256 de tous les préfixes concaténés dans l'ordre du serveur (contrôle de la mise à jour). */
  checksum() {
    const hash = crypto.createHash('sha256');
    for (const entry of this.entries()) hash.update(entry.bytes);
    return hash.digest();
  }

  /** Préfixe de `fullHash` (32 octets) présent dans la liste, ou null. */
  match(fullHash) {
    if (!Buffer.isBuffer(fullHash) || fullHash.length < 4) return null;
    const word = fullHash.readUInt32BE(0);
    let lo = 0;
    let hi = this.short.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const value = this.short[mid];
      if (value === word) return Buffer.from(fullHash.subarray(0, 4));
      if (value < word) lo = mid + 1;
      else hi = mid - 1;
    }
    for (const prefix of this.long) {
      if (prefix.length <= fullHash.length && fullHash.subarray(0, prefix.length).equals(prefix)) return prefix;
    }
    return null;
  }

  /** Forme enregistrée sur le disque. */
  serialize() {
    return {
      short: Buffer.from(this.short.buffer, this.short.byteOffset, this.short.byteLength).toString('base64'),
      long: this.long.map((prefix) => prefix.toString('base64')),
    };
  }

  static deserialize(data) {
    const set = new PrefixSet();
    if (!data || typeof data !== 'object') return set;
    const raw = typeof data.short === 'string' ? Buffer.from(data.short, 'base64') : Buffer.alloc(0);
    if (raw.length % 4 === 0) {
      // Copie alignée (Buffer.from(base64) peut ne pas être aligné sur 4 octets).
      const copy = new Uint8Array(raw.length);
      copy.set(raw);
      set.short = new Uint32Array(copy.buffer);
    }
    if (Array.isArray(data.long)) {
      set.long = data.long
        .filter((item) => typeof item === 'string')
        .map((item) => Buffer.from(item, 'base64'))
        .filter((prefix) => prefix.length >= 5 && prefix.length <= 32)
        .sort(compareBuffers);
    }
    return set;
  }
}

module.exports = { PrefixSet };
