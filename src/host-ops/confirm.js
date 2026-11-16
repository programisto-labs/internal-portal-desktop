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
      `« Toujours autoriser » couvre les commandes commençant par « ${prefix.join(' ')} », dans ${req.cwd} et ses sous-dossiers, pour cet agent et cet appareil. Jamais les commandes composées ni sensibles. Révocable dans Fichier > Opérations sur l’hôte.`
    );
  } else if (req.notRememberableReason) {
    lines.push('', req.notRememberableReason);
  }
  return { title: 'Un agent demande à exécuter une commande', message: lines.join('\n'), buttons, decisions };
}

function buildConfirmDialog(req) {
  if (req.operation === 'shell.run') return buildShellConfirmDialog(req);
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
    lines.push('', `« Toujours autoriser » ne vaut que pour cet agent, cette opération, cet appareil et ces dossiers : ${roots.join(', ')}. Révocable dans Lasco > Opérations sur l’hôte.`);
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
