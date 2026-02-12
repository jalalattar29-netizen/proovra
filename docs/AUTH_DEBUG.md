# PROOVRA Auth Architecture & Debug Guide

**Branch:** `fix/auth-regressions-cursor`  
**Last updated:** Auth web fixes — redirect flow, Apple button, toasts, debug mode

---

## PHASE 1 — Architecture Map

### A) Web Auth

| Component | Detail |
|-----------|--------|
| **Library** | Custom OAuth (no NextAuth). Google Identity Services (GSI) script + Apple JS SDK. |
| **Google** | `lib/oauth.ts`: `buildGoogleAuthUrl()` builds redirect URL. Login uses **redirect-only** flow: `<a href={googleHref}>` — no GSI one-tap (avoids FedCM warning, reliable on mobile web). |
| **Apple** | `lib/oauth.ts`: `loadAppleIdentity()` loads Apple JS SDK. `buildAppleAuthUrl()` builds redirect URL. Login uses `<a href={appleHref}>` — full redirect flow. |
| **OAuth callback route** | `apps/web/app/auth/callback/route.ts` — handles GET (Google) and POST (Apple form_post). Redirects to `apps/web/app/auth/callback/ui/page.tsx`. |
| **Callback UI** | `apps/web/app/auth/callback/ui/page.tsx` — receives `?code=` or `?id_token=`, exchanges with API, sets token, calls `/v1/auth/me`, redirects to `/home` or `sessionStorage.proovra-return-url`. |
| **Session storage** | JWT in `localStorage` key `proovra-token`. API can also set `proovra_session` cookie when `x-web-client: 1` (domain `.proovra.com` in prod). |

### B) Mobile Auth (Expo)

| Component | Detail |
|-----------|--------|
| **Library** | `expo-auth-session/providers/google` (Google), `expo-apple-authentication` (Apple native). |
| **Google** | `useAuthRequest` with `responseType: IdToken`, `redirectUri` from `AuthSession.makeRedirectUri({ scheme: "proovra" })`. `promptGoogle()` opens browser/tab. |
| **Apple** | `AppleAuthentication.signInAsync()` — native iOS sheet, no redirect. Returns `identityToken` directly. |
| **Session storage** | `expo-secure-store`: `proovra-token`, `proovra-auth-mode`. `api.ts` sets `authToken` in memory + attaches to requests. |

### C) Backend Token Exchange

| Endpoint | Purpose |
|----------|---------|
| `POST /v1/auth/guest` | Creates guest session |
| `POST /v1/auth/google` | Accepts `idToken` or `code`. If `code`, exchanges via `exchangeGoogleCodeForIdToken()` using `GOOGLE_REDIRECT_URI`. |
| `POST /v1/auth/apple` | Accepts `idToken` or `code`. If `code`, exchanges via `exchangeAppleCodeForIdToken()` using `APPLE_REDIRECT_URI`. |
| `GET /v1/auth/me` | Requires Bearer token. Returns `{ user }`. |

**Files:**
- `services/api/src/routes/auth.routes.ts`
- `services/api/src/services/auth.service.ts`

---

## Runtime Redirect URIs (Exact Strings)

### Web (hardcoded in `lib/oauth.ts`)

| Environment | Value |
|-------------|-------|
| **Production** | `https://www.proovra.com/auth/callback` |
| **Local** | Same (hardcoded). Localhost would need `http://localhost:3000/auth/callback` if testing locally — **currently NOT supported** in oauth.ts. |

**Exact strings from code:**
- `buildGoogleAuthUrl()`: `redirectUri = "https://www.proovra.com/auth/callback"`
- `buildAppleAuthUrl()`: `redirectUri = "https://www.proovra.com/auth/callback"`

### Web — Backend env (for code exchange)

| Env var | Expected value |
|---------|----------------|
| `GOOGLE_REDIRECT_URI` | `https://www.proovra.com/auth/callback` |
| `APPLE_REDIRECT_URI` | `https://www.proovra.com/auth/callback` |

### Mobile (expo-auth-session)

| Environment | `makeRedirectUri({ scheme: "proovra" })` result |
|-------------|--------------------------------------------------|
| **Expo Go** | `https://auth.expo.io/@<username>/<slug>` (proxy) or custom scheme |
| **EAS / standalone** | `proovra://` (or similar from scheme in app.json) |

**app.json:** `"scheme": "proovra"` → likely `proovra://` for standalone.

