# Universal Links / App Links — what is ready, and what is not

Repository configuration is complete. Two values cannot come from a repository
and are marked in the files themselves; everything else is done.

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
| `/portal`, `/portal/*` | `(stack)/portal/*` |
| `/legal/*` | `(stack)/legal/[slug].tsx` |
| `/verify/*` | `verify.tsx` |
| `/invite/*` | `(stack)/invite/[token].tsx` |
| `/org-invites/*` | `(stack)/org-invite/[token].tsx` |
| `/reset-password` | `(stack)/reset-password.tsx` |
| `/auth/verify-email` | `(stack)/verify-email.tsx` |
| `/auth/mfa-recovery/*` | `(stack)/mfa-recovery-verify.tsx` |

`/portal/sso/callback` is deliberately absent: it is a browser redirect target
with no native analogue, and claiming it would break the web SSO round-trip by
bouncing the callback into an app that cannot complete it.

## The association files

Written to `apps/web/public/.well-known/`, which Next serves at the site root:

- `apple-app-site-association`
- `assetlinks.json`

They are served without an extension and with no redirect, which is what both
platforms require.

## The two values that are NOT in this repository

Neither is invented. Each is a placeholder in the file, so a deploy that
forgets one fails loudly rather than silently shipping a file that verifies
nothing.

| File | Field | Where it comes from |
|---|---|---|
| `apple-app-site-association` | `<APPLE_TEAM_ID>` | the Apple Developer account that owns the App ID `com.jalalattar29.proovra`; visible in the Membership tab, and in any provisioning profile |
| `assetlinks.json` | `<ANDROID_SIGNING_SHA256_FINGERPRINT>` | the SHA-256 of the certificate the app is SIGNED with. For Play App Signing this is the **upload key's** fingerprint from the Play Console, not the local debug keystore — using the debug one is the usual reason App Links silently fail in production |

## What remains external

1. Substitute the two values above.
2. Deploy `apps/web` so the two files are reachable over HTTPS at
   `https://www.proovra.com/.well-known/…` and
   `https://proovra.com/.well-known/…`, with `content-type: application/json`
   and no redirect.
3. Install a build made AFTER the `app.json` change. iOS fetches the AASA at
   install time; Android verifies on install. An existing build will not pick
   this up.

Until then a `https://` link opens the browser. That is a DEPLOYMENT state, not
a missing product surface: every screen, parser, API call and state behind
these paths is implemented and tested.

## `proovra://` works today

The custom scheme needs no association and is handled by the same parsers, so
every flow is reachable now for testing:

```
proovra://intake/<token>
proovra://portal/<token>
proovra://legal/privacy
```
