'use strict';

/**
 * Exécutions de harnais de code (Claude Code, Codex, Cursor, Vibe) sur un projet de Lasco Code.
 *
 * - Interrupteur « Harnais de code » de Réglages > Cet ordinateur (désactivé par défaut).
 * - Projet ouvert dans Lasco Code seulement (racine connue de Desktop, jamais un chemin envoyé par la page).
 * - Une confirmation par exécution (carte dans le chat, dessinée par Desktop), sauf « Toujours autoriser » pour
 *   cet agent, ce harnais et ce projet. Le harnais agit ensuite avec ses propres règles (voir `effect`).
 * - Une exécution à la fois par projet ; 30 min au plus ; arrêt à la demande (groupe de processus tué).
 * - Événements vers la page : `started`, `step`, `text`, `done` (résumé, fichiers modifiés, session).
 */

const crypto = require('crypto');
const { spawn: spawnDefault, execFile } = require('child_process');
const { HARNESSES, parseHarnessLine } = require('./harnesses');
const { checkAuth: checkAuthDefault, startLogin: startLoginDefault } = require('./auth');
const { pruneRuns } = require('./history');
const { resolveHarnessCommand, execHarness, helpFlags } = require('./command');

const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const CONVERSATION_RE = /^[a-f0-9]{24}$/;
const MAX_PROMPT = 20000;
const MAX_STEPS = 200;
const MAX_TEXT = 20000;
const DEFAULT_MAX_MS = 30 * 60 * 1000;

function clip(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function changedFiles(cwd, env) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'status', '--porcelain=v1', '-uall'], { env, timeout: 15000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(
        String(stdout)
          .split('\n')
          .filter(Boolean)
          .slice(0, 200)
          .map((line) => ({ status: line.slice(0, 2).trim() || '?', path: line.slice(3) })),
      );
    });
  });
}

