# PHASE 3 FINDINGS - Redirect URI Verification

**Date:** 2026-02-12  
**Status:** COMPLETED (Code inspection)  
**Branch:** `fix/auth-regressions`

---

## MOBILE DEEP LINK SCHEME ✅

### app.json Configuration

**File:** `apps/mobile/app.json`

```json
{
  "expo": {
    "name": "Proovra",
    "slug": "proovra",
    "scheme": "proovra",
    "sdkVersion": "52.0.0",
    "icon": "./assets/icon.png"
  }
}
```

**Status:** ✅ **CORRECT**
- `"scheme": "proovra"` is defined at top level
- Will generate deep link: `proovra://redirect`
- Expo-router will intercept and route to auth handlers

### Mobile OAuth Redirect URIs (Actual)

**Google (iOS & Android):**
```
makeRedirectUri({ scheme: "proovra" })
→ proovra://redirect  (in standalone/EAS build)
→ http://localhost:19000/--/expo-auth-session  (in Expo Go dev)
```

**Apple (iOS only):**
```
AppleAuthentication.signInAsync()
→ No HTTP redirect
→ Returns native identityToken directly
→ No redirect URI needed
```

**Status:** ✅ **CORRECT**

---

## WEB REDIRECT URIS ✅

### Web Callback Routes

**Files:** 
- `apps/web/app/auth/callback/route.ts` - Handles POST (Apple) and GET (Google)
- `apps/web/app/auth/callback/ui/page.tsx` - Processes callback

**Configuration (Hardcoded):**

```typescript
// apps/web/lib/oauth.ts
const redirectUri = "https://www.proovra.com/auth/callback";
```

**Google Callback:**
```
GET https://www.proovra.com/auth/callback?code=...&state=google
→ apps/web/app/auth/callback/route.ts (GET handler)
→ Redirects to: /auth/callback/ui?code=...&state=google&provider=google
→ apps/web/app/auth/callback/ui/page.tsx processes
```

**Apple Callback:**
```
POST https://www.proovra.com/auth/callback
Body: { code, id_token, state }
→ apps/web/app/auth/callback/route.ts (POST handler)
→ Redirects to: /auth/callback/ui?code=...&id_token=...&state=...&provider=apple
→ apps/web/app/auth/callback/ui/page.tsx processes
```

**Status:** ✅ **CORRECT**

---

## PROVIDER CONSOLE CONFIGURATION

### Google Cloud Console Verification Needed ⚠️

**What To Check:**
1. Navigate to: Google Cloud Console → APIs & Services → Credentials
2. Find OAuth Client: `548168595768-8uddhhcmdgl9108juth8fke4boncenut.apps.googleusercontent.com`
3. Under "Authorized Redirect URIs" should include:
   ```
   https://www.proovra.com/auth/callback
   ```

**Mobile consideration:**
- Google may have a second redirect URI for mobile Expo proxy
- Check if https://auth.expo.io/... is configured (unlikely needed)

**Action Required:** 📷 Screenshot for evidence

### Apple Developer Console Verification Needed ⚠️

**What To Check:**
1. Navigate to: Apple Developer → Certificates, IDs & Profiles → Identifiers
2. Find Service ID: `com.proovra.web`
3. Click edit, go to "Sign in with Apple" section
4. In "Web Authentication Configuration", should show:
   ```
   Primary App ID: com.proovra
   Domains and Subdomains: www.proovra.com
   Return URLs: https://www.proovra.com/auth/callback
   ```

**Action Required:** 📷 Screenshot for evidence

---

## BACKEND WHITELIST CHECK ⚠️

### Does API validate redirect_uri?

**Location:** `services/api/src/routes/auth.routes.ts`

**Current Code:**
```typescript
app.post("/v1/auth/google", async (req, reply) => {
  // ... code looks like it just verifies the JWT
  // No explicit redirect_uri validation found
})
```

**Status:** ⚠️ **NOT VISIBLE** - May not be validating redirect_uri

**Impact:** 
- If backend validates: mismatch would cause 400/403 error
- If not validating: relies on OAuth provider validation only

**Action:** Check if error logs show redirect_uri issues

---

## CROSS-DOMAIN COOKIE ISSUE ⚠️

### Cookie Domain Configuration

**File:** `services/api/src/routes/auth.routes.ts`

**Current Code:**
```typescript
reply.setCookie("proovra_session", token, {
  httpOnly: true,
  sameSite: "lax",
  secure: true,
  path: "/",
  maxAge: 60 * 60 * 24 * 30
  // ❌ domain NOT set!
});
```

**Problem:**
- Without explicit domain, cookie only applies to current domain
- If backend is `api.proovra.com` and web is `www.proovra.com`, cookie won't be sent to web
- Same-domain only (api.proovra.com → api.proovra.com)

**Fix Needed:** 
```typescript
domain: ".proovra.com",  // Dot prefix = cross-subdomain
```

**Status:** ⚠️ **POTENTIAL ISSUE** - May break session sharing

**Action Required:** Verify if cookie is actually being set on web

---

## SUMMARY OF PHASE 3

### ✅ Verified Correct:
- Mobile app.json has `"scheme": "proovra"`
- Web callback routes properly configured for GET (Google) and POST (Apple)
- OAuth URLs hardcoded with correct redirect_uri
- Deep links will be intercepted by expo-router

### ⚠️ Needs Verification (Screenshots):
- Google Cloud Console: Is `https://www.proovra.com/auth/callback` in redirect URIs?
- Apple Developer: Is `https://www.proovra.com/auth/callback` in Web Authentication Return URLs?

### 🔴 Known Issues to Fix (PHASE 4-5):
- Backend may not validate redirect_uri (low priority)
- Cookie domain NOT set to ".proovra.com" (may break session)
- Static Google state (weak CSRF) - needs random state

### 📋 Status:
PHASE 3 ready for testing. Code looks correct, but need provider console screenshots as evidence.

---

## QUICK REFERENCE FOR TESTERS

### Test URLs

**Local Development:**
```
Web: http://localhost:3000/login
Mobile: Expo Go or EAS build

Console Check:
curl http://localhost:3000/health
```

**Staging/Production:**
```
Web: https://www.proovra.com/login
Health: https://www.proovra.com/health

Mobile: Download from TestFlight (iOS) or Play Store (Android)
```

### Evidence Collection

**After each test, capture:**
1. Browser/Mobile logs → `window.__authLogs.getLogsAsMarkdown()`
2. Network tab → HAR or screenshot
3. Final URL and query params (for debugging)
4. /me response (redact token/secrets)

### Command to Check Build ID

```bash
# At repo root:
git rev-parse --short HEAD

# Then verify matches:
# - Login page footer (dev mode)
# - /health endpoint JSON
# - Test evidence timestamp
```

