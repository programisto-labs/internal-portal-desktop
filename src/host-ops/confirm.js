'use strict';

const OP_LABELS = {
  'file.move': 'Déplacer un fichier',
  'file.copy': 'Copier un fichier',
  'file.rename': 'Renommer un fichier',
  'folder.create': 'Créer un dossier',
};

function buildShellConfirmDialog(req) {
  const lines = [
    `Agent : ${req.agentName}`,
    `Dossier : ${req.cwd}`,
    '',
    'Commande :',
    req.command,
    '',
    `Effet : la commande s’exécute sur CET ORDINATEUR (pas la machine virtuelle), avec vos droits, pendant ${Math.round(
      (req.timeoutMs || 120000) / 1000
    )} s au plus. Elle peut modifier ou supprimer des fichiers et utiliser le réseau.`,
  ];
  const buttons = ['Refuser', 'Exécuter une fois'];
  const decisions = ['deny', 'once'];
  const prefix = (req.scope && req.scope.commandPrefix) || [];
  if (req.allowPersistent && prefix.length) {
    buttons.push(`Toujours autoriser « ${prefix.join(' ')} » dans ce dossier`);
    decisions.push('always');
    lines.push(
      '',
      `« Toujours autoriser » couvre les commandes commençant par « ${prefix.join(' ')} », dans ${req.cwd} et ses sous-dossiers, pour cet agent et cet appareil. Jamais les commandes composées ni sensibles. Révocable dans Réglages > Cet ordinateur.`
    );
  } else if (req.notRememberableReason) {
    lines.push('', req.notRememberableReason);
  }
  return { title: 'Un agent demande à exécuter une commande', message: lines.join('\n'), buttons, decisions };
}

/** Lasco Code: an agent writes or edits a file of a local project. */
function buildCodeConfirmDialog(req) {
  const lines = [
    `Agent : ${req.agentName}`,
    `Projet : ${req.project} (${req.projectRoot})`,
    `Fichier : ${req.file}`,
    '',
    req.summary,
  ];
  if (req.preview) lines.push('', req.preview);
  lines.push('', 'Le fichier est modifié sur CET ORDINATEUR. Les changements restent visibles (et annulables) dans Git.');
  const buttons = ['Refuser', 'Autoriser une fois'];
  const decisions = ['deny', 'once'];
  if (req.allowPersistent) {
    buttons.push('Toujours autoriser dans ce projet');
    decisions.push('always');
    lines.push(
      '',
      `« Toujours autoriser » couvre les créations et modifications de fichiers par cet agent dans ${req.projectRoot}, sur cet appareil. Jamais les fichiers sensibles (.env, clés). Révocable dans Réglages > Cet ordinateur.`
    );
  } else if (req.sensitive) {
    lines.push('', 'Fichier sensible (secrets, clés) : cette confirmation ne peut pas être mémorisée.');
  }
  const title = req.created ? 'Un agent demande à créer un fichier' : 'Un agent demande à modifier un fichier';
  return { title, message: lines.join('\n'), buttons, decisions };
}

/** Harnais de code : un agent demande à lancer Claude Code, Codex, Cursor ou Vibe sur un projet. */
function buildDelegateConfirmDialog(req) {
  const prompt = String(req.prompt || '');
  const lines = [
    `Agent : ${req.agentName}`,
    `Harnais : ${req.harnessLabel}`,
    `Projet : ${req.project} (${req.projectRoot})`,
    '',
    'Consigne :',
    prompt.length > 600 ? `${prompt.slice(0, 599)}…` : prompt,
    '',
    `Effet : ${req.harnessLabel} ${req.effect} Il travaille sur CET ORDINATEUR, dans ce projet ; les changements restent visibles (et annulables) dans Git.`,
  ];
  const buttons = ['Refuser', 'Lancer'];
  const decisions = ['deny', 'once'];
  if (req.allowPersistent) {
    buttons.push(`Toujours autoriser ${req.harnessLabel} dans ce projet`);
    decisions.push('always');
    lines.push('', `« Toujours autoriser » vaut pour cet agent, ${req.harnessLabel} et ${req.projectRoot}, sur cet appareil. Révocable dans Réglages > Cet ordinateur.`);
  }
  return { title: `Un agent demande à lancer ${req.harnessLabel}`, message: lines.join('\n'), buttons, decisions };
}

