# Mode VM (`--vm`) : Lasco Desktop dans l'ordinateur Lasco

Lasco Desktop remplace Chrome comme navigateur de l'ordinateur Lasco (VM Linux de chaque personne). L'agent le pilote par CDP, la personne le voit dans l'écran de l'ordinateur.

## Activation

- `lasco-desktop --vm` ou `LASCO_DESKTOP_VM=1`. Le mode VM implique `--no-agents` (internal-portal#2373) : ni opérations sur l'ordinateur, ni Lasco Code, ni harnais.
- UA : `… LascoDesktop/<version> LascoNoAgents/1 LascoVm/1`.
- Lancé par `/opt/lasco/lasco-desktop.sh` dans l'image (`LASCO_VM_BROWSER=desktop`, défaut ; `chrome` pour le retour arrière).

## Jamais de session Lasco dans la VM

La fenêtre ne charge jamais le portail : elle affiche la coquille de Desktop (`src/vm-shell/`, page `file:` sans script distant, CSP `default-src 'none'`). Elle comprend une barre d'onglets, une barre d'adresse et le panneau « Ordinateur Lasco ». Elle pilote les mêmes vues natives que le navigateur interne (`browserTabs`).

Les commandes exécutées dans la VM (`computer_exec`, page malveillante qui pousse l'agent) ne peuvent donc pas voler la session Lasco de la personne : il n'y en a pas. Les sites ouverts dans la VM gardent leurs propres connexions (profil `~/.config/lasco-desktop`, privé à l'utilisateur `lasco`).

## Réglages forcés

`VM_FORCED_SETTINGS` (`src/vm-mode.js`) l'emporte sur `settings.json` :

- liens dans l'application ;
- pas de mode arrière-plan (fermer la fenêtre quitte, la VM relance) ;
- téléchargements dans le dossier Téléchargements de la VM sans boîte de dialogue ;
- thème clair, aucun raccourci global.

Désactivés : mises à jour dans la machine (la version suit l'image, reconstruite à chaque release : docs/updates.md), icône de la barre des menus, ouverture à la connexion, notifications, client `lasco:`, navigateur par défaut, gestionnaire de mots de passe et remplissage (ils dépendent du Coffre du portail), My Drive, fenêtres détachées, fenêtre Réglages. Le panneau « Ordinateur Lasco » de la coquille les rappelle.

## Point de contrôle (démon navigateur de la VM)

Serveur HTTP sur `127.0.0.1:9334` (`LASCO_VM_CONTROL_PORT`), jeton `Bearer` aléatoire écrit en `0600` dans `vm-control-token` du dossier de données (`LASCO_VM_CONTROL_TOKEN_FILE`), renouvelé à chaque lancement.

| Route | Effet |
| --- | --- |
| `GET /v1/status` | `{ vm: true, tabs, activeTabId }` |
| `GET /v1/tabs` | onglets `{ tabId, url, title, active, targetId }` |
| `POST /v1/tabs` `{ url, activate? }` | ouvre un onglet web (http(s) seulement) |
| `POST /v1/tabs/:id/activate` | l'affiche |
| `GET /v1/active` | onglet affiché (ouvre la page d'accueil `LASCO_VM_HOME_URL` s'il n'y en a pas) |

`targetId` est la cible CDP de la page de l'onglet (`Target.getTargetInfo`) : le démon (`browser-daemon.mjs` du portail) pilote cette page, jamais la coquille, elle aussi visible sur le port CDP.

Refusés : appel hors boucle locale, en-tête `Host` autre que `127.0.0.1` / `localhost` (DNS rebinding), en-tête `Origin` (une page web), jeton absent ou faux, corps > 16 Ko.

## CDP

- `--remote-debugging-port=9222 --remote-debugging-address=127.0.0.1` (script de lancement de l'image).
- Dans la VM, le pare-feu (`fc-init.sh`) réserve 9222, 9333 et 9334 à root et à `lasco` : l'utilisateur du code (`lasco-code`) ne les joint pas.
- Le CDP donne la main sur le navigateur, ce qui est voulu pour l'agent, mais aucune session Lasco n'y est exposée.

## Tests

`scripts/test-vm-mode.js` couvre la détection, les réglages forcés, le jeton, le point de contrôle (jeton, Origin, Host, routes, taille) et la coquille (CSP, jamais le portail, pas d'opérations sur l'ordinateur).
