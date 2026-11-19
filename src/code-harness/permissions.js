'use strict';

/**
 * Autorisations demandées par un harnais pendant son exécution (Claude Code, `--permission-prompt-tool`).
 *
 * Claude Code tourne en `-p` (non interactif) : sans relais, chaque commande (npm, npx, git…) est refusée et
 * personne ne le voit. Desktop ouvre une socket locale (dossier 0700, jeton aléatoire par exécution) ; le serveur
 * MCP `permission-mcp.js`, lancé par Claude Code, y transmet chaque demande. Desktop la montre en carte dans le
 * chat (même mécanisme que `shell.run`) et répond :
 *
 * - commande (`Bash`) : Refuser / Exécuter une fois / Toujours autoriser « préfixe » dans ce projet. La règle est
 *   une règle `shell.run` ordinaire (préfixe, dossier du projet, agent, utilisateur, appareil) : jamais pour une
 *   commande composée ou sensible, révocable dans Réglages > Cet ordinateur ;
 * - autre outil (WebFetch, MCP…) : Refuser / Autoriser une fois ;
 * - exécution terminée ou arrêtée : demandes en attente refusées, jeton retiré.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { TOOL_NAME, SERVER_NAME } = require('./permission-mcp');

const MAX_REQUESTS_PER_RUN = 300;
const DEFAULT_CONFIRM_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_LINE = 256 * 1024;

const PERMISSION_TOOL = `mcp__${SERVER_NAME}__${TOOL_NAME}`;

function clip(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Résumé lisible de l'entrée d'un outil autre qu'une commande. */
function describeInput(input) {
  const i = input && typeof input === 'object' ? input : {};
  const main = i.url || i.file_path || i.path || i.pattern || i.query || i.prompt || '';
  if (main) return clip(String(main), 600);
  try {
    return clip(JSON.stringify(i), 600);
  } catch {
    return '';
  }
}

