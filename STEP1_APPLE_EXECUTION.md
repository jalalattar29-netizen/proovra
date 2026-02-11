# STEP 1.1: APPLE OAUTH TEST EXECUTION

## Status: READY TO EXECUTE

✅ Configuration validated and fixed
✅ API server running (localhost:8081)
✅ Environment variables cleaned (duplicates removed)

---

## TEST SETUP

### Prerequisites
- API server: http://localhost:8081 ✅
- Health check: `{"ok":true,"db":"down"}` ✅
- Environment: services/api/.env cleaned ✅

### What to Test

#### TC1: Happy Path (Full Flow)
**Objective**: Complete sign-in with Apple OAuth, receive JWT token

**Steps**:
1. Open browser to https://www.proovra.com/login (production) OR http://localhost:3000/login (dev)
2. Click "Sign in with Apple" button
3. Authenticate with valid Apple ID (personal or test account)
4. Approve requested permissions (name, email)
5. **Expected Result**: Redirected to dashboard, JWT token in localStorage

**Verification Points**:
- [ ] Browser redirects to appleid.apple.com/auth/authorize with correct params
- [ ] Apple redirect returns code and id_token to callback
- [ ] /auth/apple/callback/route.ts extracts and passes to /ui
- [ ] /auth/apple/callback/ui/page.tsx validates state (matches sessionStorage)
- [ ] POST /v1/auth/apple succeeds with 200 response
- [ ] Response contains: `{ token, user: { id, email, provider } }`
- [ ] Token stored in localStorage with key "auth-token"
- [ ] Redirected to /dashboard or /home

**What to Capture**:
```
Browser DevTools > Network Tab:
1. Request to appleid.apple.com/auth/authorize
   - Params: response_type=code id_token, response_mode=form_post, client_id, redirect_uri, state
   - Expected: 302 redirect to Apple login

2. Form POST to /auth/apple/callback
   - Form data: code, id_token, state
   - Expected: 307 redirect to /auth/apple/callback/ui?code=...&id_token=...

3. Request to POST /v1/auth/apple
   - Body: { code } or { idToken }
   - Response: { token: "eyJ...", user: { id: "...", email: "..." } }
   - Expected: 200 OK

Browser Console:
- Check for errors or warnings
- Verify localStorage has "auth-token" key
```

---

#### TC2: State Mismatch Detection
**Objective**: Verify CSRF protection rejects mismatched state

**Setup**:
1. Manually modify sessionStorage during callback
2. Change "proovra-apple-state" to different value
3. Complete OAuth flow

**Expected Result**: Error message "OAuth state mismatch"

**Verification**:
- [ ] /auth/apple/callback/ui/page.tsx throws state validation error
- [ ] User sees error toast/message
- [ ] Redirect to /login does NOT occur

---

#### TC3: Missing Token
**Objective**: Verify missing id_token + code is rejected

**Setup**:
1. Simulate Apple redirect without token
2. Call /auth/apple/callback with valid state but no code/id_token

**Expected Result**: Error message "Missing OAuth token"

**Verification**:
- [ ] /auth/apple/callback/ui/page.tsx detects missing token
- [ ] Error message displayed to user

---

#### TC4: Invalid Token
**Objective**: Verify expired/invalid JWT is rejected

**Setup**:
1. Create expired Apple JWT (past exp claim)
2. Send to POST /v1/auth/apple

**Expected Result**: 401 Unauthorized with message "invalid_id_token"

**Verification**:
- [ ] API rejects with 401
- [ ] Error message surfaces in UI

---

## EXECUTION STEPS

### Step 1: Prepare Browser Debugging
```bash
# Open Chrome DevTools
1. Ctrl+Shift+I (Windows) or Cmd+Option+I (Mac)
2. Go to Network tab
3. Clear logs
4. Check "Preserve log" checkbox
```

### Step 2: Set Up Session Storage Spy
```javascript
// Paste in browser console BEFORE clicking "Sign in with Apple"
(function() {
  const original = sessionStorage.setItem;
  sessionStorage.setItem = function(key, value) {
    console.log(`[sessionStorage.setItem] ${key} = ${value.substring(0, 50)}...`);
    return original.call(this, key, value);
  };
})();
```

### Step 3: Execute TC1 (Happy Path)

**If using production (www.proovra.com):**
```
1. Open https://www.proovra.com/login
2. Click "Sign in with Apple"
3. Use personal Apple ID or test account
4. Approve permissions
```

**If using local dev (localhost:3000):**
```
First, start web dev server in another terminal:
cd apps/web
npm run dev

Then:
1. Open http://localhost:3000/login
2. Click "Sign in with Apple"
3. Follow Apple auth flow
```

### Step 4: Capture Results

**Network Tab Analysis**:
```
Expected requests in order:

1. POST https://appleid.apple.com/auth/authorize
   Status: 302 (redirect to Apple login page)
   
2. POST http://localhost:8081/v1/auth/apple (or https://api.proovra.com/v1/auth/apple)
   Request Body:
   {
     "code": "..." OR
     "idToken": "eyJ0eXAiOiJKV1QiLCJhbGc..."
   }
   Response: 200
   {
     "token": "eyJ0eXAiOiJKV1QiLCJhbGc...",
     "user": {
       "id": "uuid",
       "email": "user@example.com",
       "provider": "APPLE",
       "displayName": "User Name"
     }
   }

3. GET /dashboard or /home (redirect after login)
   Status: 200
```

