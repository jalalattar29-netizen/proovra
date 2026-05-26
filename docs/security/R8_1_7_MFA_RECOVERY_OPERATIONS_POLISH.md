# PHASE R8.1.7 — Digest Preferences, Multi-Team Digest Grouping, Verify-Page Session Detection & Recovery Analytics

**Status:** Shipped
**Date:** 2026-05-24
**Predecessors:** R8 → R8.1.6 (cryptographic MFA, login challenge, durable challenge store, org enforcement, scheduled GC, circuit breaker, admin lifecycle, lost-factor recovery with verified-email preflight, admin SPA, self-cancel, per-org fail-mode, user-facing verify page, per-account throttle, admin quorum SPA, pending digest job)

## What this phase closes

R8.1.6 ended with five named operational gaps. R8.1.7 closes them all:

1. **Admin digest notification preferences** — admins had no way to opt out of recovery digest emails (had to leave the team / get downgraded / wait for de-dupe).
2. **Multi-team digest grouping** — admins of many teams received one email per team per day; should be one consolidated email per admin per day.
3. **Verify page session detection** — after success the page always offered "Return to sign in" even when the user was already authenticated.
4. **Recovery analytics** — SecOps had to inspect logs to see verify-page conversion / drop-off; no canonical analytics events fired.
5. **Digest failure handling** — a failed transport could leave the per-team log row written, marking the team "delivered today" even when no email arrived.

## What this phase deliberately does NOT do

- Does NOT create a session from email verification (contract test 13). The verify page still has no `signJwt` / `setToken` / `setCookie` / `proovra_session` reference.
- Does NOT email any OTP, recovery code, signed token, TOTP secret, or per-user enumeration (contract test 11).
- Does NOT introduce a parallel auth or analytics system (contract tests 15 + 16). All analytics flow through the canonical `writeAnalyticsEvent`.
- Does NOT change the recovery state machine — R8.1.5 invariants preserved.
- Does NOT touch capture / upload / custody / report-package / TSA / OTS / finalization (contract test 19).
- Does NOT involve workflow / persona authorization (contract test 17).

## Part 1 — Admin digest notification preferences

### Schema

New `MfaAdminDigestPreference` model + append-only migration `20260728000000_r8_1_7_digest_preferences`.

| Column | Type | Notes |
|---|---|---|
| `userId` | UUID | FK → users, CASCADE |
| `teamId` | UUID? | FK → teams; `null` means global preference |
| `digestEnabled` | Boolean | default TRUE |
| `suppressUntil` | TIMESTAMPTZ? | snooze override |
| `(userId, teamId)` | UNIQUE | at most one per scope |

### Effective preference resolution

```
team-specific row (user, team)  →  wins if present
else global row    (user, NULL)  →  wins if present
else default ENABLED              →  digest will be sent
suppressUntil > now              →  suppressed regardless of digestEnabled
```

The `shouldSendDigest()` pure helper in `mfa-digest-preference.service.ts` is exported for tests + future surfaces. The worker uses a structurally-identical local `isDigestAllowed()` helper so it doesn't have to cross service boundaries.

### Endpoints

| Method + path | Behaviour |
|---|---|
| `GET /v1/identity/mfa-admin/digest-preferences` | Returns ALL preference rows for the authenticated user |
| `PATCH /v1/identity/mfa-admin/digest-preferences` | Partial upsert of ONE preference scoped to `(actor, teamId|null)` |

The body never accepts a `userId` field (contract test 3) — the actor is always the authenticated session user.

### Hard rules

- A user can only manage THEIR OWN preferences.
- A team-specific preference requires ACTIVE membership in that team (`not_member` reason otherwise).
- Mutations emit `mfa_recovery_digest_preference_updated` ONLY when the value actually changed (avoids SIEM noise on no-op PATCHes).
- **Preferences affect ONLY digest emails.** They do NOT suppress audit log rows, security events, or the admin SPA queue. The recovery service + admin lifecycle service do not import the preference module (contract test 5).

## Part 2 — Multi-team digest grouping

### Schema

