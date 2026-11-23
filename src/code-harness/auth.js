'use strict';

/**
 * Connexion aux harnais de code, sans que Lasco voie jamais d'identifiant :
 * - `checkAuth` lit l'état exposé par le CLI (`claude auth status --json`, `codex login status`,
 *   `cursor-agent status`) ;
 * - `startLogin` lance la connexion OAuth du CLI en arrière-plan : le CLI ouvre le navigateur (et on relève
 *   l'URL qu'il affiche, au cas où le navigateur ne s'ouvre pas). Les jetons restent dans le CLI.
 */

const { spawn: spawnDefault } = require('child_process');
const { execHarness, resolveHarnessCommand } = require('./command');

const AUTH = {
  'claude-code': {
    status: ['claude', ['auth', 'status', '--json']],
    login: ['claude', ['auth', 'login']],
    parse(stdout) {
      let json;
      try {
        json = JSON.parse(stdout);
      } catch {
        return { state: 'unknown' };
      }
      if (json.loggedIn !== true) return { state: 'logged_out' };
      // Compte claude.ai sans abonnement : connecté, mais `claude -p` refuse (« Not logged in »).
      if (json.authMethod === 'claude.ai' && !json.subscriptionType) {
        return {
          state: 'no_plan',
          message:
            'Claude Code est connecté avec un compte sans abonnement Claude. Reconnectez-vous avec un compte Claude Pro ou Max, ou avec un compte Console (clé API).',
        };
      }
      return { state: 'ok' };
    },
  },
  codex: {
    status: ['codex', ['login', 'status']],
    login: ['codex', ['login']],
    parse(stdout, stderr, code) {
      const text = `${stdout}\n${stderr}`;
      if (/error loading configuration|failed to deserialize/i.test(text)) {
        return {
          state: 'config_error',
          message: `La configuration de Codex est invalide (~/.codex/config.toml) : ${text.split('\n').find((l) => l.trim() && !/^\s*$/.test(l))?.trim().slice(0, 200) ?? ''}`,
        };
      }
      if (code === 0 && /logged in/i.test(text) && !/not logged in/i.test(text)) return { state: 'ok' };
      return { state: 'logged_out' };
    },
  },
  cursor: {
    status: ['cursor-agent', ['status']],
    login: ['cursor-agent', ['login']],
    parse(stdout, stderr) {
      const text = `${stdout}\n${stderr}`;
      if (/not logged in|not authenticated/i.test(text)) return { state: 'logged_out' };
      return /logged in/i.test(text) ? { state: 'ok' } : { state: 'unknown' };
    },
  },
};

const URL_RE = /https:\/\/[^\s"'<>]+/;

function supportsLogin(harness) {
  return Boolean(AUTH[harness]);
}

/** État de connexion : `ok`, `logged_out`, `no_plan`, `config_error`, `unknown` (statut indisponible). */
function checkAuth(harness, { env, execFileImpl = execHarness } = {}) {
  const def = AUTH[harness];
  if (!def) return Promise.resolve({ state: 'unknown' });
  const [bin, args] = def.status;
  return new Promise((resolve) => {
    execFileImpl(bin, args, { env, timeout: 15000, maxBuffer: 256 * 1024 }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') return resolve({ state: 'not_installed' });
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve(def.parse(String(stdout || ''), String(stderr || ''), code));
    });
  });
}

/**
 * Lance la connexion OAuth du CLI. `onUpdate({ state: 'pending' | 'done' | 'error', url?, message? })`.
 * Renvoie `cancel()`. La connexion abandonne au bout de `timeoutMs`.
 */
function startLogin(harness, { env, onUpdate, spawnImpl = spawnDefault, timeoutMs = 5 * 60 * 1000, recheck }) {
  const def = AUTH[harness];
  if (!def) {
    onUpdate({ state: 'error', message: 'Connexion non prise en charge pour ce harnais.' });
    return () => undefined;
  }
  const [bin, args] = def.login;
  let child;
  try {
    const resolved = resolveHarnessCommand(bin, { env });
    if (resolved.error) throw new Error(resolved.error);
    child = spawnImpl(resolved.command, [...resolved.prefixArgs, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  } catch {
    onUpdate({ state: 'error', message: `${bin} n’a pas pu être lancé.` });
    return () => undefined;
  }
  let url = null;
  let finished = false;
  let output = '';
  onUpdate({ state: 'pending' });
  const watch = (chunk) => {
    const text = chunk.toString('utf8');
    output = `${output}${text}`.slice(-4000);
    if (!url) {
      const match = URL_RE.exec(text);
      if (match) {
        url = match[0].replace(/[).,]+$/, '');
        onUpdate({ state: 'pending', url });
      }
    }
  };
  child.stdout?.on('data', watch);
  child.stderr?.on('data', watch);
  child.on('error', () => undefined);
  const timer = setTimeout(() => {
    if (finished) return;
    finished = true;
    try {
      child.kill('SIGTERM');
    } catch {
      // déjà terminé
    }
    onUpdate({ state: 'error', message: 'La connexion n’a pas abouti à temps. Réessayez.' });
  }, timeoutMs);
  child.on('close', async (code) => {
    clearTimeout(timer);
    if (finished) return;
    finished = true;
    const status = recheck ? await recheck().catch(() => ({ state: 'unknown' })) : { state: code === 0 ? 'ok' : 'logged_out' };
    if (status.state === 'ok') onUpdate({ state: 'done' });
    else
      onUpdate({
        state: 'error',
        message: status.message || (code === 0 ? 'Connexion terminée, mais le harnais ne se dit pas connecté.' : 'La connexion a échoué ou a été annulée.'),
        ...(url ? { url } : {}),
      });
  });
  return () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    try {
      child.kill('SIGTERM');
    } catch {
      // déjà terminé
    }
  };
}

module.exports = { checkAuth, startLogin, supportsLogin };
