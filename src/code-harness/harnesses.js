'use strict';

/**
 * Harnais de code tiers lancés par un agent Lasco sur un projet de Lasco Code (cet ordinateur) :
 * Claude Code, Codex, Cursor Agent, Mistral Vibe, en mode non interactif avec une sortie JSON en flux.
 *
 * Lasco ne gère jamais leur connexion : la personne se connecte elle-même dans le CLI (`loginCommand`),
 * Desktop détecte seulement « non connecté » dans la sortie et le signale.
 */

const HARNESSES = {
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    bin: 'claude',
    loginCommand: 'claude /login',
    updateCommand: 'claude update',
    // Modifications de fichiers acceptées ; chaque autre outil (commande npm, npx, git…) passe par le relais
    // d'autorisation de Desktop (`permissions.js`) et s'affiche en carte dans le chat. Sans relais, refusé.
    effect:
      'modifie les fichiers du projet sans confirmer chaque modification ; chaque commande qu’il veut lancer (npm, npx, git…) vous est demandée dans le chat.',
    permissionPrompt: true,
    args({ prompt, sessionId, permission }) {
      return [
        '-p',
        prompt,
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        'acceptEdits',
        ...(permission ? ['--mcp-config', permission.mcpConfig, '--permission-prompt-tool', permission.toolName] : []),
        ...(sessionId ? ['--resume', sessionId] : []),
      ];
    },
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    bin: 'codex',
    loginCommand: 'codex login',
    updateCommand: 'npm install -g @openai/codex@latest',
    // Bac à sable de Codex : écriture limitée au projet, sans réseau.
    effect: 'modifie les fichiers et lance des commandes dans le bac à sable de Codex (écriture limitée au projet, sans réseau).',
    // Pas de reprise de session en mode exec avec cette version : chaque demande repart du projet.
    args({ prompt, cwd }) {
      return ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-C', cwd, prompt];
    },
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    bin: 'cursor-agent',
    loginCommand: 'cursor-agent login',
    effect: 'modifie les fichiers et lance des commandes avec vos droits, sans confirmer chaque action.',
    updateCommand: 'cursor-agent update',
    // `--trust` (sans lui, un projet jamais ouvert attend une confirmation) n'existe que dans les versions
    // récentes : une version plus ancienne refuse l'option et ne démarre pas. On ne passe que ce qu'elle connaît.
    probeHelp: true,
    args({ prompt, sessionId, supports = () => true }) {
      return [
        '-p',
        prompt,
        '--output-format',
        'stream-json',
        ...(supports('--force') ? ['--force'] : []),
        ...(supports('--trust') ? ['--trust'] : []),
        ...(sessionId ? ['--resume', sessionId] : []),
      ];
    },
  },
  vibe: {
    id: 'vibe',
    label: 'Mistral Vibe',
    bin: 'vibe',
    loginCommand: 'vibe --setup',
    effect: 'modifie les fichiers et lance des commandes avec vos droits (outils approuvés automatiquement).',
    args({ prompt, cwd }) {
      return ['-p', prompt, '--output', 'streaming', '--workdir', cwd, '--max-turns', '60'];
    },
  },
};

const LOGIN_RE = /not logged in|please run \/login|\blogin required\b|authenticat(e|ion) (required|failed)|no api key|api key (is )?(missing|not set)|unauthorized|401\b/i;

function clip(text, max = 400) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

function toolLabel(name, input) {
  const n = String(name || 'outil');
  const i = input && typeof input === 'object' ? input : {};
  const target = i.file_path || i.path || i.filePath || i.command || i.cmd || i.pattern || i.query || i.url || '';
  const shown = Array.isArray(target) ? target.join(' ') : target;
  return clip(shown ? `${n} · ${shown}` : n, 160);
}

/**
 * Pur : événements communs pour une ligne JSON d'un harnais.
 * `{ kind: 'session', id }`, `{ kind: 'text', text }`, `{ kind: 'step', text }`,
 * `{ kind: 'result', text, error }`, `{ kind: 'login_required', text }`.
 */
