# PHASE R8.1.6 — Recovery Verify Page, Per-Account Throttle, Quorum SPA & Pending Digest

**Status:** Shipped
**Date:** 2026-05-24
**Predecessors:** R8 → R8.1.5 (cryptographic MFA, orchestrator, login challenge, durable challenge store, org enforcement, scheduled GC, circuit breaker, admin lifecycle, lost-factor recovery with verified-email preflight + admin SPA + self-cancel + per-org fail-mode)

## What this phase closes

R8.1.5 ended with four named pilot-readiness gaps. R8.1.6 closes all four:

1. **User-facing email verification page** — the verify endpoint was live; the landing page that consumes the email link wasn't.
2. **Per-account recovery throttle** — request-level rate limiting was absent; a stolen session could spam the admin queue.
3. **Admin SPA quorum visibility** — the backend supported quorum-of-N but the UI didn't surface "N/M approvals recorded".
4. **Pending recovery digest email** — admins had to check the SPA proactively to discover requests sitting in `PENDING_ADMIN_REVIEW`.

## What this phase deliberately does NOT do

- Does NOT create a session from email verification. The verify page contains no `signJwt` / `setToken` / `setCookie` / `proovra_session` reference (contract test 4).
- Does NOT email any OTP, recovery code, signed pending token, TOTP secret, or per-user enumeration data (contract test 15).
- Does NOT introduce a parallel auth surface. The verify page lives under `/auth/mfa-recovery/verify` and uses the canonical `apiFetch` against the canonical R8.1.5 verify endpoint (contract test 16).
- Does NOT touch capture / upload / custody / report-package / TSA / OTS / finalization (contract test 19).
- Does NOT involve workflow / persona authorization (contract test 17).
- Does NOT change the recovery state machine. The state graph from R8.1.5 is unchanged — R8.1.6 only adds throttling at the entry edge and operational tooling around the existing transitions.

## Part 1 — User-facing recovery verify page

New page at `apps/web/app/auth/mfa-recovery/verify/page.tsx`.

### Behaviour

1. Reads `?id=` (request id) and `?token=` (raw verification token) from the URL.
2. Immediately strips the token from the visible URL via `history.replaceState` so back-button / share / browser-history does not leak it.
3. POSTs to `POST /v1/identity/mfa/recovery-requests/:id/verify-email` via the canonical `apiFetch`.
4. Renders one of three calm, bounded states:
   - **Verifying** (in-flight, spinner copy)
   - **Verified** ("Email verified" + explicit "did NOT log you in" warning + return-to-sign-in CTA)
   - **Error** with one of six bounded reasons: `missing_params`, `expired`, `invalid`, `wrong_user`, `already_handled`, `unknown`

### Hard rules (UI-enforced)

| Rule | Where |
|---|---|
| Token never lands in localStorage / sessionStorage | source-grep: no `localStorage.set` / `sessionStorage.set` (test 2) |
| Token never renders after submission | `history.replaceState` strips it; state never holds the token |
| Token never logged | no `console.log` / `authLogger` on token |
| Page does not issue a session | source-grep: no `signJwt` / `setToken` / `setCookie` / `proovra_session` (test 4) |
| Verified state explicitly states "did NOT log you in" | string check (test 4) |

### Error-state copy

| Reason | When | Copy summary |
|---|---|---|
| `missing_params` | URL missing `?id=` or `?token=` | "Recovery link incomplete — use the most recent email" |
| `expired` | endpoint returned `token_expired` | "Link expired — request a fresh recovery email" |
| `invalid` | endpoint returned `token_invalid` / 404 | "Link invalid — request a fresh recovery" |
| `wrong_user` | endpoint returned `wrong_user` | "Different account signed in — try in a private window" |
| `already_handled` | endpoint returned `request_not_in_email_pending` | "Already handled — no further action needed" (we collapse approved/cancelled/rejected/expired into one calm message; never leak the specific state) |
| `unknown` | other failure | Generic "try again, or contact admin" |

## Part 2 — Per-account recovery throttle

### Limits

