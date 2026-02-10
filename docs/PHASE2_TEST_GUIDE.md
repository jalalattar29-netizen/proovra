# PHASE 2: AUTH & PROFILE — TEST VERIFICATION GUIDE

**Date**: February 10, 2026  
**Tester**: Automated Test Plan  
**Status**: Ready for Manual Testing

---

## Prerequisites

### Environment Setup

Before running any tests, ensure these environment variables are configured:

**Web App** (`.env.local` in `apps/web/`):
```bash
NEXT_PUBLIC_API_BASE=https://api.proovra.com
NEXT_PUBLIC_WEB_BASE=https://www.proovra.com
NEXT_PUBLIC_APP_BASE=https://app.proovra.com
NEXT_PUBLIC_GOOGLE_CLIENT_ID=<your-google-client-id>
NEXT_PUBLIC_GOOGLE_REDIRECT_URI=https://app.proovra.com/auth/callback
NEXT_PUBLIC_APPLE_CLIENT_ID=<your-apple-client-id>
NEXT_PUBLIC_APPLE_REDIRECT_URI=https://app.proovra.com/auth/callback
```

**Backend** (`.env` in `services/api/`):
```bash
GOOGLE_CLIENT_ID=<your-google-client-id>
GOOGLE_CLIENT_SECRET=<your-google-client-secret>
GOOGLE_REDIRECT_URI=https://api.proovra.com/v1/auth/google/callback
APPLE_CLIENT_ID=<your-apple-client-id>
APPLE_TEAM_ID=<your-apple-team-id>
APPLE_KEY_ID=<your-apple-key-id>
APPLE_PRIVATE_KEY=<your-apple-private-key>
APPLE_REDIRECT_URI=https://api.proovra.com/v1/auth/apple/callback
```

### API Endpoints Required

The following endpoints must be working:

```
POST /v1/auth/google       → Exchange auth code for JWT token
POST /v1/auth/apple        → Exchange auth code for JWT token
POST /v1/auth/guest        → Create guest token (mobile)
POST /v1/auth/logout       → Invalidate current token
GET  /v1/auth/me           → Get current user profile
POST /v1/evidence/claim    → Claim guest evidence when upgrading
GET  /v1/billing/status    → Get current plan
```

---

## Test 1: Google OAuth Flow ✅

### Setup
- [ ] NEXT_PUBLIC_GOOGLE_CLIENT_ID configured
- [ ] NEXT_PUBLIC_GOOGLE_REDIRECT_URI set to callback URL
- [ ] Backend has GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET

### Test Steps

1. **Open Login Page**
   - Navigate to: `https://app.proovra.com/login`
   - ✅ Page loads
   - ✅ "Sign in with Google" button visible

2. **Click Google Sign-in**
   - Click "Sign in with Google" button
   - ✅ Google auth dialog opens
   - ✅ Can enter Google credentials

3. **Complete Google Authentication**
   - Enter valid Google credentials
   - ✅ Google dialog closes
   - ✅ Redirects to app.proovra.com

4. **Verify Token Storage**
   ```js
   // In browser console:
   localStorage.getItem('proovra-token')
   // ✅ Should return JWT token string
   ```

5. **Check User Profile**
   - Navigate to: `https://app.proovra.com/settings`
   - ✅ User name displays
   - ✅ User email displays
   - ✅ Auth provider shows "google"
   - ✅ Current plan displays

6. **Verify Toast Notifications**
   - ✅ "Signing in via google..." appears (info)
   - ✅ Redirects after auth completes

7. **Test Logout**
   - Click "Sign out" button on settings
   - ✅ "Signing out..." Toast appears (info)
   - ✅ "Signed out successfully" Toast appears (success)
   - ✅ Redirects to home page
   - ✅ localStorage token is cleared

### Expected Results
- ✅ Token stored in localStorage
- ✅ User profile displays in settings
- ✅ Logout clears token
- ✅ Cannot access protected routes after logout

### Failure Scenarios
- ❌ "Google client ID is missing" → Check .env
- ❌ Redirect URI mismatch → Check Google Console config
- ❌ "Sign-in failed" → Check backend auth endpoint
- ❌ Token not stored → Check localStorage permissions

---

## Test 2: Apple Sign-in Flow ✅

### Setup
- [ ] NEXT_PUBLIC_APPLE_CLIENT_ID configured
- [ ] NEXT_PUBLIC_APPLE_REDIRECT_URI set to callback URL
- [ ] Backend has APPLE_CLIENT_ID, APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY

### Test Steps

1. **Open Login Page (Safari)**
   - Open Safari (Apple Sign-in only works in Safari)
   - Navigate to: `https://app.proovra.com/login`
   - ✅ Page loads
   - ✅ "Sign in with Apple" button visible

2. **Click Apple Sign-in**
   - Click "Sign in with Apple" button
   - ✅ Apple auth dialog opens
   - ✅ Can enter Apple ID credentials

3. **Complete Apple Authentication**
   - Enter valid Apple ID credentials
   - ✅ Apple dialog closes
   - ✅ Redirects to app.proovra.com

