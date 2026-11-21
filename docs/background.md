# Lasco en arrière-plan, ouverture de session et raccourcis globaux

## Fermer = masquer

Avec l'icône Lasco ([tray.md](./tray.md) : barre des menus macOS, zone de notification Windows, barre système Linux), fermer la fenêtre principale (bouton rouge, « Fermer la fenêtre ») la **masque** au lieu de la détruire. Le portail continue de tourner : tours d'agent, flux du chat, validations, notifications et résumé de l'icône restent à jour.

- Quitter vraiment : ⌘Q (macOS), « Quitter Lasco » du popover ou du menu de l'icône, ou une mise à jour (`quitAndInstallUpdate` pose `isQuitting` avant `autoUpdater.quitAndInstall`, qui ferme les fenêtres avant `before-quit`).
- Retour : clic sur le Dock (`activate`, macOS), « Ouvrir Lasco » du popover ou du menu, raccourci global, lien `lasco://`, relance de Lasco (seconde instance : icône épinglée de la barre des tâches, lanceur Linux), clic sur une notification.
- Plein écran : la fenêtre en sort avant d'être masquée (pas d'espace vide). Sans autre fenêtre Lasco visible, `app.hide()` rend le focus à l'app précédente.
- La fenêtre principale a `backgroundThrottling: false` : la page masquée garde le rythme de ses minuteurs.
- Fenêtres détachées ([tab-windows.md](./tab-windows.md)) : inchangées, les fermer ferme leurs onglets.
- Première fermeture : notification « Lasco reste ouvert » (une seule fois, `backgroundHintShown`).
- Fenêtre masquée : les confirmations « Cet ordinateur » passent par le dialogue natif, sans fenêtre parente (une feuille sur une fenêtre masquée serait invisible), et l'icône du Dock rebondit.
- Réglages > Général > « Garder Lasco ouvert dans la barre des menus / la zone de notification / la barre système » (`keepInBackground`, activé par défaut). Coupé : fermer détruit la fenêtre comme avant (et quitte Lasco sous Windows / Linux).
- Sans icône (Linux sans barre système, ex. GNOME sans l'extension AppIndicator : `new Tray` échoue ou n'affiche rien) : la ligne disparaît des Réglages si l'icône n'a pas pu être créée, fermer quitte, et un démarrage masqué affiche quand même la fenêtre. Si l'icône est créée mais invisible, relancer Lasco ou le raccourci global la ramène.

## Ouverture de session

Réglages > Général > « Ouvrir Lasco à l'ouverture de session » (`src/login-item.js`). L'état affiché est toujours relu au système, car la personne peut le changer ailleurs.

| Plateforme | Mécanisme | Démarrage masqué détecté par |
|---|---|---|
| macOS | `app.setLoginItemSettings({ openAtLogin })` (SMAppService) | `wasOpenedAtLogin` |
| Windows | `app.setLoginItemSettings({ openAtLogin, path, args: ['--lasco-hidden'] })` (clé Run) ; état = `executableWillLaunchAtLogin` (faux si désactivé dans le Gestionnaire des tâches) ; version portable : `PORTABLE_EXECUTABLE_FILE` | `--lasco-hidden` |
| Linux | fichier XDG `~/.config/autostart/lasco.desktop` (`$XDG_CONFIG_HOME` respecté), `Exec="<AppImage ou binaire>" --lasco-hidden` ; un fichier d'une autre installation ou `Hidden=true` compte comme désactivé | `--lasco-hidden` |

- Démarré par la session avec le mode arrière-plan actif, Lasco crée la fenêtre principale **masquée** : le portail charge, l'icône se remplit, rien ne s'affiche.
- macOS 13+ : statut `requires-approval` → lien vers Réglages Système > Général > Ouverture.
- Indisponible hors app installée (`app.isPackaged`) : en développement, l'élément lancerait le binaire Electron nu.

## Raccourcis globaux

| Action | Défaut | Effet |
|---|---|---|
| Afficher / masquer Lasco (`toggleWindow`) | ⌥⇧L | Lasco devant ; déjà devant et actif : masqué |
| Demander à Lasco (`ask`) | ⌥⇧Espace | Lasco devant + commande `ask` au portail (nouvelle conversation, comme le popover) |

- Modifiables dans Réglages > Général > « Raccourcis clavier » : clic sur le raccourci, puis la combinaison. Échap annule ; « Désactiver » et « Rétablir » à côté.
- Pendant l'enregistrement, les raccourcis globaux sont libérés (`settings-modal-shortcut-recording`), sinon la combinaison actuelle n'atteindrait jamais la page ; ils sont rétablis à la sortie, à la perte de focus ou à la fermeture des Réglages.
- La page des Réglages n'envoie que la frappe (`code` + modificateurs) ; le main construit et vérifie l'accelerator (`src/background-mode.js`) : touche connue, ⌘ / ⌃ / ⌥ obligatoire (sauf F1–F24), combinaisons réservées refusées (⌘Q, ⌘W, ⌘Espace, ⌘⇧3/4/5, Alt+F4…), pas deux actions sur la même combinaison.
- Linux / Wayland : les raccourcis passent par le portail XDG `GlobalShortcuts` (option Chromium `GlobalShortcutsPortal`, posée au démarrage) ; l'environnement de bureau peut demander de les confirmer. Sous X11, enregistrement direct.
- La touche est la **position physique** (`KeyboardEvent.code`), comme l'enregistrement d'Electron : sur un clavier AZERTY, le libellé d'une lettre déplacée (A, Q, Z, W, M) peut différer de la touche gravée.
- Combinaison déjà prise par une autre app (`globalShortcut.register` → `false`) : gardée, affichée « Déjà pris par une autre app » ; elle fonctionnera si l'autre app la libère.
- Le popover affiche le raccourci « Demander à Lasco » à côté du bouton.
- `--no-agents` : pas de « Demander à Lasco ».

Code : `src/background-mode.js` (validation, libellés), `src/login-item.js` (ouverture de session Windows / Linux), `src/main.js` (masquage, enregistrement), `src/settings/` (UI). Tests : `scripts/test-background-mode.js`, `scripts/test-login-item.js`.
