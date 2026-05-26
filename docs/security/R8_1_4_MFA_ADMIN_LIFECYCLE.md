# PHASE R8.1.4 — MFA Admin Lifecycle, Scheduled GC & Circuit Breaker

**Status:** Shipped
**Date:** 2026-05-24
**Predecessors:** R8 (vocabulary + audit), R8.1 (cryptographic primitives + schema), R8.1.1 (orchestrator + REST endpoints + step-up), R8.1.2 (login MFA challenge), R8.1.3 (durable challenge store + org policy enforcement)

## What this phase closes

R8.1.3 honestly named five remaining gaps in its own doc. R8.1.4 closes all five:

1. **No scheduled GC** for `MfaPendingChallenge`. Opportunistic cleanup ran only on create/consume; replicas that never see either path could let the table grow.
2. **Fail-OPEN risk** when the enforcement resolver failed under Prisma outage. A sustained DB blip would silently allow MFA bypass.
3. **No admin lifecycle controls.** SecOps had no in-platform way to revoke a user's factor, force re-enrollment, or reset trusted devices.
4. **No lost-factor recovery.** Operators with no factor AND no recovery codes had only the "operator on-call DB UPDATE" path documented in R8.1.3.
5. **Dead in-memory deny list.** `verifyAndConsumeMfaPendingToken` + the process-local Map were no longer the production replay check, but were still exported and could mislead.

## What this phase deliberately does NOT do

- Does NOT add a bypass route or a "disable MFA and log in" shortcut. The recovery workflow only puts the user into the enrollment-required state — they still need to complete primary credentials AND enroll a fresh factor.
- Does NOT send OTP / recovery code / signed token over email. None of the new code paths surface secret material to anyone.
- Does NOT create a parallel auth system. The new routes live under `/v1/identity/mfa-admin/*` (an admin **sub**-domain of the canonical identity surface); the only auth route files under `src/routes/` matching `*auth*` are still `auth.routes.ts` + `sso-auth.routes.ts`. Contract test 14 enforces this.
- Does NOT touch capture / upload / custody / report-package / TSA / OTS / finalization. Contract test 17 enforces this.
- Does NOT introduce workflow / persona authorization. The enforcement resolver, admin lifecycle, and recovery services consult only canonical RBAC (team membership + role) and the existing org MFA policy. Contract test 15 enforces this.

## Part 1 — Scheduled MFA challenge cleanup

### Implementation

A new worker module `services/worker/src/mfa-challenge-gc.ts` exports `runMfaChallengeGc()`. The worker's existing `setInterval`-based scheduler (mirroring `capture-reaper`, `orphan-scan`, retention-reconciliation patterns) calls it every **15 minutes** by default.

| Knob | Default | Env var |
|---|---|---|
| Enabled | `true` | `MFA_CHALLENGE_GC_ENABLED` |
| Interval | 15 min | `MFA_CHALLENGE_GC_INTERVAL_MS` |
| Retention beyond expiry | 1 hour | `RETENTION_SECONDS` (compiled-in to keep API + worker definitions identical) |
| Pending-challenge batch | 200 rows | compiled-in |
| Recovery-request batch | 200 rows | compiled-in |

### Two cleanup paths in one tick

1. **`MfaPendingChallenge`** — deletes rows where `(consumedAt IS NOT NULL AND consumedAt < now - 1h)` OR `(expiresAt < now - 1h)`. Active rows in their 5-min window are NEVER deleted.
2. **`MfaRecoveryRequest`** — flips PENDING rows whose `expiresAt < now` to EXPIRED. APPROVED / REJECTED / COMPLETED rows are append-only audit trail and are not touched.

### Observability

A `SecurityEvent` with `eventType: "mfa_challenge_gc_completed"` is written on any non-trivial sweep. The event payload includes the trigger label, counts, retention window, and batch size — but NEVER any user id, IP, UA, or row content beyond the bounded numbers.

### Tests

R8.1.4 tests 1–3 lock the retention check (`lt: retentionCutoff` on both `consumedAt` and `expiresAt`), the bounded `take` (≤ 200), and the idempotent re-check of `status: "PENDING"` in the recovery-request UPDATE.

## Part 2 — Enforcement circuit breaker

### Strategy

`resolveLoginMfaEnforcement` now wraps EACH Prisma lookup in its own try/catch and classifies failures into three kinds:

| Kind | Meaning |
|---|---|
| `factor_lookup_failed` | Cannot read `MfaFactor` / `MfaRecoveryCode` |
| `membership_lookup_failed` | Cannot read `TeamMember` |
| `policy_lookup_failed` | Cannot read `OrganizationSecurityPolicy` |