New `MfaRecoveryAdminDigestLog` model with UNIQUE `(userId, sentDate)`. Per-admin-per-day idempotency.

The legacy R8.1.6 `MfaRecoveryDigestLog` (per-team-per-day) is **kept** as an operational SecOps marker so dashboards counting "teams digested today" continue to work.

### Worker refactor

R8.1.6 sent ONE email per team per admin per day. R8.1.7 refactors `runMfaRecoveryDigest()` to send ONE consolidated email per admin per UTC day, with all of the admin's flagged teams' pending requests listed in a single message.

### Lifecycle (R8.1.7)

```
1. Find PENDING_ADMIN_REVIEW rows older than 24h. Group by team.
2. Load all admin recipients across all flagged teams in one
   batched TeamMember.findMany.
3. Build `teamsByAdmin: Map<adminUserId, { email, teams: Set<teamId> }>`.
4. For each admin (bounded MAX_ADMINS_PER_TICK = 100):
   a. Skip if MfaRecoveryAdminDigestLog already exists for today
      (UNIQUE userId+sentDate enforces idempotency).
   b. Load admin's digest preferences in one query.
   c. Filter the admin's team set via isDigestAllowed() —
      suppressed teams drop out.
   d. If the filtered list is empty: skip without writing a log
      row (preserves the right to retry if suppression lifts).
   e. Send ONE consolidated email with all included team
      summaries.
   f. ONLY AFTER transport returns OK: write the per-admin log
      row (UNIQUE-protected against parallel workers).
   g. Mark every included team as "digested today" in the
      legacy per-team log (UNIQUE teamId+sentDate; duplicates
      gracefully ignored).
   h. Emit one `mfa_recovery_digest_sent` event per included team.
5. On transport failure: increment adminsFailed, emit
   `mfa_recovery_digest_failed`, continue. The admin's log row
   is NOT written so the next tick retries.
```

### Email body shape (R8.1.7)

```
Pending MFA recovery requests on PROOVRA

You have 7 requests awaiting your review across 3 teams:

  • Acme Corp: 4 requests
  • Globex: 2 requests
  • Initech: 1 request

Open the admin console: https://www.proovra.com/security-center/mfa-recovery

Approving a request does NOT grant a session — the user must still
re-enroll their MFA.

To change which workspaces send you these digests, update your
notification preferences in the admin console.
```

NO raw user emails enumerated into the body. NO recovery reasons. NO tokens. NO OTPs. NO recovery codes. The body iterates `input.teams` (team summaries with only `{ teamId, teamName, pendingCount }`).

## Part 3 — Digest failure handling

The R8.1.7 worker writes the per-admin idempotency row **only after** the email transport returns OK. On transport failure:

1. `mfa_recovery_digest_failed` security event written (bounded payload: `{ trigger, teamCount, requestCount, reason: "transport_error" }`).
2. `adminsFailed` counter incremented.
3. `continue` — no log row, no per-team `mfa_recovery_digest_sent` events.
4. The next scheduler tick re-processes this admin (idempotency check sees no row).

Contract test 9 verifies this strictly: the failure branch's `sent = "failed"` + `adminsFailed += 1` + `continue` block appears **before** the `mfaRecoveryAdminDigestLog.create` call in source order.

## Part 4 — Verify page session detection

### Bug fix carried along

R8.1.5 mistakenly gated the `verify-email` route behind `requireAuth`, but the email link is by nature unauthenticated. R8.1.7 removes the `requireAuth` preHandler and adds a small `readOptionalSessionUserId()` helper that:
- Reads the session JWT from the Authorization header or `proovra_session` cookie if present.
- Refuses pending tokens (`payload.mfa === "pending"`) so a pending token cannot satisfy the optional identity check.
- Returns `null` gracefully on any error.

The route still calls `verifyRecoveryRequestEmail` — the service tightens its `wrong_user` check when an `actorUserId` is supplied and skips it when null. Both authenticated and anonymous verifications work; anonymous never grants extra rights.

### Page session detection

