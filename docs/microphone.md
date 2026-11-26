# Micro (voix des agents)

Le portail propose la dictée et le mode vocal du chat Lasco AI (PR programisto-labs/internal-portal#2539). Dans Lasco Desktop :

- **macOS** : entitlements `com.apple.security.device.audio-input` et `com.apple.security.device.camera` (onglets web) (`build/entitlements.mac.plist`, runtime renforcé) et textes `NSMicrophoneUsageDescription` / `NSCameraUsageDescription` (`build.mac.extendInfo` de `package.json`). La première demande affiche la boîte système ; un refus se change dans Réglages Système > Confidentialité > Micro.
- **Permissions** (`src/media-permissions.js`). Electron accorde tout sans règle ; on en pose :
  - session du portail (`persist:portal`) : micro **seul** (pas de caméra), pour une page du portail (`isPortalNavigationUrl`) ; sur macOS, accès système demandé à la première utilisation ;
  - onglets web (`persist:browser-tabs`) : micro et caméra demandés par site, comme les autres autorisations (docs/site-permissions.md) ;
  - autres permissions : inchangées.
- Windows / Linux : réglages de confidentialité du système.

Tests : `scripts/test-media-permissions.js`.
