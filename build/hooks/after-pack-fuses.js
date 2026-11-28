'use strict';

/**
 * Fusibles d'Electron (docs/security.md, « Fusibles ») : options figées dans le binaire, posées
 * après l'empaquetage et avant la signature (electron-builder `afterPack`).
 *
 * - `EnableNodeOptionsEnvironmentVariable` / `EnableNodeCliInspectArguments` : coupés. Sinon
 *   `NODE_OPTIONS=--require …` ou `--inspect` lancerait du code dans Lasco, avec ses autorisations
 *   macOS (micro, caméra, accès complet au disque pour l'import Safari).
 * - `OnlyLoadAppFromAsar` + `EnableEmbeddedAsarIntegrityValidation` (macOS) : l'app ne charge que
 *   son `app.asar`, dont l'empreinte est vérifiée (Info.plist `ElectronAsarIntegrity`, écrit par
 *   electron-builder). Windows : electron-builder 25 n'écrit pas l'empreinte, la validation y
 *   bloquerait le lancement ; elle viendra avec electron-builder 26 (`electronFuses`).
 * - `EnableCookieEncryption` : PAS ENCORE. Il fait lire la clé « Lasco Safe Storage » du trousseau avant
 *   le premier chargement ; sur un build non signé, la page attend indéfiniment la réponse du trousseau
 *   (vérifié le 28/11/2026). À activer après un essai sur un build signé (mise à jour d'une 2.x installée).
 * - `RunAsNode` : GARDÉ. Le serveur d'autorisation des harnais de code (src/code-harness/permissions.js)
 *   lance le binaire de Lasco avec `ELECTRON_RUN_AS_NODE=1`. À couper quand il aura son propre binaire.
 * - `GrantFileProtocolExtraPrivileges` : gardé (pages locales de Lasco en `file:`), voir docs/security.md.
 */

const path = require('path');

function fusesConfig(platform, FuseV1Options) {
  return {
    [FuseV1Options.RunAsNode]: true,
    [FuseV1Options.EnableCookieEncryption]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: platform === 'darwin',
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: true,
  };
}

function executablePath(context) {
  const { appOutDir, electronPlatformName, packager } = context;
  const name = packager.appInfo.productFilename;
  if (electronPlatformName === 'darwin' || electronPlatformName === 'mas') return path.join(appOutDir, `${name}.app`);
  if (electronPlatformName === 'win32') return path.join(appOutDir, `${name}.exe`);
  return path.join(appOutDir, packager.executableName || name.toLowerCase());
}

async function afterPack(context) {
  // Diagnostic local seulement (comparer un build avec et sans fusibles). Jamais en CI de release.
  if (process.env.LASCO_SKIP_FUSES === '1' && !process.env.CI) {
    console.log('[fuses] ignorés (LASCO_SKIP_FUSES=1)');
    return;
  }
  const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
  const platform = context.electronPlatformName;
  await flipFuses(executablePath(context), {
    version: FuseVersion.V1,
    // Binaire arm64 non signé : la signature ad hoc est refaite (la vraie signature suit).
    resetAdHocDarwinSignature: platform === 'darwin' && context.arch === require('builder-util').Arch.arm64,
    ...fusesConfig(platform, FuseV1Options),
  });
  console.log(`[fuses] ${platform}: fusibles posés sur ${path.basename(executablePath(context))}`);
}

module.exports = afterPack;
module.exports.default = afterPack;
module.exports.fusesConfig = fusesConfig;