After a successful verify, the page calls `GET /v1/auth/me` with `{ auth: false }` (cookies travel, helper doesn't throw on 401). On success → `sessionPresent: true` → renders `data-cc-mfa-recovery-verify-cta="continue-home"` pointing at `/home`. On failure → `sessionPresent: false` → renders `data-cc-mfa-recovery-verify-cta="return-to-sign-in"` pointing at `/login`.

**Neither path issues a session.** The page just navigates the EXISTING session if one happens to be present.

## Part 5 — Recovery verify analytics

Three new event types written via the canonical `writeAnalyticsEvent`:

| Event | When | Payload `metadata` |
|---|---|---|
| `mfa_recovery_verify_page_viewed` | Verify page POSTs to `/v1/identity/mfa/recovery-requests/analytics/page-viewed` on mount | `{}` |
| `mfa_recovery_verify_succeeded` | Server-side after the verify endpoint accepts the token | `{}` |
| `mfa_recovery_verify_failed` | Server-side on every bounded failure reason | `{ reason: "expired" \| "invalid" \| ... }` |

All three are written from the API route (server-side) so the frontend never has to handle analytics auth tokens. The page-viewed ingest endpoint is intentionally unauthenticated; the verify success/failure events ride along with the verify call so they share its request context (path, IP, UA via the analytics helper).

### Privacy contract

Contract test 14 enforces: NO analytics call carries `token`, `rawToken`, `otpauth`, `recoveryCode`, or `secret*` in the metadata. The only failure-side payload field is `reason: result.reason ?? "unknown"` — a bounded enum from the recovery service.

### No parallel analytics

Contract test 15 enforces: the only import for analytics in the routes file is `analytics-event.service`. No `sendAnalytics()`, no `postAnalytics()`, no `from "/analytics-shim"`. The worker does NOT write analytics events at all (R8.1.7 keeps analytics in the API tier).

## Part 6 — Email copy hardening

The consolidated digest body is documented above. Key safety properties:
- Approval consequences stated in plain language.
- "Approving a request does NOT grant a session" reminder appears verbatim.
- "Update your notification preferences" pointer surfaces the new R8.1.7 control to the admin in the email itself.
- No raw user emails, recovery reasons, tokens, OTPs, or codes.

The existing R8.1.5 user-facing verification email is unchanged.

## Files touched

### API

| Path | Change |
|---|---|
| `prisma/schema.prisma` | + `MfaAdminDigestPreference`, `MfaRecoveryAdminDigestLog`; User + Team back-relations |
| `prisma/migrations/20260728000000_r8_1_7_digest_preferences/migration.sql` | Append-only migration |
| `src/services/security/mfa-digest-preference.service.ts` | **NEW.** List + upsert preferences, `shouldSendDigest` pure helper. Emits `mfa_recovery_digest_preference_updated` only on change |
| `src/routes/mfa-admin.routes.ts` | + `GET/PATCH /v1/identity/mfa-admin/digest-preferences`; removed `requireAuth` from verify-email route; new `readOptionalSessionUserId` helper; added page-viewed analytics ingest endpoint; verify-email analytics emit |

### Worker

| Path | Change |
|---|---|
| `src/mfa-recovery-digest.ts` | Refactored from per-team to per-admin grouping. Loads digest preferences per admin. Writes per-admin idempotency log AFTER transport OK. Emits `mfa_recovery_digest_failed` on transport error. Per-team legacy log preserved as SecOps marker |

### Web

| Path | Change |
|---|---|
| `app/auth/mfa-recovery/verify/page.tsx` | + Page-viewed analytics ping on mount. + Session detection via `GET /v1/auth/me` after success. + `data-cc-mfa-recovery-verify-cta` discriminator for "continue-home" vs "return-to-sign-in" |

### Shared

| Path | Change |
|---|---|
| `packages/shared/src/security.ts` | + 2 R8.1.7 events with Phase marker: `mfa_recovery_digest_failed`, `mfa_recovery_digest_preference_updated` |

### Tests

| Path | Change |
|---|---|
| `test/phase-r8-1-7-mfa-recovery-operations-polish.test.ts` | **NEW.** 22 tests (19 spec-numbered + 3 bonus) |
| `test/phase-r8-1-4-mfa-admin-lifecycle.test.ts` | Test 10 tightened to assert the routes file does not WRITE the session cookie (it now READS it for optional session detection) |
| `test/phase-r8-1-6-mfa-recovery-ux-completion.test.ts` | Tests 13/14/18 updated to accept the per-admin refactor (count variable rename, batched team-member query, MAX_ADMINS_PER_TICK constant) |
| `test/phase-32-7-2-security-event-mapping-drift.test.ts` | Migration allow-list extended |

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
| Recovery verification still does not grant session | ✅ Tests 13 + 16 — verify page has no `signJwt`/`setToken`/`setCookie`; routes file has no `signJwt` |
| Admin approval still does not grant session | ✅ R8.1.4 invariant preserved + R8.1.7 routes file does not write `proovra_session` cookie |
| Digest emails contain no secrets | ✅ Test 11 — send fn has no raw token / OTP / recovery code / secret material |
| Admins can suppress digest notifications | ✅ Tests 1 + 8 — preference model + `isDigestAllowed` gate in worker |
| Multi-team admins receive consolidated digest | ✅ Test 6 — worker builds `teamsByAdmin` map + sends ONCE per admin |
| Failed digest sends are retried later | ✅ Test 9 — admin log row written AFTER transport OK; failure path emits + continues |
| Analytics contain no raw tokens/codes/secrets | ✅ Test 14 — every `writeAnalyticsEvent` call's metadata is grep-asserted |
| No duplicate auth system introduced | ✅ Test 16 — still only `auth.routes.ts` + `sso-auth.routes.ts` under `*auth*` |
| No workflow/persona auth logic | ✅ Test 17 |
| No tenant isolation regression | ✅ Test 18 — preferences scoped by (user, team); admin log per user; team membership query stays scoped |
| No capture/upload/finalize/custody/TSA/OTS/report/package regression | ✅ Test 19 |

## Remaining risks (honest)

1. **`skipped_no_transport` branch writes the log row.** When `RESEND_API_KEY` is unset (test envs), the worker still records the admin as "delivered today" so opportunistic local runs don't loop forever attempting to send. Production environments always have `RESEND_API_KEY` set, so this branch never fires there — but if it ever does, it's a quiet silent-failure mode. We accepted the trade-off because the alternative (loop forever) is worse for ops drills. Documented inline in the worker.
2. **Per-admin idempotency is by UTC day.** An admin's preferences change mid-day won't change their digest today — they were already covered by the morning tick. Acceptable; the next day picks up the new preference.
3. **No "send me a test digest right now" admin button.** Admins can't preview what the digest would look like. Low priority — the SPA itself already shows the same data.
4. **`mfa_recovery_digest_failed` is severity=WARNING.** A single transport hiccup will surface in SecOps dashboards. Acceptable — better noisy than silent on email delivery failures.
5. **Session detection on the verify page calls `/v1/auth/me` even for users we know are anonymous.** Adds one extra round trip on the verified-state render. Could be conditioned on a "saw session cookie" hint from the verify response. Low priority.

## Exact next phase recommendation

**R8.1.8 — Preference SPA + digest preview + per-admin email rendering polish.** Specifically:

1. Build a small admin-facing preferences card under `/security-center` that surfaces the `MfaAdminDigestPreference` rows with toggle + snooze controls (today admins must call the PATCH endpoint directly).
2. Add a `POST /v1/identity/mfa-admin/digest-preferences/preview` endpoint that returns the digest payload the admin WOULD receive on the next tick — no actual email send. Useful for testing preference changes.
3. Add an HTML version of the consolidated digest email (currently plain text only) using the existing `emailShell` helper for parity with other transactional emails.
4. Add a per-admin "snooze until" quick-action chip in the admin SPA that calls the PATCH endpoint with `suppressUntil: now + 7d`.

After R8.1.8 the MFA recovery surface is enterprise-pilot-complete pending the WebAuthn / hardware-token primitives that are R8.2 scope.
