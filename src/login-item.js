'use strict';

/**
 * « Ouvrir Lasco à l'ouverture de session » selon la plateforme (docs/background.md).
 * - macOS : `app.setLoginItemSettings` (SMAppService) ; démarrage détecté par `wasOpenedAtLogin`.
 * - Windows : `app.setLoginItemSettings` avec l'argument `--lasco-hidden` (clé Run du registre).
 * - Linux : Electron ne gère pas l'ouverture de session ; fichier XDG
 *   `~/.config/autostart/lasco.desktop`, lancé avec `--lasco-hidden`.
 * Le main ne garde aucun état : tout est relu au système (la personne peut le changer ailleurs).
 */
const path = require('path');

const LOGIN_HIDDEN_ARG = '--lasco-hidden';
const AUTOSTART_FILE = 'lasco.desktop';

/** Exécutable à relancer : l'AppImage elle-même (pas son point de montage temporaire), sinon le binaire. */
function linuxLaunchPath({ env = process.env, execPath = process.execPath } = {}) {
  return env.APPIMAGE || execPath;
}

/** Exécutable Windows : la version « portable » s'extrait dans un dossier temporaire à chaque lancement. */
function windowsLaunchPath({ env = process.env, execPath = process.execPath } = {}) {
  return env.PORTABLE_EXECUTABLE_FILE || execPath;
}

/** Argument d'une ligne `Exec` (spécification Desktop Entry : entre guillemets, `"` `` ` `` `$` `\` échappés). */
function quoteExecArg(value) {
  return `"${String(value).replace(/[\\"`$]/g, (c) => `\\${c}`)}"`;
}

function buildAutostartEntry({ launchPath, name = 'Lasco' }) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${name}`,
    `Exec=${quoteExecArg(launchPath)} ${LOGIN_HIDDEN_ARG}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

/** Dossier autostart XDG : `$XDG_CONFIG_HOME/autostart`, sinon `~/.config/autostart`. */
function autostartDir({ env = process.env, homeDir }) {
  const base = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(homeDir, '.config');
  return path.join(base, 'autostart');
}

/**
 * Ouverture de session sous Linux (fs injectable pour les tests).
 * Activé = le fichier existe et lance cet exécutable ; un fichier laissé par une autre installation
 * (autre chemin) compte comme désactivé et est réécrit à l'activation.
 */
function createLinuxAutostart({ fs, dir, launchPath }) {
  const file = path.join(dir, AUTOSTART_FILE);
  return {
    file,
    isEnabled() {
      try {
        const text = fs.readFileSync(file, 'utf8');
        return text.includes(`Exec=${quoteExecArg(launchPath)} `) && !/^Hidden=true$/m.test(text);
      } catch (_) {
        return false;
      }
    },
    setEnabled(enabled) {
      if (enabled) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, buildAutostartEntry({ launchPath }), { mode: 0o644 });
        return true;
      }
      try {
        fs.unlinkSync(file);
      } catch (err) {
        if (!err || err.code !== 'ENOENT') throw err;
      }
      return false;
    },
  };
}

/** Lancé par l'ouverture de session (Windows / Linux) : l'argument posé dans l'entrée de démarrage. */
function launchedHidden(argv = process.argv) {
  return Array.isArray(argv) && argv.includes(LOGIN_HIDDEN_ARG);
}

module.exports = {
  LOGIN_HIDDEN_ARG,
  linuxLaunchPath,
  windowsLaunchPath,
  quoteExecArg,
  buildAutostartEntry,
  autostartDir,
  createLinuxAutostart,
  launchedHidden,
};
