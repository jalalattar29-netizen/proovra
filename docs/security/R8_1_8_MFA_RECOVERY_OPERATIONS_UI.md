# PHASE R8.1.8 — Preferences UI, Digest Preview, HTML Digest Email & Verify-Page Auth Optimization

**Status:** Shipped
**Date:** 2026-05-24
**Predecessors:** R8 → R8.1.7 (cryptographic MFA, login challenge, durable challenge store, org enforcement, scheduled GC, circuit breaker, admin lifecycle, lost-factor recovery with verified-email preflight, admin SPA, self-cancel, per-org fail-mode, user-facing verify page, per-account throttle, admin quorum SPA, pending digest job, consolidated multi-team digest, digest preferences endpoints)

## What this phase closes

R8.1.7 named five remaining operational polish gaps. R8.1.8 closes all five:

1. **Digest preferences API existed but no admin-facing UI** — admins had to call PATCH endpoints directly.
2. **No digest preview** — admins couldn't see what their next digest would contain.
3. **Digest email was plain text only** — no rendered HTML body for modern email clients.
4. **No snooze quick-action in the SPA** — required hand-crafting PATCH bodies.
5. **Verify page always called `/v1/auth/me`** even for obviously anonymous users — wasted round-trip.

## What this phase deliberately does NOT do

- Does NOT create a session from email verification (contract test 14). The verify page still has no `signJwt` / `setToken` / `setCookie('proovra_session', …)` reference.
- Does NOT email any OTP, recovery code, signed token, TOTP secret, or per-user enumeration (contract test 13).
- Does NOT introduce a parallel auth surface or analytics shim (contract tests 16 + bonus).
- Does NOT add insecure client-side session storage — the optimization READS an existing `localStorage` value as a presence signal only; verification tokens never enter localStorage (contract test 15).
- Does NOT touch capture / upload / custody / report-package / TSA / OTS / finalization (contract test 19).
- Does NOT involve workflow / persona authorization (contract test 17).

## Part 1 — Admin digest preferences UI

Inline section added to `apps/web/app/(app)/security-center/mfa-recovery/page.tsx`. Marked with `data-cc-mfa-recovery-digest-preferences-card`.

### Capabilities

| Control | Behaviour |
|---|---|
| Toggle `Enabled` checkbox | PATCH `{ teamId, digestEnabled: bool }` |
| Snooze 7d button | PATCH `{ teamId, digestEnabled: true, suppressUntil: now+7d }` |
| Resume button (visible when snoozed) | PATCH `{ teamId, digestEnabled: true, suppressUntil: null }` |
| Global vs per-team rows | Global = `teamId: null`; per-team rows surface as separate `DigestPreferenceRowEditor` instances |
| Last-updated chip | Shows `updatedAt` per row |

### Hard rules (UI-enforced)

- **Copy reinforces scope**: `Digest preferences only affect notification emails. Security events and audit logs are always preserved.` (Contract test 5)
- **Canonical endpoints only**: GET + PATCH `/v1/identity/mfa-admin/digest-preferences` (Contract test 2).
- **No duplicate state**: changes immediately reload from the server; UI never invents preferences.
- **No security score / decorative widgets**: the card is a flat list with bounded controls.

## Part 2 — Snooze quick action

Three snooze surfaces:

1. **Header-level "Snooze digest for 7 days"** (`data-cc-mfa-recovery-digest-snooze`) — targets the global preference. Flips to a "Resume digest notifications" button when the global is already snoozed.
2. **Per-team "Snooze 7d"** chips on every preview team row (`data-cc-mfa-recovery-digest-snooze-team`).
3. **Per-preference-row "Snooze 7d" / "Resume"** buttons inside the preferences card (`data-cc-mfa-recovery-digest-preference-snooze` / `…-resume`).

All three call the same `doSnooze(teamId | null, days)` / `doResume(teamId | null)` helpers, which:
- Compute `suppressUntil = now + days * 24h` for snooze (or `null` for resume).
- PATCH `/v1/identity/mfa-admin/digest-preferences`.
- Toast `Snoozed for 7 days.` / `Digest notifications resumed.` for 4 seconds.
- Reload preferences AND preview so the UI reflects the new state immediately.

### Status badges

- `data-cc-mfa-recovery-digest-preference-snoozed="true"|"false"` on each preference row.
- Last-updated timestamp inline so admins can see when they (or another tab) last touched the preference.

## Part 3 — Digest preview endpoint

`GET /v1/identity/mfa-admin/digest-preferences/preview` (optional `?includeSuppressed=true`).

### Backend

New service `services/api/src/services/security/mfa-recovery-digest-preview.service.ts`:

```typescript
previewDigestForAdmin({ actorUserId, includeSuppressed }) →
  {
    adminUserId, generatedAt,
    teamCount, requestCount, suppressedTeamCount,
    teams: [{
      teamId, teamName, pendingCount,
      oldestRequestAgeSeconds, adminRecoveryUrl,
      suppressedByPreference
    }]
  }
```

### Hard properties

