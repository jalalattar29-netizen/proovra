# AUTH REGRESSION DEBUG PROTOCOL

**Branch:** `fix/auth-regressions`
**Baseline Commit:** `13c4cfa` (BUILD_ID added)
**Previous Work:** `415b54e` (Initial fixes)

## CURRENT STATUS

### ✅ PHASE 0 COMPLETE
- BUILD_ID infrastructure added
- Login footer shows build info (dev mode)
- `/health` endpoint available for verification
- Branch created for controlled testing

### 🔄 PHASE 1-6 PENDING
Before merging, must complete:
1. Reproduce each bug with evidence
2. Document actual auth architecture
3. Fix redirect URIs correctly
4. Fix cancel/success/error handling
5. Verify session persistence
6. Create test evidence matrix

## ROOT CAUSES (From Previous Analysis)

### Apple Sign-In
- **Issue:** Never completes, message channel error
- **Cause:** Unresolved promises from Google SDK when Apple redirects
- **Fix Applied:** Dual abort flags + timeout in web Google SDK cleanup
- **Status:** NOT VERIFIED ON REAL DEVICE

### Google Sign-In (Mobile)
- **Issue:** Picker opens, user selects/cancels, nothing happens
- **Cause:** Not handling `dismiss` and `error` response types
- **Fix Applied:** Early return for cancel/error states
- **Status:** NOT VERIFIED ON REAL DEVICE

### Google Sign-In (Web)
- **Issue:** Message channel error after navigation
- **Cause:** SDK callbacks firing after page unmounts
- **Fix Applied:** Dual abort flags + timeout
- **Status:** NOT VERIFIED ON WEB

## VERIFICATION NEEDED

### Test Matrix (MUST COMPLETE BEFORE MERGE)

```
Platform | Flow | Environment | Status | Evidence
---------|------|-------------|--------|----------
iOS      | Apple success | Physical device | PENDING | screenshots + logs
iOS      | Apple cancel | Physical device | PENDING | screenshots + logs
iOS      | Persistence after restart | Physical device | PENDING | screenshots
Android  | Google success | Physical device | PENDING | screenshots + logs
Android  | Google cancel | Physical device | PENDING | screenshots + logs
Android  | Persistence after restart | Physical device | PENDING | screenshots
Web      | Apple success | Chrome | PENDING | console logs + network tab
Web      | Google success | Chrome | PENDING | console logs + network tab
Web      | Google cancel | Safari | PENDING | console logs
Web      | No message channel error | All browsers | PENDING | console clean
```

### Required Evidence for Each Test

- ✅ Build info (from footer or /health) confirming deployed version
- ✅ Browser/mobile console logs (no uncaught errors)
- ✅ Network tab showing callback URL and token exchange
- ✅ Backend logs showing auth endpoint called with requestId
- ✅ Session persists (token stored, /me returns user)
- ✅ UI state correct (authenticated user shown, redirected to app)

## ARCHITECTURE TO DOCUMENT

**Web:**
- [ ] Which OAuth library/approach?
- [ ] Callback route used?
- [ ] Session storage (cookie, localStorage)?
- [ ] Current redirect URIs at runtime (log them)

**Mobile:**
- [ ] Which OAuth library?
- [ ] Callback/deep link handler?
- [ ] Session storage (SecureStore)?
- [ ] Current redirectUri values (log them - dev vs prod)

**Backend:**
- [ ] Auth endpoints: /v1/auth/google, /v1/auth/apple, /v1/auth/guest
- [ ] Token exchange flow?
- [ ] Session validation (/v1/auth/me)?

## CONSOLE CONFIGURATIONS TO VERIFY

**Google Cloud Console:**
- [ ] Screenshot: OAuth Client → Authorized Redirect URIs
  - Should include: https://www.proovra.com/auth/callback
  - AND: proovra:// scheme for mobile (if applicable)

**Apple Developer Console:**
- [ ] Screenshot: Services ID → Web Authentication Configuration
  - Redirect URI should match exactly
  - Domains should be listed

## FILES CHANGED (THIS BRANCH)

```
apps/web/lib/build-info.ts          (NEW) - Build metadata utility
apps/web/app/health/route.ts        (NEW) - Health check endpoint
apps/web/app/login/page.tsx         (MODIFIED) - Added BUILD_ID to footer
apps/mobile/app/(stack)/auth.tsx    (MODIFIED) - Google cancel handling + Apple logging
apps/web/app/login/page.tsx         (MODIFIED) - Dual abort flags for Google SDK
```

## NEXT STEPS

1. **BEFORE testing on real devices:**
   - Deploy current branch to staging/production
   - Verify BUILD_ID shows correct commit
   - Check `/health` endpoint accessible

2. **Test on iOS physical device:**
   - Apple sign-in → success → redirect to app
   - Apple cancel → cleanly return to login
   - Restart app → session persists

3. **Test on Android physical device:**
   - Google sign-in → success → redirect to app
   - Google cancel → cleanly return to login
   - Restart app → session persists

4. **Test on web (Chrome + Safari):**
   - Both providers work
   - Console shows NO message channel errors
   - Network tab shows clean token exchange

5. **Capture evidence:**
   - Screenshots of Build IDs
   - Console logs
   - Network requests
   - /me responses (redacted)

6. **Only then:**
   - Create PR with evidence
   - Merge to main
   - Full rollback instructions documented

## ROLLBACK INSTRUCTION

If any regression found after merge:
```bash
git revert 415b54e --no-edit    # Revert initial fixes if needed
git revert 13c4cfa --no-edit    # Revert BUILD_ID if needed
# Or full reset:
git reset --hard 690dab3        # Back to working state before fixes
```

