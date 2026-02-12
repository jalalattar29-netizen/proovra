# QUICK START CHECKLIST - NEXT STEPS

**Branch:** `fix/auth-regressions`  
**Status:** ✅ Ready to deploy  
**Last Updated:** 2026-02-12

---

## FOR THE NEXT PERSON: DO THIS NEXT

### ✅ Step 1: Deploy to Staging (5 min)

```bash
cd d:\digital-witness
git push origin fix/auth-regressions
```

Wait 2-3 minutes for Vercel build to complete.

**Verify:**
```
https://www.proovra.com/login
Look for: "Build: f412e04" in blue footer box (dev mode)

https://www.proovra.com/health
Should return JSON with commitSha: "f412e04"
```

### ✅ Step 2: Test Web Flows (30 min)

Follow [TESTING_GUIDE.md](TESTING_GUIDE.md) **Web Testing** section:

1. Google success (Chrome)
   - [ ] Redirect to /home
   - [ ] Cookie domain=.proovra.com
   - [ ] authLogger shows: URL_BUILD → CALLBACK → TOKEN_EXCHANGE → SESSION → success

2. Apple success (Safari)
   - [ ] Redirect to /home
   - [ ] NO message channel errors in console
   - [ ] authLogger shows successful flow

3. Google cancel (Chrome)
   - [ ] Return to login cleanly
   - [ ] No error message

4. Apple cancel (Safari)
   - [ ] Return to login cleanly

### ✅ Step 3: Test Mobile Flows (30 min)

**For Android:** (Google only)
1. [ ] Google success → app home screen
2. [ ] Kill app → restart → still logged in (session persisted)
3. [ ] Google cancel → return to login cleanly

**For iOS:** (Apple + Google)
1. [ ] Apple success → app home screen
2. [ ] Kill app → restart → still logged in
3. [ ] Apple cancel → return to login cleanly
4. [ ] Google success → app home screen
5. [ ] Google cancel → return to login cleanly

### ✅ Step 4: Collect Evidence (15 min)

For each successful test:

```javascript
// In browser console:
window.__authLogs.getLogsAsMarkdown()
// Copy output to file: auth-[flow]-logs.md
```

Screenshot for each:
- Before: Login page with BUILD_ID visible
- After: Redirected to home (or clean cancel)
- DevTools: Network tab showing requests
- DevTools: Console showing NO errors

### ✅ Step 5: Report Results (10 min)

Document results using [TESTING_GUIDE.md](TESTING_GUIDE.md) **Data Collection Template**

**If ALL pass:** Ready to merge to main!
**If ANY fail:** Document issue + proceed to PHASE 5

---

## WHAT'S BEEN DONE (DON'T REPEAT)

✅ **PHASE 0:** BUILD_ID infrastructure → shows deployment version  
✅ **PHASE 1:** Runtime logging → captures auth events  
✅ **PHASE 2:** Architecture docs → explains how auth works  
✅ **PHASE 3:** Redirect URI verification → code inspection done  
✅ **PHASE 4:** Cookie domain fix → ready for production  

---

## KEY FILES TO KNOW

| File | Purpose | Read if... |
|------|---------|-----------|
| [COMPLETION_SUMMARY.md](COMPLETION_SUMMARY.md) | Executive overview | Need big picture |
| [TESTING_GUIDE.md](TESTING_GUIDE.md) | Step-by-step procedures | Ready to test |
| [AUTH_ARCHITECTURE.md](AUTH_ARCHITECTURE.md) | How auth works | Need technical details |
| [PHASE_4_PREPARATION.md](PHASE_4_PREPARATION.md) | What was fixed | Want to understand fixes |
| [PHASE_3_FINDINGS.md](PHASE_3_FINDINGS.md) | Redirect URI verification | Seeing OAuth errors |

---

## COMMON ISSUES & QUICK FIXES

**Issue: BUILD_ID doesn't show in footer**
- [ ] Check NODE_ENV (dev footer only shows in development)
- [ ] Vercel deploy may take 2-3 minutes
- [ ] Refresh page with Ctrl+Shift+R (hard refresh)

