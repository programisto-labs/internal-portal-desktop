# Host operations (agent file operations on this computer)

Native Electron implementation of the optional `lascoDesktop.hostOps` bridge. **Disabled by default**; no shell, no VM fallback, no `computer_*` coupling.

## Contract (preload → IPC)

This contract is the one consumed by `internal-portal` (`apps/frontend/lib/desktop-host/`, `types/lasco-desktop.d.ts`).
The web app does **no** consent or rule handling of its own: this native layer is the only authority.

`window.lascoDesktop.hostOps` (also on `programistoDesktop`) exists only when the page origin is the portal origin
(passed by main to the preload as `--lasco-portal-origin=`), and never when Desktop runs with `--no-agents` /
`LASCO_DESKTOP_NO_AGENTS=1` (internal-portal#2373: a Desktop inside a VM must not reach the physical computer).
In that mode the user agent also carries `LascoNoAgents/1`, the bridge exposes `noAgents: true`, the menu entry is
hidden and the IPC handlers refuse.

- `getCapabilities(): Promise<{ available, enabled, deviceId, operations: ['file.move','file.copy','file.rename','folder.create'], scope: 'host', platform, homeDir }>`
- `execute(request): Promise<Result>`
- `cancel(requestId): Promise<{ ok }>`
- `settings` — portal profile settings, section « Cet ordinateur » (`host-ops-web-*`, same trusted sender):
  - `status(): Promise<{ available, enabled, shellEnabled, codeEnabled, grants: { files, shell, code, total } }>` — switches and counts only (no paths, commands, agent ids, journal);
  - `disable(feature)` / `revokeAll()` — applied directly (they only remove rights); `feature` is `host`, `shell` or `code`;
  - `requestEnable(feature)` — a native dialog decides (« Annuler » default and cancel). Shell / code also turn on host operations, in the same dialog. One dialog at a time (`busy`), 30 s `cooldown` after a refusal. Result `{ ok, decision: 'enabled'|'denied'|'already', status }`;
  - `openSettings()` — opens the native settings window (grants and journal stay there).

Request: `{ requestId, agentId, userId, agentName?, deviceId?, operation, source?, destination?, newName?, overwrite? }`
(`file.rename` uses `source` + `newName`; `folder.create` uses `destination` only, parent must exist; ids match `[A-Za-z0-9_.:-]{1,128}`; paths absolute.)

Result: `{ ok, status: 'completed'|'denied'|'cancelled'|'timeout'|'error', requestId, decision: 'once'|'always'|'grant'|'denied'|'none', error?: { code, message }, result?: { source, destination }, verification?: { destinationExists, sourceAbsent | sourceStillPresent, destinationSize | destinationIsDirectory, ok }, persistentGrantCreated? }`.
Success is only returned after the filesystem state was re-read and verified.

Error codes: `disabled, invalid_request, unsupported_operation, wrong_device, duplicate_request, busy, forbidden, invalid_path, path_not_absolute, path_traversal, invalid_name, symlink_rejected, source_missing, not_a_file, destination_exists, destination_is_directory, same_path, parent_missing, changed_during_confirmation, source_changed, grant_revoked, permission_denied, no_space, verification_failed, timeout, cancelled, denied, io_error`.

IPC channels: `host-ops-capabilities`, `host-ops-execute`, `host-ops-cancel` (web); `host-ops-admin-*` answer only to the local options window (`file:`).

## Confirmations in the chat (card drawn by Desktop)

Every confirmation (file operations, `shell.run`, Lasco Code writes) goes through `host-ops/inline-confirm.js`:

1. Desktop sends `host-ops-confirm` `{ type: 'request', id, title, agentName, height }` to the portal (`hostOps.onConfirm`). `id` is the request id, i.e. the agent's tool call id.
2. The portal reserves a placeholder of that height at the end of the Lasco AI thread and reports where it is (`hostOps.placeConfirm(id, { visible, x, y, width, height })`, CSS pixels, scaled by the zoom factor in main).
3. Desktop draws its own `WebContentsView` (`confirm-card.html`, sandboxed `file:` page, text through `textContent` only) on that spot: title, agent, command or file preview, buttons. The page never gets the confirmation text nor the buttons, and cannot click into that view.
4. Buttons are armed only after the card stayed still for 600 ms; any move disarms them. A spot is used only if it is at least 280 px wide, tall enough, fully inside the window and reported visible.
5. No valid spot within 1.5 s (chat closed, older portal, error page, minimized window), or the spot lost for 1.5 s: the regular native dialog takes over the same request. The card's height is measured by the card itself (`size` event).
6. `{ type: 'resolved', id }` when the request ends (decision, timeout, cancel, fallback). `hostOps.pendingConfirms()` lists waiting requests after a page reload.

## Code harnesses (Claude Code, Codex, Cursor, Vibe)

`window.lascoDesktop.codeHarness` (same exposure and trusted-sender rule as `hostOps`), `src/code-harness/`:

- `status()` → `{ enabled, harnesses: [{ id, label, installed, version, loginCommand }] }` (runs `--version` only).
- `start({ requestId, userId, agentId, agentName, harness, projectId, prompt, sessionId? })` → resolves when the run ends: `{ ok, status: 'completed'|'denied'|'error'|'stopped'|'timeout'|'login_required', result: { runId, harness, project, summary, files, sessionId?, durationMs, loginCommand? }, error? }`.
- `stop(runId)`, `stopRequest(requestId)`, `runs()`, `openLogin(harness)` (macOS: Terminal on the login command, fallback), `onEvent(cb)` with `started` / `step` / `text` / `done` / `removed` / `login`.
- Auth is checked before any confirmation (`src/code-harness/auth.js`: `claude auth status --json`, `codex login status`, `cursor-agent status`). Not logged in, a claude.ai account without a subscription (`no_plan`) or an invalid config (`config_error`) end the request without spawning anything, as a `login_required` / `error` run carrying `authState` and the reason.
- `login(harness)` runs the CLI's own OAuth login in the background (`claude auth login`, `codex login`, `cursor-agent login`): the CLI opens the browser, the first https URL it prints is forwarded (`login` event, `pending` + `url`), then auth is re-checked (`done` / `error`). Tokens stay in the CLI. `retry(runId)` replays the same request (new requestId `…-rN`, new confirmation).
- `followUp(runId, prompt)` asks a finished run for more: same harness and project, same session when the harness resumes one (Claude Code, Cursor), otherwise the previous request and result are restated in the prompt. New requestId `…-fN`, new confirmation; the old run is `removed`.
- Runs are kept in `userData/code-harness-runs.json` (mode 600, atomic write; 40 runs, 7 days, never a credential) and reloaded at start: the chat card survives a restart, and a run still `running` when the app closed comes back as `error` (« interrompu »). `runs()` returns them; `followUp` works on a reloaded run.
- Runs carry `conversationId` (the chat thread that asked, 24-hex, from the page) and `origin`: `tool` (started by `host_code_delegate`, whose caller gets the result) or `card` (`retry` / `followUp` from the chat card). The page asks the agent for a report when a `card` run, or a run longer than the tool wait, ends.
- The harness environment drops `CLAUDECODE` / `CLAUDE_CODE_*` / `CLAUDE_AGENT_SDK*` (a parent Claude Code session must not leak into the harness).

Rules: switch « Harnais de code » (`harnessEnabled`, needs host operations and code projects; off by default; turning code projects or host operations off turns it off). Project must be open in Lasco Code (root from the project store, never a path from the page). One confirmation per run (card in the chat, `operation: 'code.delegate'`), « Toujours autoriser » bound to user × device × agent × harness × project root. One run per project, 30 min max, process group killed on stop. Lasco never handles harness credentials; « not logged in » is detected in the output.

## Native checks (independent of the frontend)

- Sender must be the main frame of the main window at the exact portal origin.
- Absolute paths only; `.`/`..`/NUL rejected; final component symlinks rejected; parents resolved with `realpath` and the **real** path is shown, granted and journaled.
- Pre-confirmation plan is recomputed (and compared: realpath, device/inode, size, mtime) after the dialog; any change aborts.
- No-clobber publish (`link`/`wx`); copy via temp file + atomic publish; source opened with `O_NOFOLLOW` and identity-checked.
- Overwrite requires `overwrite: true` **and** a dedicated confirmation each time; never covered by a persistent rule.
- Requests are serialized; replayed `requestId` rejected; queue bounded; confirmation timeout 120 s, execution timeout 60 s; `cancel` aborts.

## Permissions

Dialog: Refuser / Autoriser une fois / Toujours autoriser ce type d'opération. A persistent rule is bound to user, device, agent, operation, and the real source/destination folders shown. Not offered when a folder is a filesystem root or contains the home directory. Manage (enable, review, revoke, journal) in **Lasco > Réglages… (⌘,)** on macOS, **Fichier > Réglages… (Ctrl+,)** elsewhere; the portal profile (« Cet ordinateur ») shows the switches, disables and revokes, and asks to enable through the native dialog. State: `userData/host-ops.json`, journal (200 entries, paths/ids only) `userData/host-ops-journal.json`, both mode 0600.

## Limits / remaining work

- `userId`/`agentId` are asserted by the web app (native cannot verify them); rules are keyed on them, user confirmation shows the agent name.
- Residual race: a parent directory swapped between the final re-check and the syscall (no `openat`/`renameat` in Node).
- Dialog abort relies on Electron's `signal` option for `showMessageBox`; timeout/cancel on a still-open dialog is not unit-testable.
- Chat routing lives in internal-portal: agent tools `host_*`, `requestId` = the model's tool call id, `userId` / `agentId` stamped by the API.
- Windows/macOS behaviour (case-insensitivity, `link` on exFAT/network volumes falls back to copy) not exercised; automated tests ran on Linux only.

## Manual test (Desktop)

1. Lasco > Réglages… (or portal profile > Cet ordinateur) → enable. 2. In the Lasco AI chat, ask « déplace ~/Downloads/test.txt dans ~/Documents » (or call `hostOps.execute` from the portal devtools console). 3. Check the dialog, Refuser (nothing moves), Autoriser une fois (file moves, result `verification` true). 4. « Toujours autoriser », restart, repeat inside the folder (no dialog); outside (dialog). 5. Revoke → dialog again. Not yet run on a real Electron build.

## Shell commands (`shell.run`)

Same bridge, same consent model as ChatGPT / Claude Code. Separate switch (« Autoriser les commandes shell »), off by default, only effective when host operations are enabled.

Request: `{ requestId, agentId, userId, agentName?, operation: 'shell.run', command, cwd?, timeoutMs? }`. `cwd` defaults to the home folder; absolute, no `.`/`..`, resolved with `realpath`, must be a directory; re-resolved after the dialog (`changed_during_confirmation`). `timeoutMs`: default 120 s, clamped to 1 s–300 s.

Result: `{ ok: true, status: 'completed', result: { command, cwd, exitCode, signal, stdout, stderr, truncated, durationMs }, verification: { ok: true, exitCode, signal } }`. A non-zero exit code is still `completed`: the agent reads it. Timeout and cancel return `status: 'timeout' | 'cancelled'` with the partial `result`.

Execution: `$SHELL -l -c <command>` (login shell, for the user's PATH; `/bin/sh` fallback), PowerShell `-NoProfile -NonInteractive -Command` on Windows. User rights, never elevated; stdin closed; `TERM=dumb`, `NO_COLOR=1`, `LASCO_AGENT=1`, `ELECTRON_*` removed. Process group killed on timeout/cancel (SIGTERM, SIGKILL after 3 s; `taskkill /T` on Windows). stdout/stderr bounded to 12 000 chars each (head + tail) and secret-masked.

Dialog: Refuser / Exécuter une fois / Toujours autoriser « <prefix> » dans ce dossier. It shows the agent, the folder and the exact command.

Rules: a command prefix (program, plus its subcommand when the second word looks like one: `git status`, `npm test`; otherwise the program alone) in the folder and its subfolders, for this agent, user and device. Never offered or applied for:
- compound commands: `;`, `&`, `|`, `<`, `>`, `$…`, backticks, parentheses/braces, newline, unterminated quote, leading `VAR=value`;
- sensitive programs: deletion, privileges, permissions, disks, process/system control, keychain, shells and interpreters, `xargs`/`env`/`eval`, network transfer (`curl`, `wget`, `ssh`, `rsync`…), `open` (see `SENSITIVE_PROGRAMS` in `src/host-ops/shell.js`);
- any command on Windows;
- a folder that is the filesystem root.

A shell rule never covers a file operation and vice versa. Journal: folder, masked command, decision and exit code; never the output.

Limits: a prefix rule trusts the program in that folder (e.g. `npm test` runs the project's scripts). Arguments after the prefix are not inspected (e.g. `git status` allows any `git status …`); rules are the user's choice and are revocable. Not run on a real Electron build or on Windows yet.

## Lasco Code projects (`code.*`, `git.*`)

Agents read and edit the local git projects the user opened in Lasco Code, through this same bridge. Separate switch
« Ouvrir mes projets de code aux agents » (off by default). Reads need no dialog; `code.write` / `code.edit` are confirmed
(or covered by « Toujours autoriser dans ce projet »). Contract, limits and dialog: [code-workspace.md](code-workspace.md).
