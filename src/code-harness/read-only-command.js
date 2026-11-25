'use strict';

/**
 * Commandes en lecture seule d'un harnais : autorisées sans carte dans le chat.
 *
 * Claude Code enchaîne surtout des lectures pour comprendre un problème (`git log`, `gh run view … | grep`,
 * `cat`, `ls`…). Les confirmer une à une rend le harnais inutilisable sans quelqu'un devant l'écran. Une commande
 * passe sans carte seulement si :
 *
 * - elle n'enchaîne que des segments (`|`, `&&`, `||`, `;`) qui sont chacun une lecture connue (programme et,
 *   pour `git` / `gh`, sous-commande en liste blanche, sans option qui écrit) ;
 * - aucune substitution (`$VAR`, `$(…)`, accents graves), sous-shell, groupe, tâche de fond, assignation ou
 *   redirection autre que vers `/dev/null` ou entre sorties (`2>&1`) ;
 * - tout chemin cité reste dans le projet (liens résolus), sans `~`, et ne vise pas un fichier de secrets.
 *
 * Toute autre commande garde la carte. Sous Windows (PowerShell), rien n'est reconnu.
 */

const fs = require('fs');
const path = require('path');

/** Programmes qui ne font que lire (sans option d'écriture vérifiée plus bas). */
const READ_PROGRAMS = new Set([
  'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'wc', 'sort', 'uniq', 'cut', 'tr', 'nl', 'column',
  'ls', 'tree', 'pwd', 'echo', 'basename', 'dirname', 'realpath', 'readlink', 'stat', 'file', 'du', 'which',
  'diff', 'cmp', 'comm', 'true', 'false', 'date', 'whoami', 'uname', 'jq', 'find', 'sed', 'cd', 'test', '[',
]);

const GIT_READ = new Set([
  'status', 'log', 'show', 'diff', 'branch', 'rev-parse', 'ls-files', 'ls-tree', 'blame', 'grep', 'describe',
  'shortlog', 'reflog', 'remote', 'worktree', 'config', 'stash', 'tag', 'merge-base', 'cat-file', 'show-ref',
  'name-rev', 'for-each-ref', 'count-objects', 'rev-list', 'whatchanged',
]);

const GH_READ = {
  pr: new Set(['view', 'list', 'checks', 'diff', 'status']),
  run: new Set(['view', 'list', 'watch']),
  issue: new Set(['view', 'list', 'status']),
  repo: new Set(['view']),
  release: new Set(['view', 'list']),
  workflow: new Set(['view', 'list']),
  search: null, // toutes les recherches
  status: null,
};

/** Fichiers de secrets : jamais lus sans carte (leur contenu partirait au modèle). */
const SECRET_FILE_RE = /(^|[\\/])(\.env(\.[^\\/]*)?|\.npmrc|\.netrc|\.pgpass|id_(rsa|dsa|ecdsa|ed25519)[^\\/]*|[^\\/]*\.(pem|key|p12|pfx|keystore|jks)|credentials(\.[a-z]+)?|secrets?\.(json|ya?ml|env))$/i;

/**
 * Découpe une commande en segments de mots. Renvoie null dès qu'une construction n'est pas sûre.
 * Opérateurs acceptés : `|`, `||`, `&&`, `;`. Redirections acceptées : `N>&M` (M = 1 ou 2), `>`/`>>`/`&>`
 * vers `/dev/null`.
 */
