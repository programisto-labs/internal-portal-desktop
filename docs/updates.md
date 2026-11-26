# Mises à jour imposées

Objectif : pas de parc d'applications anciennes. Une version publiée est installée partout dans les heures qui suivent.

## Lasco Desktop (ordinateurs des personnes)

- Vérification au lancement puis toutes les heures (`UPDATE_CHECK_INTERVAL_MS`), téléchargement automatique (`electron-updater`).
- Version téléchargée : notification « Lasco x.y.z s'installe dans une minute », puis redémarrage et installation (`src/forced-update.js`). Plus de choix « Plus tard ».
- Jamais au milieu d'un travail : un agent qui répond, un harnais qui tourne ou une confirmation en attente (`mainWindowNeedsFullPace`) repoussent le redémarrage, au plus 2 h. Au-delà, l'installation a lieu.
- « Installer maintenant » (Réglages) reste disponible. Les onglets sont restaurés au redémarrage.

## Ordinateur Lasco (mode `--vm`)

Pas de mise à jour dans la machine : l'application y est installée par root (paquet `.deb`, dossier en lecture seule pour l'utilisateur du bureau), et l'utilisateur `lasco` ne peut pas la remplacer.

La version suit l'image : chaque release Linux déclenche la reconstruction de l'image de l'ordinateur Lasco (build args `LASCO_DESKTOP_DEB_URL`, `LASCO_DESKTOP_DEB_SHA256`), et chaque machine démarre sur l'image la plus récente. Le disque de données (profil, téléchargements, projets) est conservé. Voir `docker/lasco-computer` du dépôt `internal-portal`.

## Tests

`scripts/test-forced-update.js`.
