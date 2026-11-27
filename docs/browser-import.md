# Import from another browser

The in-app browser imports bookmarks, history and passwords from another browser installed on the
computer, like Chrome's « Importer les favoris et les paramètres ». Desktop reads the other browser's
profile files; the portal (the trusted main window) shows the wizard and saves bookmarks and passwords
through the Lasco API.

## Pieces

| Where | File | Role |
| --- | --- | --- |
| Main process | `src/browser-import/browsers.js` | Installed browsers and profiles. No file path leaves the main process (`publicBrowser`). |
| Main process | `src/browser-import/readers.js` | Readers: Chromium `Bookmarks` (JSON), `History` / `Login Data` (SQLite), Firefox `places.sqlite`, Safari `Bookmarks.plist` / `History.db`, password CSV. |
| Main process | `src/browser-import/index.js` | Controller: runs an import, writes history to Desktop's store, holds passwords for the portal. |
| Main process | `src/browser-import/ipc.js` | IPC channels, portal windows only. |
| Portal bridge | `src/preload.js` → `lascoDesktop.browserImport` | See below. |

## Browsers

| Browser | macOS | Windows | Linux | Passwords |
| --- | --- | --- | --- | --- |
| Chrome, Brave, Edge, Vivaldi, Chromium | `~/Library/Application Support/<…>` | `%LOCALAPPDATA%/<…>/User Data` | `~/.config/<…>` | macOS: decrypted (Keychain). Elsewhere: CSV. |
| Arc | `~/Library/Application Support/Arc/User Data` | — | — | macOS: decrypted (Keychain). |
| Safari | `~/Library/Safari` | — | — | CSV (Safari > Fichier > Exporter > Mots de passe). |
| Firefox | `~/Library/Application Support/Firefox` | `%APPDATA%/Mozilla/Firefox` | `~/.mozilla/firefox` | CSV (about:logins > ⋯ > Exporter). |

- Chromium profiles: `Local State` (`profile.info_cache`, name and account e-mail) plus the `Default` /
  `Profile N` folders that hold at least one of `Bookmarks`, `History`, `Login Data`.
- Firefox profiles: `profiles.ini` (relative or absolute paths) with a `places.sqlite`.
- SQLite files are copied (with their `-journal` / `-wal` / `-shm`) to a private temporary folder and read
  with `node:sqlite`; the copy is deleted right after. The other browser can stay open.
- Chromium times are µs since 1601: the SQL divides by 1000 (µs overflow JavaScript's safe integers).

## Safari: Full Disk Access

`~/Library/Safari` is protected by macOS (TCC). Without the permission, the folder cannot even be listed
(`EPERM`): `list()` still shows Safari with `needsFullDiskAccess: true`, and a read fails with
`full-disk-access`. The portal explains it and opens System Settings > Privacy & Security > Full Disk
Access (`openFullDiskAccessSettings`). The person adds Lasco, then restarts it (macOS applies the
permission to a new process only).

## Chromium passwords (macOS)

- `Login Data` and `Login Data For Account` (passwords of the browser's synced account), table `logins`.
- Values start with `v10` / `v11`: AES-128-CBC, IV of 16 spaces, key = PBKDF2-SHA1(Keychain secret,
  `saltysalt`, 1003 iterations, 16 bytes).
- The Keychain secret is the item « Chrome Safe Storage » (« Brave Safe Storage », « Arc Safe Storage »,
  « Microsoft Edge Safe Storage »…), read with `/usr/bin/security find-generic-password -w`. macOS asks
  the person to allow it (enter the session password, then « Autoriser »): this is expected. Refused:
  `keychain-denied`; no answer within 2 minutes: `keychain-timeout`. The portal proposes the CSV instead.
- A value that does not decrypt to valid UTF-8 (other format, wrong key) is counted in `unreadable`, never
  imported. Never-save entries (`blacklisted_by_user`) and non-web origins (`android://`) are skipped.
- Windows (DPAPI, app-bound encryption) and Linux (libsecret) are not decrypted: CSV only.

## Bridge (`lascoDesktop.browserImport`)

Portal windows only (not in VM mode). Every channel checks the sender is a portal window.

- `list()` → `{ ok, platform, browsers: [{ id, name, passwords: 'native' | 'csv', keychainItem?, needsFullDiskAccess?,
  profiles: [{ id, name, email?, data: { bookmarks, history, passwords } }] }] }`.
- `run({ importId, browserId, profileId, kinds: { bookmarks, history, passwords } })` →
  `{ ok, browser, profile, history?, bookmarks?, passwords?, errors: { <kind>: code } }`. One import at a
  time (`busy`). Each kind succeeds or fails on its own.
  - `history: { found, imported, skipped }`: written to Desktop's history (`history.importEntries`): an
    address already known keeps the larger visit count and the latest visit, so a second import counts
    nothing twice. The store keeps 5000 addresses: the oldest go first.
  - `bookmarks: { found, items: [{ title, url, root: 'bar' | 'menu' | 'other' | 'mobile', folder: string[] }] }`:
    the portal saves them as favorites.
  - `passwords: { token, found, unreadable }`: no password in the result.
- `importPasswordsCsv()` → native open dialog, then `{ ok, token, found, skipped }` or `{ ok: false, error }`
  (`canceled`, `csv-format`, `csv-empty`, `csv-too-large`, `read-failed`). Columns recognised: `url`,
  `username` / `login`, `password` (Chrome, Edge, Brave, Arc, Firefox, Safari, Bitwarden-like exports).
- `takePasswords({ token })` → `{ ok, items: [{ url, username, password }] }`, **once**; then forgotten.
  An unclaimed list expires after 10 minutes. `discardPasswords({ token })` drops it.
- `openFullDiskAccessSettings()` (macOS).
- `onProgress(cb)` → `{ importId, step: 'history' | 'bookmarks' | 'passwords', status: 'running' | 'done' | 'failed', count?, error? }`.

Error codes: `not-found`, `full-disk-access`, `read-failed`, `keychain-denied`, `keychain-timeout`, `keychain-not-found`,
`passwords-csv-only`, `unknown-browser`, `busy`, `forbidden`.

## Rules

- Passwords are decrypted in the main process, held in memory only, handed to the portal once, never logged
  nor written to disk. The portal saves them in the Vault (`POST /vault/logins`, after `/check`), then drops them.
- The portal imports passwords only when the workspace Vault is on; otherwise it says so and does not call `run`
  with `passwords`.
- Tests: `scripts/test-browser-import.js` (fixtures in `scripts/fixtures/browser-import/`, SQLite databases
  built at test time).