The `circuitBreakerOutcome` helper consumes the kind + a flag (`hasObservedMembership`) and returns one of the three bounded outcomes plus emits exactly one event:

- `mfa_enforcement_degraded` (fail-OPEN with warning) — only for personal users with no membership AND no factor.
- `mfa_enforcement_failed_closed` (fail-CLOSED with deny) — every other class of failure for any user that looks org-scoped.

### Fail-mode env override

| Value | Behaviour |
|---|---|
| `smart` (default) | Personal users fail-OPEN; org-scoped users fail-CLOSED. Best balance for mixed-tenant deployments. |
| `closed` | EVERY classified error returns ENROLLMENT_REQUIRED (or MFA_REQUIRED if a factor is already known). Most conservative — recommended for high-security pilots. |
| `open` | EVERY classified error returns NOT_REQUIRED. Recommended only for low-risk demo environments; the spec calls this NOT recommended for enterprise. |

Set via `MFA_ENFORCEMENT_FAIL_MODE=closed` in API env when piloting a high-security tenant.

### What "smart" means in practice

- A user whose TeamMember lookup fails → the resolver cannot prove they're personal → treats them as org-scoped → fail-CLOSED.
- A user whose membership read succeeded with N > 0 active memberships, but whose policy lookup fails → fail-CLOSED.
- A user with NO observed memberships and a factor lookup failure → fail-OPEN (personal user; locking them out on a Prisma blip would be the wrong trade-off).

This is the simplest classification that satisfies the spec's "no silent bypass for org-required MFA" hard rule without locking every personal-account user out of the platform during a database hiccup.

### Tests

R8.1.4 tests 4–5 lock the org-scoped branch's outcome set (must contain `MFA_REQUIRED` and `ENROLLMENT_REQUIRED`, must NOT contain `NOT_REQUIRED`) and verify the env-override paths are wired.

## Part 3 — Admin MFA lifecycle controls

### New service: `mfa-admin-lifecycle.service.ts`

Pure backend service — every public function enforces the same tenant-isolation contract via the shared `assertAdminCanAct` guard:

1. Acting admin MUST be an ACTIVE OWNER/ADMIN of the team scope.
2. Target user MUST be an ACTIVE member of the SAME team.
3. Cross-team actions are refused with bounded failure codes (`admin_not_in_team` / `admin_not_admin` / `target_not_in_team`).

| Function | Purpose | Event | Side effect |
|---|---|---|---|
| `readUserMfaPosture` | Read-only count + last-used timestamp | none | none |
| `revokeUserFactor` | Revoke ONE factor | `mfa_admin_factor_revoked` | factor.status → REVOKED |
| `requireUserReenrollment` | Revoke ALL ACTIVE factors atomically | `mfa_admin_reenrollment_required` | all factors REVOKED |
| `resetTrustedDevicesForUser` | Revoke all team-scoped trusted devices | `mfa_trusted_devices_reset` | trusted_device rows REVOKED |
| `listRecentMfaEvents` | Recent MFA security events for the team | none | none |

NONE of these functions return OTP, recovery code, secret material, or any auth artifact. The most they return is a count + a bounded reason code.

### New routes: `mfa-admin.routes.ts`

All under `/v1/identity/mfa-admin/*` — a clearly-scoped admin sub-domain of the canonical identity surface. NEVER under `/v1/auth-admin/*` or `/v1/admin/login/*` (test 14 enforces this).

```
GET   /v1/identity/mfa-admin/posture/:teamId/:userId
POST  /v1/identity/mfa-admin/factors/:teamId/:userId/:factorId/revoke
POST  /v1/identity/mfa-admin/factors/:teamId/:userId/require-reenrollment
POST  /v1/identity/mfa-admin/trusted-devices/:teamId/:userId/reset
GET   /v1/identity/mfa-admin/events/:teamId
GET   /v1/identity/mfa-admin/recovery-requests/:teamId
POST  /v1/identity/mfa-admin/recovery-requests
POST  /v1/identity/mfa-admin/recovery-requests/:requestId/approve
POST  /v1/identity/mfa-admin/recovery-requests/:requestId/reject
```

Every endpoint requires `requireAuth`. Every admin endpoint additionally enforces the OWNER/ADMIN scope at the service layer.

### Tests

R8.1.4 tests 6–9 lock the scope guard's three failure codes, verify both admin- and target-membership lookups are scoped by the explicit teamId, prove `revokeUserFactor` flips status (never deletes), and assert each lifecycle action emits the corresponding security event + audit log.

