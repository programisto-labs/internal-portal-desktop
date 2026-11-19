# Lasco Code (IDE page of the portal)

Native side of **Lasco Code**, the IDE tab of the portal's in-app browser (internal-portal: `components/code-workspace/`,
`lib/code-workspace/`): local git projects, editor, git, real terminals, and agent development through host operations.

## Exposure and trust

`window.lascoDesktop.codeWorkspace` follows the `hostOps` rule: only on the exact portal origin, never with `--no-agents`
(internal-portal#2373). Every IPC call is re-validated natively (main window, main frame, portal origin). The portal renders
the Code page in the shell document (renderer `internal-code`), never in an iframe.

- `invoke(method, payload)` → `code-workspace-invoke`; only the methods of `METHODS` in `src/code-workspace/service.js`.
- `terminalWrite(id, data)` / `terminalResize(id, cols, rows)` → `code-terminal-input` / `code-terminal-resize` (fire and forget).
- Events: `code-terminal-data { id, data }`, `code-terminal-exit { id, exitCode, signal }`, `code-fs-changed { projectId, paths, overflow, git }`.

Responses: `{ ok: true, ...result }` or `{ ok: false, error: { code, message } }` (message in French, shown as is).

## Projects

- A project is **only ever registered natively**: folder picker (`projects.add`, offers `git init` for a plain folder) or
  clone destination picker (`projects.clone`: https / ssh / git URLs only, never an option or a local path). The page names
  projects by id (`p_` + 16 hex), per signed-in user (`userId`, asserted by the page like the browser history).
- The stored root is the real path of the repository top level. State: `userData/code-projects.json` (0600), 50 projects per user.
- `projects.remove` only forgets the project; nothing is deleted on disk.

## Files (`src/code-workspace/paths.js`, `files.js`)

- Paths are project-relative (`/` separators). Absolute paths, `..`, NUL and any `.git` segment are refused.
- Reads follow a symlink only when its real target stays inside the project; writes refuse a symlink as final component.
- Writes are atomic (temp file + rename, mode kept); `expectedMtimeMs` detects a change on disk (`changed_on_disk`);
  creation is no-clobber (`link`). The written bytes are re-read and compared.
- Editor limit 5 MB; binary / non UTF-8 files are reported, never decoded lossily.
- Deletion goes to the system trash (`shell.trashItem`).
- Search: `git grep` (tracked and untracked non-ignored files); quick open: `git ls-files`.

## Git (`src/code-workspace/git.js`)

Always `execFile('git', …)`: no shell, user values after `--` or validated (branch names, clone URLs). `GIT_TERMINAL_PROMPT=0`:
a command needing credentials fails instead of hanging (credential helpers still work). PATH comes from the user's interactive login shell
(`$SHELL -i -l -c`, then `-l -c`; `login-env.js`), plus existing `~/.local/bin`, `~/bin`… and every nvm node `bin` (default alias
first), so Homebrew git, `gh`, nvm globals and the code harnesses (`claude`, `cursor-agent`, `codex`, `vibe`) work when the app is
started from the Dock.

Remote links (repository, branch, compare / new pull request, file, commit) are derived for github.com and gitlab.com; **the raw
remote URL never leaves the native side** (it may contain a token). The current pull request comes from `gh pr view` when the
GitHub CLI is installed and signed in.

## Terminals (`src/code-workspace/terminals.js`)

Real pseudo-terminals (`node-pty`, N-API prebuilds for macOS / Windows; Linux needs a native build, otherwise
`terminal_unavailable`). The user's interactive login shell (`$SHELL -l`, PowerShell on Windows) in the project root, with the
user's rights; `TERM=xterm-256color`, `LASCO_TERMINAL=1`, `ELECTRON_*` removed.

- Output batched (~60 fps) and kept in a 256 KB scrollback. `terminal.attach` flushes pending output then returns the scrollback:
  data events received before the reply are in it, later ones are new (no loss, no duplicate on re-attach).
  The reply also carries the pty's current `cols` / `rows`: the IDE sizes xterm to them before replaying.
- Sessions belong to the web contents that created them; killed on a full reload, a renderer crash, window close and quit.
- Packaging: `asarUnpack: node_modules/node-pty/**`, `npmRebuild: false` (prebuilds are N-API, ABI stable); `postinstall`
  restores the exec bit npm drops on `spawn-helper` (`scripts/fix-node-pty.js`).

## Agent operations (host-ops)

Agents develop in these projects through the existing host-ops bridge (`hostOps.execute`), with the same identity, replay,
queue, journal and consent model. New switch **« Ouvrir mes projets de code aux agents »** (`codeEnabled`), off by default,
effective only when host operations are enabled. Implementation: `src/code-workspace/agent-ops.js`.

| Operation | Consent | Notes |
|---|---|---|
| `code.projects` | none | user's projects: id, name, root, branch, changed files |
| `code.list` | none | entries, `ignored` and `sensitive` flags |
| `code.read` | none | line ranges (`offset`, `limit`), 22 000 chars max; sensitive files refused (`sensitive_file`) |
| `code.search` | none | `git grep`, 200 results, sensitive files dropped, text masked |
| `git.status` / `git.diff` | none | diff vs HEAD (or `--cached`), sensitive files left out, masked |
| `code.write` | dialog or rule | create (no-clobber) or replace a file |
| `code.edit` | dialog or rule | exact `oldString` → `newString`; unique unless `replaceAll` (`no_match`, `multiple_matches`) |

Sensitive files: `.env*` (except examples), keys and certificates, `id_*`, `.npmrc` / `.netrc` / `.pypirc`, credentials and
secrets files (`paths.js`).

Write dialog: agent, project, file, `−n / +m lines from line L` and a masked excerpt of the change. Buttons: Refuser / Autoriser
une fois / **Toujours autoriser dans ce projet** (grant `code.write` = user × device × agent × project root; never offered for a
sensitive file, nor for a root that is the filesystem root or contains the home folder). After the dialog the plan is rebuilt and
compared (same target, same content hash, same new content), otherwise `changed_during_confirmation`; the file is then written
with the mtime check and re-read: success only when the hash matches (`verification.ok`).

Reads are not journaled (volume); writes, refusals and errors are, with the project root and the relative path only.
Commands (tests, builds, commits) stay `shell.run`, with its own consent and prefix rules.

## Manual test

1. `npm install`, then `npm run dev` with the portal on `localhost:3001`. 2. Sidebar « Code » (or new tab › Lasco Code) →
« Ouvrir un dossier » → pick a git repository. 3. Explorer, open / edit / save a file (⌘S, autosave), ⌘P, ⌘⇧F, terminal (⌘J):
`git status`, `npm test`. 4. Git panel: stage, commit (⌘↵), push / pull, branch picker, « Créer une PR » opens in a browser tab.
5. Lasco › Réglages… (or portal profile › Cet ordinateur): enable host operations and « Ouvrir mes projets de code aux agents »; in Lasco AI with the
Code tab active: « ajoute un test pour X » → reads without dialog, each edit confirmed, `npm test` confirmed as a shell command.
