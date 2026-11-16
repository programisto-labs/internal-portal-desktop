'use strict';

/**
 * `shell.run`: an agent runs a command in the user's shell on this computer (internal-portal#2387).
 *
 * Same model as ChatGPT / Claude Code: every command is shown and confirmed in a native dialog,
 * unless a « Toujours autoriser » rule covers it. A rule is a command prefix (e.g. `git status`,
 * `npm test`) in a folder, for one agent, user and device. Compound commands, expansions and
 * sensitive programs (deletion, privileges, interpreters, network, keychain…) are never covered
 * by a rule: they are confirmed every time.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { HostOpsError, assertPlainAbsolutePath, isWithin } = require('./paths');

const MAX_COMMAND_LENGTH = 4000;
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_TIMEOUT_MS = 300000;
const MIN_TIMEOUT_MS = 1000;
/** Characters kept per stream (head + tail). */
const MAX_STREAM_CHARS = 12000;
const KILL_GRACE_MS = 3000;

/**
 * Programs whose commands can never be remembered: deletion, privileges, permissions,
 * interpreters (a prefix would allow any script), network transfer, process control,
 * keychain and system configuration.
 */
const SENSITIVE_PROGRAMS = new Set([
  'rm', 'rmdir', 'unlink', 'shred', 'srm', 'trash', 'del', 'erase', 'rd', 'remove-item',
  'sudo', 'su', 'doas', 'pkexec', 'runas', 'start-process',
  'chmod', 'chown', 'chgrp', 'chflags', 'xattr', 'icacls', 'takeown', 'setfacl',
  'dd', 'mkfs', 'fdisk', 'diskutil', 'parted', 'format', 'mount', 'umount',
  'shutdown', 'reboot', 'halt', 'poweroff', 'kill', 'killall', 'pkill', 'taskkill', 'stop-process',
  'launchctl', 'systemctl', 'service', 'crontab', 'at', 'schtasks', 'defaults', 'reg', 'regedit',
  'security', 'csrutil', 'spctl', 'tccutil', 'networksetup', 'scutil', 'pmset', 'nvram',
  'sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'cmd', 'powershell', 'pwsh',
  'python', 'python2', 'python3', 'node', 'deno', 'bun', 'perl', 'ruby', 'php', 'lua', 'osascript',
  'eval', 'exec', 'source', '.', 'xargs', 'env', 'nohup', 'time', 'timeout', 'watch', 'command', 'builtin',
  'curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat', 'netcat', 'telnet', 'ftp', 'invoke-webrequest',
  'open', 'xdg-open', 'start',
  'git-credential', 'gpg', 'ssh-add', 'ssh-keygen',
]);

const SUBCOMMAND_RE = /^[A-Za-z][A-Za-z0-9:_-]{0,40}$/;

/** Secret-looking values never reach the journal or the model. */
const SECRET_PATTERNS = [
  /(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /((?:password|passwd|pwd|secret|token|api[_-]?key)\s*[=:]\s*)\S+/gi,
  /\b(sk|ghp|gho|ghs|github_pat|xox[abp])[-_][A-Za-z0-9_-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];

function maskSecrets(text) {
  if (typeof text !== 'string') return '';
  return SECRET_PATTERNS.reduce(
    (acc, re) => acc.replace(re, (_m, p1) => `${typeof p1 === 'string' && p1.length < 16 ? p1 : ''}[masqué]`),
    text
  );
}

/**
 * POSIX-like tokenizer, enough to recognise a simple command `prog arg…`.
 * `compound` is true for anything a prefix rule could not reason about: operators
 * (; & | < > newline), substitutions ($ and backticks), unterminated quotes, env assignments.
 */
function analyzeCommand(command) {
  const tokens = [];
  let cur = '';
  let has = false;
  let quote = null;
  let compound = false;
  const push = () => {
    if (has) tokens.push(cur);
    cur = '';
    has = false;
  };
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    const next = command[i + 1];
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && next !== undefined && '"\\$`'.includes(next)) {
        cur += next;
        i += 1;
      } else {
        if (c === '$' || c === '`') compound = true;
        cur += c;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
      continue;
    }
    if (c === '\\') {
      if (next === '\n' || next === undefined) compound = true;
      else {
        cur += next;
        i += 1;
        has = true;
      }
      continue;
    }
    if (c === '\n' || c === '\r') {
      compound = true;
      push();
      continue;
    }
    if (/\s/.test(c)) {
      push();
      continue;
    }
    if (';&|<>`$(){}'.includes(c)) compound = true;
    cur += c;
    has = true;
  }
  if (quote) compound = true;
  push();
  // `FOO=bar prog` changes how prog behaves (GIT_SSH_COMMAND, LD_PRELOAD…).
  if (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) compound = true;
  return { tokens, compound };
}

