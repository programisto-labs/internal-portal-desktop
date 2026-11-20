# Icône Lasco de la barre des menus (macOS)

Une icône (la flamme de l'app, image « template ») dans la barre des menus. Un clic ouvre un popover sous l'icône :

1. **À valider** : confirmations « Cet ordinateur » en attente (commande, fichier, harnais) et validations d'actions d'agent (`toolsConfig.writeApproval`).
2. **En cours** : agent qui répond dans le chat, harnais de code qui tournent.
3. **Non lus** : dernières réponses d'agents (6 au plus), avec leur nombre.
4. « Demander à Lasco… », « Ouvrir Lasco », « Suspendre les opérations sur cet ordinateur » (si activées), « Réglages… », « Quitter Lasco ».

À côté de l'icône : le nombre d'éléments à valider. Un point sur l'icône : quelque chose attend ou n'est pas lu.

## Sources

| Source | Contenu | Canal |
|---|---|---|
| Portail (cadre principal de la fenêtre principale, origine du portail) | validations d'actions, agent qui répond, non-lus, `canAsk` | `lascoDesktop.tray.setState(state \| null)` → `tray-set-state` |
| Desktop | confirmations en attente (`inlineConfirm.list()`), harnais `running` (`harnessRunner.list()`), état des opérations | lu à chaque rafraîchissement |

`null` (déconnexion, rechargement complet de la page) : le popover affiche « Connectez-vous à Lasco ». Toute valeur est normalisée (`src/tray/tray-state.js`) : identifiants ObjectId, textes bornés, 6 éléments par liste.

## Commandes vers le portail

`lascoDesktop.tray.onCommand(cb)` reçoit `tray-command` :

- `{ command: 'open-conversation', conversationId, agentId? }` : ouvre le fil dans la colonne Lasco AI ;
- `{ command: 'approve' | 'deny', conversationId, callId }` : répond à la validation (même route que la carte du fil) ; le popover reste ouvert ;
- `{ command: 'ask' }` : nouvelle conversation avec l'agent principal.

## Sécurité

- Le popover est une fenêtre `file:` isolée (sandbox, CSP sans script, rendu en `textContent`), sans accès au portail.
- Chaque action du popover est revérifiée par le main contre la vue affichée (`resolveTrayAction`) : seul un identifiant présent dans le popover est relayé.
- Une confirmation « Cet ordinateur » ne se décide **jamais** depuis le popover : « Voir dans Lasco » ouvre la fenêtre, où la carte (armée après 600 ms) ou le dialogue natif décide.
- Pas d'« Toujours autoriser » depuis le popover.

Code : `src/tray/` ; portail : `components/portal-tabs/portal-desktop-tray-bridge.tsx`, `lib/desktop-tray.ts`.
