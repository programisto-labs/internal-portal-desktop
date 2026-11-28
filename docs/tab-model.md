# Liste des onglets (modèle d'onglets)

Desktop tient la liste des onglets du navigateur interne : une seule source pour l'ordre, l'onglet actif, le type (page du portail ou page web), la fenêtre, l'épinglage et le groupe. La page du portail (la coquille) en est une vue abonnée. Note de design : `docs/BROWSER-TAB-MODEL.md` du dépôt `internal-portal`.

## Modèle (`src/tab-model.js`)

- **Fenêtres** : une entrée par fenêtre du portail, par clé : `main` pour la fenêtre principale, `w-…` pour une fenêtre détachée (créée avec la fenêtre, passée à la page par `--lasco-tab-window=`, gardée au redémarrage). La réserve (fenêtre préchargée) n'envoie rien tant qu'elle n'est pas prise.
- **Portées** : dans chaque fenêtre, une liste par portée, chaîne opaque choisie par la page (aujourd'hui la clé de stockage du workspace ; un profil pourra la composer). 12 portées au plus par fenêtre, la plus ancienne sort.
- **Liste** : `tabs` (60 au plus, les moins récemment utilisés sortent), `activeId`, `revision`, `locationHref` (chemin du portail affiché par la fenêtre).
- **Onglet** (`sanitizeTabRecord`) : `id`, `kind` (`internal` | `external`), `href` (chemin du portail, ou URL http(s)), `title`, `favicon` (http(s) ou chemin du portail), `blank`, `lastUsedAt`, `pinned`, `groupId`. Tout le reste est ignoré.
- **Événements** (`tabModelEvents` dans `main.js`, `on('event', …)`) : `created`, `removed`, `updated` (`changes`), `moved`, `activated`, `attached`, `detached`, avec `windowKey` et `scope`. Point d'attache des extensions (`chrome.tabs`).
- **`moveTab({ tabId, fromKey, toKey, scope, index })`** : déplacement côté Desktop entre deux fenêtres ; les deux pages reçoivent leur nouvelle liste.

## Contrat avec la page (`window.lascoDesktop.tabModel`)

Appels acceptés seulement depuis le cadre principal d'une fenêtre du portail, à l'origine du portail. Absent (`undefined`) sur une fenêtre sans clé : la page garde alors son stockage.

| Membre | Rôle |
| --- | --- |
| `version` | `1`. |
| `windowKey` | Clé de la fenêtre dans le modèle. |
| `read()` | **Synchrone** : `{ key, role, lastScope, strips: { [scope]: { tabs, activeId, revision, locationHref } } }`, ou `null`. Lu une fois au chargement, pour que le premier rendu montre les onglets restaurés. |
| `commit({ scope, tabs?, activeId?, locationHref? })` | La page envoie sa liste après un changement (envoi partiel accepté : seulement l'onglet actif). Renvoie `{ ok, revision }`. Refusé depuis la réserve. |
| `onChange(cb)` | `{ scope, strip }` : changement fait par Desktop (déplacement, extension). La page adopte la liste. Ses propres envois ne lui reviennent pas. |

## Session et redémarrage

- Le modèle est écrit dans `<userData>/tab-session.json` (`src/tab-session-store.js`) : 400 ms après un changement, par fichier temporaire puis renommage, et à la fermeture de l'app. Fichier absent ou illisible : session vide.
- **Fenêtre détachée fermée par la personne** : ses onglets sont oubliés (comme Chrome). **⌘Q, mise à jour** : elle est gardée.
- **Au démarrage**, Desktop rouvre chaque fenêtre détachée qui a des onglets : à sa place (ramenée sur un écran branché), sur la page de son onglet actif (le nouvel onglet pour une page web), sans prendre le focus ; la page y relit ses onglets. Lancé à l'ouverture de session en arrière-plan : les fenêtres reviennent avec la fenêtre principale.
- La position et la taille d'une fenêtre sont gardées à la fin d'un déplacement ou d'un redimensionnement (`moved`, `resized`).
- Fenêtres privées et mode VM : jamais dans le modèle.

## Côté portail

`lib/portal-tabs/tab-model.ts` ; `loadPersistedPortalTabs` / `persistPortalTabs` de `protocol.ts` passent par ce pont quand il existe. Sans lui (web, ancien Desktop), rien ne change. Sur Desktop, la page écrit aussi son `localStorage` (retour à une ancienne version sans perte) et le reprend au premier lancement.