function programName(token) {
  const base = String(token || '').split(/[\\/]/).pop().toLowerCase();
  return base.replace(/\.(exe|cmd|bat|ps1)$/, '').replace(/^(python|pip)\d+(\.\d+)?$/, 'python');
}

function isSensitiveProgram(token) {
  const name = programName(token);
  return SENSITIVE_PROGRAMS.has(name) || name.startsWith('mkfs') || name.startsWith('python');
}

/** Rule prefix offered by « Toujours autoriser »: program, plus its subcommand when there is one. */
function suggestPrefix(tokens) {
  if (!tokens.length) return [];
  if (tokens.length > 1 && SUBCOMMAND_RE.test(tokens[1])) return tokens.slice(0, 2);
  return tokens.slice(0, 1);
}

/**
 * Why the command can never be remembered, or null when a prefix rule may cover it.
 * Windows shells parse differently: no rules there, every command is confirmed.
 */
function notRememberableReason(analysis, platform) {
  if (platform === 'win32') return 'Sous Windows, chaque commande est confirmée.';
  if (!analysis.tokens.length) return 'Commande vide.';
  if (analysis.compound) {
    return 'Commande composée (;, &&, |, redirection, $(…), variable…) : confirmée à chaque fois.';
  }
  if (isSensitiveProgram(analysis.tokens[0])) {
    return `« ${programName(analysis.tokens[0])} » est une commande sensible : confirmée à chaque fois.`;
  }
  return null;
}

function prefixMatches(prefix, tokens) {
  return (
    Array.isArray(prefix) &&
    prefix.length > 0 &&
    tokens.length >= prefix.length &&
    prefix.every((t, i) => tokens[i] === t)
  );
}

function clampTimeout(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(n)));
}

/** Validated, real-path plan for a shell request. Recomputed after the dialog. */
async function buildShellPlan(fsp, request, { platform = process.platform, homeDir }) {
  const command = typeof request.command === 'string' ? request.command.trim() : '';
  if (!command) throw new HostOpsError('invalid_command', 'Commande vide.');
  if (command.length > MAX_COMMAND_LENGTH) throw new HostOpsError('invalid_command', 'Commande trop longue.');
  if (command.includes('\0')) throw new HostOpsError('invalid_command', 'Caractère nul interdit.');
  const rawCwd = request.cwd === undefined || request.cwd === null || request.cwd === '' ? homeDir : request.cwd;
  const plain = assertPlainAbsolutePath(rawCwd, 'cwd', platform);
  let cwd;
  try {
    cwd = await fsp.realpath(plain);
  } catch (err) {
    if (err && err.code === 'ENOENT') throw new HostOpsError('cwd_missing', "Le dossier de travail n'existe pas.");
    throw err;
  }
  const st = await fsp.stat(cwd);
  if (!st.isDirectory()) throw new HostOpsError('cwd_not_directory', "Le dossier de travail n'est pas un dossier.");
  const analysis = analyzeCommand(command);
  const reason = notRememberableReason(analysis, platform);
  return {
    operation: 'shell.run',
    command,
    cwd,
    timeoutMs: clampTimeout(request.timeoutMs),
    tokens: analysis.tokens,
    compound: analysis.compound,
    prefix: reason ? [] : suggestPrefix(analysis.tokens),
    notRememberableReason: reason,
  };
}

