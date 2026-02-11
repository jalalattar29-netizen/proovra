# PHASE 2 — APPLE OAUTH TEST REPORT

## Test Execution Date: 2026-02-11

### STEP 1.1: REPRODUCE APPLE LOGIN FAILURE

**Objective**: Test Apple OAuth flow end-to-end and capture exact failure points with requestId.

---

## TEST CONFIGURATION

| Setting | Value | Source |
|---------|-------|--------|
| APPLE_CLIENT_ID | `com.proovra.web` | .env |
| APPLE_REDIRECT_URI | `https://www.proovra.com/auth/callback` | .env (canonical) |
| APPLE_TEAM_ID | `4LCZK75N86` | .env |
| APPLE_KEY_ID | `9DPTW34UXN` | .env |
| API_BASE | `http://localhost:8081` (DEV) / `https://api.proovra.com` (PROD) | .env |
| Apple Auth Endpoint | `https://appleid.apple.com/auth/authorize` | Apple official |
| Response Type | `code id_token` | buildAppleAuthUrl() |
| Response Mode | `form_post` | buildAppleAuthUrl() |

---

## FLOW DIAGRAM

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. USER CLICKS "SIGN IN WITH APPLE"                            │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. GENERATE STATE + NONCE                                       │
│    - state: random UUID                                         │
│    - Session storage: proovra-apple-state                      │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ 3. REDIRECT TO APPLE                                            │
│    buildAppleAuthUrl({state: UUID, scope: "name email"})        │
│    → https://appleid.apple.com/auth/authorize?...              │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ 4. USER AUTHENTICATES WITH APPLE                               │
│    (Browser redirects to Apple's servers)                       │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ 5. APPLE REDIRECTS BACK TO WEB                                 │
│    POST to /auth/apple/callback/route.ts                       │
│    Form data: {code, id_token, state}                          │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ 6. CALLBACK ROUTE REDIRECTS TO UI                              │
│    /auth/apple/callback/route.ts → /auth/apple/callback/ui     │
│    Search params: {code, id_token, state, provider=apple}      │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ 7. UI PAGE PROCESSES TOKEN                                     │
│    /auth/apple/callback/ui/page.tsx useEffect()               │
│    - Verify state matches sessionStorage                       │
│    - Extract id_token or code                                  │
│    - Call /v1/auth/apple API endpoint                          │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ 8. API EXCHANGE TOKEN FOR SESSION                              │
│    POST /v1/auth/apple {idToken OR code}                       │
│    auth.routes.ts handler:                                      │
│    - exchangeAppleCodeForIdToken() if code                     │
│    - verifyAppleIdToken() → JWKS validation                    │
│    - upsertUserWithEmailLink() → Create/update user            │
│    - signJwt() → Return session token                          │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ 9. UI STORES TOKEN + REDIRECTS                                 │
│    - setToken(response.token) → Auth context                   │
│    - router.replace("/home") or stored return URL              │
└─────────────────────────────────────────────────────────────────┘
```

---

## CRITICAL VERIFICATION POINTS

### VP1: State/Nonce Anti-CSRF
- [ ] `sessionStorage.setItem("proovra-apple-state", uuid)` at click
- [ ] Retrieved state matches URL param on callback
- [ ] Error if mismatch

### VP2: Redirect URI Matching
- [ ] buildAppleAuthUrl() uses exact: `https://www.proovra.com/auth/callback`
- [ ] Apple config registered: `https://www.proovra.com/auth/callback`
- [ ] `/auth/apple/callback/route.ts` receives POST form data
- [ ] Mismatch → Apple rejects with "invalid_request"

### VP3: Client ID Exactness
- [ ] buildAppleAuthUrl() sends: `client_id=com.proovra.web`
- [ ] Apple config: `com.proovra.web`
- [ ] Mismatch → Apple rejects

### VP4: Token Validation
- [ ] verifyAppleIdToken():
  - [ ] Fetch JWKS from `https://appleid.apple.com/auth/keys`
  - [ ] Find key by header.kid
  - [ ] Verify JWT signature with ES256
  - [ ] Check aud == APPLE_CLIENT_ID
  - [ ] Check iss == "https://appleid.apple.com"
  - [ ] Check exp > now (clock skew: ±30 sec typical)

### VP5: User Creation
- [ ] upsertUserWithEmailLink():
  - [ ] Extract sub (provider user ID)
  - [ ] Extract email
  - [ ] Create User + Auth record in Prisma
  - [ ] Return token with user.id

---

## TEST CASES

### TC1: Happy Path (DEV)
**Preconditions:**
- API running on http://localhost:8081
- Web app accessible (Vercel or local)
- Valid test Apple ID account

**Steps:**
1. Open web app → Login/Register page
2. Click "Sign in with Apple"
3. Authenticate with test Apple ID
4. Observe redirect flow
5. Verify landing on /home

**Expected:**
- ✅ Bearer token in localStorage (or cookie)
- ✅ User listed in Prisma User table
- ✅ Auth.provider == "APPLE"

---

### TC2: Redirect URI Mismatch (NEGATIVE)
**Test:** Apple configured with `https://app.proovra.com/auth/callback`, but web sends `https://www.proovra.com/auth/callback`

**Expected Error:**
```
400 invalid_request
redirect_uri does not match configured
```

**Capture:**
- Browser network tab: POST /auth/apple/callback (if reached)
- Console: "Sign-in failed" message
- requestId: Check API logs

---

### TC3: Code Exchange Failure
**Test:** exchangeAppleCodeForIdToken() called with invalid code

**Expected Error:**
```json
{
  "code": "502",
  "message": "token_exchange_failed"
}
```

**Capture:**
- Network tab: POST /v1/auth/apple
- Response body
- API logs with error details

---

### TC4: ID Token Expired
**Test:** Submit id_token with exp < now

**Expected Error:**
```json
{
  "code": "401",
  "message": "invalid_id_token"
}
```

---

## RESULTS CAPTURE TEMPLATE

### Test Execution: [DATE/TIME]

**Test Case:** [TC1/TC2/TC3/TC4]

**Status:** ✅ PASS / ❌ FAIL

#### Browser Console
```
[Paste console output]
```

#### Network Request (POST /v1/auth/apple)
```
Headers:
- Content-Type: application/json
- Authorization: [if any]

Request Body:
{
  "idToken": "[jwt]" OR "code": "[authcode]"
}

Response Status: [200/400/401/502]
Response Body:
{
  "token": "[session_jwt]",
  "user": {
    "id": "[uuid]",
    "email": "[email]",
    "provider": "APPLE"
  }
}
```

#### Server Logs (requestId + Error Stack)
```
[Paste API server logs]
```

#### Prisma Verification
```sql
SELECT id, email, provider, created_at FROM "user" ORDER BY created_at DESC LIMIT 1;
```

---

## KNOWN ISSUES / BLOCKERS

| Issue | Status | Impact |
|-------|--------|--------|
| Duplicate APPLE_REDIRECT_URI in .env | ⚠️ MINOR | Two entries (only first used) |
| Response mode "form_post" vs "query" | ⚠️ CHECK | Apple sends via POST (correct) |
| Clock skew tolerance not documented | ⚠️ CHECK | Default ±30sec acceptable? |

---

## NEXT STEPS

1. **If TC1 PASS:** 
   - Document successful flow
   - Move to STEP 1.2 (end-to-end config verification)

2. **If TC1 FAIL:**
   - Capture exact error from TC2-TC4
   - Trace which parameter mismatch
   - Fix in code + re-test

3. **After all TCs PASS:**
   - Create proof document (STEP 1.3)
   - Start STEP 2 (Upload pipeline)

