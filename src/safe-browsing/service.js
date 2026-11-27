'use strict';

/**
 * Protection contre les sites dangereux (docs/safe-browsing.md) : client du protocole Google Safe
 * Browsing v4 « Update API ».
 *
 * - Les listes (hameçonnage, logiciels malveillants, logiciels indésirables) sont téléchargées
 *   sous forme de préfixes de hachage et gardées sur le disque, mises à jour au rythme demandé par
 *   le serveur (`minimumWaitDuration`, 30 min par défaut).
 * - Une adresse est hachée sur l'ordinateur ; seuls les rares préfixes présents dans la liste
 *   (4 octets) sont envoyés pour obtenir les hachages complets. L'adresse n'est jamais envoyée.
 * - Jamais bloquant : listes indisponibles, serveur injoignable ou clé absente → la page s'ouvre,
 *   l'échec est seulement journalisé.
 *
 * deps :
 * - transport(method, body) → Promise<object> : POST `threatListUpdates:fetch` / `fullHashes:find`
 *   (relais de l'API Lasco ou Google directement, voir createSafeBrowsingTransport).
 * - storage : { load() → object | null, save(object) } (fichier de userData).
 * - isEnabled() : Réglages > Confidentialité, « Protection contre les sites dangereux ».
 */

const { PrefixSet } = require('./prefix-set');
const { urlFullHashes, canonicalizeUrl } = require('./url-hashes');

const THREAT_LISTS = [
  { threatType: 'MALWARE', platformType: 'ANY_PLATFORM', threatEntryType: 'URL' },
  { threatType: 'SOCIAL_ENGINEERING', platformType: 'ANY_PLATFORM', threatEntryType: 'URL' },
  { threatType: 'UNWANTED_SOFTWARE', platformType: 'ANY_PLATFORM', threatEntryType: 'URL' },
];

/** Menace → page d'avertissement (le plus grave d'abord, comme Chrome). */
const THREAT_KINDS = {
  MALWARE: 'malware',
  SOCIAL_ENGINEERING: 'phishing',
  UNWANTED_SOFTWARE: 'unwanted',
};
const THREAT_PRIORITY = ['malware', 'phishing', 'unwanted'];

const DEFAULT_WAIT_MS = 30 * 60 * 1000;
const MAX_BACKOFF_MS = 8 * 60 * 60 * 1000;
const FIRST_UPDATE_DELAY_MS = 5 * 1000;
const DEFAULT_CACHE_MS = 5 * 60 * 1000;
const FULL_HASH_TIMEOUT_MS = 5 * 1000;
const MAX_CACHE_ENTRIES = 5000;

function listKey(list) {
  return `${list.threatType}/${list.platformType}/${list.threatEntryType}`;
}

/** `"123.45s"` → millisecondes. */
function parseDuration(value, fallback) {
  const match = /^(\d+(?:\.\d+)?)s$/.exec(String(value || ''));
  return match ? Math.round(Number(match[1]) * 1000) : fallback;
}

function threatKind(threatType) {
  return THREAT_KINDS[threatType] || null;
}

function worstThreat(kinds) {
  for (const kind of THREAT_PRIORITY) if (kinds.includes(kind)) return kind;
  return null;
}

/** Hôte retenu pour « Continuer vers ce site » (sans « www. »). */
function allowanceHost(url) {
  const canonical = canonicalizeUrl(url);
  return canonical ? canonical.host.replace(/^www\./, '') : '';
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), ms);
      if (timer.unref) timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

