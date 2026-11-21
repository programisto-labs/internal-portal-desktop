# Icône Lasco (barre des menus, zone de notification, barre système)

| Plateforme | Icône | Clic | Clic droit |
|---|---|---|---|
| macOS | flamme « template » (teintée par le système), nombre à valider à côté | popover sous l'icône | popover |
| Windows | flamme en couleur (`tray.png`), point rouge si quelque chose attend | popover au-dessus de la barre des tâches (ou à côté si elle est sur un bord) | menu natif |
| Linux | flamme en couleur, menu natif attaché (StatusNotifier / AppIndicator : le clic n'arrive pas toujours à l'app) | popover si l'environnement envoie le clic, sinon le menu | menu natif |

Le menu natif (`buildTrayMenuItems`, `src/tray/tray-platform.js`) reprend « Ouvrir Lasco », « Demander à Lasco… », les compteurs (à valider, en cours, non lus : ils ouvrent Lasco), « Suspendre les opérations », « Réglages… », « Quitter Lasco ». Chaque entrée repasse par `resolveTrayAction` ; aucune décision depuis le menu. Position du popover : `computePopoverBounds` (côté de la barre déduit de la zone utile de l'écran ; icône sans position sous Linux → au pointeur). Linux sans barre système : pas d'icône (création tolérante), pas de mode arrière-plan.

Un clic ouvre un popover à côté de l'icône :

1. **À valider** : confirmations « Cet ordinateur » en attente (commande, fichier, harnais) et validations d'actions d'agent (`toolsConfig.writeApproval`).
2. **En cours** : agent qui répond dans le chat, harnais de code qui tournent.
3. **Non lus** : dernières réponses d'agents (6 au plus), avec leur nombre.
4. « Demander à Lasco… », « Ouvrir Lasco », « Suspendre les opérations sur cet ordinateur » (si activées), « Réglages… », « Quitter Lasco ».

Fermer la fenêtre de Lasco la masque : l'icône reste à jour. Raccourcis globaux et ouverture de session : [background.md](./background.md).

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
