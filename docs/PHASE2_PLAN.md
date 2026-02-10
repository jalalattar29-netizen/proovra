# PHASE 2: AUTH & PROFILE — EXECUTION PLAN

**Status**: Just Started  
**Priority**: HIGH (Critical Path)  
**Estimated Time**: 4-6 hours

---

## Objectives

### 1. Auth Flow Testing ✅ (Partially Complete)
- [x] Google OAuth endpoint exists (`/v1/auth/google`)
- [x] Apple Sign-in endpoint exists (`/v1/auth/apple`)
- [x] Guest auth endpoint exists (checked in Phase 1)
- [ ] **Test** Google OAuth flow end-to-end
- [ ] **Test** Apple Sign-in flow end-to-end
- [ ] **Test** Guest auto-login on mobile
- [ ] **Test** Token persistence across browser refresh
- [ ] **Test** Logout clears all state correctly

### 2. Profile Page Verification ✅ (Complete)
- [x] `/settings` page exists
- [x] Displays user email, name, provider
- [x] Shows current plan
- [x] Has logout button
- [x] Has language selector
- [x] Has subscription/billing link
- [x] Has legal links

**Action**: Enhance with Toast feedback and profile photo display

### 3. Mobile Camera Integration ❌ (Not Started)
- [ ] Photo capture with Toast
- [ ] Video recording with Toast
- [ ] Document upload with Toast
- [ ] Parity with web capture page

---

## Current Implementation Review

### Web OAuth Flow

**Files**:
- `apps/web/lib/oauth.ts` — URL builders, script loaders
- `apps/web/app/login/page.tsx` — Login page with OAuth buttons
- `apps/web/app/auth/callback/route.ts` — Callback redirect router
- `apps/web/app/auth/apple/callback/ui/page.tsx` — Token handler

**Flow**:
1. User clicks "Sign in with Google/Apple" → `login/page.tsx`
2. Opens OAuth provider auth dialog
3. Provider redirects to `/auth/callback?code=...&state=...`
4. Route handler redirects to `/auth/callback/ui?code=...`
5. UI page fetches token from `/v1/auth/google` or `/v1/auth/apple`
6. Sets token in localStorage + context
7. Fetches `/v1/auth/me` to get user profile
8. Redirects to `/home`

**Current State**: 
- ✅ Implementation looks correct
- ✅ Error handling in place
- ✅ State validation present
- ⚠️ Need to test with actual OAuth credentials
- ⚠️ Need to verify token persistence

### Settings Page

**File**: `apps/web/app/(app)/settings/page.tsx`

**Current Features**:
- ✅ Profile section (name, email, provider)
- ✅ Security section (login method, session status)
- ✅ Language section (EN/AR selector)
- ✅ Subscription section (current plan)
- ✅ Legal section (links)
- ✅ Logout button

**Missing**:
- ❌ Profile photo display
- ❌ Toast feedback on logout
- ❌ Toast feedback on errors

---

## Work Items for Phase 2

### Task 1: Enhance Settings Page with Toast

**File**: `apps/web/app/(app)/settings/page.tsx`

**Changes**:
1. Import `useToast` hook
2. Add Toast notification when user signs out
3. Add Toast on successful page load
4. Add Toast on error fetching plan
5. Show profile photo if available

**Estimated Time**: 15 minutes

### Task 2: Create Mobile Camera Integration Plan

**Files to Create/Modify**:
- `apps/mobile/app/(tabs)/upload.tsx` — Photo/video/document tabs
- Integrate Toast feedback (if Expo has Toast library)
- Ensure parity with web capture page

**Estimated Time**: 2-3 hours

### Task 3: Test Google OAuth End-to-End

**Steps**:
1. Ensure `NEXT_PUBLIC_GOOGLE_CLIENT_ID` is set in `.env.local`
2. Ensure `NEXT_PUBLIC_GOOGLE_REDIRECT_URI` matches Google Console config
3. Visit `app.proovra.com/login`
4. Click "Sign in with Google"
5. Verify:
   - Opens Google auth dialog
   - Redirects back to app after auth
   - Token is stored in localStorage
   - User profile displays in settings
   - Logout clears token

**Estimated Time**: 30 minutes

### Task 4: Test Apple Sign-in End-to-End

**Steps**:
1. Ensure `NEXT_PUBLIC_APPLE_CLIENT_ID` is set in `.env.local`
2. Ensure `NEXT_PUBLIC_APPLE_REDIRECT_URI` matches Apple config
3. Visit `app.proovra.com/login` on Safari (required for Apple Sign-in)
4. Click "Sign in with Apple"
5. Verify:
   - Opens Apple auth dialog
   - Redirects back to app after auth
   - Token is stored in localStorage
   - User profile displays in settings
   - Logout clears token

