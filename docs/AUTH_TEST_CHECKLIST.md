# Auth Web — Test Checklist

**Enable debug:** Set `NEXT_PUBLIC_DEBUG_AUTH=1` in `.env.local` for the Auth Debug panel and logs.

---

## 1. Apple Sign-In

### Web Chrome (Desktop)

| Step | Action | Expected |
|------|--------|----------|
| 1 | Open `/login` | Login page loads |
| 2 | Click "Continue with Apple" | `[Auth] Apple click` in console; `AUTH_START provider=apple` in logs |
| 3 | Browser navigates to | `appleid.apple.com/auth/authorize?...` |
| 4 | Sign in with Apple ID | Redirect to `https://www.proovra.com/auth/callback` (POST) |
| 5 | Redirect to `/auth/callback/ui` | `AUTH_CALLBACK_RECEIVED provider=apple`; `AUTH_SESSION_SUCCESS userId=...` |
| 6 | Navigate to `/home` | User is logged in; dashboard visible |

**Network:** `POST /v1/auth/apple` → 200; `GET /v1/auth/me` → 200

### Web Chrome (Mobile Emulation — iPhone)

| Step | Action | Expected |
|------|--------|----------|
| 1 | DevTools → Toggle device toolbar (iPhone 14) | Mobile viewport |
| 2 | Click "Continue with Apple" | Same navigation as desktop |
| 3 | Complete Apple flow | Same redirect and session |

### Web Safari

- Same flow as Chrome. Verify redirect URI is registered in Apple Developer Console.

---

## 2. Google Sign-In

### Web Chrome (Desktop)

| Step | Action | Expected |
|------|--------|----------|
| 1 | Open `/login` | Login page loads |
| 2 | Click "Continue with Google" | `[Auth] Google click`; `AUTH_START provider=google` |
| 3 | Browser navigates to | `accounts.google.com/o/oauth2/v2/auth?...` |
| 4 | Pick account, allow | Redirect to `https://www.proovra.com/auth/callback?code=...` |
| 5 | Redirect to `/auth/callback/ui` | `AUTH_CALLBACK_RECEIVED provider=google`; `AUTH_SESSION_SUCCESS` |
| 6 | Navigate to `/home` | User logged in |

**Network:** `POST /v1/auth/google` → 200; `GET /v1/auth/me` → 200

### Web Chrome (Mobile Emulation — iPhone)

| Step | Action | Expected |
|------|--------|----------|
| 1 | Mobile emulation | Mobile viewport |
| 2 | Click "Continue with Google" | Full redirect flow (no popup) |
| 3 | Complete flow | Same success |

---

## 3. Error Paths

| Scenario | Expected |
|----------|----------|
| User cancels Apple | Redirect to callback with `error=access_denied`; "Sign-in was cancelled." + toast |
| User cancels Google | Same |
| Token exchange fails (e.g. API down) | Error toast with `requestId` if API returns it |
| Invalid state | "OAuth state mismatch" + toast |

---

## 4. Console Logs (with DEBUG_AUTH)

| Log | When |
|-----|------|
| `[Auth] Apple click` | Apple button clicked |
| `[Auth] Google click` | Google button clicked |
| `[Auth] Redirect URIs ready` | Login page mounted |
| `[Auth] Callback received` | Callback page loaded |

---

## 5. Console Configuration

**No console change required** if already configured:

- **Google Console:** Authorized redirect URI = `https://www.proovra.com/auth/callback`
- **Apple Developer:** Services ID redirect URL = `https://www.proovra.com/auth/callback`

If localhost testing is added later, add `http://localhost:3000/auth/callback` to both.
