# PHASE 1-2 VERIFICATION CHECKLIST

## PHASE 1: Runtime Logging Infrastructure ✅ COMPLETE

### Files Created:
- [x] `apps/web/lib/auth-logger.ts` - Evidence capture utility
- [x] `apps/web/app/login/page.tsx` - Instrumented with authLogger calls
- [x] `apps/web/app/auth/callback/ui/page.tsx` - Instrumented with authLogger calls

### Evidence Collection Enabled:
```javascript
// In browser dev console, use:
window.__authLogs.getLogsAsMarkdown()  // Get formatted logs
window.__authLogs.copyToClipboard()    // Copy to clipboard
window.__authLogs.getLogs()            // Get raw array
```

### Logs Captured:
- URL_BUILD: When OAuth URLs are generated
- GOOGLE_SDK: When Google SDK loads and initializes
- CALLBACK: When OAuth callback is received
- TOKEN_EXCHANGE: Token exchange requests/responses
- SESSION: /me validation results
- ERROR: Any errors encountered
- CLEANUP: Component unmount events

---

## PHASE 2: Architecture Documentation ✅ COMPLETE

### Files Created:
- [x] `AUTH_ARCHITECTURE.md` - Complete implementation analysis
- [x] `AUTH_DEBUG_PROTOCOL.md` - Test protocol (from PHASE 0)

### Architecture Documented:

**WEB (Custom OAuth):**
- ✅ Google: URL generation → callback (GET) → token exchange → /me validation
- ✅ Apple: URL generation → callback (POST form) → token exchange → /me validation
- ✅ Sessions: Cookie-based (httpOnly) + memory JWT
- ⚠️ Issue: Google uses static state="google" (weak CSRF)
- ⚠️ Issue: Apple form_post creates message channel closure
- ⚠️ Issue: No auto-restore on page reload

