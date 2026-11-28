# Onglets web : autorisations, sécurité, erreurs, plein écran

Ce que Lasco Desktop fait comme un navigateur pour les onglets web (sessions des onglets web (`persist:bp-…` par profil et workspace, `persist:browser-tabs` sans profil, docs/browser-profiles.md)).

## Autorisations des sites

Code : `src/browser-tabs/site-permissions.js`, branché par `manager.js` sur la session des onglets web (une fois pour toutes les fenêtres).

- **Accordées sans question** : plein écran, verrouillage du pointeur et du clavier, écriture dans le presse-papiers après un geste, DRM (`mediaKeySystem`), choix de la sortie audio, accès au stockage.
- **Demandées, puis retenues par site** : micro (`microphone`) et caméra (`camera`), position, notifications, lecture du presse-papiers, MIDI, détection d'inactivité, gestion des fenêtres, modification de fichiers (File System Access). Question native « <site> souhaite … » : Autoriser / Bloquer (retenus) ou Ignorer (refusé sans nouvelle question jusqu'au redémarrage de Lasco ou jusqu'à un changement depuis les informations du site ; rien n'est écrit sur le disque). Une seule question à la fois par site et par permission.
- **Micro et caméra** : Electron les demande ensemble (`media`, `mediaTypes` `audio` / `video`). Une seule question pour ce qui n'est pas encore décidé (« <site> souhaite utiliser votre micro et votre caméra »), réponse retenue pour chacun ; accordé seulement si tout est autorisé. Puis, sur macOS, l'accès de l'app elle-même (boîte système la première fois : `NSMicrophoneUsageDescription`, `NSCameraUsageDescription`, entitlements `audio-input` et `camera`). Lecture synchrone : `navigator.permissions.query({ name: 'camera' | 'microphone' })` répond « accordé » tant que rien n'est bloqué ni ignoré pour le site (Electron ne sait pas répondre « à demander » ; avec « refusé », Google Meet concluait à un blocage et n'appelait jamais `getUserMedia`, donc aucune question), « refusé » après Bloquer ou Ignorer. La caméra avec pan/tilt/zoom (`{ name: 'camera', panTiltZoom: true }`, que Meet interroge aussi ; vérification `media` sans `mediaType`) suit la décision de la caméra. Les noms des appareils (`enumerateDevices`) restent cachés jusqu'à Autoriser. Une demande `media` sans type connu est refusée.
- **Toujours refusées** : appareils (HID, USB, série), ouverture d'applications par permission (`openExternal`, passé par la confirmation des liens d'app), toute permission inconnue.
- La décision porte sur le **site affiché** (origine du document principal) : un cadre intégré n'obtient une permission que si Chromium l'a déjà autorisée par la délégation Permissions-Policy.
- Lecture synchrone (`Notification.permission`, `navigator.permissions.query`) : « accordé » seulement après Autoriser. Sans décision elle répond « refusé » (Electron ne sait pas répondre « à demander ») : `Notification.requestPermission()` pose bien la question, mais un site qui lit `Notification.permission` avant de demander croira les notifications bloquées.
- **Réglage par défaut** (Réglages > Autorisations des sites) : pour chaque permission demandable, « Demander » (défaut) ou « Bloquer » (refusé sans question, lecture synchrone « refusé », caméra et micro compris). Une décision du site l'emporte toujours.
- Fichier : `userData/browser-site-permissions.json` (`{ version: 1, origins: { "https://x": { "geolocation": "allow" } }, defaults: { "camera": "block" } }`, `defaults` ne garde que « Bloquer »), entrées invalides ignorées. « Effacer les données de navigation » vide les décisions des sites et garde les réglages par défaut.

## Réglages > Autorisations des sites

Lasco > Réglages… (⌘,), section `sites` (`src/settings/`), comme `brave://settings/content` :

- **Par défaut** : une ligne par permission demandable, Demander / Bloquer.
- **Sites** : chaque site avec une décision retenue ou un « Ignorer » en cours, trié par hôte, avec un résumé (« Caméra : autorisé · Position : ignoré »). Recherche dans les adresses. « Modifier » déplie toutes les permissions du site (Autoriser / Bloquer / « Demander (par défaut) » ou « Bloquer (par défaut) »), « Redemander » lève un « Ignorer ». « Supprimer » oublie le site ; « Tout réinitialiser » oublie tous les sites après confirmation native.
- Canaux (vérifiés `fromSettings`) : `settings-modal-site-set-default`, `settings-modal-site-set`, `settings-modal-site-remove`, `settings-modal-site-reset-all` ; état dans `settings-modal-state.sitePermissions` (`names`, `defaults`, `sites`).

