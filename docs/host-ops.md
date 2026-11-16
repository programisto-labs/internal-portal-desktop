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

Request: `{ requestId, agentId, userId, agentName?, deviceId?, operation, source?, destination?, newName?, overwrite? }`
(`file.rename` uses `source` + `newName`; `folder.create` uses `destination` only, parent must exist; ids match `[A-Za-z0-9_.:-]{1,128}`; paths absolute.)

Result: `{ ok, status: 'completed'|'denied'|'cancelled'|'timeout'|'error', requestId, decision: 'once'|'always'|'grant'|'denied'|'none', error?: { code, message }, result?: { source, destination }, verification?: { destinationExists, sourceAbsent | sourceStillPresent, destinationSize | destinationIsDirectory, ok }, persistentGrantCreated? }`.
Success is only returned after the filesystem state was re-read and verified.

Error codes: `disabled, invalid_request, unsupported_operation, wrong_device, duplicate_request, busy, forbidden, invalid_path, path_not_absolute, path_traversal, invalid_name, symlink_rejected, source_missing, not_a_file, destination_exists, destination_is_directory, same_path, parent_missing, changed_during_confirmation, source_changed, grant_revoked, permission_denied, no_space, verification_failed, timeout, cancelled, denied, io_error`.

IPC channels: `host-ops-capabilities`, `host-ops-execute`, `host-ops-cancel` (web); `host-ops-admin-*` answer only to the local options window (`file:`).

## Native checks (independent of the frontend)

- Sender must be the main frame of the main window at the exact portal origin.
- Absolute paths only; `.`/`..`/NUL rejected; final component symlinks rejected; parents resolved with `realpath` and the **real** path is shown, granted and journaled.
- Pre-confirmation plan is recomputed (and compared: realpath, device/inode, size, mtime) after the dialog; any change aborts.
- No-clobber publish (`link`/`wx`); copy via temp file + atomic publish; source opened with `O_NOFOLLOW` and identity-checked.
- Overwrite requires `overwrite: true` **and** a dedicated confirmation each time; never covered by a persistent rule.
- Requests are serialized; replayed `requestId` rejected; queue bounded; confirmation timeout 120 s, execution timeout 60 s; `cancel` aborts.

## Permissions

Dialog: Refuser / Autoriser une fois / Toujours autoriser ce type d'opération. A persistent rule is bound to user, device, agent, operation, and the real source/destination folders shown. Not offered when a folder is a filesystem root or contains the home directory. Manage (enable, review, revoke, journal) in **Fichier > Opérations sur l'hôte (agents)…**. State: `userData/host-ops.json`, journal (200 entries, paths/ids only) `userData/host-ops-journal.json`, both mode 0600.

## Limits / remaining work

- `userId`/`agentId` are asserted by the web app (native cannot verify them); rules are keyed on them, user confirmation shows the agent name.
- Residual race: a parent directory swapped between the final re-check and the syscall (no `openat`/`renameat` in Node).
- Dialog abort relies on Electron's `signal` option for `showMessageBox`; timeout/cancel on a still-open dialog is not unit-testable.
- Chat routing lives in internal-portal: agent tools `host_*`, `requestId` = the model's tool call id, `userId` / `agentId` stamped by the API.
- Windows/macOS behaviour (case-insensitivity, `link` on exFAT/network volumes falls back to copy) not exercised; automated tests ran on Linux only.

## Manual test (Desktop)

1. Menu Fichier > Opérations sur l'hôte → enable. 2. In the Lasco AI chat, ask « déplace ~/Downloads/test.txt dans ~/Documents » (or call `hostOps.execute` from the portal devtools console). 3. Check the dialog, Refuser (nothing moves), Autoriser une fois (file moves, result `verification` true). 4. « Toujours autoriser », restart, repeat inside the folder (no dialog); outside (dialog). 5. Revoke → dialog again. Not yet run on a real Electron build.

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