| Constant | Value | Notes |
|---|---|---|
| `MFA_RECOVERY_PER_ACCOUNT_LIMIT` | 3 | Max recovery requests per user in any rolling 24h window |
| `MFA_RECOVERY_PER_ACCOUNT_WINDOW_SECONDS` | 86400 | 24 hours |

### Hard properties

- **DB-backed** (contract test 7). The throttle is a single `prisma.mfaRecoveryRequest.count({ where: { userId, createdAt: { gte: windowStart } } })`. No in-process Map / Set / counter — survives multi-instance / serverless / replicas.
- **Counts ALL recent rows** including cancelled, expired, rejected, completed. A hostile actor can NOT reset the counter by cancelling their own requests.
- **Returns `retryAfter`** — the soonest the user could try again, computed from the oldest in-window row's `createdAt + 24h`. The route surfaces this as an ISO string in the 429 response so the UI can render a calm "try again at HH:MM" message without leaking row counts.
- **Audited** — appends `mfa.recovery.throttled` to the platform audit log with `{ recentCount, limit, windowSeconds, teamId }` metadata.
- **Emits `mfa_recovery_throttled`** (new bounded security event). Payload: `{ actorUserId, recentCount, limit, windowSeconds }`. No raw tokens / OTPs / recovery codes anywhere.

### Route response

```json
HTTP/1.1 429 Too Many Requests
{ "error": "rate_limited", "retryAfter": "2026-05-25T10:34:12.000Z" }
```

## Part 3 — Admin SPA quorum progress

Updated `apps/web/app/(app)/security-center/mfa-recovery/page.tsx`.

### Table cell — `data-cc-mfa-recovery-quorum-count`

- Renders `approvalCount/requiredApprovals` in a fixed-width monospace cell so admins can scan the column.
- When `approvalCount > 0 && approvalCount < requiredApprovals`, renders a yellow `Waiting for additional approval` badge (`data-cc-mfa-recovery-quorum-waiting`).

### Approve confirmation modal — `data-cc-mfa-recovery-approve-quorum`

Now states three things explicitly:
1. **What gets revoked**: "ALL of user X's active MFA factors, invalidate their outstanding recovery codes, AND reset their trusted devices."
2. **What does NOT happen**: "Approval does **NOT** grant the user a session" (yellow warn box).
3. **Quorum context** (R8.1.6 addition):
   - When this approval would complete the quorum: *"Your approval will complete the quorum and revoke the user's factors immediately."*
   - When more admins are needed: *"Your approval still needs N additional admin(s) before factors are reset."*

The approve button is still disabled until `rq.emailVerified === true` (R8.1.5 invariant; contract test 10).

## Part 4 — Pending recovery digest

### Schema

New `MfaRecoveryDigestLog` table (append-only migration `20260727000000_r8_1_6_recovery_digest_logs`):

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | PK |
| `teamId` | UUID | FK → teams, CASCADE |
| `sentDate` | VARCHAR(10) | YYYY-MM-DD UTC |
| `sentAtUtc` | TIMESTAMPTZ | Audit timestamp |
| `pendingCount` | INT | Count at assembly time |
| `recipientCount` | INT | Admin count digest was sent to |

UNIQUE index on `(teamId, sentDate)` — at most one digest per team per UTC day, idempotent under concurrency.

### Worker

`services/worker/src/mfa-recovery-digest.ts` exports `runMfaRecoveryDigest()`. Wired into the existing scheduler lifecycle in `services/worker/src/index.ts`:

| Knob | Default | Env var |
|---|---|---|
| Enabled | `true` | `MFA_RECOVERY_DIGEST_ENABLED` |
| Interval | 6 hours | `MFA_RECOVERY_DIGEST_INTERVAL_MS` |
| Pending age threshold | 24 h | compiled-in |
| Max teams per tick | 50 | compiled-in |
| Max recipients per team | 25 | compiled-in |

### Lifecycle

1. Find `MfaRecoveryRequest` rows in `PENDING_ADMIN_REVIEW` with `createdAt < now - 24h`.
2. Group by team. Take up to `MAX_TEAMS_PER_TICK` teams.
3. For each team:
   - Check `mfaRecoveryDigestLog` for today's UTC date — if a row exists, skip (idempotent).
   - Look up ACTIVE OWNER/ADMIN team members with a resolvable email.
   - INSERT the digest log row (UNIQUE constraint catches racing workers).
   - For each admin, send the digest email via Resend's HTTP API directly (no SDK dep added to the worker).
   - Emit one `mfa_recovery_digest_sent` event per team with `{ trigger, pendingCount, recipientCount, sentDate }`.

