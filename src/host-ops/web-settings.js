'use strict';

/**
 * Host-operation settings seen from the portal (profile settings > « Cet ordinateur »).
 *
 * The page never grants rights on its own:
 * - status: switches and grant counts only (no paths, commands, agent ids or journal);
 * - disable / revoke all: applied directly (they only remove rights);
 * - enable: a native confirmation dialog decides, default button « Annuler »; one dialog at a time and a
 *   cooldown after a refusal, so a page cannot pester the user into clicking;
 * - details (grants, journal): the native settings window only.
 */

const FEATURES = ['host', 'shell', 'code', 'harness'];
const REFUSAL_COOLDOWN_MS = 30000;

const FEATURE_TEXT = {
  host: {
    title: 'Activer les opérations sur l’hôte ?',
    detail:
      'Les agents IA pourront demander à déplacer, copier, renommer des fichiers et créer des dossiers sur CET ORDINATEUR. Chaque opération reste affichée et confirmée ici, sauf celles couvertes par une autorisation « Toujours autoriser ».',
  },
  shell: {
    title: 'Autoriser les commandes shell ?',
    detail:
      'Les agents IA pourront demander à exécuter des commandes dans votre shell, avec VOS droits, sur CET ORDINATEUR. Chaque commande est affichée et confirmée, sauf celles couvertes par une autorisation « Toujours autoriser » ; les commandes composées ou sensibles (suppression, sudo, réseau, interpréteurs…) sont confirmées à chaque fois.',
  },
  harness: {
    title: 'Autoriser les harnais de code ?',
    detail:
      'Les agents IA pourront lancer Claude Code, Codex, Cursor ou Mistral Vibe sur un projet ouvert dans Lasco Code. Chaque lancement est confirmé (sauf « Toujours autoriser » pour ce projet) ; le harnais modifie ensuite les fichiers, et selon le harnais lance des commandes, sans confirmer chaque action. Vous vous connectez vous-même à chaque harnais ; Lasco ne voit jamais vos identifiants.',
  },
  code: {
    title: 'Ouvrir vos projets de code aux agents ?',
    detail:
      'Les agents IA pourront lire les projets git ouverts dans Lasco Code (sauf fichiers sensibles : .env, clés) et y proposer des créations ou modifications de fichiers. Chaque modification est affichée et confirmée, sauf « Toujours autoriser dans ce projet ».',
  },
};

function grantKind(operation) {
  if (operation === 'shell.run') return 'shell';
  if (operation === 'code.delegate') return 'harness';
  if (operation === 'code.write') return 'code';
  return 'files';
}

function createHostOpsWebSettings({ store, confirmEnable, openSettings, now = Date.now, cooldownMs = REFUSAL_COOLDOWN_MS }) {
  let pending = null;
  let refusedAt = 0;

  function status() {
    const grants = { files: 0, shell: 0, code: 0, harness: 0 };
    for (const g of store.listGrants()) grants[grantKind(g.operation)] += 1;
    return {
      available: true,
      enabled: store.isEnabled(),
      shellEnabled: store.isShellEnabled(),
      codeEnabled: store.isCodeEnabled(),
      harnessEnabled: typeof store.isHarnessEnabled === 'function' ? store.isHarnessEnabled() : false,
      grants: { ...grants, total: grants.files + grants.shell + grants.code + grants.harness },
    };
  }

  function isOn(feature) {
    if (feature === 'host') return store.isEnabled();
    if (feature === 'shell') return store.isShellEnabled();
    if (feature === 'harness') return store.isHarnessEnabled();
    return store.isCodeEnabled();
  }

  function setOn(feature) {
    if (feature === 'host') store.setEnabled(true);
    else if (feature === 'shell') store.setShellEnabled(true);
    else if (feature === 'harness') store.setHarnessEnabled(true);
    else store.setCodeEnabled(true);
  }

  function disable(feature) {
    if (!FEATURES.includes(feature)) return { ok: false, error: { code: 'invalid_request', message: 'Réglage inconnu.' } };
    if (feature === 'host') {
      // Couper l'hôte coupe aussi le shell et les projets : une réactivation ne rallume que ce qu'elle annonce.
      store.setEnabled(false);
      store.setShellEnabled(false);
      store.setCodeEnabled(false);
      store.setHarnessEnabled(false);
    } else if (feature === 'shell') store.setShellEnabled(false);
    else if (feature === 'harness') store.setHarnessEnabled(false);
    else {
      // Les harnais travaillent sur les projets : couper les projets les coupe aussi.
      store.setCodeEnabled(false);
      store.setHarnessEnabled(false);
    }
    return { ok: true, status: status() };
  }

  async function requestEnable(feature) {
    if (!FEATURES.includes(feature)) return { ok: false, error: { code: 'invalid_request', message: 'Réglage inconnu.' } };
    if (isOn(feature)) return { ok: true, decision: 'already', status: status() };
    if (pending) return { ok: false, error: { code: 'busy', message: 'Une confirmation est déjà affichée dans Lasco Desktop.' } };
    if (refusedAt && now() - refusedAt < cooldownMs) {
      return { ok: false, error: { code: 'cooldown', message: 'Demande refusée il y a peu : réessayez dans quelques secondes.' } };
    }
    // Shell commands and code projects need host operations: one dialog lists both.
    // Prérequis annoncés dans le même dialogue : hôte, puis projets de code pour les harnais.
    const features = [];
    if (feature !== 'host' && !store.isEnabled()) features.push('host');
    if (feature === 'harness' && !store.isCodeEnabled()) features.push('code');
    features.push(feature);
    const main = FEATURE_TEXT[feature];
    const detail = features.map((f) => FEATURE_TEXT[f].detail).join('\n\n');
    pending = (async () => {
      let accepted = false;
      try {
        accepted = (await confirmEnable({ feature, features, title: main.title, detail })) === true;
      } catch (_) {
        accepted = false;
      }
      if (!accepted) {
        refusedAt = now();
        return { ok: true, decision: 'denied', status: status() };
      }
      refusedAt = 0;
      for (const f of features) setOn(f);
      return { ok: true, decision: 'enabled', status: status() };
    })().finally(() => {
      pending = null;
    });
    return pending;
  }

  function revokeAll() {
    store.revokeAll();
    return { ok: true, status: status() };
  }

  function open() {
    if (openSettings) openSettings();
    return { ok: true, opened: Boolean(openSettings) };
  }

  return { status, disable, requestEnable, revokeAll, open };
}

/** Native dialog for an enable request from the portal: « Annuler » is the default and the cancel button. */
function buildEnableDialog({ title, detail }) {
  return {
    type: 'warning',
    title: 'Lasco',
    message: title,
    detail: `${detail}\n\nCette demande vient de la page Réglages de Lasco. Vous pourrez tout désactiver et révoquer à tout moment.`,
    buttons: ['Annuler', 'Activer'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

module.exports = { createHostOpsWebSettings, buildEnableDialog, FEATURES, REFUSAL_COOLDOWN_MS };
