'use strict';

/**
 * Worker du bloqueur (docs/adblock.md) : télécharge EasyList + EasyPrivacy (et les listes uBlock
 * associées), compile le moteur Ghostery et renvoie sa forme sérialisée au processus principal.
 * Le parsage prend une à deux secondes : hors du processus principal, la fenêtre ne gèle jamais.
 */

const { parentPort } = require('worker_threads');
const { FiltersEngine, adsAndTrackingLists } = require('@ghostery/adblocker');

async function compile() {
  const engine = await FiltersEngine.fromLists(fetch, adsAndTrackingLists, {
    loadNetworkFilters: true,
    loadCosmeticFilters: true,
    enableMutationObserver: true,
  });
  return engine.serialize();
}

compile().then(
  (bytes) => {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    parentPort.postMessage({ ok: true, bytes: buffer }, [buffer]);
  },
  (error) => parentPort.postMessage({ ok: false, error: String((error && error.message) || error) }),
);
