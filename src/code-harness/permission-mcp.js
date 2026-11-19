'use strict';

/**
 * Serveur MCP (stdio) de Lasco Desktop pour Claude Code : `--permission-prompt-tool mcp__lasco_desktop__approve`.
 *
 * Claude Code tourne en mode non interactif (`-p`) : sans ce relais, toute commande (npm, npx, git…) est refusée
 * d'office. Ici, chaque demande d'autorisation est transmise à Lasco Desktop par une socket locale (jeton propre à
 * l'exécution) ; Desktop la montre en carte dans le chat et renvoie la décision. Desktop seul décide : ce script
 * ne fait que relayer, et refuse en cas d'erreur.
 *
 * Lancé par Claude Code avec `ELECTRON_RUN_AS_NODE=1` (binaire de Desktop), sans dépendance.
 */

const net = require('net');
const readline = require('readline');

const TOOL_NAME = 'approve';
const SERVER_NAME = 'lasco_desktop';

function deny(message) {
  return { behavior: 'deny', message };
}

/** Demande la décision à Desktop ; refus si la socket est absente ou muette. */
function askDesktop({ socketPath, token, request, timeoutMs }) {
  return new Promise((resolve) => {
    let settled = false;
    let buffer = '';
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        // déjà fermée
      }
      resolve(value);
    };
    const timer = setTimeout(() => done(deny('Pas de réponse de Lasco Desktop.')), timeoutMs);
    const socket = net.createConnection(socketPath);
    socket.on('connect', () => socket.write(`${JSON.stringify({ token, ...request })}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      try {
        const reply = JSON.parse(buffer.slice(0, nl));
        if (reply && reply.behavior === 'allow') done({ behavior: 'allow', updatedInput: request.input });
        else done(deny(typeof reply?.message === 'string' ? reply.message : 'Refusé par l’utilisateur.'));
      } catch {
        done(deny('Réponse illisible de Lasco Desktop.'));
      }
    });
    socket.on('error', () => done(deny('Lasco Desktop est injoignable.')));
    socket.on('close', () => done(deny('Lasco Desktop a fermé la demande.')));
  });
}

/** Pur (hors E/S) : réponse JSON-RPC à un message MCP. `null` pour une notification. */
async function handleMessage(message, ask) {
  if (!message || typeof message !== 'object' || message.id === undefined || message.id === null) return null;
  const reply = (result) => ({ jsonrpc: '2.0', id: message.id, result });
  const error = (code, text) => ({ jsonrpc: '2.0', id: message.id, error: { code, message: text } });
  switch (message.method) {
    case 'initialize':
      return reply({
        protocolVersion: message.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: '1.0.0' },
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({
        tools: [
          {
            name: TOOL_NAME,
            description: 'Demande à la personne, dans Lasco, d’autoriser un outil de Claude Code.',
            inputSchema: {
              type: 'object',
              properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
              required: ['tool_name', 'input'],
            },
          },
        ],
      });
    case 'tools/call': {
      if (message.params?.name !== TOOL_NAME) return error(-32602, 'Outil inconnu.');
      const args = message.params?.arguments || {};
      const input = args.input && typeof args.input === 'object' ? args.input : {};
      const decision = await ask({ toolName: String(args.tool_name || ''), input, toolUseId: String(args.tool_use_id || '') });
      return reply({ content: [{ type: 'text', text: JSON.stringify(decision) }] });
    }
    default:
      return error(-32601, 'Méthode inconnue.');
  }
}

function main() {
  const socketPath = process.env.LASCO_HARNESS_PERMISSION_SOCKET;
  const token = process.env.LASCO_HARNESS_PERMISSION_TOKEN;
  const timeoutMs = Number(process.env.LASCO_HARNESS_PERMISSION_TIMEOUT_MS) || 10 * 60 * 1000;
  const ask = (request) =>
    socketPath && token ? askDesktop({ socketPath, token, request, timeoutMs }) : Promise.resolve(deny('Relais Lasco non configuré.'));
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    handleMessage(message, ask).then((response) => {
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    });
  });
  rl.on('close', () => process.exit(0));
}

if (require.main === module) main();

module.exports = { handleMessage, askDesktop, TOOL_NAME, SERVER_NAME };