/** Harnais en cours : Claude Code demande à lancer une commande dans le projet (relais `--permission-prompt-tool`). */
function buildHarnessCommandConfirmDialog(req) {
  const lines = [
    `Agent : ${req.agentName}`,
    `Harnais : ${req.harnessLabel}`,
    `Projet : ${req.project} (${req.projectRoot})`,
    '',
    'Commande :',
    req.command,
  ];
  if (req.description) lines.push('', `But : ${req.description}`);
  lines.push(
    '',
    `Effet : la commande s’exécute sur CET ORDINATEUR, dans le projet, avec vos droits. Elle peut modifier ou supprimer des fichiers et utiliser le réseau. Si vous refusez, ${req.harnessLabel} continue sans elle.`
  );
  const buttons = ['Refuser', 'Exécuter une fois'];
  const decisions = ['deny', 'once'];
  const prefix = (req.scope && req.scope.commandPrefix) || [];
  if (req.allowPersistent && prefix.length) {
    buttons.push(`Toujours autoriser « ${prefix.join(' ')} » dans ce projet`);
    decisions.push('always');
    lines.push(
      '',
      `« Toujours autoriser » couvre les commandes commençant par « ${prefix.join(' ')} », dans ${req.projectRoot} et ses sous-dossiers, pour cet agent (et ses harnais) sur cet appareil. Jamais les commandes composées ni sensibles. Révocable dans Réglages > Cet ordinateur.`
    );
  } else if (req.notRememberableReason) {
    lines.push('', req.notRememberableReason);
  }
  return { title: `${req.harnessLabel} demande à exécuter une commande`, message: lines.join('\n'), buttons, decisions };
}

/** Harnais en cours : un outil autre qu'une commande (accès web, serveur MCP…), autorisé une fois. */
function buildHarnessToolConfirmDialog(req) {
  const lines = [
    `Agent : ${req.agentName}`,
    `Harnais : ${req.harnessLabel}`,
    `Projet : ${req.project} (${req.projectRoot})`,
    '',
    `Outil : ${req.toolName}`,
  ];
  if (req.detail) lines.push(req.detail);
  lines.push('', `Si vous refusez, ${req.harnessLabel} continue sans cet outil.`);
  return {
    title: `${req.harnessLabel} demande à utiliser ${req.toolName}`,
    message: lines.join('\n'),
    buttons: ['Refuser', 'Autoriser une fois'],
    decisions: ['deny', 'once'],
  };
}

function buildConfirmDialog(req) {
  if (req.operation === 'code.delegate') return buildDelegateConfirmDialog(req);
  if (req.operation === 'code.harness_command') return buildHarnessCommandConfirmDialog(req);
  if (req.operation === 'code.harness_tool') return buildHarnessToolConfirmDialog(req);
  if (req.operation === 'shell.run') return buildShellConfirmDialog(req);
  if (req.operation === 'code.write' || req.operation === 'code.edit') return buildCodeConfirmDialog(req);
  const lines = [`Agent : ${req.agentName}`, `Opération : ${OP_LABELS[req.operation] || req.operation}`, ''];
  if (req.source) lines.push(`Source : ${req.source}`);
  lines.push(`Destination : ${req.destination}`, '');
  const effects = {
    'file.move': 'Le fichier sera déplacé : il n’existera plus à son emplacement d’origine.',
    'file.copy': 'Le fichier sera copié ; l’original est conservé.',
    'file.rename': 'Le fichier sera renommé dans son dossier.',
    'folder.create': 'Un nouveau dossier vide sera créé sur cet ordinateur.',
  };
  lines.push(`Effet : ${effects[req.operation] || ''}`);
  lines.push('Cette action modifie les fichiers de CET ORDINATEUR (pas la machine virtuelle).');
  const buttons = ['Refuser'];
  let title = 'Un agent demande à modifier vos fichiers';
  if (req.overwrite) {
    title = 'Écrasement d’un fichier existant';
    lines.push('', '⚠ La destination existe déjà et sera REMPLACÉE. Cette confirmation ne peut pas être mémorisée.');
    buttons.push('Autoriser et écraser (une fois)');
    return { title, message: lines.join('\n'), buttons, decisions: ['deny', 'once'] };
  }
  buttons.push('Autoriser une fois');
  const decisions = ['deny', 'once'];
  if (req.allowPersistent) {
    const roots = [...new Set([...(req.scope.sourceRoots || []), ...(req.scope.destinationRoots || [])])];
    buttons.push('Toujours autoriser ce type d’opération');
    decisions.push('always');
    lines.push('', `« Toujours autoriser » ne vaut que pour cet agent, cette opération, cet appareil et ces dossiers : ${roots.join(', ')}. Révocable dans Réglages > Cet ordinateur.`);
  }
  return { title, message: lines.join('\n'), buttons, decisions };
}

/** Native confirmation through an injected showMessageBox (Electron dialog). */
function createConfirm(showMessageBox, getParent) {
  return async (req) => {
    const spec = buildConfirmDialog(req);
    const options = {
      type: 'warning',
      title: 'Lasco',
      message: spec.title,
      detail: spec.message,
      buttons: spec.buttons,
      defaultId: 0, // Refuser is the default
      cancelId: 0,
      noLink: true,
      signal: req.signal,
    };
    const parent = getParent && getParent();
    const result = parent ? await showMessageBox(parent, options) : await showMessageBox(options);
    return spec.decisions[result.response] || 'deny';
  };
}

module.exports = { buildConfirmDialog, createConfirm };
