# TESTING GUIDE - PHASE 1-4 VERIFICATION

**Date:** 2026-02-12  
**Branch:** `fix/auth-regressions`  
**Commits:** 
- Phase 0: 13c4cfa (BUILD_ID infrastructure)
- Phase 1-2: 060537e (Logging + Architecture)
- Phase 3-4: e11f211 (Cookie domain fix + Preparation)

---

## DEPLOYMENT INSTRUCTIONS

### Step 1: Push Branch to GitHub

```bash
cd d:\digital-witness
git push origin fix/auth-regressions
```

**Expected:** Vercel will automatically deploy to staging environment

### Step 2: Verify Deployment

**Wait 2-3 minutes for Vercel build to complete, then:**

```bash
# Check BUILD_ID in footer (dev mode only)
https://www.proovra.com/login
# Look for blue box at bottom with: "Build: <SHA>, Env: production"

# Check health endpoint
https://www.proovra.com/health
# Should return JSON with buildTime, commitSha, environment, vercelEnv
```

**Expected Response:**
```json
{
  "status": "ok",
  "timestamp": "2026-02-12T...",
  "build": {
    "buildTime": "2026-02-12T...",
    "commitSha": "e11f211",
    "environment": "production",
    "vercelEnv": "production"
  },
  "environment": {
    "nodeEnv": "production",
    "vercelEnv": "production",
    "vercelUrl": "..."
  }
}
```

---

## WEB TESTING - GOOGLE OAUTH

### Test: Google Sign-In Success

**Prerequisites:**
- Browser: Chrome
- URL: https://www.proovra.com/login
- Note the BUILD_ID in footer

**Steps:**
1. Open DevTools (F12)
2. Go to Console tab
3. Go to Network tab (disable cache if possible)
4. Click "Continue with Google"
5. Google picker opens → select account
6. Should redirect to /home

**Evidence to Capture:**

**Console Logs:**
```javascript
// In DevTools Console, run:
window.__authLogs.getLogsAsMarkdown()

// Copy output and save to auth-google-success-web.md
// Should include:
// - URL_BUILD: Google OAuth URL created
// - CALLBACK: Received auth code
// - TOKEN_EXCHANGE: POST /v1/auth/google succeeded
// - SESSION: /me validation successful
// - LOGIN: success, redirectTo=/home
```

**Network Tab:**
```
1. GET https://accounts.google.com/o/oauth2/v2/auth?...
   (Google OAuth dialog)

2. GET https://www.proovra.com/auth/callback?code=...&state=google
   (Callback from Google)

3. POST https://api.proovra.com/v1/auth/google
   Status: 200
   Response: { token: "...", user: { id: "...", email: "..." } }

4. GET https://api.proovra.com/v1/auth/me
   Status: 200
   Response: { user: { id: "...", email: "..." } }

5. GET https://www.proovra.com/home
   (Final redirect)
```

**Cookie Check:**
```
DevTools → Application → Cookies → www.proovra.com
Look for: proovra_session
- Domain: .proovra.com (cross-subdomain)
- Path: /
- Secure: ✓
- HttpOnly: ✓
- SameSite: Lax
- Expires: ~30 days
```

**Screenshot Required:**
- Before: Login page with BUILD_ID visible
- After: Redirected to home/dashboard (logged in)
- DevTools: Network tab showing successful requests
- DevTools: Cookie showing domain=.proovra.com

---

### Test: Google Sign-In Cancel

**Steps:**
1. Click "Continue with Google"
2. Google picker appears
3. Click "Cancel" or close dialog
4. Should return to login page (no error shown)

**Evidence:**
```javascript
window.__authLogs.getLogsAsMarkdown()
// Should show: GOOGLE_SDK callback_ignored (not success/error)
```

**Check:** No error message displayed on login page

---

## WEB TESTING - APPLE OAUTH

### Test: Apple Sign-In Success

**Prerequisites:**
- Browser: Safari (Apple redirects may be restricted in Chrome)
- URL: https://www.proovra.com/login
- Apple ID account ready

**Steps:**
1. Open DevTools (Cmd+Opt+I on Mac)
2. Click "Sign in with Apple"
3. Apple redirects to apple.com signin
4. Sign in with Apple ID
5. Should redirect to /home

