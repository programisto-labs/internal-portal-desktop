# Profils de navigation et isolation par workspace

Les onglets web ont un contexte par **workspace** et par **profil de navigation**, comme les profils de Chrome ou de Brave. Changer d'espace de travail ou de profil donne d'autres cookies, d'autres connexions et un autre stockage des sites. On peut donc avoir deux comptes Google, un par profil, sur le même espace.

## Modèle

- **Profil** : identité de navigation (historique, autorisations des sites, applications externes, liste des téléchargements ; extensions plus tard). Les profils appartiennent au **compte Lasco** : le portail les garde dans l'API (`/browser-profiles`) et les retrouve sur chaque Desktop. Les données de navigation elles-mêmes restent sur l'ordinateur.
- **Profil par défaut** « Personnel » : identifiant `default`, toujours présent, accès à tous les workspaces. Les autres profils (`bp_` + 16 caractères hexadécimaux) ont accès aux workspaces choisis. Un workspace peut appartenir à plusieurs profils.
- **Identifiant stable** : `default` ou `bp_…`, jamais réattribué (un profil retiré garde son identifiant en base). Il nomme les sessions et les fichiers ci-dessous ; la synchro du navigateur et le Coffre s'en servent tels quels.
- **Contexte web** d'une fenêtre = (compte, profil, workspace) → session Electron `persist:bp-<compte>-<profil>-<workspace>` : cookies, cache, stockage local, IndexedDB, service workers. `<compte>` = 12 premiers caractères de l'empreinte du compte (sujet du JWT haché par le portail, `accessTokenOwner`), `<workspace>` = slug du workspace.

## Pont (`lascoDesktop.browserProfiles`, fenêtres du portail, jamais en mode VM ni en navigation privée)

| Appel | Rôle |
| --- | --- |
| `setContext({ owner, profileId, workspace })` | Pose le contexte de la fenêtre, **avant** son premier `browserTabs.create`. Un contexte différent du précédent détruit les vues web de la fenêtre (le portail recrée ses onglets). Les messages d'un même renderer arrivent dans l'ordre : un `setContext` envoyé avant un `create` est traité avant. |
| `getContext()` | `{ profileId, workspace }` de la fenêtre, `null` sans contexte. |
| `forget({ owner, profileId })` | Profil retiré : vide cookies, cache et stockage de toutes ses sessions sur cet ordinateur et supprime ses fichiers. Refusé pour `default` et pour un profil affiché par une fenêtre (`in-use`). |

Sans `setContext` (ancien portail, mode VM) : la fenêtre garde la session d'avant les profils, `persist:browser-tabs`, et ses fichiers. Un portail récent sur un ancien Desktop ne trouve pas le pont et n'affiche pas les profils.

## Fichiers par profil

| Donnée | Profil par défaut | Autre profil |
| --- | --- | --- |
| Historique | `browser-history.json` (celui d'avant) | `browser-profiles/<compte>-<profil>/history.json` |
| Autorisations des sites | `browser-site-permissions.json` | `…/site-permissions.json` |
| Applications externes | `browser-external-apps.json` | `…/external-apps.json` |
| Téléchargements | `downloads.json`, `profileId` sur chaque entrée (le portail filtre) | idem |

- Réglages > Autorisations des sites et l'import depuis un autre navigateur (historique) agissent sur le profil de la fenêtre principale.
- « Effacer les données de navigation » vide la session du contexte de la fenêtre et les fichiers de son profil.
- Un nouvel essai de téléchargement repart dans la session d'origine (`partition` de l'entrée).
- Réglages communs appliqués à chaque nouvelle session : identité Chrome (user agent, Client Hints), autorisations des sites (avec micro et caméra), bloqueur de pubs, onglet Responsive des DevTools, mots de passe et saisie automatique (preload), suivi des téléchargements (une fois par session).

## Migration depuis la session partagée

- La première fois qu'un contexte du **profil par défaut** est ouvert, les cookies de `persist:browser-tabs` y sont copiés (`session.cookies`), puis la page s'ouvre. On reste donc connecté partout ; ensuite chaque contexte vit sa vie. Le stockage local et le cache ne sont pas copiés.
- Une seule fois par partition (`browser-profiles/migration.json`), même après un échec partiel. L'ancienne session revient au premier compte Lasco qui passe aux profils (`legacyOwner`) : jamais copiée chez un autre compte.
- Les autres profils démarrent vides.

## Code et tests

- `src/browser-profiles/context.js` (contexte, noms, reprise des cookies), `src/browser-profiles/registry.js` (sessions et fichiers partagés par les fenêtres), IPC `browser-profile-*` dans `src/main.js`, pont dans `src/preload.js`.
- `createBrowserTabManager` reçoit `partition`, `history`, `sitePermissions`, `externalAppPermissions`, `sessionReady` et `onSessionCreated` ; `dispose()` à chaque changement de contexte.
- `scripts/test-browser-profiles.js`.
