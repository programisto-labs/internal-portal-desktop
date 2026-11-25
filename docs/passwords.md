# Password manager of the web tabs

The in-app browser saves sign-ins to the user's Lasco **Vault** (Coffre) and fills them back, like
Chrome's password manager. The Vault lives on the Lasco server: Desktop never stores a password on
disk and never talks to the API. The portal (the trusted main window) does.

## Pieces

| Where | File | Role |
| --- | --- | --- |
| Web page | `src/browser-tabs/password-preload.js` | Preload of every web view, main frame only, isolated world. Detects sign-ins, reports clicks on login fields, fills fields. Exposes nothing to the page (no `contextBridge`). |
| Main process | `src/browser-tabs/passwords.js` | Per-window controller: captured sign-ins (memory, 5 min, one per tab), Vault suggestions per tab, autofill popover state, fill checks. |
| Main process | `src/browser-tabs/password-popover.js` | Autofill popover: placement under the field (`popoverBounds`), arming, choices. Shared with the form autofill (`docs/form-autofill.md`): each `show` names its owner; a popover replaced by another owner is told it closed, and `hide(owner)` only hides its own. |
| Popover page | `src/browser-tabs/password-popover.html` + `password-popover-preload.js` | Desktop's own `file:` view drawn over the tab view; text only (`textContent`). |
| Main process | `src/browser-tabs/manager.js` | Sets the preload, routes page messages to the tab (`handlePasswordMessage`) and popover messages (`handlePasswordPopoverMessage`), owns the popover view. |
| Portal bridge | `src/preload.js` → `lascoDesktop.browserTabs.passwords` | See below. |

## Bridge (`lascoDesktop.browserTabs.passwords`)

Only a portal window can call it (same `tabManagerFor` check as the other browser-tab channels).

- `setEnabled({ enabled })` — the portal enables it when the workspace Vault is on. While disabled,
  captures, suggestions and pending usernames are dropped and nothing new is kept.
- `setSuggestions({ tabId, host, items: [{ id, username, label }], labels? })` — Vault credentials of the
  tab's site (metadata only), possibly none. `labels: { title, empty, other, manage }`: popover texts in
  the person's language (French fallback). Drives the autofill popover.
- `onCapture(cb)` → `{ tabId, captureId, host, username }` — a sign-in was submitted. **No password.**
- `takeCapture({ tabId, captureId })` → `{ ok, host, username, password }` — once; then forgotten.
- `dismissCapture({ tabId, captureId? })`.
- `onFillRequest(cb)` → `{ tabId, host, secretId }` — the user picked a credential in the popover.
- `onAction(cb)` → `{ tabId, host, action: 'manage' | 'pick' }` — « Gérer les mots de passe » /
  « Choisir un identifiant du Coffre… ».
- `fill({ tabId, host, username, password, submit? })` → `{ ok, error?, username, password, submitted }`.
  Refused unless `host` is the host the tab shows **now** (`host-mismatch`), over https or a local
  development host (`unsupported-page`). `no-login-form` when no field was found.

## Page runtime

- Capture: `submit` (capture phase), click on a submit-like control, Enter in a text or password
  field — trusted events only. Username = field hinted as username/email, else the last text field
  before the password, else a hidden `autocomplete="username"` (or hidden email) field of a
  password-only step. Sign-up / change-password forms keep the new password. A password Desktop
  filled from the Vault on this page (last 10 min) is never captured again.
- Two-step sign-ins: an identifier submitted without a password field is kept by the main process
  (same host, 5 min) and paired with the next password.
- Autofill popover, like Chrome's: a login field that gets the focus (`focusin`) or is clicked
  (`pointerdown`), trusted events only, sends its rectangle; the main process shows the popover under
  it (above it without room, inside the tab view) when the portal pushed suggestions for that exact
  host. Without any credential for the site it opens on a click only, with « Choisir un identifiant
  du Coffre… ». The field keeps the focus: ↑ ↓ Enter Escape typed in it go to the popover
  (`lasco-pw:key`); typing, scrolling, Tab, a blur outside the popover, a navigation, a tab switch,
  a portal overlay or a moved tab view close it. No popover while Desktop fills the fields.
- The popover accepts a choice only after 300 ms on screen (a page cannot pop it under a click it
  expects). It is a separate `file:` web contents; its messages (`lasco-pw-popover`) are accepted only
  from it.
- Fill: values are written through the `HTMLInputElement` value setter plus `input`/`change` events
  (React, Vue… see a typed value). `submit` clicks the form's submit button or `requestSubmit()`.

## Rules

- https only (plus `localhost`, `127.0.0.1`, `*.localhost`, `*.test`). Plain http pages are ignored.
- Main frame only: sub-frames never get the preload (`nodeIntegrationInSubFrames` stays off).
- Messages are accepted only from the main frame of a web view owned by the window's tab manager;
  the origin is read from `event.senderFrame.url`, never from the page's payload.
- The autofill popover and the save prompt are drawn by Desktop / the portal, never by the page.
- Tests: `scripts/test-browser-passwords.js`.

## Show a password (`lascoDesktop.vault`)

Before the portal shows a saved password in the Vault, it asks Desktop to check that the person at the
computer is the account owner, like Chrome's password manager (`src/vault-auth.js`):

- `vault.verifyUser({ reason })` → `{ ok: true }` or `{ ok: false, error: 'denied' | 'unavailable' | 'unsupported' | 'failed' }`.
  - macOS: Touch ID through Electron `promptTouchID` (dialog attributed to Lasco); without Touch ID, the
    LocalAuthentication sheet that accepts the session password (`osascript -l JavaScript`, policy
    `DeviceOwnerAuthentication`).
  - Windows: Windows Hello (`UserConsentVerifier`, PIN / face / fingerprint) through PowerShell; the reason
    is passed in an environment variable, never in the script. Without Hello: `unavailable`.
  - Linux: `unsupported`.
- A success is remembered for 60 s; concurrent calls share one prompt. `vault.resetVerification()` forgets it.
- Portal windows only. This gates what the computer shows; the server still checks ownership and logs
  each view (`vault.view`).
- Tests: `scripts/test-vault-auth.js`.