**Console Log Analysis**:
```
Expected logs:
✓ [sessionStorage.setItem] proovra-apple-state = <uuid>
✓ [sessionStorage.setItem] auth-token = eyJ0eXAi...
✓ No errors about state mismatch or missing tokens
```

**localStorage Verification**:
```javascript
// Paste in console after successful login
console.log('auth-token:', localStorage.getItem('auth-token'));
console.log('user-id:', localStorage.getItem('user-id'));
```

---

## EXPECTED BEHAVIOR BY FILE

### apps/web/lib/oauth.ts → buildAppleAuthUrl()
✅ Should generate:
```
https://appleid.apple.com/auth/authorize?
  response_type=code%20id_token
  &response_mode=form_post
  &client_id=com.proovra.web
  &redirect_uri=https://www.proovra.com/auth/callback (or http://localhost:3000/auth/callback)
  &scope=name%20email
  &state=<uuid>
```

### apps/web/app/auth/apple/callback/route.ts
✅ Should:
1. Receive POST with form data: code, id_token, state
2. Extract all three values
3. Redirect to `/auth/apple/callback/ui?code=...&id_token=...&state=...&provider=apple`

### apps/web/app/auth/apple/callback/ui/page.tsx
✅ Should:
1. Parse URL search params
2. Validate state against sessionStorage("proovra-apple-state")
3. Infer provider from id_token issuer (should be "apple")
4. POST to `/v1/auth/apple` with body: `{ idToken: "<jwt>" }` or `{ code: "<code>" }`
5. Receive response with token + user
6. Save token to localStorage("auth-token")
7. Redirect to /dashboard

### services/api/src/routes/auth.routes.ts → POST /v1/auth/apple
✅ Should:
1. Parse AppleBody (validates idToken, id_token, or code)
2. If code provided, call exchangeAppleCodeForIdToken() to get id_token
3. Call verifyAppleIdToken(idToken) to validate JWT
4. Call upsertUserWithEmailLink(profile) to create/get user in Prisma
5. Generate 30-day JWT: `signJwt({ sub: user.id, provider, email }, jwtSecret, 2592000)`
6. Set web cookie via maybeSetWebCookie()
7. Return 200 with `{ token, user }`

### services/api/src/services/auth.service.ts → verifyAppleIdToken()
✅ Should:
1. Fetch JWKS from https://appleid.apple.com/auth/keys (with cache)
2. Parse JWT header to get kid
3. Find matching key in JWKS array
4. Verify ES256 signature
5. Validate claims: aud == APPLE_CLIENT_ID, iss == "https://appleid.apple.com", exp > now
6. Return AuthProfile with provider=APPLE, providerUserId, email, displayName

---

## FAILURE SCENARIOS TO DOCUMENT

If TC1 fails, systematically test these:

### F1: "OAuth state mismatch"
- **Cause**: Session storage state doesn't match
- **Fix**: Clear sessionStorage, retry
- **Code Location**: apps/web/app/auth/apple/callback/ui/page.tsx:44-47

### F2: "Missing OAuth token"
- **Cause**: No code or id_token in response
- **Possible Reason**: Apple didn't return token (scopes issue, app config)
- **Code Location**: apps/web/app/auth/apple/callback/ui/page.tsx:66-69

### F3: "invalid_id_token" (400 from API)
- **Cause**: Token validation failed at API
- **Check**:
  - [ ] Token signature valid? (JWKS fetch working?)
  - [ ] Audience (aud claim) matches APPLE_CLIENT_ID=com.proovra.web?
  - [ ] Issuer (iss claim) equals "https://appleid.apple.com"?
  - [ ] Token not expired?
- **Code Location**: services/api/src/services/auth.service.ts:137-173

### F4: "apple_jwks_fetch_failed" (502 from API)
- **Cause**: Can't fetch Apple JWKS
- **Check**: `curl https://appleid.apple.com/auth/keys`
- **Fix**: Network connectivity issue

### F5: 500 error (Prisma upsertUserWithEmailLink fails)
- **Cause**: Database error
- **Expected**: DB is "down" in dev (MinIO needed)
- **Fix**: Not critical for this phase

---

## COMMIT CRITERIA: APPLE OAUTH "DONE"

To mark Apple OAuth as DONE, all of these must pass:
- ✅ TC1 successfully completes end-to-end
- ✅ State validation prevents CSRF (TC2 shows error)
- ✅ Missing token error surfaces (TC3 shows error)
- ✅ Invalid token rejected by API (TC4 shows 401)
- ✅ Network trace shows correct endpoints
- ✅ JWT token stored in localStorage
- ✅ No console errors
- ✅ Documentation screenshot proof

---

## NEXT PHASE: UPLOAD PIPELINE

After Apple OAuth confirmed DONE:
1. Test POST /v1/evidence → presigned PUT URL
2. Test PUT <presigned_url> with file binary
3. Test POST /v1/evidence/:id/complete → report generation
4. Verify Prisma Evidence record fields populated

