'use strict';

/**
 * Transport du protocole Safe Browsing v4 (docs/safe-browsing.md).
 *
 * Par défaut, le relais de l'API Lasco (`<portail>/__proxy_api/safe-browsing/v4/…`) : la clé
 * d'API reste sur le serveur, et l'API peut changer de fournisseur (Web Risk) sans nouvelle
 * version de Desktop. En développement, `LASCO_SAFE_BROWSING_API_KEY` parle directement à Google
 * et `LASCO_SAFE_BROWSING_URL` remplace l'adresse du relais.
 *
 * Ce qui part : l'état des listes et, pour une adresse dont un préfixe correspond, ce préfixe de
 * 4 octets. Jamais l'adresse, jamais de cookie.
 */

const GOOGLE_V4 = 'https://safebrowsing.googleapis.com/v4';
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/** Méthode du protocole → chemin du relais (pas de « : » dans les routes de l'API). */
const RELAY_PATHS = {
  'threatListUpdates:fetch': 'threat-list-updates',
  'fullHashes:find': 'full-hashes',
};

function resolveEndpoint({ portalOrigin, env = process.env }) {
  const key = String(env.LASCO_SAFE_BROWSING_API_KEY || '').trim();
  if (key) return { kind: 'google', base: GOOGLE_V4, key };
  const override = String(env.LASCO_SAFE_BROWSING_URL || '').trim();
  if (override) return { kind: 'relay', base: override.replace(/\/+$/, '') };
  return { kind: 'relay', base: `${String(portalOrigin).replace(/\/+$/, '')}/__proxy_api/safe-browsing/v4` };
}

function methodUrl(endpoint, method) {
  if (endpoint.kind === 'google') return `${endpoint.base}/${method}?key=${encodeURIComponent(endpoint.key)}`;
  const path = RELAY_PATHS[method];
  if (!path) throw new Error(`unknown-method ${method}`);
  return `${endpoint.base}/${path}`;
}

function createSafeBrowsingTransport({ fetch, endpoint, clientVersion }) {
  const client = { clientId: 'lasco-desktop', clientVersion: String(clientVersion || '0') };
  return async function transport(method, body) {
    const res = await fetch(methodUrl(endpoint, method), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client, ...body }),
      credentials: 'omit',
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`http-${res.status}`);
    const length = Number(res.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new Error('response-too-large');
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new Error('response-too-large');
    return text ? JSON.parse(text) : {};
  };
}

/** Fichier JSON de userData, écrit d'un coup (fichier temporaire puis renommage). */
function createFileStorage({ fs, filePath }) {
  return {
    load() {
      try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (error) {
        if (error && error.code === 'ENOENT') return null;
        throw error;
      }
    },
    save(data) {
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, filePath);
    },
  };
}

module.exports = { resolveEndpoint, methodUrl, createSafeBrowsingTransport, createFileStorage, RELAY_PATHS };