## Part 4 — Lost-factor recovery workflow

### Schema

New `MfaRecoveryRequest` + `MfaRecoveryRequestApproval` tables (append-only migration `20260725000000_r8_1_4_mfa_recovery_requests`). Append-only approval ledger with a `UNIQUE (requestId, approverUserId)` constraint so the same admin cannot double-approve.

### Lifecycle

```
PENDING ──(admin approves; quorum reached)──► APPROVED
        ──(admin approves; below quorum)────► PENDING (approval row recorded)
        ──(admin rejects)────────────────────► REJECTED
        ──(TTL elapsed; worker GC)───────────► EXPIRED
APPROVED ──(user re-enrolls)──────────────────► COMPLETED
```

### Hard properties

| Property | Where enforced |
|---|---|
| User MUST be ACTIVE member of the target team | `createRecoveryRequest` |
| At most one PENDING request per (user, team) | `createRecoveryRequest` returns `already_pending` |
| Approver MUST be ACTIVE OWNER/ADMIN of the team | `approveRecoveryRequest` |
| User CANNOT approve their own request | `approveRecoveryRequest` returns `cannot_self_approve` |
| Double-approval refused | `UNIQUE (requestId, approverUserId)` constraint |
| Approval is append-only | new row in `MfaRecoveryRequestApproval`, never an update |
| Approved request atomically revokes all ACTIVE factors AND invalidates outstanding recovery codes | `prisma.$transaction([...])` |
| Recovery NEVER issues a session | `RECOVERY_SVC.ts` contains no `signJwt`, no `setCookie`, no `proovra_session` — test 10 enforces |
| Recovery NEVER hands the admin a code | service returns counts + bounded enums only |
| Quorum bump available for high-risk orgs | `requiredApprovals` column, default 1, max 3 |

### Tests

R8.1.4 tests 10–11 prove the workflow never mints a session and that the APPROVED transition is a single `prisma.$transaction` with three writes (status update + factor revocation + recovery-code invalidation).

## Part 5 — In-memory JTI deny-list removed

### What was removed from `jwt.ts`

| Symbol | Disposition |
|---|---|
| `mfaPendingDenyList` (Map) | **removed** |
| `gcMfaPendingDenyList` | **removed** |
| `MFA_PENDING_GC_INTERVAL_MS` | **removed** |
| `mfaPendingGcLastRun` | **removed** |
| `verifyAndConsumeMfaPendingToken` | **removed** |
| `__resetMfaPendingDenyListForTests` | **removed** |

### What remains

- `signMfaPendingToken(payload, secret, jti?)` — production callers pass the JTI returned by `createMfaPendingChallenge`.
- `verifyMfaPendingTokenSignature(token, secret)` — pure HMAC + discriminator check. NO in-process side effect.
- `MFA_PENDING_TTL_SECONDS` — TTL constant.

### Caller audit

The only non-test caller of the removed `verifyAndConsumeMfaPendingToken` was `jwt.ts` itself. The R8.1.3 verify endpoint already moved to `verifyMfaPendingTokenSignature` + `consumeMfaPendingChallenge` (durable). R8.1.2 contract tests 3–4 were updated to verify the equivalent pure-signature semantics.

### Tests

R8.1.4 test 12 grep-asserts none of the removed symbol names appear in `jwt.ts`; the bonus "auth.routes.ts no longer imports the removed legacy helper" test reinforces this from the caller side.

## Part 6 — Security events

Nine new bounded events added to `SECURITY_EVENT_TYPES`. The bonus "appears exactly once" test detects accidental duplicate insertions.

| Event | Severity | Emitted from | Payload (`details`) |
|---|---|---|---|
| `mfa_challenge_gc_completed` | INFO | worker `mfa-challenge-gc.ts` | `{ trigger, challengesDeleted, recoveryRequestsExpired, retentionSeconds, batchSize }` |
| `mfa_enforcement_degraded` | WARNING | `login-mfa-enforcement.service.ts` | `{ actorUserId, kind, failMode }` |
| `mfa_enforcement_failed_closed` | WARNING | `login-mfa-enforcement.service.ts` | `{ actorUserId, kind, failMode }` |
| `mfa_admin_factor_revoked` | WARNING | `mfa-admin-lifecycle.service.ts` | `{ actorUserId, targetUserId, factorId }` |
| `mfa_admin_reenrollment_required` | WARNING | `mfa-admin-lifecycle.service.ts` | `{ actorUserId, targetUserId, revokedFactorCount }` |
| `mfa_trusted_devices_reset` | WARNING | `mfa-admin-lifecycle.service.ts` | `{ actorUserId, targetUserId, resetCount }` |
| `mfa_recovery_requested` | WARNING | `mfa-recovery-request.service.ts` | `{ actorUserId, requestId, requiredApprovals }` |
| `mfa_recovery_approved` | WARNING | `mfa-recovery-request.service.ts` | `{ actorUserId, targetUserId, requestId }` |
| `mfa_recovery_completed` | INFO | `mfa-recovery-request.service.ts` | `{ actorUserId, requestId }` |