- **No side effects**. The service does NOT import `email.service`, Resend, or call `fetch()`. Does NOT emit any security event. The route emits one bounded analytics event (`mfa_recovery_digest_preview_generated`) for adoption tracking — never carries the preview body. (Contract test 7)
- **No secret material**. Return shape is exhaustively listed above — counts + names + URL only. (Contract test 8)
- **Tenant-scoped**. The Prisma queries select strictly by the actor's ACTIVE OWNER/ADMIN memberships; an admin cannot preview another admin's digest. (Contract test 18)
- **Bounded**. Capped at `MAX_TEAMS_PER_DIGEST = 50` (same as the worker so preview never inflates beyond the actual email).
- **Preference-aware**. By default suppressed teams are dropped from `teams[]`. With `?includeSuppressed=true` they appear flagged as `suppressedByPreference: true` so admins can see what they'd see if they un-snoozed.

## Part 4 — Digest preview UI

New `data-cc-mfa-recovery-digest-preview-card` section in the admin SPA renders:

- Total `N requests across M teams` summary line.
- "X teams suppressed by your preferences" hint when applicable.
- Per-team list with team name + pending count + oldest request age (in hours).
- "Suppressed" pill on rows that are suppressed by current preferences.
- Per-team "Snooze 7d" chip.
- "Include teams my preferences would suppress" checkbox driving the `?includeSuppressed=true` param.
- `Generated <timestamp>` line.

### Hard rule

**Read-only.** The preview section never includes approve / reject controls or `setPendingAction` calls. Operators must use the queue table above for approvals — preview is observation only. (Contract test 10)

## Part 5 — HTML digest email

The worker's `sendAdminDigest` now sends BOTH plain text and HTML bodies in the same Resend request. Plain text fallback is preserved verbatim for clients that don't render HTML.

### HTML template properties

- Minimal inline CSS (no external stylesheets, no JS, no remote images) — friendly to every major email client.
- Bounded fields only: title, total request count, team breakdown list, admin SPA CTA button, "approval does NOT grant a session" warn box, preference-management pointer.
- `escapeHtml()` helper used on EVERY team name interpolation — defends against a team name containing `<`/`>` bleeding into the markup.
- Same content contract as the plain text body. No raw user emails enumerated. (Contract tests 11/12/13)

## Part 6 — Verify page auth-status optimization

### Honest constraint

The canonical session cookie (`proovra_session`) is `HttpOnly` and therefore **not readable from JavaScript**. There is no purely client-side signal that conclusively says "this user is signed in" without a round trip.

### Pragmatic signal

The web client persists a `proovra-token` value in `localStorage` (used by `apiFetch` to set the `Authorization` header). When that key is **absent**, the user is definitely not signed in through the web stack, and we can skip the `/v1/auth/me` probe entirely.

### Behaviour

```
After successful verify-email:
  if (localStorage.getItem("proovra-token")) {
    // Confirm the token is still current (logout-elsewhere safe).
    GET /v1/auth/me (auth=false, soft-fail on 401)
    if (response.user) → sessionPresent = true
    else                → sessionPresent = false
  } else {
    sessionPresent = false  // skip the probe entirely
  }
```

### Honest UX caveat (documented in code)

An SSO-only user who has a fresh `proovra_session` cookie but no `proovra-token` in localStorage will be classified as anonymous and shown the "Return to sign in" CTA. They can click it and proceed; we accepted the mild UX loss because the alternative (always probe) costs every anonymous user a round trip they would never benefit from. The code comment notes this trade-off inline.

### Hard rules preserved

- No session minted from the verify page (contract test 14 + 15).
- Verification token never persisted (`localStorage.set` / `sessionStorage.set` grep-asserted absent).
- The optimization READS `localStorage("proovra-token")` for presence detection only — never the verification token (test 15).

## Part 7 — Analytics events

Four new analytics events wired through the canonical `writeAnalyticsEvent`:

| Event | When | Metadata |
|---|---|---|
| `mfa_recovery_digest_preferences_viewed` | GET digest-preferences | `{ rowCount }` |
| `mfa_recovery_digest_preview_generated` | GET digest-preferences/preview | `{ teamCount, requestCount, suppressedTeamCount, includeSuppressed }` |
| `mfa_recovery_digest_snoozed` | PATCH digest-preferences with `suppressUntil` in the future | `{ teamScoped }` |
| `mfa_recovery_digest_resumed` | PATCH digest-preferences with `suppressUntil: null` (cleared) | `{ teamScoped }` |

All emissions go through `writeAnalyticsEvent` (contract bonus test). No bespoke `sendAnalytics()` / `postAnalytics()`. No metadata payload carries `token`, `rawToken`, `otpauth`, `recoveryCode`, or `secret*` (contract bonus test).

## Files touched

### API

| Path | Change |
|---|---|
| `src/services/security/mfa-recovery-digest-preview.service.ts` | **NEW.** Tenant-scoped, observation-only digest preview |
| `src/routes/mfa-admin.routes.ts` | + `GET /v1/identity/mfa-admin/digest-preferences/preview`; + 4 analytics emissions wired into GET prefs + PATCH prefs + GET preview |