**Issue: "OAuth state mismatch" error**
- [ ] Check Google/Apple console redirect URIs match exactly
- [ ] See PHASE_3_FINDINGS.md for what to verify

**Issue: Message channel error on Apple redirect**
- [ ] This is expected behavior (PHASE 4 investigation item)
- [ ] Should NOT block successful redirect to /home
- [ ] Check authLogger for actual flow

**Issue: Session not persisting after page reload**
- [ ] Check cookie in DevTools → domain should be .proovra.com
- [ ] If domain is www.proovra.com (too specific) → cookie domain fix didn't work
- [ ] Check services/api/src/routes/auth.routes.ts → domain setup

**Issue: Mobile app doesn't redirect to home after auth**
- [ ] Check app.json → should have "scheme": "proovra"
- [ ] Might need to rebuild app for scheme to register
- [ ] Check expo logs: `expo logs`

---

## EVIDENCE CHECKLIST

For each test flow, capture:

- [ ] authLogger output (JSON or markdown)
- [ ] Network request screenshot (showing /v1/auth/[provider])
- [ ] /me validation response (redact token/sensitive data)
- [ ] Final state (redirected to home or back to login)
- [ ] Cookie check (web only - domain, secure, httponly)
- [ ] Timestamp and BUILD_ID tested
- [ ] Any errors or warnings in console

---

## IF TEST FAILS

**Don't:**
- ❌ Change code without evidence
- ❌ Skip the authLogger evidence
- ❌ Assume issue is "known" without checking

**Do:**
- ✅ Capture authLogger output
- ✅ Screenshot network requests
- ✅ Document exact error message
- ✅ Note which flow fails
- ✅ Try flow again (might be transient)
- ✅ Create GitHub issue with evidence

**Then:**
Proceed to PHASE 5 to fix identified issues.

---

## SUCCESS = MERGE TO MAIN

**After all tests pass:**
```bash
git checkout main
git merge fix/auth-regressions
git push origin main
# Vercel deploys to production
```

**Verify production:**
```
https://www.proovra.com/health
Should return: status: "ok", buildTime: "2026-02-12T..."
```

---

## PROGRESS TRACKING

| Phase | Status | Done | Next |
|-------|--------|------|------|
| 0 | ✅ BUILD_ID | 2026-02-12 | Deploy |
| 1 | ✅ Logging | 2026-02-12 | Test |
| 2 | ✅ Architecture | 2026-02-12 | Reference |
| 3 | ✅ Redirect URIs | 2026-02-12 | Verify via testing |
| 4 | ✅ Fixes ready | 2026-02-12 | Deploy + verify |
| 5 | ⏳ Debug panel | TBD | After Phase 4 testing |
| 6 | ⏳ Test matrix | TBD | After Phase 5 |

---

## QUICK COMMANDS

```bash
# Check current branch
git branch

# See what changed
git diff main

# View commits
git log --oneline fix/auth-regressions -5

# Deploy to staging
git push origin fix/auth-regressions

# Merge to main (after tests pass)
git checkout main
git merge fix/auth-regressions
git push origin main

# Rollback if needed
git revert f412e04
```

---

## TIME ESTIMATE

- Deployment: 5 min
- Web testing: 30 min
- Mobile testing: 30 min
- Evidence collection: 15 min
- Documentation: 10 min
- **Total: ~90 minutes**

---

## NEED HELP?

1. Check [TESTING_GUIDE.md](TESTING_GUIDE.md) for step-by-step
2. Check [AUTH_ARCHITECTURE.md](AUTH_ARCHITECTURE.md) for technical details
3. Check [PHASE_4_PREPARATION.md](PHASE_4_PREPARATION.md) for known issues
4. Check [PHASE_3_FINDINGS.md](PHASE_3_FINDINGS.md) for redirect URI info

---

## READY? START HERE:

**👉 Next Step:** `git push origin fix/auth-regressions`

Then follow [TESTING_GUIDE.md](TESTING_GUIDE.md) **Web Testing** section.

Good luck! 🚀

