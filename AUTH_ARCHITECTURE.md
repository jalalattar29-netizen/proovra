# AUTH ARCHITECTURE DOCUMENTATION
## PHASE 2 - Actual Implementation Analysis

**Document Version:** 2026-02-12
**Branch:** `fix/auth-regressions`
**Purpose:** Document real OAuth implementation to understand what's actually happening

---

## 1. WEB AUTHENTICATION ARCHITECTURE

### 1.1 OAuth Flow (Google & Apple)

**Libraries Used:**
- ❌ NextAuth (NOT used)
- ✅ Custom implementation using OAuth 2.0 + OpenID Connect
- ✅ Google Identity Services SDK (loaded dynamically: `https://accounts.google.com/gsi/client`)
- ✅ Apple Sign In SDK (loaded dynamically: `https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js`)

### 1.2 Web Google OAuth Flow

**File:** `apps/web/app/login/page.tsx`

**Step 1: Generate OAuth URL**
```
buildGoogleAuthUrl() generates:
  - Client ID: 548168595768-8uddhhcmdgl9108juth8fke4boncenut.apps.googleusercontent.com
  - Redirect URI: https://www.proovra.com/auth/callback (HARDCODED)
  - Response Type: code
  - Scopes: openid email profile
  - State: "google" (STATIC - NOT RANDOM)
  - Access Type: offline
  - Prompt: consent
```

**Step 2: Callback Received**
- URL: `https://www.proovra.com/auth/callback?code=...&state=google`
- Handled by: `apps/web/app/auth/callback/route.ts`
- Method: GET request
- Sets provider param: `?provider=google`
- Redirects to: `apps/web/app/auth/callback/ui/page.tsx`

**Step 3: Token Exchange**
- Route: `apps/web/app/auth/callback/ui/page.tsx`
- Parses: code from URL
- Endpoint: `POST /v1/auth/google`
- Payload: `{ code }` or `{ idToken }`
- Response: `{ token: JWT, user: { id, email, ... } }`

**Step 4: Session Validation**
- Endpoint: `GET /v1/auth/me`
- Header: `Authorization: Bearer <JWT>`
- Response: `{ user: { ... } }`
- Confirms session is active

### 1.3 Web Apple OAuth Flow

**File:** `apps/web/app/login/page.tsx`

**Step 1: Generate OAuth URL**
```
buildAppleAuthUrl() generates:
  - Client ID: com.proovra.web (HARDCODED)
  - Redirect URI: https://www.proovra.com/auth/callback (HARDCODED)
  - Response Type: code id_token
  - Response Mode: form_post (KEY: submits as form, not query params)
  - Scopes: name email
  - State: <random UUID> (GENERATED)
```

**Step 2: Callback Received**
- URL: `https://www.proovra.com/auth/callback`
- Method: POST form submission (from Apple)
- Handled by: `apps/web/app/auth/callback/route.ts`
- Extracts: code, id_token, state from FormData
- Sets provider param: `?provider=apple`
- Redirects to: `apps/web/app/auth/callback/ui/page.tsx`

**Step 3: Token Exchange**
- Route: `apps/web/app/auth/callback/ui/page.tsx`
- Parses: id_token from URL or code
- Endpoint: `POST /v1/auth/apple`
- Payload: `{ idToken }` or `{ code }`
- Response: `{ token: JWT, user: { id, email, ... } }`

**Step 4: Session Validation**
- Endpoint: `GET /v1/auth/me`
- Same as Google flow

### 1.4 Web Session Management

**Session Storage:**
- **Cookies:** `proovra_session` (set by backend if `x-web-client: 1` header present)
- **LocalStorage:** Not used for tokens
- **JWT:** Stored in browser memory only (lost on page reload)

**Cookie Configuration:**
```
- httpOnly: true (secure, can't access from JS)
- sameSite: lax (CSRF protection)
- secure: true (HTTPS only, in production)
- path: /
- maxAge: 30 days
- domain: (NOT explicitly set - defaults to current domain)
```

**Session Endpoint:**
```
GET /v1/auth/me
  Headers: Authorization: Bearer <JWT>
  Returns: { user: { id, email, ... } }
  Purpose: Validate session after callback
```

### 1.5 Web Known Issues

**Issue 1: Static Google State**
- ❌ **Current:** state = "google" (hardcoded, same for all users)
- ⚠️ **Problem:** CSRF protection is weak (attacker can predict state)
- ✅ **Fix Available:** Generate random state like Apple does
- 📋 **Status:** PHASE 4 (not yet fixed)