---

## Callback Flow Summary

1. **Web Google:** User clicks → redirect to `accounts.google.com` → back to `https://www.proovra.com/auth/callback?code=...` → route.ts GET redirects to `/auth/callback/ui?code=...&provider=google` → UI page exchanges code with API (`/v1/auth/google` with `{ code }`) → API uses `GOOGLE_REDIRECT_URI` for server-side exchange.
2. **Web Apple:** User clicks → redirect to `appleid.apple.com` → form POST to `https://www.proovra.com/auth/callback` → route.ts POST redirects to `/auth/callback/ui?code=...&provider=apple` → UI exchanges with API → API uses `APPLE_REDIRECT_URI`.
3. **Mobile Google:** `promptGoogle()` opens browser → OAuth → redirect to `redirectUri` (from makeRedirectUri) → app receives response in `googleResponse`.
4. **Mobile Apple:** Native sheet → returns `identityToken` → no redirect.

---

## Phase 4 — Cancel / Dismiss Handling

| Area | Behavior |
|------|----------|
| **Web GSI** | When user dismisses one-tap (no credential): no error shown; logs `callback_no_credential` with note "user dismissed/cancelled". |
| **Web callback UI** | When OAuth returns `error=access_denied` or `user_cancelled_*` and no token: shows "Sign-in was cancelled." + "Back to sign in" link. |
| **Apple POST callback** | Route forwards `error` and `error_description` form params to UI for cancel detection. |
| **Mobile Apple** | Catches `ERR_REQUEST_CANCELED` or message containing "cancel"; clears error, no status. |
| **Mobile Google** | `googleResponse.type === "dismiss"` already handled; no error set. |
| **Login page** | `handleAuth` guards all `setState` / `router.replace` with `isMountedRef` to avoid updates after unmount. |

---

## Required Env Vars

### Web (Next.js)

| Var | Purpose |
|-----|---------|
| `NEXT_PUBLIC_API_BASE` | API URL (e.g. `https://api.proovra.com`) |
| `BUILD_TIME` | (optional) Injected at build |
| `VERCEL_GIT_COMMIT_SHA` | (Vercel) Auto-set |

### Mobile (Expo)

| Var | Purpose |
|-----|---------|
| `EXPO_PUBLIC_GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `EXPO_PUBLIC_API_BASE` | API URL |

### API (Backend)

| Var | Purpose |
|-----|---------|
| `AUTH_JWT_SECRET` | JWT signing |
| `GOOGLE_CLIENT_ID` | Must match web/mobile |
| `GOOGLE_CLIENT_SECRET` | For code exchange |
| `GOOGLE_REDIRECT_URI` | Must be `https://www.proovra.com/auth/callback` (for web) |
| `APPLE_CLIENT_ID` | e.g. `com.proovra.web` |
| `APPLE_REDIRECT_URI` | Must be `https://www.proovra.com/auth/callback` |
| `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` | Apple Sign In |

---

## Console Checklist (Manual Verification)

### Google Cloud Console

- **Authorized JavaScript origins:** `https://www.proovra.com`, `https://app.proovra.com`, `http://localhost:3000` (if testing locally)
- **Authorized redirect URIs:** `https://www.proovra.com/auth/callback`, `http://localhost:3000/auth/callback` (if local)
- **Mobile:** Add Expo redirect URI if using Expo Go: `https://auth.expo.io/@...` or custom scheme `proovra://`

### Apple Developer

- **Services ID** (e.g. `com.proovra.web`): Redirect URL = `https://www.proovra.com/auth/callback`
- **Sign In with Apple** enabled for App ID and Services ID

---

## Repro Checklist (Phase 2 — To Be Filled)

| Scenario | Status | Evidence |
|----------|--------|----------|
| Web Chrome: Google success | — | — |
| Web Chrome: Google cancel | — | — |
| Web Safari: Apple success | — | — |
| Web Safari: Apple cancel | — | — |
| iOS: Apple success | — | — |
| iOS: Apple cancel | — | — |
| iOS: Session persistence after restart | — | — |
| Android: Google success | — | — |
| Android: Google cancel | — | — |
| Android: Session persistence after restart | — | — |

---

## BUILD_ID / Proof of Deployment

- **Route:** `GET /api/health` returns `buildId`, `commitSha`, `buildTime`, `environment`, `vercelEnv`.
- **Verify:** `curl https://www.proovra.com/api/health` (or localhost during dev).