Test 13 enforces that NO payload across all R8.1.4 surfaces carries `code:`, `recoveryCode:`, `otpauth`, `secret*`, `mfaPendingToken:`, or `token:`.

## Part 7 — Security Center admin surface

The `/security-center` page received a new conditional section: **Pending MFA recovery requests** (rendered only when the list is non-empty, which itself only fires for OWNER/ADMIN viewers because the API returns 403 to non-admins).

Each request row shows:
- Truncated target user id
- The user's free-text reason
- Approval progress (`N / M`)
- Expiry timestamp

The render layer points operators to the canonical admin endpoints (`POST /v1/identity/mfa-admin/recovery-requests/:id/approve`) rather than re-implementing the approval UI inline. A dedicated admin SPA / button-driven surface is **honestly deferred to R10** (the doc names this explicitly so SecOps know the endpoints are usable today via `curl` / a Postman collection / a tiny ops script even before the rich UI lands).

## Files touched

### API

| Path | Change |
|---|---|
| `prisma/schema.prisma` | + `MfaRecoveryRequest`, `MfaRecoveryRequestApproval`, `MfaRecoveryRequestStatus` enum + back-relations on `User` + `Team` |
| `prisma/migrations/20260725000000_r8_1_4_mfa_recovery_requests/migration.sql` | NEW append-only migration |
| `src/services/jwt.ts` | Removed `mfaPendingDenyList`, `gcMfaPendingDenyList`, `verifyAndConsumeMfaPendingToken`, `__resetMfaPendingDenyListForTests`. Updated R8.1.2 comment block to reflect R8.1.4 deletion |
| `src/services/security/login-mfa-enforcement.service.ts` | Wrapped each Prisma lookup in try/catch. New `circuitBreakerOutcome` helper with classified errors + env-overrideable `EnforcementFailMode` |
| `src/services/security/mfa-admin-lifecycle.service.ts` | **NEW.** Admin read/write surface, every function gated by `assertAdminCanAct` |
| `src/services/security/mfa-recovery-request.service.ts` | **NEW.** Lost-factor recovery workflow with atomic approve-and-revoke |
| `src/routes/mfa-admin.routes.ts` | **NEW.** 9 endpoints under `/v1/identity/mfa-admin/*` |
| `src/server.ts` | Registers `mfaAdminRoutes` |

### Worker

| Path | Change |
|---|---|
| `src/mfa-challenge-gc.ts` | **NEW.** Bounded GC for `MfaPendingChallenge` + `MfaRecoveryRequest` PENDING-expiry. Emits one `mfa_challenge_gc_completed` event per non-trivial sweep |
| `src/index.ts` | New `MFA_CHALLENGE_GC_ENABLED` / `MFA_CHALLENGE_GC_INTERVAL_MS` env block; `startMfaChallengeGcScheduler` / `stopMfaChallengeGcScheduler` wired into the existing scheduler lifecycle |

### Web

| Path | Change |
|---|---|
| `app/(app)/security-center/page.tsx` | + Pending recovery requests admin card (only renders when list non-empty) |

### Shared

| Path | Change |
|---|---|
| `packages/shared/src/security.ts` | + 9 R8.1.4 event types in `SECURITY_EVENT_TYPES` with the `Phase R8.1.4` marker comment |

### Tests

| Path | Change |
|---|---|
| `test/phase-r8-1-4-mfa-admin-lifecycle.test.ts` | **NEW.** 23 tests (17 numbered + 6 bonus: bounded vocabulary additions, server wiring, security-center surface, removed-symbol assertions, file-size sentinel) |
| `test/phase-r8-1-2-login-mfa.test.ts` | Updated tests 3–4 to use `verifyMfaPendingTokenSignature` (replay protection is now durable-only) |
| `test/phase-32-7-2-security-event-mapping-drift.test.ts` | Migration allow-list extended with the R8.1.4 migration |

## Validation evidence