## Informations du site (pont `lascoDesktop.browserTabs`)

| Méthode | Effet |
| --- | --- |
| `siteInfo({ tabId })` | `{ ok, origin, host, security, permissions }` du site affiché par l'onglet (même derrière une page d'erreur). `permissions` : **toutes** les permissions demandables, dans l'ordre d'affichage : `{ permission, decision: 'allow' \| 'block' \| 'ask', dismissed, defaultDecision: 'ask' \| 'block' }` (`ask` = aucune décision ; `dismissed` = « Ignorer » en mémoire jusqu'au redémarrage) |
| `setSitePermission({ tabId, permission, decision })` | `decision` : `allow`, `block`, `ask` ou `null` (aucune décision : redemander, lève aussi un « Ignorer ») ; renvoie les informations à jour |
| `resetSitePermissions({ tabId })` | oublie toutes les décisions et les « Ignorer » du site |
| `openSiteSettings()` | ouvre Réglages > Autorisations des sites (fenêtres du portail seulement) |

Avant cette version, `permissions` ne contenait que les décisions retenues : le portail complète la liste lui-même.

Un changement vaut pour les prochaines demandes du site ; une page déjà ouverte garde ce qu'elle a obtenu jusqu'au rechargement.

## État de l'onglet (`browser-tab-state`)

Champs ajoutés :

- `security` : `secure` (https), `insecure` (http hors de cette machine), `local` (http sur `localhost`, `*.localhost`, `127.0.0.1`, `::1`), `dangerous` (certificat refusé, ou site signalé par la protection contre les sites dangereux : voir docs/safe-browsing.md, avec `threat`), `null` (vide, page d'erreur réseau ou plantage).
- `pageError` : `crashed`, `network`, `certificate` ou `null` : Lasco affiche sa page à la place du site.
- `htmlFullscreen` : une vidéo (ou tout élément) est en plein écran.

## Pages d'erreur

Code : `src/browser-tabs/page-errors.js`, page `src/browser-tabs/tab-error.html` (+ `tab-error.js`, texte seulement, aucun HTML venu de l'adresse).

- **Échec de chargement** du document principal (hors annulation `-3`, donc hors téléchargement et Arrêter) : « Impossible d'ouvrir cette page » avec la cause (hors ligne, adresse introuvable, refus, délai…) et le code `ERR_*`, bouton Réessayer.
- **Certificat refusé** (codes -200 à -299) : « Votre connexion n'est pas privée », sans possibilité de continuer. Cadenas `dangerous`.
- **Onglet planté** (`render-process-gone` hors `clean-exit`) : « Cet onglet a planté », bouton Recharger. L'identité Chrome (débogueur) est rattachée de nouveau, pour que la page rechargée reste vue comme Chrome.
- **Page qui ne répond pas** (`unresponsive`) : question « Attendre / Quitter la page » ; la question disparaît si la page répond de nouveau. Quitter arrête le processus de la page et affiche « Cet onglet a planté ».
- L'onglet garde l'adresse du site (barre d'adresse, favoris, historique) ; Actualiser (⌘R) recharge le site, pas la page d'erreur.

## Plein écran d'une page

`enter-html-full-screen` / `leave-html-full-screen` : la fenêtre passe en plein écran et la vue de l'onglet couvre toute sa zone de contenu (barre d'onglets et colonnes masquées dessous) ; à la sortie, la fenêtre reprend son état d'avant. Sortie par Échap, par la page, en changeant d'onglet, en fermant l'onglet ou en quittant le plein écran de la fenêtre.

## Menu contextuel des pages

En plus de l'existant : suggestions du correcteur orthographique et « Ajouter au dictionnaire » ; « Télécharger le fichier lié », « Enregistrer l'image… », ouvrir / enregistrer / copier l'adresse d'une vidéo ou d'un son. Les téléchargements passent par docs/downloads.md (dossier et « Demander où enregistrer » des Réglages).

## Tests

`scripts/test-site-permissions.js`, `scripts/test-page-errors.js`.