function createHarnessPermissions({
  /** Même contrat que la confirmation des opérations : résout 'deny' | 'once' | 'always'. */
  confirm,
  /** Plan validé d'une commande (`buildShellPlan` de host-ops). */
  buildPlan,
  /** Règle `shell.run` couvrant ce plan pour cet utilisateur et cet agent, ou null. */
  findShellGrant,
  /** Enregistre une règle `shell.run`. */
  addShellGrant,
  /** Binaire qui lance le serveur MCP (Electron en mode Node) et chemin du script. */
  nodeBinary = process.execPath,
  scriptPath = path.join(__dirname, 'permission-mcp.js'),
  platform = process.platform,
  confirmTimeoutMs = DEFAULT_CONFIRM_TIMEOUT_MS,
  netImpl = net,
}) {
  const contexts = new Map(); // token -> contexte d'exécution
  let server = null;
  let socketPath = null;
  let starting = null;

  function listen() {
    if (server) return Promise.resolve(socketPath);
    if (starting) return starting;
    starting = new Promise((resolve, reject) => {
      if (platform === 'win32') {
        socketPath = `\\\\.\\pipe\\lasco-harness-${crypto.randomBytes(8).toString('hex')}`;
      } else {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lasco-h-'));
        fs.chmodSync(dir, 0o700);
        socketPath = path.join(dir, 'p.sock');
      }
      const srv = netImpl.createServer((socket) => onConnection(socket));
      srv.on('error', (err) => {
        starting = null;
        reject(err);
      });
      srv.listen(socketPath, () => {
        server = srv;
        starting = null;
        resolve(socketPath);
      });
    });
    return starting;
  }

  function onConnection(socket) {
    let buffer = '';
    let handled = false;
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      if (handled) return;
      buffer += chunk.toString('utf8');
      if (buffer.length > MAX_LINE) {
        handled = true;
        socket.destroy();
        return;
      }
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      handled = true;
      let message;
      try {
        message = JSON.parse(buffer.slice(0, nl));
      } catch {
        message = null;
      }
      const ctx = message && typeof message.token === 'string' ? contexts.get(message.token) : null;
      const answer = ctx
        ? decide(ctx, { toolName: String(message.toolName || ''), input: message.input })
        : Promise.resolve({ behavior: 'deny', message: 'Demande inconnue.' });
      answer
        .catch(() => ({ behavior: 'deny', message: 'Erreur de Lasco Desktop.' }))
        .then((reply) => {
          try {
            socket.end(`${JSON.stringify(reply)}\n`);
          } catch {
            // le harnais est parti
          }
        });
    });
  }

  const allow = { behavior: 'allow' };
  const refused = (message) => ({ behavior: 'deny', message });

  async function ask(ctx, req) {
    const timer = setTimeout(() => ctx.controller.abort('timeout'), confirmTimeoutMs);
    timer.unref?.();
    try {
      return await confirm({ ...req, signal: ctx.controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function decide(ctx, { toolName, input }) {
    if (ctx.controller.signal.aborted) return refused('L’exécution est terminée.');
    ctx.count += 1;
    if (ctx.count > MAX_REQUESTS_PER_RUN) return refused('Trop de demandes pour cette exécution.');
    const base = {
      requestId: `${ctx.requestId.slice(0, 110)}-p${ctx.count}`,
      userId: ctx.userId,
      agentId: ctx.agentId,
      agentName: ctx.agentName,
      harness: ctx.harness,
      harnessLabel: ctx.harnessLabel,
      project: ctx.projectName,
      projectRoot: ctx.root,
    };
    const toolInput = input && typeof input === 'object' ? input : {};

    if (toolName === 'Bash') {
      let plan;
      try {
        plan = await buildPlan({ command: toolInput.command, cwd: ctx.root });
      } catch (err) {
        return refused(err?.message || 'Commande invalide.');
      }
      if (findShellGrant(ctx, plan)) {
        ctx.onDecision?.({ toolName, command: plan.command, decision: 'grant' });
        return allow;
      }
      const allowPersistent = !plan.notRememberableReason && plan.prefix.length > 0 && path.parse(plan.cwd).root !== plan.cwd;
      const answer = await ask(ctx, {
        ...base,
        operation: 'code.harness_command',
        command: plan.command,
        description: typeof toolInput.description === 'string' ? clip(toolInput.description, 300) : '',
        allowPersistent,
        notRememberableReason: plan.notRememberableReason,
        scope: { commandPrefix: plan.prefix, cwdRoots: [plan.cwd] },
      });
      ctx.onDecision?.({ toolName, command: plan.command, decision: answer });
      if (answer !== 'once' && answer !== 'always') return refused('Refusé par l’utilisateur dans Lasco.');
      if (answer === 'always' && allowPersistent) {
        addShellGrant({ ...ctx, commandPrefix: plan.prefix, cwdRoots: [plan.cwd] });
      }
      return allow;
    }

    const answer = await ask(ctx, {
      ...base,
      operation: 'code.harness_tool',
      toolName: clip(toolName || 'outil', 120),
      detail: describeInput(toolInput),
      allowPersistent: false,
    });
    ctx.onDecision?.({ toolName, decision: answer });
    return answer === 'once' || answer === 'always' ? allow : refused('Refusé par l’utilisateur dans Lasco.');
  }

  /**
   * Prépare le relais d'une exécution : options de Claude Code (`--mcp-config`, `--permission-prompt-tool`),
   * variables d'environnement et `dispose()` à appeler à la fin de l'exécution.
   */
  async function prepare(run) {
    const where = await listen();
    const token = crypto.randomBytes(24).toString('hex');
    const ctx = {
      token,
      requestId: String(run.requestId),
      userId: run.userId,
      agentId: run.agentId,
      agentName: run.agentName,
      harness: run.harness,
      harnessLabel: run.harnessLabel,
      projectName: run.projectName,
      root: run.root,
      onDecision: run.onDecision,
      controller: new AbortController(),
      count: 0,
    };
    contexts.set(token, ctx);
    const mcpConfig = JSON.stringify({
      mcpServers: {
        [SERVER_NAME]: {
          type: 'stdio',
          command: nodeBinary,
          args: [scriptPath],
          env: {
            ELECTRON_RUN_AS_NODE: '1',
            LASCO_HARNESS_PERMISSION_SOCKET: where,
            LASCO_HARNESS_PERMISSION_TOKEN: token,
            LASCO_HARNESS_PERMISSION_TIMEOUT_MS: String(confirmTimeoutMs + 30000),
          },
        },
      },
    });
    return {
      mcpConfig,
      toolName: PERMISSION_TOOL,
      // Délai d'un appel MCP côté Claude Code : la personne a le temps de répondre à la carte.
      // Connexion MCP bloquante : l'outil d'autorisation doit exister dès le démarrage, sinon Claude Code s'arrête
      // (« passed via --permission-prompt-tool not found »).
      env: { MCP_TOOL_TIMEOUT: String(confirmTimeoutMs + 60000), MCP_CONNECTION_NONBLOCKING: '0' },
      dispose() {
        ctx.controller.abort('done');
        contexts.delete(token);
      },
    };
  }

  function close() {
    for (const ctx of contexts.values()) ctx.controller.abort('closed');
    contexts.clear();
    if (server) {
      server.close();
      server = null;
    }
    if (socketPath && platform !== 'win32') {
      try {
        fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
      } catch {
        // déjà supprimé
      }
    }
  }

  return { prepare, close, decide, contexts };
}

module.exports = { createHarnessPermissions, PERMISSION_TOOL, describeInput };