### Email body

Plain-text + simple HTML. Carries ONLY:
- The bounded `pendingCount` integer.
- The team display name (or "your workspace" fallback).
- A deep link to `/security-center/mfa-recovery`.
- An explicit reminder: *"Approving a request does NOT grant a session — the user must still re-enroll."*

Contract test 13 enforces that the worker's email body does NOT include OTPs, recovery codes, signed tokens, raw verification tokens, or per-user enumeration.

### Idempotency under concurrency

Two workers racing on the same team will both see "no digest log row for today" in the read, then both attempt to INSERT. The UNIQUE `(teamId, sentDate)` constraint makes exactly one INSERT succeed; the loser catches the unique-violation and moves on without sending duplicate emails.

## Part 5 — Email service hardening

### New email type

`EmailService.sendMfaRecoveryAdminDigestEmail(adminEmail, teamDisplayName, pendingCount, adminSpaUrl)`:
- Subject: `${pendingCount} pending MFA recovery request(s) — ${teamName}`.
- Body: bounded count + admin SPA URL + "approval does NOT grant a session" reminder.
- No tokens, no OTPs, no recovery codes, no per-user enumeration.

The worker uses its own Resend HTTP-API client (Node 20+ `fetch`) so no new SDK dependency was added. The API's `EmailService` exposes the typed method for any future API-side trigger of the digest.

### Existing recovery verification email — unchanged

`sendMfaRecoveryVerificationEmail` from R8.1.5 already includes:
- Explicit "confirms mailbox access only" language.
- "Your administrator must still approve the reset" reminder.
- 15-minute TTL note.
- Support-warning footer for accidental recipients.

R8.1.6 leaves this email's wording untouched.

## Part 6 — Security events

2 new bounded events added to `SECURITY_EVENT_TYPES`:

| Event | Severity | Emitted from | `details` payload |
|---|---|---|---|
| `mfa_recovery_throttled` | WARNING | `mfa-recovery-request.service.ts` (create branch when over limit) | `{ actorUserId, recentCount, limit, windowSeconds }` |
| `mfa_recovery_digest_sent` | INFO | worker `mfa-recovery-digest.ts` (per team that received a digest) | `{ trigger, pendingCount, recipientCount, sentDate }` |

Privacy contract (contract test 15): no payload across ANY R8.1.6 surface contains `rawToken`, `emailToken`, `otpauth`, `secretCiphertext`/`secretIv`/`secretAuthTag`, `mfaPendingToken`, or per-user emails in event details / log objects.

## Files touched

### API

| Path | Change |
|---|---|
| `prisma/schema.prisma` | + `MfaRecoveryDigestLog` model with UNIQUE `(teamId, sentDate)`, Team back-relation |
| `prisma/migrations/20260727000000_r8_1_6_recovery_digest_logs/migration.sql` | Append-only migration |
| `src/services/security/mfa-recovery-request.service.ts` | + per-account throttle constants, DB-backed `prisma.count` check in `createRecoveryRequest`, `rate_limited` reason + `retryAfter`, `mfa_recovery_throttled` event |
| `src/services/email.service.ts` | + `sendMfaRecoveryAdminDigestEmail` (interface + implementation + unconfigured stub) |
| `src/routes/mfa-admin.routes.ts` | Create-request handler maps `rate_limited` → HTTP 429 with `retryAfter` ISO |

### Worker

| Path | Change |
|---|---|
| `src/mfa-recovery-digest.ts` | **NEW.** Bounded daily digest job: find stale `PENDING_ADMIN_REVIEW`, look up admin recipients, write idempotency log, send via Resend HTTP API, emit security event |
| `src/index.ts` | + `MFA_RECOVERY_DIGEST_*` env block; `startMfaRecoveryDigestScheduler` / `stopMfaRecoveryDigestScheduler` wired into existing scheduler lifecycle |

### Web

