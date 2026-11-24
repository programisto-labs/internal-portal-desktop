# Password manager of the web tabs

The in-app browser saves sign-ins to the user's Lasco **Vault** (Coffre) and fills them back, like
Chrome's password manager. The Vault lives on the Lasco server: Desktop never stores a password on
disk and never talks to the API. The portal (the trusted main window) does.

## Pieces

| Where | File | Role |
| --- | --- | --- |
| Web page | `src/browser-tabs/password-preload.js` | Preload of every web view, main frame only, isolated world. Detects sign-ins, reports clicks on login fields, fills fields. Exposes nothing to the page (no `contextBridge`). |
| Main process | `src/browser-tabs/passwords.js` | Per-window controller: captured sign-ins (memory, 5 min, one per tab), Vault suggestions per tab, native menu, fill checks. |
| Main process | `src/browser-tabs/manager.js` | Sets the preload, routes page messages to the tab (`handlePasswordMessage`), draws the native menu. |
| Portal bridge | `src/preload.js` → `lascoDesktop.browserTabs.passwords` | See below. |

## Bridge (`lascoDesktop.browserTabs.passwords`)

Only a portal window can call it (same `tabManagerFor` check as the other browser-tab channels).

- `setEnabled({ enabled })` — the portal enables it when the workspace Vault is on. While disabled,
  captures, suggestions and pending usernames are dropped and nothing new is kept.
- `setSuggestions({ tabId, host, items: [{ id, username, label }] })` — Vault credentials of the tab's
  site (metadata only). Drives the native menu.
- `onCapture(cb)` → `{ tabId, captureId, host, username }` — a sign-in was submitted. **No password.**
- `takeCapture({ tabId, captureId })` → `{ ok, host, username, password }` — once; then forgotten.
- `dismissCapture({ tabId, captureId? })`.
- `onFillRequest(cb)` → `{ tabId, host, secretId }` — the user picked a credential in the native menu.
- `onAction(cb)` → `{ tabId, host, action: 'manage' | 'pick' }` — « Gérer les mots de passe… » /
  « Autre identifiant du Coffre… ».
- `fill({ tabId, host, username, password, submit? })` → `{ ok, error?, username, password, submitted }`.
  Refused unless `host` is the host the tab shows **now** (`host-mismatch`), over https or a local
  development host (`unsupported-page`). `no-login-form` when no field was found.

## Page runtime

- Capture: `submit` (capture phase), click on a submit-like control, Enter in a text or password
  field — trusted events only. Username = field hinted as username/email, else the last text field
  before the password. Sign-up / change-password forms keep the new password.
- Two-step sign-ins: an identifier submitted without a password field is kept by the main process
  (same host, 5 min) and paired with the next password.
- Field click (`pointerdown`, trusted): the field rectangle goes to the main process, which pops the
  native menu under it when the portal pushed suggestions for that exact host.
- Fill: values are written through the `HTMLInputElement` value setter plus `input`/`change` events
  (React, Vue… see a typed value). `submit` clicks the form's submit button or `requestSubmit()`.

## Rules

- https only (plus `localhost`, `127.0.0.1`, `*.localhost`, `*.test`). Plain http pages are ignored.
- Main frame only: sub-frames never get the preload (`nodeIntegrationInSubFrames` stays off).
- Messages are accepted only from the main frame of a web view owned by the window's tab manager;
  the origin is read from `event.senderFrame.url`, never from the page's payload.
- The native menu and the save prompt are drawn by Desktop / the portal, never by the page.
- Tests: `scripts/test-browser-passwords.js`.
