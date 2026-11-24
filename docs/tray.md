# Icône Lasco (barre des menus, zone de notification, barre système)

| Plateforme | Icône | Clic | Clic droit |
|---|---|---|---|
| macOS | flamme « template » (teintée par le système), nombre à côté (comme Cursor) | popover sous l'icône | popover |
| Windows | flamme en couleur (`tray.png`), pastille rouge avec le nombre | popover au-dessus de la barre des tâches (ou à côté si elle est sur un bord) | menu natif |
| Linux | flamme en couleur, pastille avec le nombre, menu natif attaché (StatusNotifier / AppIndicator : le clic n'arrive pas toujours à l'app) | popover si l'environnement envoie le clic, sinon le menu | menu natif |

Le menu natif (`buildTrayMenuItems`, `src/tray/tray-platform.js`) reprend « Ouvrir Lasco », « Demander à Lasco… », les compteurs (à valider, en cours, non lus : ils ouvrent Lasco), « Suspendre les opérations », « Réglages… », « Quitter Lasco ». Chaque entrée repasse par `resolveTrayAction` ; aucune décision depuis le menu. Position du popover : `computePopoverBounds` (côté de la barre déduit de la zone utile de l'écran ; icône sans position sous Linux → au pointeur). Linux sans barre système : pas d'icône (création tolérante), pas de mode arrière-plan.

Un clic ouvre un popover à côté de l'icône :

1. **À valider** : confirmations « Cet ordinateur » en attente (commande, fichier, harnais) et validations d'actions d'agent (`toolsConfig.writeApproval`).
2. **En cours** : agent qui répond dans le chat, harnais de code qui tournent.
3. **Non lus** : dernières réponses d'agents (6 au plus), avec leur nombre.
4. « Demander à Lasco… », « Ouvrir Lasco », « Suspendre les opérations sur cet ordinateur » (si activées), « Réglages… », « Quitter Lasco ».

Fermer la fenêtre de Lasco la masque : l'icône reste à jour. Raccourcis globaux et ouverture de session : [background.md](./background.md).

Nombre de l'icône = à valider (confirmations « Cet ordinateur » + validations d'actions) + réponses d'agents non lues (`trayBadgeCount`, même total de non-lus que le badge du Dock). Le travail en cours n'est pas compté. macOS l'écrit à côté de la flamme (`setTitle`). Windows et Linux ne peuvent pas écrire de texte à côté de l'icône : la pastille est dessinée sur la flamme (`src/tray/tray-badge.js`, un chiffre à 16 px, « + » au-delà de 9 ; deux chiffres à 32 px, « + » au-delà de 99) ; le nombre exact est dans l'info-bulle. Si l'image ne peut pas être dessinée, le point rouge (`trayDot.png`) reste.

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
