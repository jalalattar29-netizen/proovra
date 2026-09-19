# PROOVRA Native — External Configuration Manifest

The repository is wired for native OAuth and deep links. The following values live
in external consoles / EAS secrets and are **EXTERNAL-CONFIG-PENDING**. No secret
is committed. Never weaken the backend audience allowlist to accommodate a missing
value — provision the value instead.

## Google Sign-In (A1)

Native Google needs **platform-specific** OAuth client IDs from the Google Cloud
console (APIs & Services → Credentials), all under the same project:

| Env var (EAS / `.env`)                    | Google client type | Bound to |
| ----------------------------------------- | ------------------ | -------- |
| `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`        | iOS                | bundle id `com.jalalattar29.proovra` |
| `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID`    | Android            | package `com.jalalattar29.proovra` + release SHA-1 |
| `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`        | Web                | sets the `id_token` **audience** for the server exchange |

- The screen consumes these in `src/auth/use-oauth.ts` (`iosClientId` /
  `androidClientId` / `webClientId`). expo-auth-session derives the correct
  native redirect from them — do **not** re-introduce a custom `proovra://`
  redirect for Google.
- **iOS URL scheme:** add the reversed iOS client id
  (`com.googleusercontent.apps.<...>`) as a `CFBundleURLTypes` entry for
  standalone/dev-client builds. This value comes from the iOS client id above and
  is added at build config time (EXTERNAL-CONFIG-PENDING).
- **Backend audience allowlist:** the API must accept the iOS/Android/Web client
  ids it should trust — and only those. Keep it strict; no wildcard.

## Apple Sign-In (A2)

- Repository config is complete: `ios.usesAppleSignIn: true` and the
  `expo-apple-authentication` plugin are declared in `app.json`; EAS generates the
  entitlement. Apple sign-in renders on iOS only (never faked on Android).
- **Apple Developer console:** enable "Sign in with Apple" for the App ID
  `com.jalalattar29.proovra`. The **bundle id** is the native token audience; a
  separate **Service ID** is only needed for a web/Android Apple flow (not used
  here).
- **Backend audience:** must accept the bundle id `com.jalalattar29.proovra`.

## Universal / App Links (M7) — pending

- iOS Associated Domains (`applinks:<domain>`) + an AASA file hosted at
  `https://<domain>/.well-known/apple-app-site-association`.
- Android App Links: `assetlinks.json` at
  `https://<domain>/.well-known/assetlinks.json` + intent filters.
- These require the production web domain + hosting of the association files; the
  custom `proovra://` scheme works today without them.