**Issue 2: Message Channel Closure**
- ❌ **Symptom:** "A listener indicated an asynchronous response by returning true, but the message channel closed"
- ❌ **Cause:** Google SDK callbacks fire after page unmounts
- ⚠️ **Workaround:** Dual abort flags + 100ms timeout (not ideal)
- 🟡 **Status:** PHASE 4 (needs proper fix)

**Issue 3: Apple form_post Challenge**
- ✅ **Current:** Using form POST which works
- ❌ **Problem:** Browser security model doesn't allow programmatic handling
- ✅ **Solution:** Store state in sessionStorage, validate on callback

---

## 2. MOBILE AUTHENTICATION ARCHITECTURE

### 2.1 OAuth Flow (Google & Apple)

**Libraries Used:**
- ✅ `expo-apple-authentication` (native Apple Sign In)
- ✅ `expo-auth-session/providers/google` (Google OAuth via Expo proxy)
- ✅ `expo-auth-session` (handles deep link redirection)

**Platform Support:**
- iOS: Both Apple and Google (via Expo proxy)
- Android: Google only (Apple not supported)

### 2.2 Mobile Google OAuth Flow

**File:** `apps/mobile/app/(stack)/auth.tsx`

**Step 1: Initialize Google Auth**
```typescript
const redirectUri = AuthSession.makeRedirectUri({ scheme: "proovra" });
// Generates: proovra://redirect OR http://localhost:19000/--/expo-auth-session (in dev)

const [googleRequest, googleResponse, promptGoogle] = Google.useAuthRequest({
  clientId: process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID,
  responseType: AuthSession.ResponseType.IdToken,
  scopes: ["openid", "email", "profile"],
  redirectUri
});
```

**Step 2: Prompt User**
```typescript
promptGoogle()
  → Opens Google Sign In picker (native or web view)
  → User selects account
  → Google redirects to: proovra://redirect?...
  → Expo intercepts deep link
  → Returns googleResponse
```

**Step 3: Handle Response**
```typescript
// googleResponse can be:
// - { type: "success", params: { id_token, ... } }
// - { type: "dismiss" } (user closed picker)
// - { type: "error", params: { error, error_description } }

if (googleResponse.type === "success") {
  const idToken = googleResponse.params?.id_token;
  // Continue with token exchange
}
```

**Step 4: Token Exchange**
- Endpoint: `POST /v1/auth/google`
- Payload: `{ idToken }`
- Response: `{ token, user }`

**Step 5: Session Storage**
```typescript
setSession({ 
  token: data.token, 
  user: me.user,
  mode: "google"
});
// Stored in: SecureStore (encrypted, mobile-specific)
```

### 2.3 Mobile Apple OAuth Flow

**File:** `apps/mobile/app/(stack)/auth.tsx`

**Step 1: Check Availability**
```typescript
AppleAuthentication.isAvailableAsync()
  → true (iOS only)
  → false (Android or older iOS)
```

**Step 2: Trigger Sign In**
```typescript
const result = await AppleAuthentication.signInAsync({
  requestedScopes: [
    AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
    AppleAuthentication.AppleAuthenticationScope.EMAIL
  ]
});
```

**Step 3: Native Dialog**
- Shows Apple system sign-in dialog (native iOS UI)
- User authenticates with Face ID / Touch ID / password
- Returns: identityToken (JWT), user (optional)

**Step 4: Handle Result**
```typescript
if (!result.identityToken) {
  throw new Error("No identity token");
}
// result.identityToken is JWT from Apple
```

**Step 5: Token Exchange**
- Endpoint: `POST /v1/auth/apple`
- Payload: `{ idToken: result.identityToken }`
- Response: `{ token, user }`

**Step 6: Session Storage**
```typescript
setSession({ 
  token: data.token, 
  user: me.user,
  mode: "apple"
});
// Stored in: SecureStore
```

### 2.4 Mobile Known Issues

**Issue 1: No Cancel/Error Handling (FIXED)**
- ❌ **Was:** Not checking googleResponse.type before accessing params
- ✅ **Fixed:** Added explicit handling for "dismiss" and "error" types
- 📋 **Status:** PHASE 4 (already in code)

**Issue 2: Apple on Android Not Supported**
- ❌ **Current:** Apple button only shows if `isAvailableAsync()` returns true
- ✅ **Behavior:** Android users see only Google + Guest
- 📋 **Status:** Working as designed

**Issue 3: Deep Link Scheme**
- ✅ **Current:** Using `makeRedirectUri({ scheme: "proovra" })`
- ❓ **Question:** What's registered in app.json?
- 📋 **Status:** PHASE 3 (needs verification)