function createSafeBrowsingService({
  transport,
  storage,
  isEnabled = () => true,
  now = () => Date.now(),
  log = (...args) => console.warn('[safe-browsing]', ...args),
  setTimer = (fn, ms) => {
    const handle = setTimeout(fn, ms);
    if (handle.unref) handle.unref();
    return handle;
  },
  clearTimer = (handle) => clearTimeout(handle),
}) {
  /** key → { list, state, prefixes: PrefixSet } */
  const lists = new Map();
  for (const list of THREAT_LISTS) lists.set(listKey(list), { list, state: '', prefixes: new PrefixSet() });
  /** Hachage complet (hex) → { kinds, expiresAt } */
  const positiveCache = new Map();
  /** Préfixe (hex) → expiresAt : aucun hachage complet dangereux pour ce préfixe. */
  const negativeCache = new Map();
  /** Hôtes ouverts malgré l'avertissement, jusqu'à la fin de la session. */
  const allowedHosts = new Set();
  /** Vérifications en cours, une seule par adresse. */
  const pendingChecks = new Map();

  let nextUpdateAt = 0;
  let fullHashBackoffUntil = 0;
  let failures = 0;
  let timer = null;
  let updating = null;
  let started = false;

  function restore() {
    let data = null;
    try {
      data = storage.load();
    } catch (error) {
      log('lecture des listes impossible', error && error.message);
    }
    if (!data || typeof data !== 'object' || !data.lists) return;
    for (const [key, saved] of Object.entries(data.lists)) {
      const entry = lists.get(key);
      if (!entry || !saved || typeof saved.state !== 'string') continue;
      const prefixes = PrefixSet.deserialize(saved.prefixes);
      // Un fichier abîmé ne doit jamais servir : contrôle du checksum enregistré.
      if (saved.checksum && prefixes.checksum().toString('base64') !== saved.checksum) continue;
      entry.state = saved.state;
      entry.prefixes = prefixes;
    }
    if (Number.isFinite(data.nextUpdateAt)) nextUpdateAt = data.nextUpdateAt;
  }

  function persist() {
    const out = { version: 1, nextUpdateAt, lists: {} };
    for (const [key, entry] of lists) {
      out.lists[key] = {
        state: entry.state,
        checksum: entry.prefixes.checksum().toString('base64'),
        prefixes: entry.prefixes.serialize(),
      };
    }
    try {
      storage.save(out);
    } catch (error) {
      log('enregistrement des listes impossible', error && error.message);
    }
  }

  function applyListUpdate(response) {
    const key = listKey(response);
    const entry = lists.get(key);
    if (!entry) return;
    const prefixes = response.responseType === 'FULL_UPDATE' ? new PrefixSet() : entry.prefixes;
    for (const removal of response.removals || []) {
      if (removal.compressionType && removal.compressionType !== 'RAW') throw new Error('unsupported-compression');
      prefixes.removeIndices((removal.rawIndices && removal.rawIndices.indices) || []);
    }
    for (const addition of response.additions || []) {
      if (addition.compressionType && addition.compressionType !== 'RAW') throw new Error('unsupported-compression');
      const raw = addition.rawHashes || {};
      prefixes.addRaw(raw.prefixSize, Buffer.from(String(raw.rawHashes || ''), 'base64'));
    }
    const expected = response.checksum && response.checksum.sha256;
    if (expected && prefixes.checksum().toString('base64') !== expected) {
      // Désynchronisé : repartir d'une liste complète au prochain passage.
      entry.state = '';
      entry.prefixes = new PrefixSet();
      throw new Error(`checksum-mismatch ${key}`);
    }
    entry.prefixes = prefixes;
    entry.state = String(response.newClientState || '');
  }

  async function update() {
    if (updating) return updating;
    updating = (async () => {
      const body = {
        listUpdateRequests: [...lists.values()].map(({ list, state }) => ({
          ...list,
          state,
          constraints: { supportedCompressions: ['RAW'] },
        })),
      };
      try {
        const res = await transport('threatListUpdates:fetch', body);
        let mismatch = false;
        for (const response of (res && res.listUpdateResponses) || []) {
          try {
            applyListUpdate(response);
          } catch (error) {
            mismatch = true;
            log('mise à jour refusée', error && error.message);
          }
        }
        failures = 0;
        // Après un checksum faux, la liste complète est redemandée sans attendre 30 min.
        const wait = mismatch ? 60 * 1000 : parseDuration(res && res.minimumWaitDuration, DEFAULT_WAIT_MS);
        nextUpdateAt = now() + Math.max(wait, 60 * 1000);
        // Les hachages complets en cache valent pour l'ancienne liste.
        negativeCache.clear();
        persist();
      } catch (error) {
        failures += 1;
        // Retour exponentiel du protocole : 15 min × 2^n, 8 h au plus.
        const backoff = Math.min(MAX_BACKOFF_MS, 15 * 60 * 1000 * 2 ** Math.min(failures - 1, 5));
        nextUpdateAt = now() + backoff;
        log('listes indisponibles, nouvel essai plus tard', error && error.message);
      } finally {
        updating = null;
        schedule();
      }
    })();
    return updating;
  }

  function schedule() {
    if (timer) clearTimer(timer);
    timer = null;
    if (!started) return;
    const delay = Math.max(FIRST_UPDATE_DELAY_MS, nextUpdateAt - now());
    timer = setTimer(() => {
      timer = null;
      if (isEnabled()) void update();
      else {
        nextUpdateAt = now() + DEFAULT_WAIT_MS;
        schedule();
      }
    }, delay);
  }

  function start() {
    if (started) return;
    started = true;
    restore();
    schedule();
  }

  function stop() {
    started = false;
    if (timer) clearTimer(timer);
    timer = null;
  }

  function ready() {
    for (const entry of lists.values()) if (entry.state) return true;
    return false;
  }

  function prune(map) {
    if (map.size <= MAX_CACHE_ENTRIES) return;
    const t = now();
    for (const [key, value] of map) {
      const expiresAt = typeof value === 'number' ? value : value.expiresAt;
      if (expiresAt <= t) map.delete(key);
    }
    while (map.size > MAX_CACHE_ENTRIES) map.delete(map.keys().next().value);
  }

  /**
   * Décision immédiate, sans réseau :
   * - `{ verdict: 'safe' }` : rien dans les listes (ou protection coupée, site autorisé, listes absentes) ;
   * - `{ verdict: 'dangerous', threat }` : hachage complet connu comme dangereux ;
   * - `{ verdict: 'check', prefixes }` : un préfixe correspond, à confirmer avec `check(url)`.
   */
  function classify(url) {
    if (!isEnabled() || !ready()) return { verdict: 'safe' };
    const host = allowanceHost(url);
    if (!host || allowedHosts.has(host)) return { verdict: 'safe' };
    const t = now();
    const kinds = [];
    const unresolved = [];
    for (const fullHash of urlFullHashes(url)) {
      const cached = positiveCache.get(fullHash.toString('hex'));
      if (cached && cached.expiresAt > t) {
        kinds.push(...cached.kinds);
        continue;
      }
      for (const entry of lists.values()) {
        const prefix = entry.prefixes.match(fullHash);
        if (!prefix) continue;
        const negative = negativeCache.get(prefix.toString('hex'));
        if (negative && negative > t) continue;
        if (!unresolved.some((item) => item.equals(prefix))) unresolved.push(prefix);
      }
    }
    const threat = worstThreat(kinds);
    if (threat) return { verdict: 'dangerous', threat };
    if (unresolved.length) return { verdict: 'check', prefixes: unresolved };
    return { verdict: 'safe' };
  }

  async function findFullHashes(prefixes) {
    if (now() < fullHashBackoffUntil) throw new Error('backoff');
    const body = {
      clientStates: [...lists.values()].map((entry) => entry.state).filter(Boolean),
      threatInfo: {
        threatTypes: THREAT_LISTS.map((list) => list.threatType),
        platformTypes: ['ANY_PLATFORM'],
        threatEntryTypes: ['URL'],
        threatEntries: prefixes.map((prefix) => ({ hash: prefix.toString('base64') })),
      },
    };
    let res;
    try {
      res = await withTimeout(transport('fullHashes:find', body), FULL_HASH_TIMEOUT_MS);
    } catch (error) {
      fullHashBackoffUntil = now() + 60 * 1000;
      throw error;
    }
    const t = now();
    for (const match of (res && res.matches) || []) {
      const kind = threatKind(match.threatType);
      const hash = match.threat && match.threat.hash;
      if (!kind || typeof hash !== 'string') continue;
      const key = Buffer.from(hash, 'base64').toString('hex');
      const previous = positiveCache.get(key);
      const kinds = previous && previous.expiresAt > t ? [...new Set([...previous.kinds, kind])] : [kind];
      positiveCache.set(key, { kinds, expiresAt: t + parseDuration(match.cacheDuration, DEFAULT_CACHE_MS) });
    }
    const negativeUntil = t + parseDuration(res && res.negativeCacheDuration, DEFAULT_CACHE_MS);
    for (const prefix of prefixes) negativeCache.set(prefix.toString('hex'), negativeUntil);
    prune(positiveCache);
    prune(negativeCache);
  }

  /**
   * Décision complète : `{ verdict: 'safe' }` ou `{ verdict: 'dangerous', threat }`. Serveur
   * injoignable → 'safe' (jamais bloquant), avec `unverified: true`.
   */
  async function check(url) {
    const first = classify(url);
    if (first.verdict !== 'check') return first;
    const key = String(url);
    if (pendingChecks.has(key)) return pendingChecks.get(key);
    const run = (async () => {
      try {
        await findFullHashes(first.prefixes);
      } catch (error) {
        log('vérification impossible, page ouverte', error && error.message);
        return { verdict: 'safe', unverified: true };
      }
      const second = classify(url);
      return second.verdict === 'dangerous' ? second : { verdict: 'safe' };
    })().finally(() => pendingChecks.delete(key));
    pendingChecks.set(key, run);
    return run;
  }

  /** « Continuer vers ce site (non recommandé) » : retenu pour l'hôte jusqu'à la fin de la session. */
  function allowForSession(url) {
    const host = allowanceHost(url);
    if (host) allowedHosts.add(host);
    return Boolean(host);
  }

  function isAllowed(url) {
    const host = allowanceHost(url);
    return Boolean(host) && allowedHosts.has(host);
  }

  function status() {
    let prefixes = 0;
    for (const entry of lists.values()) prefixes += entry.prefixes.size;
    return { enabled: isEnabled(), ready: ready(), prefixes, nextUpdateAt, failures };
  }

  return { start, stop, update, classify, check, allowForSession, isAllowed, status };
}

module.exports = {
  createSafeBrowsingService,
  THREAT_LISTS,
  parseDuration,
  allowanceHost,
};
