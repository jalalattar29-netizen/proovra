# Auth Web — Root Cause Analysis

## Bug 1: Apple Sign-In Button Does Nothing

**Root cause:** The Apple button's `onClick` handler calls `event.preventDefault()` when `appleReady` is true, then returns without navigating. The anchor's default behavior (navigating to `href`) is blocked.

**Evidence (code):**
```tsx
// apps/web/app/login/page.tsx (lines 317–328)
if (appleReady) {
  event.preventDefault();  // ← BLOCKS navigation
  return;                   // ← Does nothing; no window.location assignment
}
```

When `appleReady` is true (set in useEffect when `appleHref` exists), the click:
1. Sets `sessionStorage` (proovra-return-url)
2. Enters `appleReady` block
3. Prevents default → anchor never navigates
4. Returns → no fallback
5. **Result:** No navigation, no console error, no visible feedback

**Fix:** Do *not* call `preventDefault` when we want to navigate. Only prevent when `busy` or when `!appleHref`. Let the anchor navigate naturally.

---

## Bug 2: Google Sign-In Returns Without Completing Login

**Root cause:** The flow uses GSI One Tap `google.accounts.id.prompt()` with deprecated moment callbacks (`isNotDisplayed`, `isSkippedMoment`, `isDismissedMoment`). These trigger the FedCM migration warning and can cause unreliable behavior on mobile web (popup blocked, one-tap not displayed, callback timing issues).

**Evidence:**
- Console warning: `[GSI_LOGGER] Your client application uses ... UI status methods ... FedCM migration warning`
- User flow: Clicks → `prompt()` may show one-tap or redirect; if one-tap appears and user selects account, callback receives credential → `handleAuth` runs. If one-tap is not displayed/skipped, we redirect to `googleHref`. On mobile web, one-tap often fails or behaves inconsistently; redirect flow is more reliable.

**Fix:** Use redirect-based flow exclusively. When user clicks, navigate directly to `buildGoogleAuthUrl()` (same as Apple). Remove GSI prompt and deprecated moment callbacks. Guarantees: click → redirect → callback → session.

---

## Bug 3: Silent Failures

**Root cause:** Errors are set in component state (`setError`) but not shown as toast. Callback errors show inline text only. No `requestId` propagation for API errors.

**Fix:** Use `useToast` for errors; include `requestId` from API responses in logs and toast when available.