---

## 3. BACKEND AUTH ARCHITECTURE

### 3.1 Auth Endpoints

**File:** `services/api/src/routes/auth.routes.ts`

**Endpoint 1: POST /v1/auth/google**
```typescript
Request:
  - idToken?: string (from provider)
  - id_token?: string (alternate field name)
  - code?: string (auth code, requires exchange)

Flow:
  1. Accept idToken OR exchange code for idToken
  2. Call verifyGoogleIdToken(idToken)
  3. Parse token: { sub, email, provider: "GOOGLE" }
  4. upsertUser() - create or update user in DB
  5. Sign JWT with 30-day expiry
  6. Set cookie if x-web-client: 1 header present
  7. Return { token, user }

Response:
  - 200: { token, user }
  - 400: invalid_code, invalid_id_token
  - 401: invalid_id_token
  - 502: token_exchange_failed, apple_jwks_fetch_failed
```

**Endpoint 2: POST /v1/auth/apple**
```typescript
Request:
  - idToken?: string
  - id_token?: string
  - code?: string

Flow:
  1. Accept idToken OR exchange code for idToken
  2. Call verifyAppleIdToken(idToken)
  3. Parse token: { sub, email, provider: "APPLE" }
  4. upsertUserWithEmailLink() - handle email linking
  5. Sign JWT with 30-day expiry
  6. Set cookie if x-web-client: 1 header present
  7. Return { token, user }

Response:
  - Same as Google endpoint
```

**Endpoint 3: POST /v1/auth/guest**
```typescript
Flow:
  1. createGuestProfile() - generate random guest user
  2. upsertUser() - create user in DB with provider: "GUEST"
  3. ensureGuestIdentity() - create guest identity record
  4. Sign JWT with 30-day expiry
  5. Return { token, user }

Response:
  - 201: { token, user }
```

**Endpoint 4: GET /v1/auth/me**
```typescript
Request:
  - Headers: Authorization: Bearer <JWT>

Flow:
  1. Validate JWT signature
  2. Extract sub (user ID)
  3. Fetch user from DB
  4. Return user object

Response:
  - 200: { user }
  - 401: Invalid/missing token
```

### 3.2 Database Layer

**Prisma Models Used:**

```prisma
model User {
  id          String        @id
  email       String?
  provider    AuthProvider  // GOOGLE, APPLE, GUEST
  createdAt   DateTime
  updatedAt   DateTime
  // ... other fields
}

enum AuthProvider {
  GOOGLE
  APPLE
  GUEST
}
```

**User Creation Flow:**
```
upsertUser(profile: { sub, email, provider }) →
  1. Check if user with sub exists
  2. If yes: update email, return user
  3. If no: create new user with sub as ID
  4. Return user object
```

### 3.3 JWT Generation

**File:** `services/api/src/services/jwt.ts`

**JWT Payload:**
```json
{
  "sub": "user-id-uuid",
  "provider": "GOOGLE|APPLE|GUEST",
  "email": "user@example.com",
  "iat": 1707763200,
  "exp": 1710355200
}
```

**Secret:** `AUTH_JWT_SECRET` environment variable
**Algorithm:** HS256 (HMAC-SHA256)
**Expiry:** 30 days

---

## 4. REDIRECT URIS - CRITICAL VERIFICATION

### 4.1 Web Redirect URIs

**Current Configuration:**

| Provider | URI | Route | Method |
|----------|-----|-------|--------|
| Google | `https://www.proovra.com/auth/callback` | `GET` | Query params |
| Apple | `https://www.proovra.com/auth/callback` | `POST` | Form data |

**Handler:**
- File: `apps/web/app/auth/callback/route.ts`
- Parses POST (Apple) or GET (Google)
- Sets provider param
- Redirects to `/auth/callback/ui`

**Status:** ✅ Correct

### 4.2 Mobile Redirect URIs

**Current Configuration:**

| Platform | Provider | Scheme | Details |
|----------|----------|--------|---------|
| iOS | Google | `proovra://` | Via Expo proxy |
| iOS | Apple | Native | No redirect needed |
| Android | Google | `proovra://` | Via Expo proxy |
| Android | Apple | N/A | Not supported |

**Expo Deep Link Handler:**
- File: `apps/mobile/app/(stack)/auth.tsx`
- Intercepted by: expo-router via app.json config
- Current routing: Handled by `useAuthRequest` hook

**Status:** ⚠️ NEEDS VERIFICATION in app.json

### 4.3 app.json Configuration (NEEDS CHECKING)