/** A shell rule covers a simple, non-sensitive command starting with its prefix, inside its folder. */
function shellGrantCovers(grant, plan, platform = process.platform) {
  if (grant.operation !== 'shell.run' || plan.notRememberableReason) return false;
  if (!prefixMatches(grant.commandPrefix, plan.tokens)) return false;
  return (grant.cwdRoots || []).some((root) => isWithin(root, plan.cwd, platform));
}

/** Keeps the first and last chars of a stream. */
function createCollector(max = MAX_STREAM_CHARS) {
  const half = Math.floor(max / 2);
  let head = '';
  let tail = '';
  let total = 0;
  return {
    push(chunk) {
      const text = chunk.toString('utf8');
      total += text.length;
      if (head.length < half) {
        const room = half - head.length;
        head += text.slice(0, room);
        tail = (tail + text.slice(room)).slice(-half);
      } else {
        tail = (tail + text).slice(-half);
      }
    },
    result() {
      const truncated = total > head.length + tail.length;
      return {
        text: truncated ? `${head}\n…[${total - head.length - tail.length} caractères omis]…\n${tail}` : head + tail,
        truncated,
      };
    },
  };
}

function shellInvocation(command, platform, env) {
  if (platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
    };
  }
  const userShell = typeof env.SHELL === 'string' && path.isAbsolute(env.SHELL) && fs.existsSync(env.SHELL) ? env.SHELL : '/bin/sh';
  // Login shell: GUI apps on macOS start with a minimal PATH (no Homebrew, nvm…).
  return { file: userShell, args: ['-l', '-c', command] };
}

function childEnv(base) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (!k.startsWith('ELECTRON_') && typeof v === 'string') env[k] = v;
  }
  return { ...env, TERM: 'dumb', NO_COLOR: '1', LASCO_AGENT: '1' };
}

function killTree(child, platform, spawnImpl) {
  if (!child || child.exitCode !== null || child.pid === undefined) return;
  if (platform === 'win32') {
    try {
      spawnImpl('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } catch (_) {
      // best effort
    }
    return;
  }
  const signalGroup = (sig) => {
    try {
      process.kill(-child.pid, sig);
    } catch (_) {
      try {
        child.kill(sig);
      } catch (__) {
        // already gone
      }
    }
  };
  signalGroup('SIGTERM');
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) signalGroup('SIGKILL');
  }, KILL_GRACE_MS).unref();
}

/**
 * Runs the command with the user's rights (never elevated), stdin closed, bounded output.
 * Resolves with the real exit status; `aborted` is set when the signal stopped it.
 */
function runShell({ command, cwd, signal, platform = process.platform, env = process.env, spawnImpl = spawn }) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const { file, args } = shellInvocation(command, platform, env);
    let child;
    try {
      child = spawnImpl(file, args, {
        cwd,
        env: childEnv(env),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: platform !== 'win32',
        windowsHide: true,
      });
    } catch (err) {
      reject(err);
      return;
    }
    const stdout = createCollector();
    const stderr = createCollector();
    child.stdout.on('data', (d) => stdout.push(d));
    child.stderr.on('data', (d) => stderr.push(d));
    const onAbort = () => killTree(child, platform, spawnImpl);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('error', (err) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code, sig) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      const out = stdout.result();
      const err = stderr.result();
      resolve({
        exitCode: typeof code === 'number' ? code : null,
        signal: sig || null,
        stdout: maskSecrets(out.text),
        stderr: maskSecrets(err.text),
        truncated: out.truncated || err.truncated,
        durationMs: Date.now() - started,
        aborted: Boolean(signal && signal.aborted),
      });
    });
  });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MAX_STREAM_CHARS,
  analyzeCommand,
  buildShellPlan,
  createCollector,
  isSensitiveProgram,
  maskSecrets,
  notRememberableReason,
  runShell,
  shellGrantCovers,
  suggestPrefix,
};