**MOBILE (Expo libraries):**
- ✅ Google: via expo-auth-session/google (deep link: proovra://)
- ✅ Apple: via expo-apple-authentication (native iOS only)
- ✅ Sessions: SecureStore-based, persists correctly
- ⚠️ Issue: No cancel/error handling for Google (FIXED in code)
- ❓ Unknown: app.json deep link scheme configuration

**BACKEND:**
- ✅ POST /v1/auth/google → verify JWT → upsert user → return JWT
- ✅ POST /v1/auth/apple → exchange code → verify JWT → upsert user → return JWT
- ✅ POST /v1/auth/guest → create guest user → return JWT
- ✅ GET /v1/auth/me → validate JWT → return user
- ⚠️ Issue: May not validate redirect_uri (needs check)

---

## PHASE 3: Redirect URI Verification - PENDING

### Required Verification:

**Web:**
- [ ] Google Console: Screenshot Authorized Redirect URIs
  - Should show: `https://www.proovra.com/auth/callback`
- [ ] Apple Developer: Screenshot Services ID Web Configuration
  - Should show: `https://www.proovra.com/auth/callback`

**Mobile:**
- [ ] Check `apps/mobile/app.json` for:
  - [ ] `"scheme": "proovra"` at top level
  - [ ] `"plugins": ["expo-router"]`
  - [ ] iOS/Android scheme configs
- [ ] Verify Google Cloud Console:
  - [ ] Screenshot OAuth credentials
  - [ ] Check if OAuth URIs include mobile scheme

**Expected Output:**
- Web callbacks work both locally and on proovra.com
- Mobile deep links intercepted by expo-router
- No CORS or redirect_uri mismatch errors

---

## PHASE 4: Cancel/Success/Error Handling - IN PROGRESS

### Web Google SDK

**Current Status:** Has dual abort flags + 100ms timeout
**Problem:** Timeout-based cleanup is fragile
**Needed:**
- [ ] Remove timeouts
- [ ] Use proper SDK cleanup patterns
- [ ] Verify no message channel errors in console

### Mobile Google

**Current Status:** Already handles dismiss/error/success
**Code Location:** `apps/mobile/app/(stack)/auth.tsx` lines 34-49
```typescript
if (googleResponse.type === "dismiss") { ... }
if (googleResponse.type === "error") { ... }
if (googleResponse.type !== "success") return;
```
**Status:** ✅ LOOKS GOOD, needs testing

### Mobile Apple

**Current Status:** Handles cancel (checks for "User canceled..." message)
**Code Location:** `apps/mobile/app/(stack)/auth.tsx` lines 139-143
```typescript
if (err instanceof Error && err.message === "User canceled the sign-in flow") {
  // Clean return
}
```
**Status:** ✅ LOOKS GOOD, needs testing

### Web Apple

**Current Status:** Just navigates to href
**Problem:** No way to detect if user cancelled at Apple's dialog
**Limitation:** This is expected (form_post model)

---

## PHASE 5: Session Persistence - PENDING

### Web Session Persistence

**Current Problem:**
- ✅ Cookie set correctly (proovra_session, 30 days, httpOnly, secure)
- ❌ But... is cookie domain set correctly for .proovra.com?
- ❌ No automatic restore on page reload

**Needed:**
- [ ] Verify cookie domain includes .proovra.com (cross-domain sharing)
- [ ] Add automatic /me call in useAuth hook on mount
- [ ] Create debug panel showing: isAuthenticated, user, last refresh
- [ ] Test: reload page → should stay logged in

### Mobile Session Persistence

**Current Status:** ✅ SecureStore-based, auto-restores correctly

**Needed:**
- [ ] Add debug panel showing session state
- [ ] Test: restart app → should show user, no login screen

### Auth Debug Panel (Dev Only)

**Needed for PHASE 5:**
```
Web (apps/web/app/login/page.tsx footer):
  - isAuthenticated: true/false
  - userId: <redacted>
  - lastAuthTime: <timestamp>
  - hasCookie: true/false
  - lastMeStatus: 200/401/error

Mobile (apps/mobile/app/(stack)/auth.tsx):
  - Session mode: google/apple/guest
  - Token in SecureStore: yes/no
  - User loaded: yes/no
  - Last refresh: <timestamp>
```

---

## PHASE 6: Test Evidence Matrix - PENDING

### Test Flows Required

**Web Chrome:**
- [ ] Google success: Screenshot → console logs → network tab → redirect to /home
- [ ] Google cancel: Screenshot → no error message → stay on login
- [ ] Apple success: Screenshot → console logs → network tab → redirect to /home  
- [ ] Apple cancel: Screenshot → no error message → stay on login
- [ ] No message channel errors in console

**Web Safari:**
- [ ] Google success: Screenshot + logs
- [ ] Apple success: Screenshot + logs
- [ ] Console clean (no errors)

**iOS Physical Device:**
- [ ] Apple success: Photo + logs → redirected to app
- [ ] Apple cancel: Photo + logs → clean return to login
- [ ] Restart app → session persists, no login screen
- [ ] BUILD_ID visible in footer

**Android Physical Device:**
- [ ] Google success: Photo + logs → redirected to app
- [ ] Google cancel: Photo + logs → clean return to login
- [ ] Restart app → session persists, no login screen
- [ ] BUILD_ID visible in footer

### Evidence Format

For each test, capture:
1. **BuildID:** Show `/health` endpoint or footer showing commit SHA
2. **Console Logs:** Copy from `window.__authLogs.getLogsAsMarkdown()`
3. **Network Tab:** Screenshot showing:
   - Request to https://accounts.google.com/... OR https://appleid.apple.com/...
   - Request to POST /v1/auth/google OR /v1/auth/apple
   - Request to GET /v1/auth/me
   - All should be 2xx status
4. **Screen Recording:** 30-second video showing:
   - Before: Login page
   - Action: Click Google/Apple button
   - After: Signed in state or cancel state
5. **Backend Logs:** If accessible, paste /api logs showing successful auth

---

## DEPLOYMENT STRATEGY

### Current Branch: `fix/auth-regressions`

**Step 1: Ready to Test**
```bash
git push origin fix/auth-regressions
# Deploy to staging environment
# Vercel builds and deploys
# BUILD_ID appears in footer and /health
```

**Step 2: Reproduce Bugs**
- Use checklist above
- Capture evidence for each flow
- Document exact errors

**Step 3: Fix Issues**
- Only fix issues WITH evidence
- Update code with logging disabled for prod
- Re-test with new deploy

**Step 4: Merge to Main**
```bash
git checkout main
git pull origin main
git merge fix/auth-regressions
git push origin main
# Production deploy
```

**Rollback if Needed:**
```bash
git revert <commit-sha>
# Returns to previous working state
```

---

## COMMANDS FOR TESTING

### Verify Build ID is Correct

```bash
# Terminal at repo root:
git rev-parse --short HEAD

# Then visit:
# https://www.proovra.com (check footer)
# https://www.proovra.com/health (check JSON)
# Confirm SHA matches
```

### View Auth Logs in Browser Console

```javascript
// On login page, open DevTools Console
window.__authLogs.getLogsAsMarkdown()

// Copy output to file or share
window.__authLogs.copyToClipboard()
```

### Capture Network Flows

**Chrome DevTools:**
1. Open Network tab
2. Disable cache (if device allows)
3. Click Google/Apple button
4. Wait for all requests to complete
5. Right-click → Save all as HAR (or screenshot)

### Check Backend Logs

**If deploying to staging:**
```bash
# View recent logs
heroku logs -a <app-name> --tail

# Or query if logs endpoint available
curl https://api.proovra.com/logs?limit=50
```

---

## SUCCESS CRITERIA

**PHASE 1 COMPLETE when:**
- ✅ authLogger captures all events
- ✅ Can view logs in browser console
- ✅ All callback events logged with timestamps
- ✅ Errors captured with context

**PHASE 2 COMPLETE when:**
- ✅ AUTH_ARCHITECTURE.md documents all flows
- ✅ All unknowns identified
- ✅ Code comments reference this doc

**PHASE 3 COMPLETE when:**
- ✅ app.json has correct scheme
- ✅ Redirect URIs screenshots provided
- ✅ No CORS or redirect_uri errors in logs

**PHASE 4 COMPLETE when:**
- ✅ Web cancel/success works cleanly
- ✅ Mobile cancel/success works cleanly
- ✅ No message channel errors
- ✅ All flows tested with evidence

**PHASE 5 COMPLETE when:**
- ✅ Session persists after page reload (web)
- ✅ Session persists after app restart (mobile)
- ✅ Debug panel shows session state
- ✅ /me endpoint validates correctly

**PHASE 6 COMPLETE when:**
- ✅ All 12+ flows tested with evidence
- ✅ Screenshots + logs + network captures
- ✅ No regressions found
- ✅ Ready for production merge

---

## NEXT IMMEDIATE STEPS

1. **Push current branch:**
   ```bash
   git push origin fix/auth-regressions
   ```

2. **Wait for Vercel deploy**

3. **Verify BUILD_ID is visible:**
   - Visit login page footer
   - Or check /health endpoint

4. **Test each flow with authLogger:**
   - Google login
   - Apple login
   - Google cancel
   - Console logs captured?

5. **Report findings:**
   - What worked?
   - What failed?
   - Attach evidence (logs, screenshots, network)

