# Mises à jour imposées

Objectif : pas de parc d'applications anciennes. Une version publiée est installée partout dans les heures qui suivent.

## Lasco Desktop (ordinateurs des personnes)

- Vérification au lancement puis toutes les heures (`UPDATE_CHECK_INTERVAL_MS`), téléchargement automatique (`electron-updater`).
- Version téléchargée : notification « Lasco x.y.z s'installe dans une minute », puis redémarrage et installation (`src/forced-update.js`). Plus de choix « Plus tard ».
- Jamais au milieu d'un travail : un agent qui répond, un harnais qui tourne ou une confirmation en attente (`mainWindowNeedsFullPace`) repoussent le redémarrage, au plus 2 h. Au-delà, l'installation a lieu.
- « Installer maintenant » (Réglages) reste disponible. Les onglets sont restaurés au redémarrage.

## Ordinateur Lasco (mode `--vm`)

Pas de mise à jour dans la machine : l'application y est installée par root (paquet `.deb`, dossier en lecture seule pour l'utilisateur du bureau), et l'utilisateur `lasco` ne peut pas la remplacer.

La version suit l'image, une par release : à chaque release Linux, la CI du portail (`.github/workflows/lasco-computer-image.yml` du dépôt `internal-portal`, release relevée toutes les 15 min) construit l'image de l'ordinateur Lasco avec ce `.deb` (vérifié par son `.sha256`) et déplace le canal `:stable` (ou `:develop`) dessus. Le vm-runner prépare le rootfs de cette image ; l'API passe chaque machine dessus dès qu'elle est au repos (en pause ou arrêtée), et elle repart sur la nouvelle version au prochain usage. Le disque de données (profil, téléchargements, projets) est conservé.

Une release sans `.deb` ni `.sha256` n'est pas déployée dans les machines. Retour arrière : variable de dépôt `LASCO_COMPUTER_DESKTOP_PIN_STABLE` du portail. Détail : `apps/api/src/modules/computers/README.md` du dépôt `internal-portal`, « Image de l'ordinateur Lasco ».

## Tests

`scripts/test-forced-update.js`.