function parseHarnessLine(harness, line) {
  let json;
  try {
    json = JSON.parse(line);
  } catch {
    return [];
  }
  if (!json || typeof json !== 'object') return [];
  const out = [];
  const pushText = (text) => {
    const t = String(text || '').trim();
    if (!t) return;
    if (LOGIN_RE.test(t) && t.length < 300) out.push({ kind: 'login_required', text: clip(t, 300) });
    else out.push({ kind: 'text', text: t.slice(0, 8000) });
  };

  if (harness === 'claude-code' || harness === 'cursor') {
    if (json.session_id && json.type === 'system') out.push({ kind: 'session', id: String(json.session_id) });
    if (json.type === 'assistant' && json.message) {
      const content = Array.isArray(json.message.content) ? json.message.content : [];
      for (const part of content) {
        if (part?.type === 'text') pushText(part.text);
        else if (part?.type === 'tool_use') out.push({ kind: 'step', text: toolLabel(part.name, part.input) });
      }
    }
    if (json.type === 'tool_call' && (json.subtype === 'started' || !json.subtype)) {
      const call = json.tool_call && typeof json.tool_call === 'object' ? json.tool_call : {};
      const key = Object.keys(call)[0];
      const args = key && call[key] && typeof call[key] === 'object' ? call[key].args : undefined;
      out.push({ kind: 'step', text: toolLabel(key ? key.replace(/ToolCall$/, '') : 'outil', args) });
    }
    if (json.type === 'result') {
      const text = typeof json.result === 'string' ? json.result : '';
      if (LOGIN_RE.test(text) && text.length < 300) out.push({ kind: 'login_required', text: clip(text, 300) });
      else out.push({ kind: 'result', text: text.slice(0, 8000), error: json.is_error === true || json.subtype === 'error' });
      if (json.session_id) out.push({ kind: 'session', id: String(json.session_id) });
    }
    return out;
  }

  if (harness === 'codex') {
    // Format 0.2x : { id, msg: { type, … } } ; format récent : { type: 'item.completed', item: { … } }.
    const msg = json.msg && typeof json.msg === 'object' ? json.msg : null;
    if (msg) {
      if (msg.type === 'session_configured' && msg.session_id) out.push({ kind: 'session', id: String(msg.session_id) });
      else if (msg.type === 'agent_message') pushText(msg.message);
      else if (msg.type === 'exec_command_begin') out.push({ kind: 'step', text: toolLabel('Commande', { command: [].concat(msg.command || []).join(' ') }) });
      else if (msg.type === 'patch_apply_begin') out.push({ kind: 'step', text: toolLabel('Modification', { path: Object.keys(msg.changes || {}).join(', ') }) });
      else if (msg.type === 'task_complete') out.push({ kind: 'result', text: String(msg.last_agent_message || '').slice(0, 8000), error: false });
      else if (msg.type === 'error' || msg.type === 'stream_error') {
        const text = String(msg.message || 'Erreur de Codex.');
        out.push(LOGIN_RE.test(text) ? { kind: 'login_required', text: clip(text, 300) } : { kind: 'result', text: clip(text, 2000), error: true });
      }
      return out;
    }
    if (json.type === 'thread.started' && json.thread_id) out.push({ kind: 'session', id: String(json.thread_id) });
    const item = json.item && typeof json.item === 'object' ? json.item : null;
    if (json.type === 'item.completed' && item) {
      if (item.type === 'agent_message') pushText(item.text);
      else if (item.type === 'command_execution') out.push({ kind: 'step', text: toolLabel('Commande', { command: item.command }) });
      else if (item.type === 'file_change') out.push({ kind: 'step', text: toolLabel('Modification', { path: (item.changes || []).map((c) => c.path).join(', ') }) });
    }
    if (json.type === 'turn.completed') out.push({ kind: 'result', text: '', error: false });
    if (json.type === 'turn.failed' || json.type === 'error') {
      const text = String(json.error?.message || json.message || 'Erreur de Codex.');
      out.push(LOGIN_RE.test(text) ? { kind: 'login_required', text: clip(text, 300) } : { kind: 'result', text: clip(text, 2000), error: true });
    }
    return out;
  }

  if (harness === 'vibe') {
    if (json.role === 'assistant') {
      if (typeof json.content === 'string') pushText(json.content);
      for (const call of Array.isArray(json.tool_calls) ? json.tool_calls : []) {
        let args = {};
        try {
          args = JSON.parse(call?.function?.arguments || '{}');
        } catch {
          args = {};
        }
        out.push({ kind: 'step', text: toolLabel(call?.function?.name, args) });
      }
    }
    return out;
  }
  return out;
}

module.exports = { HARNESSES, parseHarnessLine, LOGIN_RE };