function createHarnessRunner({
  isEnabled,
  getProject,
  confirm,
  emit: emitEvent,
  history = null,
  getEnv = () => process.env,
  spawnImpl = spawnDefault,
  listFiles = changedFiles,
  maxMs = DEFAULT_MAX_MS,
  now = Date.now,
  checkAuth = (harness, env) => checkAuthDefault(harness, { env }),
  startLogin = startLoginDefault,
  /** Relais des demandes d'autorisation du harnais (`permissions.js`) ; absent = refus d'office (mode -p). */
  permissions = null,
  /** Commande réelle du binaire (Windows : `.exe`, ou programme derrière un `.cmd`). */
  resolveCommand = (bin, env) => resolveHarnessCommand(bin, { env }),
  /** Options connues de la version installée (`--help`), `null` si inconnues. */
  probeFlags = (bin, env) => helpFlags(bin, { env }),
}) {
  const runs = new Map();
  const logins = new Map(); // harness -> cancel
  let persistTimer = null;

  /** Champs gardés d'une exécution (jamais le processus) ; relus au redémarrage. */
  function stored(run) {
    const { child: _child, ...rest } = run;
    return { ...rest, steps: run.steps.slice(-40), text: clip(run.text, 4000) };
  }

  function persistNow() {
    persistTimer = null;
    if (!history) return;
    const kept = pruneRuns([...runs.values()], now());
    for (const runId of [...runs.keys()]) if (!kept.some((r) => r.runId === runId)) runs.delete(runId);
    history.save(kept.map(stored));
  }

  function schedulePersist() {
    if (!history || persistTimer) return;
    persistTimer = setTimeout(persistNow, 300);
    persistTimer.unref?.();
  }

  function emit(event) {
    emitEvent(event);
    if (event.type === 'started' || event.type === 'done' || event.type === 'removed') schedulePersist();
  }

  // Exécutions des sessions précédentes : une exécution en cours à la fermeture est marquée interrompue.
  for (const saved of history ? pruneRuns(history.load(), now()) : []) {
    if (!HARNESSES[saved.harness] || !Array.isArray(saved.steps)) continue;
    const run = { ...saved, child: null, text: String(saved.text ?? ''), lastText: String(saved.lastText ?? '') };
    if (run.status === 'running') {
      run.status = 'error';
      run.result = {
        ok: false,
        summary: `${HARNESSES[run.harness].label} a été interrompu : Lasco Desktop a été fermé pendant l’exécution.`,
        files: [],
        ...(run.sessionId ? { sessionId: run.sessionId } : {}),
        durationMs: Math.max(0, now() - run.startedAt),
      };
    }
    runs.set(run.runId, run);
  }

  /** Environnement du harnais : celui du shell, sans les variables d'une session Claude Code parente. */
  async function harnessEnv() {
    // `getEnv` peut renvoyer une promesse (environnement du shell de connexion, résolu une fois).
    const env = { ...((await getEnv()) || {}) };
    delete env.ELECTRON_RUN_AS_NODE;
    for (const key of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT_SDK)/.test(key)) delete env[key];
    return env;
  }

  function view(run) {
    return {
      runId: run.runId,
      requestId: run.requestId,
      harness: run.harness,
      harnessLabel: HARNESSES[run.harness].label,
      projectId: run.projectId,
      projectName: run.projectName,
      agentName: run.agentName,
      prompt: clip(run.prompt, 400),
      status: run.status,
      startedAt: run.startedAt,
      steps: run.steps.slice(-40),
      text: clip(run.text, 4000),
      ...(run.result !== undefined ? { result: run.result } : {}),
      ...(run.authState ? { authState: run.authState } : {}),
      // Fil du chat qui a lancé l'exécution, et qui l'a lancée : l'outil de l'agent ou la carte (relance, suite).
      ...(run.conversationId ? { conversationId: run.conversationId } : {}),
      origin: run.origin || 'tool',
    };
  }

  /** Exécution sans processus (connexion requise) : la carte propose « Se connecter » puis « Relancer ». */
  function blockedRun(req, def, project, agentName, prompt, auth, origin) {
    const run = {
      runId: `h_${crypto.randomBytes(8).toString('hex')}`,
      requestId: req.requestId,
      request: { ...req, prompt },
      origin,
      conversationId: conversationOf(req),
      harness: req.harness,
      projectId: req.projectId,
      projectName: project.name,
      agentName,
      prompt,
      status: auth.state === 'config_error' ? 'error' : 'login_required',
      startedAt: now(),
      steps: [],
      text: '',
      authState: auth.state,
      result: {
        ok: false,
        summary:
          auth.message ||
          `${def.label} n’est pas connecté sur cet ordinateur. Utilisez « Se connecter » dans la carte du chat, puis « Relancer ».`,
        files: [],
        loginCommand: def.loginCommand,
      },
    };
    runs.set(run.runId, run);
    emit({ type: 'done', run: view(run) });
    return {
      ok: false,
      status: run.status,
      requestId: run.requestId,
      result: { runId: run.runId, harness: run.harness, project: project.name, ...run.result },
      error: { code: auth.state === 'config_error' ? 'config_error' : 'login_required', message: run.result.summary },
    };
  }

  /** Statut des harnais installés (version), sans rien lancer d'autre que `--version`. */
  async function status() {
    const env = await harnessEnv();
    const entries = await Promise.all(
      Object.values(HARNESSES).map(
        (h) =>
          new Promise((resolve) => {
            execHarness(h.bin, ['--version'], { env, timeout: 8000 }, (err, stdout) => {
              const version = err ? null : clip(String(stdout).split('\n')[0].trim(), 80);
              resolve({ id: h.id, label: h.label, installed: Boolean(version), version, loginCommand: h.loginCommand });
            });
          }),
      ),
    );
    return { enabled: isEnabled(), harnesses: entries };
  }

  function conversationOf(req) {
    return typeof req.conversationId === 'string' && CONVERSATION_RE.test(req.conversationId) ? req.conversationId : null;
  }

  /** Lancement demandé par l'outil de l'agent (`host_code_delegate`). */
  function start(request) {
    return launch(request, 'tool');
  }

  async function launch(request, origin) {
    const req = request && typeof request === 'object' ? request : {};
    const fail = (code, message) => ({ ok: false, status: 'error', error: { code, message } });
    if (!isEnabled()) return fail('disabled', 'Les harnais de code ne sont pas activés dans Lasco Desktop (Réglages > Cet ordinateur).');
    const harness = HARNESSES[req.harness] ? req.harness : null;
    if (!harness) return fail('unsupported_harness', 'Harnais de code inconnu.');
    for (const key of ['requestId', 'userId', 'agentId', 'projectId']) {
      if (typeof req[key] !== 'string' || !ID_RE.test(req[key])) return fail('invalid_request', `${key} invalide.`);
    }
    const prompt = typeof req.prompt === 'string' ? req.prompt.trim().slice(0, MAX_PROMPT) : '';
    if (!prompt) return fail('invalid_request', 'Consigne vide.');
    let project;
    try {
      project = getProject(req.userId, req.projectId);
    } catch (error) {
      return fail(error?.code || 'project_not_found', error?.message || 'Projet introuvable. Ouvrez-le dans Lasco Code.');
    }
    if ([...runs.values()].some((r) => r.projectId === req.projectId && r.status === 'running')) {
      return fail('busy', `Un harnais travaille déjà sur ${project.name}. Attendez la fin ou arrêtez-le.`);
    }
    const def = HARNESSES[harness];
    const agentName = clip(typeof req.agentName === 'string' ? req.agentName : 'Agent', 120);
    // Connexion vérifiée avant toute confirmation : inutile de demander l'accord pour un harnais inutilisable.
    const auth = await checkAuth(harness, await harnessEnv()).catch(() => ({ state: 'unknown' }));
    if (auth.state === 'not_installed') return fail('not_installed', `${def.label} n’est pas installé sur cet ordinateur.`);
    if (auth.state === 'logged_out' || auth.state === 'no_plan' || auth.state === 'config_error') {
      return blockedRun(req, def, project, agentName, prompt, auth, origin);
    }

    const decision = await confirm({
      requestId: req.requestId,
      agentId: req.agentId,
      userId: req.userId,
      agentName,
      operation: 'code.delegate',
      harness,
      harnessLabel: def.label,
      effect: def.effect,
      project: project.name,
      projectRoot: project.root,
      prompt,
    });
    if (decision !== 'once' && decision !== 'always' && decision !== 'grant') {
      return { ok: false, status: 'denied', error: { code: 'denied', message: 'Refusé par l’utilisateur.' } };
    }

    const run = {
      runId: `h_${crypto.randomBytes(8).toString('hex')}`,
      requestId: req.requestId,
      request: { ...req, prompt },
      harness,
      projectId: req.projectId,
      projectName: project.name,
      root: project.root,
      agentName,
      prompt,
      status: 'running',
      startedAt: now(),
      steps: [],
      text: '',
      lastText: '',
      sessionId: typeof req.sessionId === 'string' && ID_RE.test(req.sessionId) ? req.sessionId : null,
      request: { ...req, prompt },
      origin,
      conversationId: conversationOf(req),
      loginRequired: null,
      child: null,
      result: undefined,
    };
    runs.set(run.runId, run);
    emit({ type: 'started', run: view(run) });

    const env = await harnessEnv();
    // Claude Code : ses demandes d'autorisation (commandes) remontent en carte dans le chat.
    let permission = null;
    if (def.permissionPrompt && permissions) {
      permission = await permissions
        .prepare({
          requestId: req.requestId,
          userId: req.userId,
          agentId: req.agentId,
          agentName,
          harness,
          harnessLabel: def.label,
          projectName: project.name,
          root: project.root,
          onDecision: ({ command, toolName, decision }) => {
            if (decision !== 'deny') return;
            const text = `Refusé · ${clip(command || toolName, 140)}`;
            run.steps.push({ at: now(), text });
            if (run.steps.length > MAX_STEPS) run.steps.shift();
            emit({ type: 'step', runId: run.runId, text });
          },
        })
        .catch(() => null);
      if (permission) Object.assign(env, permission.env || {});
    }
    const resolved = resolveCommand(def.bin, env);
    const flags = def.probeHelp && !resolved.error ? await probeFlags(def.bin, env).catch(() => null) : null;
    const supports = (flag) => (flags ? flags.has(flag) : true);
    const args = def.args({ prompt, sessionId: run.sessionId, cwd: project.root, permission, supports });
    return new Promise((resolve) => {
      let child = null;
      if (!resolved.error) {
        try {
          child = spawnImpl(resolved.command, [...resolved.prefixArgs, ...args], {
            cwd: project.root,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: process.platform !== 'win32',
            windowsHide: true,
          });
        } catch {
          child = null;
        }
      }
      if (!child) {
        permission?.dispose();
        run.status = 'error';
        const summary =
          resolved.error === 'unsupported_shim'
            ? `${def.label} est installé (${resolved.shim}), mais Lasco Desktop ne sait pas lancer ce script sous Windows. Réinstallez ${def.label} avec son installeur officiel, puis relancez.`
            : `${def.label} n’a pas pu être lancé. Est-il installé ?`;
        run.result = { ok: false, summary, files: [] };
        emit({ type: 'done', run: view(run) });
        return resolve({ ok: false, status: 'error', error: { code: 'spawn_failed', message: run.result.summary }, run: view(run) });
      }
      run.child = child;
      let buffer = '';
      let stderr = '';
      let resultText = null;
      let resultError = false;
      const timer = setTimeout(() => stop(run.runId, 'timeout'), maxMs);

      const handle = (incoming) => {
        let event = incoming;
        if (event.kind === 'session') run.sessionId = event.id;
        else if (event.kind === 'login_required') run.loginRequired = event.text;
        else if (event.kind === 'step') {
          // Chemins affichés relatifs au projet.
          event = { ...event, text: event.text.split(`${project.root}/`).join('').split(`${project.root}\\`).join('') };
          run.steps.push({ at: now(), text: event.text });
          if (run.steps.length > MAX_STEPS) run.steps.shift();
          emit({ type: 'step', runId: run.runId, text: event.text });
        } else if (event.kind === 'text') {
          run.lastText = event.text;
          run.text = `${run.text}${run.text ? '\n\n' : ''}${event.text}`.slice(-MAX_TEXT);
          emit({ type: 'text', runId: run.runId, text: clip(event.text, 4000) });
        } else if (event.kind === 'result') {
          resultText = event.text;
          resultError = event.error === true;
        }
      };
      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) for (const event of parseHarnessLine(harness, line)) handle(event);
        }
      });
      child.stderr.on('data', (chunk) => {
        stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000);
      });
      child.on('error', () => undefined);
      child.on('close', async (code) => {
        clearTimeout(timer);
        // Demandes encore affichées : refusées, jeton retiré.
        permission?.dispose();
        if (buffer.trim()) for (const event of parseHarnessLine(harness, buffer.trim())) handle(event);
        const files = await listFiles(project.root, env).catch(() => []);
        const stopped = run.status === 'stopped' || run.status === 'timeout';
        let ok = !stopped && code === 0 && !resultError && !run.loginRequired;
        // Certains harnais (Cursor) renvoient tous leurs messages collés : le dernier suffit.
        const finalText = resultText && run.lastText && resultText !== run.lastText && resultText.endsWith(run.lastText) ? run.lastText : resultText;
        let summary = clip(finalText || run.lastText || '', 8000);
        if (run.loginRequired) {
          summary = `${def.label} n’est pas connecté sur cet ordinateur. Ouvrez un terminal et lancez \`${def.loginCommand}\`, puis relancez la demande.`;
        } else if (run.status === 'timeout') {
          summary = `${def.label} a été arrêté après ${Math.round(maxMs / 60000)} minutes.`;
        } else if (run.status === 'stopped') {
          summary = `${def.label} a été arrêté.`;
        } else if (!ok && !summary && /unknown option|unrecognized option|unexpected argument/i.test(stderr)) {
          // Version trop ancienne pour une option que Desktop passe : message utile plutôt que l'erreur brute.
          const option = /(?:unknown|unrecognized) option '([^']+)'|unexpected argument '([^']+)'/i.exec(stderr);
          const name = option ? option[1] || option[2] : null;
          summary = `La version de ${def.label} installée sur cet ordinateur est trop ancienne${name ? ` (option ${name} inconnue)` : ''}. Mettez-la à jour${def.updateCommand ? ` dans un terminal avec \`${def.updateCommand}\`` : ''}, puis relancez la demande.`;
        } else if (!ok && !summary) {
          summary = clip(stderr.trim() || `${def.label} s’est arrêté avec le code ${code}.`, 2000);
          ok = false;
        }
        if (!stopped) run.status = ok ? 'done' : run.loginRequired ? 'login_required' : 'error';
        run.result = {
          ok,
          summary,
          files,
          ...(run.sessionId ? { sessionId: run.sessionId } : {}),
          durationMs: now() - run.startedAt,
          ...(run.loginRequired ? { loginCommand: def.loginCommand } : {}),
        };
        run.child = null;
        emit({ type: 'done', run: view(run) });
        resolve({
          ok,
          status: ok ? 'completed' : run.status,
          requestId: run.requestId,
          result: { runId: run.runId, harness, project: project.name, ...run.result },
          ...(ok ? {} : { error: { code: run.status, message: summary } }),
        });
      });
    });
  }

  function stop(runId, reason = 'stopped') {
    const run = runs.get(runId);
    if (!run || run.status !== 'running' || !run.child) return { ok: true, stopped: false };
    run.status = reason === 'timeout' ? 'timeout' : 'stopped';
    try {
      if (run.child.pid && process.platform === 'win32') {
        // Windows : pas de groupe de processus ; taskkill /T arrête aussi les commandes lancées par le harnais.
        spawnImpl('taskkill', ['/pid', String(run.child.pid), '/T', '/F'], { windowsHide: true }).on?.('error', () => undefined);
      } else if (run.child.pid) process.kill(-run.child.pid, 'SIGTERM');
      else run.child.kill('SIGTERM');
    } catch {
      try {
        run.child.kill('SIGTERM');
      } catch {
        // déjà terminé
      }
    }
    const child = run.child;
    setTimeout(() => {
      try {
        if (child.exitCode === null && child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
      } catch {
        // déjà terminé
      }
    }, 5000).unref?.();
    return { ok: true, stopped: true };
  }

  function stopByRequest(requestId) {
    for (const run of runs.values()) if (run.requestId === requestId) return stop(run.runId);
    return { ok: true, stopped: false };
  }

  function list() {
    return [...runs.values()].map(view);
  }

  /** Connexion OAuth du harnais en arrière-plan ; événements `login` (pending / done / error, url). */
  async function login(harnessId) {
    const def = HARNESSES[harnessId];
    if (!def) return { ok: false, error: { code: 'unsupported_harness', message: 'Harnais de code inconnu.' } };
    if (logins.has(harnessId)) return { ok: true, pending: true };
    logins.set(harnessId, () => undefined); // réservé pendant la résolution de l'environnement
    const env = await harnessEnv();
    const cancel = startLogin(harnessId, {
      env,
      recheck: () => checkAuth(harnessId, env),
      onUpdate: (update) => {
        emit({ type: 'login', harness: harnessId, ...update });
        if (update.state !== 'pending') logins.delete(harnessId);
      },
    });
    logins.set(harnessId, cancel);
    return { ok: true, pending: true };
  }

  function nextRequestId(requestId, letter = 'r') {
    const value = String(requestId);
    const base = value.replace(/-[rf]\d+$/, '');
    const attempt = (Number(/-[rf](\d+)$/.exec(value)?.[1]) || 0) + 1;
    return `${base.slice(0, 120)}-${letter}${attempt}`;
  }

  /** Relance la même demande (nouvelle confirmation), par exemple après la connexion. */
  function retry(runId) {
    const run = runs.get(runId);
    if (!run || !run.request || run.status === 'running') {
      return Promise.resolve({ ok: false, status: 'error', error: { code: 'not_found', message: 'Exécution introuvable.' } });
    }
    runs.delete(runId);
    emit({ type: 'removed', runId });
    return launch({ ...run.request, requestId: nextRequestId(run.request.requestId) }, 'card');
  }

  /**
   * Suite d'une exécution terminée, demandée depuis la carte : même harnais, même projet, même session
   * quand le harnais la reprend (Claude Code, Cursor) ; sinon la demande précédente et son résultat sont
   * rappelés dans la consigne. Nouvelle confirmation, comme tout lancement.
   */
  function followUp(runId, text) {
    const run = runs.get(runId);
    const prompt = typeof text === 'string' ? text.trim().slice(0, MAX_PROMPT) : '';
    if (!run || !run.request || run.status === 'running') {
      return Promise.resolve({ ok: false, status: 'error', error: { code: 'not_found', message: 'Exécution introuvable ou en cours.' } });
    }
    if (!prompt) return Promise.resolve({ ok: false, status: 'error', error: { code: 'invalid_request', message: 'Consigne vide.' } });
    const sessionId = run.result?.sessionId || run.sessionId || null;
    const fullPrompt = sessionId
      ? prompt
      : clip(
          [
            'Suite d’une demande précédente sur ce projet.',
            `Demande précédente :\n${clip(run.prompt, 4000)}`,
            run.result?.summary ? `Ton résultat :\n${clip(run.result.summary, 4000)}` : '',
            `Nouvelle demande :\n${prompt}`,
          ]
            .filter(Boolean)
            .join('\n\n'),
          MAX_PROMPT,
        );
    runs.delete(runId);
    emit({ type: 'removed', runId });
    const { sessionId: _previous, ...request } = run.request;
    return launch(
      { ...request, prompt: fullPrompt, ...(sessionId ? { sessionId } : {}), requestId: nextRequestId(run.request.requestId, 'f') },
      'card',
    );
  }

  return { status, start, stop, stopByRequest, list, login, retry, followUp };
}

module.exports = { createHarnessRunner };