- `pnpm --filter proovra-api prisma generate` ✅
- `pnpm --filter proovra-api typecheck` ✅
- `pnpm --filter proovra-api test` ✅ (run as part of 6/6 gate)
- `pnpm --filter proovra-web typecheck` ✅
- `pnpm --filter proovra-web build` ✅
- `pnpm --filter proovra-worker typecheck` ✅
- `pnpm --filter proovra-worker test` ✅

## Hard confirmations (per spec)

| Confirmation | Status |
|---|---|
| Expired MFA challenges are cleaned safely | ✅ Worker scheduled GC every 15 min; cuts only past-retention rows; bounded 200/call; idempotent under concurrency |
| Org-required MFA is not silently bypassed | ✅ Circuit breaker classifies errors; `smart`-mode org-scoped failures emit `mfa_enforcement_failed_closed` and return MFA_REQUIRED or ENROLLMENT_REQUIRED (test 4) |
| Admin MFA actions are org-scoped and audited | ✅ `assertAdminCanAct` enforces three-class scope checks; every action emits both audit log + security event (tests 6–9) |
| Lost-factor recovery does NOT grant direct full-session bypass | ✅ Recovery service contains no `signJwt` / `setCookie` / `proovra_session` (test 10); admin routes likewise |
| Replay protection remains durable | ✅ R8.1.3 durable consume unchanged; in-memory deny-list removed (test 12) |
| No OTP / recovery / secret / token leakage | ✅ Privacy contract test 13 across all R8.1.4 surfaces |
| No duplicate auth system introduced | ✅ Admin routes under `/v1/identity/mfa-admin/*`; only `auth.routes.ts` + `sso-auth.routes.ts` remain in `routes/` matching `*auth*` (test 14) |
| No workflow/persona auth logic introduced | ✅ Test 15 |
| No tenant isolation regression | ✅ Test 16 — every admin lookup keyed by explicit teamId; recovery requests bound to single teamId; schema `teamId NOT NULL` |
| No capture/upload/finalize/custody/TSA/OTS/report/package regression | ✅ Test 17 |

## Remaining risks (honest)

1. **Admin UI is API-first only.** Operators today approve / reject recovery requests via the canonical endpoints; the security-center surface only LISTS pending ones. A button-driven admin SPA (with confirm-modal, optional second-approver UI, and event-feed integration) is honestly deferred to **R10**. This is the right scope split — the recovery model is enterprise-safe today even without the rich UI.
2. **No verified-email step in recovery.** The spec mentioned a "verified email step if available" as part of the recovery workflow. R8.1.4 ships the bare bones (user request → admin approve); adding an email-confirm preflight is a natural R8.1.5 addition. The current model still requires at least one ADMIN-role approver from the user's team, so the absence of email-confirm does not weaken tenant isolation.
3. **Single-instance scheduler.** The worker's `setInterval` is per-process, like every other scheduler in `services/worker/src/index.ts`. If two worker replicas are run, both will tick — the GC operations are idempotent so this is correct (the second replica observes zero stale rows), but a future BullMQ-based version with a global lock would reduce wasted queries.
4. **No automatic recovery-request cancellation when the user re-enrolls outside the workflow.** A user who somehow regains access to their factor and self-enrolls a second one will leave a PENDING request hanging — the worker GC will expire it after 7 days. Low-risk; the request carries no privileged grant on its own.
5. **`MFA_ENFORCEMENT_FAIL_MODE` is global, not per-org.** A future phase could read fail-mode from the `OrganizationSecurityPolicy` row so different orgs can adopt different conservatism levels. Low priority — the global `smart` default is already enterprise-safe.

## Exact next phase recommendation

**R8.1.5 — Verified-email recovery preflight + admin SPA + per-org fail-mode.** Specifically:

1. Add an email-confirm preflight to `createRecoveryRequest`: user clicks an emailed link to confirm the request was THEY who initiated it before it appears in the admin queue. Reduces the risk of an attacker who briefly captured a session filing junk requests.
2. Build the recovery-request admin SPA (approve / reject / detail view, with the second-approver flow surfaced for quorum-of-2 orgs) under `apps/web/app/(app)/security-center/mfa-recovery/`.
3. Add `mfaEnforcementFailMode` to `OrganizationSecurityPolicy` and have the resolver read it per-team (still defaulting to the env global). Enables per-org conservatism levels for mixed pilots.
4. Add a self-cancellation route so a user who regains MFA outside the workflow can dismiss their own PENDING request without waiting for the 7-day expiry.

After R8.1.5 the MFA series can be marked **enterprise-pilot-ready** pending future authentication primitives (WebAuthn / hardware tokens / push-based MFA) which are R8.2 scope.