**Evidence to Capture:**

**Console Logs:**
```javascript
window.__authLogs.getLogsAsMarkdown()
// Should include:
// - URL_BUILD: Apple OAuth URL with form_post mode
// - CALLBACK: POST form received
// - TOKEN_EXCHANGE: POST /v1/auth/apple succeeded
// - SESSION: /me validation successful
```

**Network Tab:**
```
1. POST https://appleid.apple.com/auth/authorize (form submission)
2. POST https://www.proovra.com/auth/callback (Apple's form_post)
3. POST https://api.proovra.com/v1/auth/apple
   Status: 200
4. GET https://api.proovra.com/v1/auth/me
   Status: 200
5. GET https://www.proovra.com/home
```

**Important:** Watch for message channel error in console:
```
❌ BAD: "A listener indicated an asynchronous response by returning true, 
        but the message channel closed"
✅ GOOD: No message channel error
```

**Screenshot Required:**
- Before: Apple button on login
- After: Redirected to home (logged in)
- DevTools: Network showing successful requests
- DevTools: Console showing NO message channel errors

---

### Test: Apple Sign-In Cancel

**Steps:**
1. Click "Sign in with Apple"
2. Redirected to apple.com
3. Click "Cancel" or close without authenticating
4. Should return to login page cleanly

**Evidence:**
```javascript
window.__authLogs.getLogsAsMarkdown()
// Should show cancel event (or nothing if Apple doesn't report it)
```

**Check:** No error message on login page

---

## MOBILE TESTING - GOOGLE (Android)

### Test: Google Sign-In Success

**Prerequisites:**
- Physical Android device or Android emulator
- Build: EAS build or local `expo run:android`
- App version: Matches BUILD_ID

**Steps:**
1. Open app
2. Navigate to Auth screen
3. Click "Continue with Google"
4. Google picker appears
5. Select Google account
6. Should redirect to app home screen

**Evidence:**

**Console Logs:**
```
Android Studio Logcat or `expo logs`:
Filter: [Mobile Auth]

Look for:
[Mobile Auth] Starting Google token exchange...
[Mobile Auth] Got session token, fetching user...
[Mobile Auth] Google sign-in success, navigating...
```

**Session Check:**
```
After successful sign-in:
- App shows user's email/name
- Navigated to home/(tabs) screen
- Session persists (don't kill app)
```

**App Restart Test:**
```
1. Kill app completely
2. Reopen app
3. Should show home screen (NOT login screen)
4. Session restored from SecureStore
```

**Screenshot Required:**
- Before: Login screen with "Continue with Google" button
- During: Google picker showing
- After: App home screen showing logged-in user
- Restart: Home screen still showing (session persisted)

---

### Test: Google Sign-In Cancel

**Steps:**
1. Click "Continue with Google"
2. Picker appears
3. Click "Cancel" or tap back
4. Should return to login screen (no error)

**Check:** 
- No error message
- Can click Google button again
- Status text clears

---

## MOBILE TESTING - APPLE (iOS)

### Test: Apple Sign-In Success

**Prerequisites:**
- Physical iOS device or iPhone simulator (requires macOS)
- Build: EAS build or local `expo run:ios`
- Apple ID configured on device

**Steps:**
1. Open app
2. Navigate to Auth screen
3. Click "Continue with Apple"
4. Native Apple sign-in dialog appears
5. Authenticate with Face ID / Touch ID / password
6. Should redirect to app home screen

**Evidence:**

**Console Logs:**
```
Xcode Console or `expo logs`:
Filter: [Mobile Auth]

Look for:
[Mobile Auth] Starting Apple sign-in...
[Mobile Auth] Apple sign-in completed, got identity token
[Mobile Auth] Exchanging Apple identity token...
[Mobile Auth] Got session token, fetching user...
[Mobile Auth] Apple sign-in success, navigating...
```

**Session Check:**
- App shows user's name (if provided by Apple)
- Navigated to home/(tabs) screen
- Session persists

**App Restart Test:**
```
1. Force quit app
2. Reopen app
3. Should show home screen (NOT login screen)
4. Session restored from SecureStore
```

