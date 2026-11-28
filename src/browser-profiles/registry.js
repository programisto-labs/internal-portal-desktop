'use strict';

/**
 * Sessions et fichiers des profils de navigation (docs/browser-profiles.md), partagés par toutes les fenêtres :
 * deux fenêtres sur le même contexte ont la même session Electron et les mêmes fichiers.
 *
 * Electron et les fabriques de fichiers sont injectés (tests : scripts/test-browser-profiles.js).
 */

const path = require('path');
const { LEGACY_BROWSER_PARTITION, DEFAULT_PROFILE_ID, migrateLegacyCookies } = require('./context');

function createBrowserProfileRegistry({
  fromPartition,
  legacy,
  createHistoryStore,
  createSitePermissionStore,
  createExternalAppPermissionStore,
  migrated,
  attachDownloads,
  log = () => {},
}) {
  /** profileKey → fichiers d'un profil autre que celui par défaut. */
  const profileStores = new Map();
  /** partition → promesse « session prête » (anciens cookies copiés). */
  const readiness = new Map();
  /** Sessions dont les téléchargements sont déjà suivis (jamais deux fois : chaque fichier serait listé en double). */
  const attached = new Set();

  function storesFor(context) {
    if (!context || context.profileId === DEFAULT_PROFILE_ID || !context.dataDir) {
      return {
        history: legacy.history(),
        sitePermissions: legacy.sitePermissions(),
        externalAppPermissions: legacy.externalAppPermissions(),
      };
    }
    let stores = profileStores.get(context.profileKey);
    if (!stores) {
      stores = {
        history: createHistoryStore({ filePath: path.join(context.dataDir, 'history.json') }),
        sitePermissions: createSitePermissionStore({ filePath: path.join(context.dataDir, 'site-permissions.json') }),
        externalAppPermissions: createExternalAppPermissionStore({ filePath: path.join(context.dataDir, 'external-apps.json') }),
      };
      profileStores.set(context.profileKey, stores);
    }
    return stores;
  }

  function partitionOf(context) {
    return context ? context.partition : LEGACY_BROWSER_PARTITION;
  }

  function readyFor(context) {
    if (!context || !context.isDefault) return null;
    let ready = readiness.get(context.partition);
    if (!ready) {
      ready = migrateLegacyCookies({
        context,
        legacySession: fromPartition(LEGACY_BROWSER_PARTITION),
        targetSession: fromPartition(context.partition),
        migrated,
      }).then(
        (result) => {
          if (!result.skipped) log(`[browser-profiles] ${result.copied} cookies repris dans ${context.workspace}`);
        },
        (error) => log(`[browser-profiles] reprise des cookies : ${error && error.message}`),
      );
      readiness.set(context.partition, ready);
    }
    return ready;
  }

  /** Options du gestionnaire d'onglets d'une fenêtre sur ce contexte (null = session d'avant les profils). */
  function managerOptions(context) {
    const stores = storesFor(context);
    const partition = partitionOf(context);
    return {
      partition,
      history: stores.history,
      sitePermissions: stores.sitePermissions,
      externalAppPermissions: stores.externalAppPermissions,
      sessionReady: readyFor(context),
      onSessionCreated: (ses) => attachOnce(ses, { profileId: context ? context.profileId : DEFAULT_PROFILE_ID, partition }),
    };
  }

  function attachOnce(ses, meta) {
    if (!ses || attached.has(ses)) return;
    attached.add(ses);
    if (typeof attachDownloads === 'function') attachDownloads(ses, meta);
  }

  return {
    storesFor,
    managerOptions,
    attachOnce,
    flushAll() {
      for (const stores of profileStores.values()) stores.history.flush();
    },
  };
}

module.exports = { createBrowserProfileRegistry };