### Worker

| Path | Change |
|---|---|
| `src/mfa-recovery-digest.ts` | `sendAdminDigest` now builds an HTML body in parallel with plain text; both sent to Resend. New `escapeHtml()` helper |

### Web

| Path | Change |
|---|---|
| `app/(app)/security-center/mfa-recovery/page.tsx` | + Preferences card (toggle + snooze/resume + per-team rows) + preview card (read-only, with include-suppressed checkbox) + global snooze/resume header button + toast + `DigestPreferenceRowEditor` helper component + 5 new style consts |
| `app/auth/mfa-recovery/verify/page.tsx` | + `localStorage("proovra-token")` presence check guards the `/v1/auth/me` probe; documented HttpOnly limitation inline |

### Tests

| Path | Change |
|---|---|
| `test/phase-r8-1-8-mfa-recovery-operations-ui.test.ts` | **NEW.** 22 tests (19 spec-numbered + 3 bonus) |
| `test/phase-r8-1-6-mfa-recovery-ux-completion.test.ts` | Test 4 tightened to permit operational `proovra_session` comments while still rejecting code that mints sessions |
| `test/phase-r8-1-7-mfa-recovery-operations-polish.test.ts` | Test 13 tightened with the same regex |

## Validation evidence

- `pnpm --filter proovra-api prisma generate` ✅
- `pnpm --filter proovra-api typecheck` ✅
- `pnpm --filter proovra-api test` ✅
- `pnpm --filter proovra-web typecheck` ✅
- `pnpm --filter proovra-web build` ✅
- `pnpm --filter proovra-worker typecheck` ✅
- `pnpm --filter proovra-worker test` ✅

## Hard confirmations (per spec)

| Confirmation | Status |
|---|---|
| Recovery verification still does not grant session | ✅ Tests 14 + 15 |
| Admin approval still does not grant session | ✅ R8.1.4 invariant preserved + preview service contains no session-minting paths |
| Preferences affect emails only, not audit/security events | ✅ Test 5 — UI copy + R8.1.7 service-layer guarantee |
| Digest preview sends no email | ✅ Test 7 — preview service has no email/Resend/fetch imports |
| Digest emails contain no secrets | ✅ Test 13 — HTML body iterates only team summaries |
| No raw tokens/codes/secrets logged | ✅ Bonus test — no analytics call carries token/OTP/recoveryCode/secret |
| No duplicate auth system | ✅ Test 16 — still only `auth.routes.ts` + `sso-auth.routes.ts` |
| No workflow/persona auth logic | ✅ Test 17 |
| No tenant isolation regression | ✅ Test 18 — preview scoped by actor's own memberships |
| No capture/upload/finalize/custody/TSA/OTS/report/package regression | ✅ Test 19 |

## Remaining risks (honest)

1. **SSO-only users get "Return to sign in" CTA after verify.** The localStorage signal misses cookie-only sessions. Acceptable trade-off — documented inline. A future micro-phase could add an unauthenticated `/v1/auth/me-light` endpoint that returns `{ authenticated: bool }` only (no PII) which the verify page could call cheaply.
2. **HTML digest does not include unsubscribe footer.** Per-team / global snooze IS available, but a one-click email-side unsubscribe link would require a signed URL infrastructure. Future work; the "update notification preferences in the admin console" copy already points operators to the SPA control.
3. **Preview cap is 50 teams.** Same as the worker. Admin of >50 teams would see only the first 50 in the preview (and digest). Bounded UI; intentional.
4. **No "send me a real preview email right now" admin button.** The preview is JSON-only. Adding a "send-test-preview-to-me" button is straightforward (PATCH endpoint that ignores idempotency for one delivery) but was out of scope.
5. **Snooze toasts auto-dismiss after 4 seconds with no undo.** Operationally fine — the next snooze/resume click is the undo.

## Exact next phase recommendation

**R8.1.9 — Unauthenticated session-check, unsubscribe link, send-test-digest, and per-admin event-feed widget.** Specifically:

1. Add a minimal `GET /v1/auth/session-light` endpoint returning `{ authenticated: bool }` only (no email, no userId). The verify page could call this cheaply for the no-localStorage case to detect SSO-only sessions.
2. Add a signed one-click "snooze digest" URL in the HTML email footer (15-day TTL, single-use). Calls the same PATCH endpoint without requiring the admin to click into the SPA.
3. Add `POST /v1/identity/mfa-admin/digest-preferences/preview/send-test` — generates the preview AND sends it to the calling admin's email (rate-limited, idempotent per-day to avoid abuse).
4. Inline a recent-events feed (last 14 days of `mfa_recovery_*` events for the admin's teams) into the SPA so SecOps doesn't have to flip surfaces to see digest delivery / snooze / approve history.

After R8.1.9 the MFA recovery surface is feature-complete for enterprise pilot. Future work shifts to R8.2 (WebAuthn + hardware tokens) and beyond.