| Path | Change |
|---|---|
| `app/auth/mfa-recovery/verify/page.tsx` | **NEW.** User-facing email verify page with 3 result states + 6 bounded error reasons |
| `app/(app)/security-center/mfa-recovery/page.tsx` | Quorum N/M cell, "Waiting for additional approval" badge, approve modal quorum context, trusted-devices mention |

### Shared

| Path | Change |
|---|---|
| `packages/shared/src/security.ts` | + 2 R8.1.6 events with Phase marker |

### Tests

| Path | Change |
|---|---|
| `test/phase-r8-1-6-mfa-recovery-ux-completion.test.ts` | **NEW.** 22 tests (19 spec-numbered + 3 bonus) |
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
| Recovery verification does not grant session | ✅ Tests 4 + 15; page has no `signJwt`/`setToken`/`setCookie` |
| Admin approval does not grant session | ✅ R8.1.5 invariant preserved + modal text reinforces |
| Users cannot spam unlimited recovery requests | ✅ Test 6 — `rate_limited` at 3/24h |
| Quorum progress is visible to admins | ✅ Tests 9 + 11 — N/M cell + waiting badge + modal quorum block |
| Digest emails contain no secrets | ✅ Test 13 — body carries only count + team name + admin SPA URL |
| No raw tokens/codes/secrets logged | ✅ Test 15 across all R8.1.6 surfaces |
| No duplicate auth system | ✅ Test 16 — still only `auth.routes.ts` + `sso-auth.routes.ts` |
| No workflow/persona auth logic | ✅ Test 17 |
| No tenant isolation regression | ✅ Test 18 — recipients scoped by teamId; throttle by userId; digest log per-team |
| No capture/upload/finalize/custody/TSA/OTS/report/package regression | ✅ Test 19 |

## Remaining risks (honest)

1. **Verify-page success state does not auto-sign-in the user.** This is by design (the page exists exactly to NOT issue a session), but it means the user has to manually click "Return to sign in" after verification. A polish phase could detect a parallel SSO/credentials session and offer a more contextual next step.
2. **Per-account throttle is global across the user's teams.** A user with memberships in many teams hits the limit faster than a single-team user. We chose global (not per-team) on purpose — abuse from a stolen session does not care which team scope the requests are filed against — but org admins should be aware that prolific multi-team operators may legitimately bump into the limit.
3. **Digest job sends one email per admin per team per day** even when the same admin is in multiple flagged teams. Daily mail volume is bounded by `(admin count × pending teams)` per day per admin. Acceptable trade-off vs collapsing into a single multi-team email (would require admin-centric reorganisation of the digest model — future phase).
4. **No "stop digesting me" admin opt-out** yet. An admin currently has to either (a) leave the team, (b) get their admin role downgraded, or (c) wait for the daily de-dupe. A small `per-admin notification preference` row would close this — clean follow-on.
5. **Resend transport-side failures retry tomorrow, not immediately.** A digest send failure is logged + the team's digest log row still persists (idempotent), so the team is marked "digested today" even if the send didn't reach the admin. We chose this over "retry immediately" because immediate retry risks duplicate emails on partial-success scenarios; "tomorrow's tick covers it" is the safer enterprise default.

## Exact next phase recommendation

**R8.1.7 — Admin notification preferences + per-team digest grouping + verify-page session detection.** Specifically:

1. Add `MfaAdminDigestPreference` row keyed by `(userId, teamId)` so an admin can opt out of digest emails for a specific team (or globally). Service-side respect the preference when assembling recipients.
2. Refactor the digest worker to send ONE multi-team email per admin per day instead of one-per-team-per-admin. Reduces inbox noise for admins of many orgs.
3. On the user-facing verify page, detect a parallel authenticated session via `GET /v1/auth/me` and offer a contextual "Continue to home" CTA instead of the generic "Return to sign in".
4. Add a recovery-page-level analytics ping (success / each error reason) into `analytics-event.service.ts` so SecOps can dashboard the verify-page conversion rate without inspecting source.

After R8.1.7 the MFA series can be marked **enterprise-pilot-ready end-to-end** pending future authentication primitives (WebAuthn / hardware tokens / push-based MFA) which are R8.2 scope.