**Screenshot Required:**
- Before: Login screen with "Continue with Apple" button
- During: Native Apple dialog
- After: App home screen (logged in)
- Restart: Home screen (session persisted)

---

### Test: Apple Sign-In Cancel

**Steps:**
1. Click "Continue with Apple"
2. Native dialog appears
3. Tap "Cancel"
4. Should return to login screen cleanly

**Check:**
- No error message
- Status text clears
- Can try again

---

## DATA COLLECTION TEMPLATE

For each test, fill in this template:

```markdown
## Test: [FLOW] on [PLATFORM]

**Build ID:** [Copy from footer or /health]
**Date/Time:** [When tested]
**Tester:** [Name]

### Result
- [ ] SUCCESS
- [ ] FAILED
- [ ] PARTIAL (description)

### Console Logs
\`\`\`javascript
// Paste: window.__authLogs.getLogsAsMarkdown()
\`\`\`

### Network Requests
```
[Paste key requests from Network tab]
1. OAuth provider (GET/POST)
2. /v1/auth/[provider]
3. /v1/auth/me
4. Final redirect
```

### Issues Found
- [Any errors or unexpected behavior]
- [Screenshots URLs if hosting externally]

### Evidence Files
- auth-[flow]-[platform]-logs.md (authLogger output)
- auth-[flow]-[platform]-network.har (or screenshot)
- auth-[flow]-[platform]-cookies.png (if applicable)
- auth-[flow]-[platform]-video.mp4 (if recording)
```

---

## EXPECTED SUCCESS CRITERIA

✅ **All tests PASS if:**

**Web Chrome:**
- ✅ Google success → /home redirected, no errors
- ✅ Google cancel → return to login, no error shown
- ✅ Apple success → /home redirected, no message channel error
- ✅ Apple cancel → return to login, clean
- ✅ Page reload → session persists (cookie works)

**Web Safari:**
- ✅ Google success → /home redirected
- ✅ Apple success → /home redirected
- ✅ No message channel errors in console

**Mobile Android:**
- ✅ Google success → home screen, session persists after restart
- ✅ Google cancel → clean return to login
- ✅ BUILD_ID visible in footer (dev build)

**Mobile iOS:**
- ✅ Apple success → home screen, session persists after restart
- ✅ Google success → home screen, session persists after restart  
- ✅ Both cancel → clean return to login
- ✅ BUILD_ID visible in footer (dev build)

---

## FAILURE TRIAGE

**If test fails, check:**

1. **Google console redirect URI mismatch:**
   ```
   Error: "redirect_uri_mismatch" in logs
   → Check Google Cloud Console → OAuth credentials
   → Verify: https://www.proovra.com/auth/callback is listed
   ```

2. **Apple console redirect URI mismatch:**
   ```
   Error: "invalid_redirect_uri" or hang
   → Check Apple Developer → Services ID → Web Configuration
   → Verify: https://www.proovra.com/auth/callback matches exactly
   ```

3. **Mobile deep link not intercepted:**
   ```
   Android: proovra:// scheme not working
   → Check app.json: "scheme": "proovra" present?
   → Check expo-router configured?
   → Build might need rebuild for scheme to register
   ```

4. **Message channel error on web:**
   ```
   Error during Apple sign-in console
   → Check authLogger: did Google callback fire after cleanup?
   → This is PHASE 4 investigation item
   ```

5. **Session not persisting:**
   ```
   Reload page → back to login
   → Check cookie: proovra_session domain should be .proovra.com
   → Check if x-web-client:1 header sent with auth request
   → May need to call /v1/auth/me on page load to restore
   ```

---

## QUICK REFERENCE URLS

**Web:**
```
Dev: http://localhost:3000/login
Staging: https://www.proovra.com/login
Health: https://www.proovra.com/health
API: https://api.proovra.com (or localhost:8081)
```

**Mobile:**
```
Expo Go: Open "proovra" app
EAS Build: Download from TestFlight (iOS) or Play Store (Android)
```

---

## NEXT PHASE AFTER TESTING

**If ALL tests pass:**
1. Merge fix/auth-regressions → main
2. Deploy to production
3. Monitor production logs for errors

**If ANY test fails:**
1. Document issue with evidence
2. Create fix in Phase 4 proper
3. Re-test before merge

---

