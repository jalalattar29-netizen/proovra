# Universal Links / App Links — what is ready, and what is not

Repository configuration is complete. The association files hold real values;
what is still unverified is listed under "What remains external".

## What the app claims

`apps/mobile/app.json`:

- `expo.ios.associatedDomains` — `applinks:www.proovra.com`,
  `applinks:proovra.com`
- `expo.android.intentFilters` — one `VIEW` filter with `autoVerify: true`
  over the same two hosts

The path list is the exact set of flows the API mints links for, not a
wildcard. A broad `/*` would make the app offer to open marketing pages it has
no screen for, and the first thing a user would learn is that "open in app"
sometimes goes nowhere useful.

| Path | Native destination |
|---|---|
| `/intake/*` | `(stack)/intake/[token].tsx` |
| `/portal`, `/portal/accept/*` | `(stack)/portal/*` |
| `/legal/*` | `(stack)/legal/[slug].tsx` |
| `/verify/<ref>` | `verify/[id].tsx`, which hands to `verify.tsx` |
| `/verify/package/<id>` | `verify/package/[id].tsx`, which opens the web page in an in-app browser |
| `/invite/*` | `(stack)/invite/[token].tsx` |
| `/org-invites/*` | `(stack)/org-invite/[token].tsx` |
| `/reset-password` | `(stack)/reset-password.tsx` |
| `/auth/verify-email` | `(stack)/verify-email.tsx` |
| `/auth/mfa-recovery/*` | `(stack)/mfa-recovery-verify.tsx` |

`/portal/sso/callback` is deliberately absent: it is a browser redirect target
with no native analogue, and claiming it would break the web SSO round-trip by
bouncing the callback into an app that cannot complete it. Android path prefixes
cannot exclude a sub-path, so neither platform claims all of `/portal`. The API
mints `/portal/accept/<grantId>`, so that is what is claimed. A `/portal/<token>`
link opens in the browser, and `proovra://portal/<token>` still opens the app.

`/evidence/*` and `/cases/*` are not claimed. Those emails open the browser. The
app can resolve them (`proovra://evidence/<id>`, through `POST /v1/deep-link/resolve`),
and whether to claim them is an open decision, MOBILE-006.

A path with no route lands on `+not-found.tsx`.

## The association files

Written to `apps/web/public/.well-known/`, which Next serves at the site root:

- `apple-app-site-association`
- `assetlinks.json`

They are served without an extension and with no redirect, which is what both
platforms require.

## What remains external

1. `assetlinks.json` holds one fingerprint, extracted from a signed APK. With Play
   App Signing, devices receive a build signed by Google's app-signing key, so that
   key's SHA-256 must be listed too. Confirm it in the Play Console. The usual
   symptom of a missing one is App Links silently opening the browser.
2. Deploy `apps/web` so the two files are reachable over HTTPS at
   `https://www.proovra.com/.well-known/…` and
   `https://proovra.com/.well-known/…`, with `content-type: application/json`
   and no redirect. Next serves the extensionless AASA with its default type
   unless told otherwise (MOBILE-010).
3. Install a build made AFTER the `app.json` change. iOS fetches the AASA at
   install time; Android verifies on install. An existing build will not pick
   this up.

Until then a `https://` link opens the browser. Nothing here has been verified on
a device: `docs/physical-acceptance.md` records what has.

## `proovra://` works today

The custom scheme needs no association and is handled by the same parsers, so
every flow is reachable now for testing:

```
proovra://intake/<token>
proovra://portal/<token>
proovra://legal/privacy
```