**Required for mobile deep links:**
```json
{
  "plugins": ["expo-router"],
  "scheme": "proovra",
  "expo": {
    "ios": {
      "scheme": "proovra"
    },
    "android": {
      "scheme": "proovra"
    }
  }
}
```

**Status:** ❓ UNKNOWN - needs to be verified

---

## 5. API WHITELIST / CORS

**Question:** Does backend validate redirect_uri?

**Current:** Not visible in auth routes
**Assumption:** Validation happens in Google/Apple OAuth libraries

**Status:** ⚠️ PHASE 3 verification needed

---

## 6. SESSION PERSISTENCE

### 6.1 Web Session

**After Login:**
1. Backend sets `proovra_session` cookie (if x-web-client: 1)
2. Frontend stores JWT in memory
3. Redirect to `/home`

**On Next Request:**
- Cookie is automatically sent (httpOnly)
- OR JWT in Authorization header manually

**On Page Reload:**
- Cookie still valid (30 days)
- `useAuth()` hook must restore from API
- Call `/v1/auth/me` to verify session

**Issue:** 
- ❌ No automatic session restoration on page reload
- ⚠️ User gets redirected to login if page refreshed
- 📋 PHASE 5 to fix

### 6.2 Mobile Session

**After Login:**
1. Backend returns JWT token
2. Mobile stores in SecureStore: `await SecureStore.setItemAsync("token", token)`
3. Redirect to `/(tabs)` home screen

**On App Restart:**
1. `useAuth()` hook loads token from SecureStore
2. Automatically restores session
3. No additional /me call needed (token is valid)

**Status:** ✅ Working correctly

---

## 7. AUTHENTICATION CONTEXT

### 7.1 Web: `apps/web/app/providers.tsx`

**How it works:**
```typescript
useAuth() → provides:
  - setToken(token: string)  // Store JWT
  - user: User | null         // Current user
  - isAuthenticated: boolean  // Token exists?
```

**Issue:** 
- ❓ Doesn't persist across page reload
- Need to verify /me endpoint call on mount

### 7.2 Mobile: `apps/mobile/src/auth-context.tsx`

**How it works:**
```typescript
useAuth() → provides:
  - setSession({ token, user, mode })  // Store auth
  - session: { token, user, mode }     // Current session
  - isLoading: boolean
```

**Status:** ✅ Handles SecureStore properly

---

## 8. LOGGING - PHASE 1

### 8.1 Web Evidence Capture

**File:** `apps/web/lib/auth-logger.ts`

**Usage in Dev Console:**
```javascript
// Get all auth logs
window.__authLogs.getLogs()

// Export as markdown
window.__authLogs.getLogsAsMarkdown()

// Copy to clipboard
window.__authLogs.copyToClipboard()

// Enable/disable logging
window.__authLogs.enable()
window.__authLogs.disable()
```

**Events Captured:**
- URL_BUILD: buildGoogleAuthUrl, buildAppleAuthUrl
- GOOGLE_SDK: loaded, initialized, callback_received
- CALLBACK: received, provider_detected, request_start, token_exchange_response, session_validation, success
- TOKEN_EXCHANGE: start, success, error
- ERROR: any errors in flow
- CLEANUP: unmount events

**Status:** ✅ Instrumented login page

---

## 9. KNOWN UNKNOWNS - REQUIRES INVESTIGATION

| Question | Impact | Priority |
|----------|--------|----------|
| Is app.json configured for proovra:// scheme? | Mobile deep link broken if no | CRITICAL |
| Is backend validating redirect_uri against whitelist? | Security + OAuth violations | HIGH |
| Does web session persist on page reload? | UX: user gets logged out on F5 | MEDIUM |
| Is x-web-client header being sent by web client? | Cookie not set if missing | HIGH |
| What's the exact error from "message channel closed"? | Can't fix without logs | HIGH |
| Are Apple/Google console redirect URIs exact match? | OAuth will fail if not | CRITICAL |

---

## SUMMARY

**Web Auth:** ✅ Using direct OAuth URLs + Google SDK
**Mobile Auth:** ✅ Using expo-auth-session + native Apple
**Backend:** ✅ Accepts idToken or code, returns JWT
**Session Web:** ⚠️ Cookie-based but no auto-restore
**Session Mobile:** ✅ SecureStore-based, persists correctly

**Next Steps:**
- PHASE 3: Verify app.json scheme config
- PHASE 3: Screenshot Google/Apple console settings
- PHASE 4: Fix web session persistence
- PHASE 4: Remove static Google state
- PHASE 4: Fix message channel error root cause