4. **Verify Token Storage**
   ```js
   // In browser console:
   localStorage.getItem('proovra-token')
   // ✅ Should return JWT token string
   ```

5. **Check User Profile**
   - Navigate to: `https://app.proovra.com/settings`
   - ✅ User name displays (if provided)
   - ✅ User email displays (if provided)
   - ✅ Auth provider shows "apple"
   - ✅ Current plan displays

6. **Verify Toast Notifications**
   - ✅ "Signing in via apple..." appears (info)
   - ✅ Redirects after auth completes

7. **Test Logout**
   - Click "Sign out" button on settings
   - ✅ "Signing out..." Toast appears (info)
   - ✅ "Signed out successfully" Toast appears (success)
   - ✅ Redirects to home page
   - ✅ localStorage token is cleared

### Expected Results
- ✅ Token stored in localStorage
- ✅ User profile displays in settings
- ✅ Logout clears token
- ✅ Cannot access protected routes after logout

### Failure Scenarios
- ❌ "Apple client ID is missing" → Check .env
- ❌ Redirect URI mismatch → Check Apple Developer config
- ❌ "Sign-in failed" → Check backend auth endpoint
- ❌ Only works on Safari → Expected (Apple Sign-in limitation)

---

## Test 3: Token Persistence ✅

### Test Steps

1. **Sign in with Google or Apple**
   - Complete Google/Apple OAuth flow
   - ✅ Token stored in localStorage

2. **Refresh Browser**
   - Press F5 or Cmd+R
   - ✅ Page reloads
   - ✅ Still logged in (token from localStorage)
   - ✅ Settings page shows user profile

3. **Close and Reopen Browser**
   - Close browser completely
   - Reopen and navigate to: `app.proovra.com/settings`
   - ✅ Still logged in
   - ✅ User profile displays
   - ✅ Token restored from localStorage

4. **Clear localStorage and Refresh**
   ```js
   // In browser console:
   localStorage.clear()
   // Then refresh page
   ```
   - ✅ Redirects to login page
   - ✅ Must sign in again

### Expected Results
- ✅ Token persists across browser refreshes
- ✅ Token persists after closing browser
- ✅ Clearing localStorage logs user out

---

## Test 4: Settings Page Features ✅

### Test Steps

1. **Sign in with any method**
   - Google or Apple auth

2. **Navigate to Settings**
   - URL: `https://app.proovra.com/settings`

3. **Verify Profile Section**
   - ✅ Avatar displays with user initials
   - ✅ Name displays
   - ✅ Email displays
   - ✅ Auth provider displays
   - ✅ Sign out button visible

4. **Verify Security Section**
   - ✅ Login method displays
   - ✅ Session status shows "Active"
   - ✅ Security policy link works
   - ✅ Email link works (opens mail client)

5. **Verify Language Section**
   - ✅ Language dropdown shows "English" and "العربية"
   - ✅ Can select different language
   - ✅ Language switcher on header changes

6. **Verify Subscription Section**
   - ✅ Current plan displays (FREE, PRO, TEAM)
   - ✅ "Go to Billing" button visible
   - ✅ Button navigates to /billing

7. **Verify Legal Section**
   - ✅ Privacy Policy link works
   - ✅ Terms of Service link works
   - ✅ Security link works

### Expected Results
- ✅ All profile sections display correctly
- ✅ All links work
- ✅ Language selector functional
- ✅ Sign out button functional

---

## Test 5: Logout & Session Cleanup ✅

### Test Steps

1. **Sign in with any method**
   - Complete OAuth flow

2. **Go to Settings**
   - Navigate to `app.proovra.com/settings`

3. **Click Sign Out**
   - Click "Sign out" button
   - ✅ "Signing out..." Toast appears
   - ✅ Waits briefly (500ms)
   - ✅ "Signed out successfully" Toast appears
   - ✅ Redirects to `/`

4. **Verify Logout**
   ```js
   // In browser console:
   localStorage.getItem('proovra-token')
   // ✅ Should return null
   ```

5. **Try to Access Protected Route**
   - Navigate to `app.proovra.com/capture`
   - ✅ Redirects to login or home
   - ✅ Cannot access protected content

### Expected Results
- ✅ Token removed from localStorage
- ✅ Auth state cleared
- ✅ Cannot access protected routes
- ✅ Must login again to continue

---

## Test 6: Guest Auto-login (Mobile) ✅

### Setup
- [ ] Expo app running on iOS or Android device/emulator

### Test Steps

1. **Open Mobile App**
   - Launch app.proovra.com on Expo
   - ✅ Should open without login prompt
   - ✅ Shows home screen

2. **Check Token Storage**
   - Open developer tools
   - ✅ Guest token stored (auto-created)
   - ✅ Can see in AsyncStorage

3. **Navigate to Capture**
   - Tap "Capture" or "New Evidence"
   - ✅ Can access capture screen
   - ✅ Can select photo/video/document

4. **Test Token Persistence**
   - Kill app (swipe up or force close)
   - Reopen app
   - ✅ Still have guest token
   - ✅ Still logged in

