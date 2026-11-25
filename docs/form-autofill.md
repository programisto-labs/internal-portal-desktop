# Form autofill of the web tabs

The in-app browser fills names, addresses, e-mail and phone fields from the person's saved
addresses, like Chrome's « Addresses and more » (Safari « Contacts », Brave « Addresses »). Passwords
stay with the password manager (`docs/passwords.md`); payment cards are not handled.

The addresses live on the Lasco server (per account, encrypted). The portal (the trusted main
window) reads them and pushes them to Desktop, which keeps them **in memory only**, never on disk.

## Pieces

| Where | File | Role |
| --- | --- | --- |
| Web page | `src/browser-tabs/password-preload.js` (second half) | Classifies address fields, reports the focused one, fills a form, reports a sent address form. Same isolated world as the password manager (a sandboxed preload cannot require another file). |
| Main process | `src/browser-tabs/form-autofill.js` | Per-window controller: profiles, popover rows, fill requests, captures. |
| Main process | `src/browser-tabs/password-popover.js` | The popover under a field, shared with the password manager (`owner`: `password` / `autofill`). |
| Main process | `src/browser-tabs/manager.js` | Routes `lasco-af:*` page messages to the controller; `autofillSetProfiles`. |
| Portal bridge | `src/preload.js` → `lascoDesktop.browserTabs.autofill` | See below. |

## Bridge (`lascoDesktop.browserTabs.autofill`)

Portal windows only (same `tabManagerFor` check as the other browser-tab channels).

- `setProfiles({ enabled, profiles: [{ id, fields }], labels? })` → `{ ok, enabled, count }`. `fields`:
  `givenName`, `familyName`, `organization`, `addressLine1`, `addressLine2`, `postalCode`, `city`,
  `region`, `country`, `email`, `phone` (one-line text). Most used first. `labels: { title, manage }`
  in the person's language. `enabled: false` (setting off, logout) drops everything.
- `onCapture(cb)` → `{ tabId, captureId, host, fields }` — an address form was sent with values that no
  profile covers yet. The portal asks whether to save them.
- `onUsed(cb)` → `{ tabId, profileId, filled }` — a form was filled with this profile (`filled` fields).
- `onAction(cb)` → `{ tabId, host, action: 'manage' }` — « Gérer les adresses… » in the popover.

## Page runtime

- Field type: `autocomplete` token first (`given-name`, `family-name`, `name`, `organization`,
  `street-address`, `address-line1/2`, `postal-code`, `address-level2/1`, `country[-name]`, `email`,
  `tel[-national]`), then `type="email"` / `type="tel"`, then hints in name, id, placeholder,
  aria-label and label text (French, English, German, Spanish, Italian, Portuguese, Dutch words).
  `cc-*`, passwords, one-time codes, usernames, search, coupons, IBAN, dates are never address fields.
  « Nom » alone (no first-name field) is the full name.
- An address form: a form (or the page outside forms) **without a password field**, with two kinds of
  address fields at least, or a field the site marked with `autocomplete`. Login forms go to the
  password manager.
- Focus or click on an address field (trusted events) sends its type and rectangle; the popover lists
  the profiles that have a value for that type (that value first, the rest of the address below), then
  « Gérer les adresses… ». No popover without such a profile. Keys, arming (300 ms), closing rules:
  the same as the password popover.
- Fill: the field that opened the popover and every **empty** address field of the same form (a value
  the person typed elsewhere is kept); `<select>` (country, region) by option text or value, accents
  ignored. Values are written through the native value setter plus `input`/`change`.
- Capture: `submit`, click on a submit control, Enter in a field. Three kinds of fields and three values
  at least, a name or an address line among them. Values just filled from a profile (10 min) are not
  offered again; the main process also drops a capture that a profile already covers, and the same
  form sent twice within 30 s.

## Rules

- https only (plus `localhost`, `127.0.0.1`, `*.localhost`, `*.test`), main frame only.
- A fill is sent only if the tab still shows the host the popover was opened for.
- Messages are accepted only from the main frame of a web view owned by the window's tab manager.
- Tests: `scripts/test-form-autofill.js`.