**Estimated Time**: 30 minutes

### Task 5: Test Guest Auto-Login on Mobile

**Steps**:
1. Open mobile app (iOS/Android)
2. Should auto-login as guest (no login prompt)
3. Verify token is stored
4. Kill app and restart
5. Verify token persists
6. Check if user can capture evidence

**Estimated Time**: 20 minutes

### Task 6: Test Token Persistence

**Steps**:
1. Sign in with Google/Apple on web
2. Refresh browser (F5)
3. Verify still logged in (token from localStorage)
4. Close browser completely
5. Reopen and visit `app.proovra.com`
6. Verify token restored from localStorage
7. Verify user profile loads

**Estimated Time**: 15 minutes

### Task 7: Test Logout Flow

**Steps**:
1. Sign in with any method
2. Go to `/settings`
3. Click "Sign out"
4. Verify:
   - API call to `/v1/auth/logout`
   - localStorage cleared
   - Toast shows "Signed out"
   - Redirects to home page
   - Cannot access protected routes

**Estimated Time**: 10 minutes

---

## Implementation Tasks

### Task 1.1: Enhance Settings Page with Toast

```tsx
// Add to settings/page.tsx:
import { useToast } from "../../../components/ui";

export default function SettingsPage() {
  // ... existing code ...
  const { addToast } = useToast();

  const handleSignOut = async () => {
    try {
      addToast("Signing out...", "info");
      await apiFetch("/v1/auth/logout", { method: "POST" });
      addToast("Signed out successfully", "success");
    } catch (err) {
      addToast("Sign out failed", "error");
    } finally {
      setToken(null);
      router.replace("/");
    }
  };

  useEffect(() => {
    // Add error toast if plan fetch fails
    apiFetch("/v1/billing/status")
      .then((data) => setPlan(data.entitlement?.plan ?? "FREE"))
      .catch(() => {
        setPlan("FREE");
        addToast("Could not load subscription status", "warning");
      });
  }, [addToast]);
}
```

**Estimated Implementation Time**: 10 minutes

---

## Testing Checklist

### ✅ Google OAuth
- [ ] Login button visible
- [ ] Clicking opens Google auth dialog
- [ ] Redirects to app on success
- [ ] Token in localStorage
- [ ] User profile in settings
- [ ] Logout works

### ✅ Apple Sign-in
- [ ] Login button visible (Safari only)
- [ ] Clicking opens Apple auth dialog
- [ ] Redirects to app on success
- [ ] Token in localStorage
- [ ] User profile in settings
- [ ] Logout works

### ✅ Guest Auto-login
- [ ] Mobile app opens without login
- [ ] Guest token auto-created
- [ ] Can capture evidence
- [ ] Token persists

### ✅ Token Persistence
- [ ] Token in localStorage
- [ ] Browser refresh keeps token
- [ ] Close/reopen app keeps token
- [ ] Logout clears token

### ✅ Settings Page
- [ ] Loads user profile
- [ ] Shows current plan
- [ ] Language selector works
- [ ] Logout button works
- [ ] All links work

### ✅ Mobile Integration
- [ ] Photo capture with Toast
- [ ] Video recording with Toast
- [ ] Document upload with Toast
- [ ] Parity with web

---

## Files to Modify

| File | Changes | Lines |
|------|---------|-------|
| `apps/web/app/(app)/settings/page.tsx` | Add useToast, enhance logout | +10 |
| `apps/web/app/(app)/settings/page.tsx` | Add profile photo | +15 |
| `apps/mobile/app/(tabs)/upload.tsx` | Camera integration | +100 |
| **TOTAL** | | **~125** |

---

## Success Criteria

✅ All OAuth flows work correctly  
✅ Token persists across refreshes  
✅ Settings page shows user profile  
✅ Logout clears all state  
✅ Mobile camera integration ready  
✅ Zero breaking changes  
✅ 100% TypeScript  

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| OAuth credentials missing | Check .env files, update as needed |
| Redirect URI mismatch | Verify in Google/Apple console |
| Token not persisting | Check localStorage implementation |
| Mobile camera not working | Use native Expo APIs |
| Browser compatibility | Test in Chrome, Safari, Firefox |

---

## Next Phase (Phase 3)

Once Phase 2 is complete:
1. Verify page (`/verify/[token]`)
2. Billing integration (Stripe)
3. Dashboard (`/home`)

---

**Ready to begin Phase 2 tasks?**