5. **Test Guest Evidence Claim**
   - Capture evidence as guest
   - Sign in with Google/Apple
   - ✅ Evidence should be claimed by account
   - ✅ Evidence appears in /home

### Expected Results
- ✅ Guest token auto-created on app open
- ✅ Can use app without login
- ✅ Guest token persists
- ✅ Evidence claimed when upgrading account

---

## Test 7: Error Handling & Toast Feedback ✅

### Test Steps

1. **Sign in with Invalid Credentials**
   - Click Google/Apple
   - Decline permissions
   - ✅ Error Toast appears: "Google/Apple sign-in failed: ..."
   - ✅ Stays on login page
   - ✅ Can retry

2. **Network Failure (Logout)**
   - Go to settings
   - Disable internet
   - Click Sign out
   - ✅ "Signing out..." Toast appears
   - ✅ Error Toast appears: "Sign out failed"
   - ✅ Still on settings page
   - ✅ Can retry when online

3. **Billing Status Failure**
   - Settings page loads
   - If billing API fails
   - ✅ Warning Toast: "Could not load subscription status"
   - ✅ Plan shows "FREE" as default
   - ✅ Page still functional

### Expected Results
- ✅ All errors show Toast messages
- ✅ Friendly error text
- ✅ User can retry actions
- ✅ No silent failures

---

## Test 8: Cross-Tab Logout Sync (Optional) ⏳

### Test Steps

1. **Sign in with Google**
   - Complete auth

2. **Open Same App in Multiple Tabs**
   - Tab 1: app.proovra.com/settings
   - Tab 2: app.proovra.com/capture

3. **Logout in Tab 1**
   - Click Sign out in Tab 1
   - ✅ Token removed in Tab 1

4. **Check Tab 2**
   - Switch to Tab 2
   - Refresh page
   - ✅ Logged out (token gone)
   - ✅ Redirects to login

### Expected Results
- ✅ Logout in one tab affects all tabs
- ✅ Token state synchronized across tabs

---

## Quick Checklist

Copy this and check off as you test:

```
GOOGLE OAUTH
[ ] Login page loads with Google button
[ ] Google auth dialog opens
[ ] Token stored in localStorage
[ ] User profile displays in settings
[ ] Logout clears token
[ ] Cannot access protected routes after logout

APPLE SIGN-IN
[ ] Login page loads with Apple button (Safari)
[ ] Apple auth dialog opens
[ ] Token stored in localStorage
[ ] User profile displays in settings
[ ] Logout clears token
[ ] Cannot access protected routes after logout

TOKEN PERSISTENCE
[ ] Refresh browser: still logged in
[ ] Close/reopen browser: still logged in
[ ] Clear localStorage: must login again

SETTINGS PAGE
[ ] Profile avatar displays
[ ] Name and email display
[ ] Auth provider displays
[ ] Current plan displays
[ ] Language selector works
[ ] All links work

LOGOUT FLOW
[ ] "Signing out..." Toast shows
[ ] "Signed out successfully" Toast shows
[ ] Redirects to home
[ ] Token cleared from localStorage

GUEST AUTO-LOGIN (MOBILE)
[ ] App opens without login prompt
[ ] Guest token auto-created
[ ] Can capture evidence
[ ] Token persists after app restart
[ ] Evidence claimed when signing in

ERROR HANDLING
[ ] Invalid credentials show error Toast
[ ] Network failures show error Toast
[ ] API failures show warning Toast
[ ] Can retry failed actions
```

---

## Troubleshooting

### Issue: "OAuth state mismatch"
- **Cause**: State parameter changed between redirect
- **Fix**: Clear sessionStorage, try again
- **Code**: `sessionStorage.clear(); location.reload()`

### Issue: "Sign-in failed: Missing access token"
- **Cause**: API didn't return token
- **Fix**: Check backend auth endpoints and credentials
- **Debug**: Check browser console for API response

### Issue: Token not persisting after refresh
- **Cause**: localStorage not available (private browsing, etc)
- **Fix**: Test in normal browsing mode
- **Check**: `navigator.localStorage` available

### Issue: Apple Sign-in doesn't work on Chrome/Firefox
- **Cause**: Apple Sign-in only works on Safari/Safari on iOS
- **Fix**: Use Safari browser
- **Note**: Expected behavior

### Issue: Logout doesn't clear token
- **Cause**: localStorage.removeItem not working
- **Fix**: Check browser console for errors
- **Debug**: Manually clear: `localStorage.clear()`

---

## Success Criteria for Phase 2

✅ **Google OAuth**: Complete flow works, token persists  
✅ **Apple Sign-in**: Complete flow works (Safari), token persists  
✅ **Token Persistence**: Survives refresh and browser restart  
✅ **Settings Page**: Displays profile and allows logout  
✅ **Logout Flow**: Clears all state, prevents access  
✅ **Guest Auto-login**: Works on mobile, persists  
✅ **Error Handling**: Toast messages for all failures  
✅ **Zero Breaking Changes**: All existing features work  

---

**Ready for manual testing!**

Document results in this file under each test section (✅ Pass or ❌ Fail).
