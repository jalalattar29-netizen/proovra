# Apple OAuth Production Investigation

## 1. Complete Flow Trace

| Step | Location | Detail |
|------|----------|--------|
| **Apple URL built** | `apps/web/lib/oauth.ts` L69 | `buildAppleAuthUrl()` |
| **redirect_uri** | `lib/oauth.ts` L69 | `https://www.proovra.com/auth/callback` (hardcoded) |
| **Callback route** | `apps/web/app/auth/callback/route.ts` | POST handler receives Apple form_post, redirects to `/auth/callback/ui` with params |
| **Callback UI** | `apps/web/app/auth/callback/ui/page.tsx` | Exchanges token with API, sets session, redirects |

## 2. Redirect URI Consistency

- **Sent to Apple:** `https://www.proovra.com/auth/callback`
- **Apple Developer Console:** Must register exactly this URL
- **Domain note:** User may land on `proovra.com` (apex) if DNS/Vercel redirects—ensure both `www.proovra.com` and `proovra.com` are configured consistently

## 3. Root Cause (Production Loop)

**Issue:** After `token_received`, `router.replace("/home")` triggered middleware redirect to `app.proovra.com/home`. Full page load on a new origin lost:
- React state (token)
- localStorage (origin-specific: www ≠ app)

**Cookie:** API sets `proovra_session` with `domain=.proovra.com`, but the callback fetch did not use `credentials: "include"`, so the cookie was never stored.

## 4. Fix Applied

1. **`credentials: "include"`** on both token exchange and `/me` fetches so the API `Set-Cookie` is stored
2. **`window.location.href`** to `app.proovra.com/home` directly instead of `router.replace("/home")` to avoid middleware redirect and ensure a single clear navigation
3. Cookie (domain `.proovra.com`) is then sent from `app.proovra.com` to `api.proovra.com`, and auth works

## 5. Auth State

- **Token:** `localStorage` key `proovra-token` (origin-specific)
- **Cookie:** `proovra_session` (domain `.proovra.com`, httpOnly, sameSite: lax)
- **API:** Accepts either `Authorization: Bearer` header or `proovra_session` cookie
- **App on app.proovra.com:** Uses `apiFetch` with `credentials: "include"` → cookie sent → session valid

## 6. Cookie Fix (Production Subdomain)

**Fix applied:** `maybeSetWebCookie` now uses host-based detection:
- When `host` includes `proovra.com` → `domain: ".proovra.com"`, `secure: true`
- `clearCookie` on logout includes same domain for proper clearing
- Auth middleware reads from `req.cookies.proovra_session` (parsed) with fallback to `Cookie` header
- CORS explicitly allows `www.proovra.com`, `proovra.com`, `app.proovra.com`

## 7. Console Errors (Not From Our Code)

| Error | Source | Action |
|-------|--------|--------|
| "A listener indicated an asynchronous response..." | Chrome extension | Disable extensions or ignore |
| "Access to font at apple.com... blocked by CORS" | Apple's appleid.apple.com page | Apple's internal; cannot fix |
| "Cannot read properties of undefined (reading 'call')" | Bundled app.js (React/Next) | May occur during unmount on redirect; `callbackProcessing` guard prevents duplicate runs |