function splitSegments(command) {
  const segments = [[]];
  let cur = '';
  let has = false;
  let quote = null;
  const push = () => {
    if (has) segments[segments.length - 1].push(cur);
    cur = '';
    has = false;
  };
  const newSegment = () => {
    push();
    if (!segments[segments.length - 1].length) return false; // opérateur sans commande devant
    segments.push([]);
    return true;
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
        if (c === '`') return null;
        // `$` suivi d'un nom, `{`, `(` ou d'un paramètre spécial : expansion. Sinon (`$]`, `$)`, fin) : littéral.
        if (c === '$' && next !== undefined && /[A-Za-z0-9_{(@*#?$!-]/.test(next)) return null;
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
      if (next === undefined || next === '\n') return null;
      cur += next;
      i += 1;
      has = true;
      continue;
    }
    if (c === '\n' || c === '\r') return null;
    if (/\s/.test(c)) {
      push();
      continue;
    }
    if (c === '|') {
      if (next === '&') return null; // |& : redirection de stderr dans un tube, rare, laissé à la carte
      if (next === '|') i += 1;
      if (!newSegment()) return null;
      continue;
    }
    if (c === ';') {
      if (!newSegment()) return null;
      continue;
    }
    if (c === '&') {
      if (next === '&') {
        i += 1;
        if (!newSegment()) return null;
        continue;
      }
      if (next === '>') {
        // &> ou &>> /dev/null
        if (has) return null;
        i += command[i + 2] === '>' ? 2 : 1;
        const target = readTarget(command, i + 1);
        if (!target || target.word !== '/dev/null') return null;
        i = target.end - 1;
        continue;
      }
      return null; // tâche de fond
    }
    if (c === '>') {
      // Descripteur collé devant (2>…) : seulement 1 ou 2.
      if (has) {
        if (!/^[12]$/.test(cur)) return null;
        cur = '';
        has = false;
      }
      if (next === '&') {
        const fd = command[i + 2];
        const after = command[i + 3];
        if ((fd !== '1' && fd !== '2') || (after !== undefined && !/\s|[|;&]/.test(after))) return null;
        i += 2;
        continue;
      }
      if (next === '>') i += 1;
      const target = readTarget(command, i + 1);
      if (!target || target.word !== '/dev/null') return null;
      i = target.end - 1;
      continue;
    }
    if ('<`$(){}'.includes(c)) return null;
    cur += c;
    has = true;
  }
  if (quote) return null;
  push();
  if (!segments[segments.length - 1].length) return null; // opérateur final
  return segments;
}

/** Cible d'une redirection : mot nu après des espaces. */
function readTarget(command, from) {
  let i = from;
  while (i < command.length && /[ \t]/.test(command[i])) i += 1;
  let word = '';
  while (i < command.length && !/\s|[|;&<>()`$'"\\]/.test(command[i])) {
    word += command[i];
    i += 1;
  }
  return word ? { word, end: i } : null;
}

function programName(token) {
  return String(token || '').split('/').pop().toLowerCase();
}

/** Vrai si une option de la liste apparaît (forme courte collée ou longue avec `=`). */
function hasOption(args, names) {
  return args.some((a) => names.some((n) => a === n || (n.startsWith('--') && a.startsWith(`${n}=`))));
}

function gitIsReadOnly(args, ctx) {
  let i = 0;
  // Options globales : seulement -C <dossier du projet>, --no-pager, -P.
  while (i < args.length && args[i].startsWith('-')) {
    const a = args[i];
    if (a === '--no-pager' || a === '-P' || a === '--no-optional-locks') {
      i += 1;
    } else if (a === '-C') {
      if (!ctx.checkPath(args[i + 1], true)) return false;
      i += 2;
    } else {
      return false; // -c (config, donc programmes externes), --git-dir, --exec-path…
    }
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (!GIT_READ.has(sub)) return false;
  if (rest.some((a) => /^--(output|exec|upload-pack|receive-pack|ext-diff)/.test(a))) return false;
  const positional = rest.filter((a) => !a.startsWith('-'));
  switch (sub) {
    case 'branch':
      // Lister seulement : aucune création, suppression, renommage ni suivi.
      return positional.length === 0 && !rest.some((a) => /^(-[dDmMcCuf]|--(delete|move|copy|force|set-upstream|unset-upstream|edit-description))/.test(a));
    case 'tag':
      return (positional.length === 0 || hasOption(rest, ['-l', '--list'])) && !rest.some((a) => /^(-[dfsaum]|--(delete|force|sign|annotate|message|file))/.test(a));
    case 'remote':
      return positional.length === 0 || (positional[0] === 'show' || positional[0] === 'get-url');
    case 'worktree':
      return positional[0] === 'list';
    case 'stash':
      return positional[0] === 'list' || positional[0] === 'show';
    case 'reflog':
      return !['expire', 'delete'].includes(positional[0]);
    case 'config':
      return rest.some((a) => ['--get', '--get-all', '--get-regexp', '--list', '-l'].includes(a));
    default:
      return true;
  }
}

function ghIsReadOnly(args) {
  const [group, action, ...rest] = args;
  if (rest.concat(action || []).some((a) => a === '--web' || a === '-w')) return false;
  if (group === 'api') {
    const all = args.slice(1);
    // Une requête avec champs ou corps passe en POST : laissée à la carte.
    if (hasOption(all, ['-f', '-F', '--field', '--raw-field', '--input'])) return false;
    const m = all.findIndex((a) => a === '-X' || a === '--method');
    if (m !== -1 && String(all[m + 1] || '').toUpperCase() !== 'GET') return false;
    if (all.some((a) => /^(-X|--method=)/.test(a) && a.length > 2 && !/GET$/i.test(a))) return false;
    return true;
  }
  if (!Object.prototype.hasOwnProperty.call(GH_READ, group)) return false;
  const allowed = GH_READ[group];
  return allowed === null || allowed.has(action);
}

/** `sed` seulement pour imprimer des lignes : `sed -n '10,20p' fichier`. */
function sedIsReadOnly(args) {
  if (!args.includes('-n')) return false;
  if (args.some((a) => /^(-i|--in-place|-f|--file|-e|--expression|-s|--separate)/.test(a) && a !== '-n')) return false;
  const operands = args.filter((a) => !a.startsWith('-'));
  if (!operands.length) return false;
  return /^(\d+|\$|\/[^/]*\/)?(,(\d+|\$|\/[^/]*\/))?p$/.test(operands[0]);
}

function segmentIsReadOnly(tokens, ctx) {
  const [first, ...args] = tokens;
  if (!first || /^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) return false; // VAR=… prog
  const name = programName(first);
  if (first.includes('/')) return false; // ./script, /usr/bin/… : pas un programme connu
  if (name === 'git') return gitIsReadOnly(args, ctx) && args.every((a) => ctx.checkArg(a));
  if (name === 'gh') return ghIsReadOnly(args);
  if (!READ_PROGRAMS.has(name)) return false;
  if (name === 'cd') {
    if (args.length !== 1 || !ctx.checkPath(args[0], true)) return false;
    ctx.cwd = ctx.resolve(args[0]);
    return true;
  }
  if (name === 'sed' && !sedIsReadOnly(args)) return false;
  if (name === 'find' && args.some((a) => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(a))) return false;
  if (name === 'sort' && args.some((a) => /^(-o|--output)/.test(a))) return false;
  if (name === 'tree' && args.some((a) => a === '-o')) return false;
  if ((name === 'uniq' || name === 'tr' || name === 'jq') && args.some((a) => a === '--in-place' || a === '-i')) return false;
  if (name === 'uniq' && args.filter((a) => !a.startsWith('-')).length > 1) return false; // uniq in out écrit
  return args.every((a) => ctx.checkArg(a));
}

/**
 * Vrai si la commande ne fait que lire dans le projet. `root` et `cwd` sont des chemins réels.
 */
function isReadOnlyCommand(command, { root, cwd, platform = process.platform, realpath = fs.realpathSync } = {}) {
  if (platform === 'win32' || typeof command !== 'string' || !root) return false;
  const text = command.trim();
  if (!text || text.length > 4000 || text.includes('\0')) return false;
  const segments = splitSegments(text);
  if (!segments) return false;

  const ctx = {
    cwd: cwd || root,
    resolve(p) {
      const abs = path.resolve(ctx.cwd, p);
      try {
        return realpath(abs);
      } catch {
        // Chemin absent : on résout le dossier parent existant le plus proche.
        let dir = path.dirname(abs);
        while (dir !== path.dirname(dir)) {
          try {
            return path.join(realpath(dir), path.relative(dir, abs));
          } catch {
            dir = path.dirname(dir);
          }
        }
        return abs;
      }
    },
    within(abs) {
      const rel = path.relative(root, abs);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    },
    /** Chemin cité : dans le projet, jamais un fichier de secrets. */
    checkPath(p, mustBeDir = false) {
      if (typeof p !== 'string' || !p || p.startsWith('~')) return false;
      const abs = ctx.resolve(p);
      if (!ctx.within(abs) || SECRET_FILE_RE.test(abs)) return false;
      if (mustBeDir) {
        try {
          return fs.statSync(abs).isDirectory();
        } catch {
          return false;
        }
      }
      return true;
    },
    /** Argument quelconque : un chemin s'il en a l'air (absolu, `~`, `..`, ou fichier existant). */
    checkArg(a) {
      if (a === '/dev/null') return true;
      if (a.startsWith('~')) return false;
      const value = a.startsWith('-') && a.includes('=') ? a.slice(a.indexOf('=') + 1) : a;
      if (value.startsWith('-')) return true;
      if (SECRET_FILE_RE.test(value)) return false;
      if (path.isAbsolute(value) || value.split(/[\\/]/).includes('..')) return ctx.checkPath(value);
      // Relatif au dossier courant : dans le projet, sauf lien vers l'extérieur (vérifié si le fichier existe).
      return !fileExists(path.resolve(ctx.cwd, value)) || ctx.checkPath(value);
    },
  };
  return segments.every((tokens) => segmentIsReadOnly(tokens, ctx));
}

function fileExists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

module.exports = { isReadOnlyCommand, splitSegments };
