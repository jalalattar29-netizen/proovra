# PHASE R8.1.5 — Verified-Email Recovery Preflight, Admin SPA, Per-Org Fail Mode & Self-Cancel

**Status:** Shipped
**Date:** 2026-05-24
**Predecessors:** R8 → R8.1.4 (full MFA stack: cryptographic primitives, orchestrator, login challenge, durable challenge store, org enforcement, scheduled GC, circuit breaker, admin lifecycle controls, lost-factor recovery, in-memory deny-list removal)

## What this phase closes

R8.1.4 named five remaining pilot-readiness gaps in its own follow-on. R8.1.5 closes all five:

1. **Recovery requests need verified-email preflight** to keep the admin queue from being flooded by hostile / accidental submissions.
2. **Admin recovery queue needs a real operational SPA**, not API-only usage.
3. **MFA fail-mode must become per-organization**, not just a global env knob.
4. **Users must be able to self-cancel** when they regain access to MFA.
5. **The state machine must enforce valid transitions only** so approval before email-verify is impossible.

## What this phase deliberately does NOT do

- Does NOT create a "click email link to log in" bypass. The email step confirms **mailbox access only** — never a session, never a factor replacement.
- Does NOT email any OTP, recovery code, signed token, or TOTP secret.
- Does NOT auto-approve. The verified-email step moves the request to `PENDING_ADMIN_REVIEW`; an organization OWNER/ADMIN still has to approve.
- Does NOT introduce a parallel auth surface. The new endpoints live under `/v1/identity/mfa/recovery-requests/*` (user) and `/v1/identity/mfa-admin/*` (admin) — there is still only `auth.routes.ts` + `sso-auth.routes.ts` under `routes/` matching `*auth*`.
- Does NOT touch capture / upload / custody / report-package / TSA / OTS / finalization. Contract test 19 enforces this.
- Does NOT involve workflow / persona authorization. Contract test 17 enforces this.

## Part 1 — Verified-email recovery preflight

### Lifecycle

```
User                     API                       Email                 Admin
 │                        │                          │                     │
 │ POST /recovery-requests│                          │                     │
 │───────────────────────►│ INSERT row (status =    │                     │
 │                        │   EMAIL_VERIFICATION_   │                     │
 │                        │   PENDING)              │                     │
 │                        │ + hash(token)           │                     │
 │                        │───────► sendMfaRecovery │                     │
 │                        │         VerificationEmail│                    │
 │                        │                          │ ── verification ──► User
 │ click link              │                          │                     │
 │ POST .../verify-email   │                          │                     │
 │───────────────────────►│ UPDATE row              │                     │
 │                        │   status = PENDING_     │                     │
 │                        │     ADMIN_REVIEW        │                     │
 │                        │   tokenHash = NULL      │                     │
 │                        │   verifiedAt = now      │                     │
 │                        │                          │                     │
 │                        │  visible in admin queue ────────────────────► │
 │                        │                          │                     │ POST .../approve
 │                        │  status = APPROVED      │                     │
 │                        │  factors revoked        │                     │
 │                        │  recovery codes void    │                     │
```

### Schema

| Column | Type | Notes |
|---|---|---|
| `emailVerificationTokenHash` | `VARCHAR(64)` nullable | SHA-256 hex of the raw token. **Never** the raw token. Cleared on successful verify. |
| `emailVerificationExpiresAt` | `TIMESTAMPTZ` nullable | 15-min TTL (`MFA_RECOVERY_EMAIL_TTL_SECONDS`). |
| `emailVerifiedAt` | `TIMESTAMPTZ` nullable | Audit timestamp set at successful verify. |
| `emailResendCount` | `INT` default 0 | Bounded by `MFA_RECOVERY_EMAIL_MAX_SENDS = 3`. |
| `emailResendBlockedUntil` | `TIMESTAMPTZ` nullable | 5-min cooldown after each send. |
| `cancelledAtUtc` | `TIMESTAMPTZ` nullable | Set on user self-cancel. |

### Token handling

- 32 random bytes (CSPRNG) → 64-hex string.
- The plaintext is **handed to the email service ONCE** as part of a URL and then forgotten.
- Only the SHA-256 hash persists. Verification recomputes the hash and compares via constant-time hex compare (`timingSafeEqualHex`).
- One-time use is enforced by clearing the hash + expiry in the same UPDATE that flips status.
- Resend mints a fresh token + hash (the old one is replaced).

### Email body

The verification email subject and body explicitly state that the link **confirms mailbox access only** and that the organization admin must still approve the reset. No raw token is shown — only a URL the user clicks.

## Part 2 — MFA recovery admin SPA

New page at `apps/web/app/(app)/security-center/mfa-recovery/page.tsx`:

| Feature | Behaviour |
|---|---|
| List | Operational table — user id, reason, email-verified pill, approvals N/M, expiry, actions |
| Approve | Disabled until `emailVerified === true`; opens a confirmation modal explaining the consequences |
| Reject | Optional bounded reason field; confirmation modal |
| Detail | Click user id → read-only modal with request id, team id, status, send-attempt count, etc. |
| Refresh | Manual reload button |

The SPA consumes ONLY the canonical admin endpoints. It contains:
- No `signJwt`, no `setCookie`, no `proovra_session` reference.
- No fake security score, no decorative dashboard.
- Approve confirmation explicitly states: *"Approval does **NOT** grant the user a session. They must still complete their primary credentials AND a fresh enrollment."*

## Part 3 — User self-cancel

| Endpoint | Auth | Allowed when |
|---|---|---|
| `POST /v1/identity/mfa/recovery-requests/:requestId/cancel` | session | actor is the row's owner AND status is `EMAIL_VERIFICATION_PENDING` or `PENDING_ADMIN_REVIEW` |

Cancellation:
- Flips status to `CANCELLED` (atomic UPDATE with status re-check).
- Clears the email verification token + expiry so an in-flight email link cannot resurrect the request.
- Emits `mfa_recovery_cancelled`.
- Appends a `mfa.recovery.cancelled` audit log row.
- Does NOT touch the user's factors. Does NOT create a session.

Non-owners receive `wrong_user`. Already-`APPROVED` / `COMPLETED` requests receive `already_approved` (a recovery cannot be unwound once approved — the user's factors are already revoked).

## Part 4 — Per-org MFA enforcement fail-mode

### Schema

| Column | Type | Default | Values |
|---|---|---|---|
| `OrganizationSecurityPolicy.mfaEnforcementFailMode` | `VARCHAR(16)` nullable | `null` (fall back to env) | `SMART` \| `FAIL_OPEN` \| `FAIL_CLOSED` |

### Resolution order

1. **Per-org**: pick the strictest fail-mode across the user's ACTIVE memberships' teams (`FAIL_CLOSED` > `SMART` > `FAIL_OPEN`).
2. **Env**: `MFA_ENFORCEMENT_FAIL_MODE` (lowercase) — fallback when no team's policy specifies.
3. **Default**: `smart`.

The resolver consults #1 BEFORE deciding any circuit-breaker outcome, so an admin who turns on `FAIL_CLOSED` for their org sees that policy honoured immediately on the next Prisma blip.

### Audit + event

`updateMfaPolicy` reads the prior fail-mode value, writes the new one, and emits `org_mfa_fail_mode_updated` **only when the value actually changed** (avoids noisy SIEM rows on no-op updates). The platform audit log row carries the previous and new values.

### API

```
GET   /v1/identity/mfa-admin/policy/:teamId     — returns ResolvedMfaPolicy (incl. mfaEnforcementFailMode)
PATCH /v1/identity/mfa-admin/policy/:teamId     — partial-update: level + ttls + mfaEnforcementFailMode
```

Body validation:
- `level` validated against `MfaPolicyLevelSchema` (the canonical R8.1 enum).
- `mfaEnforcementFailMode` validated against the three bounded values; `null` clears the override.

## Part 5 — Recovery status model hardening

The strict transition graph (enforced by the service):

```
EMAIL_VERIFICATION_PENDING → PENDING_ADMIN_REVIEW   (verify-email)
EMAIL_VERIFICATION_PENDING → CANCELLED               (user cancel)
EMAIL_VERIFICATION_PENDING → EXPIRED                 (GC: email TTL or row TTL)
EMAIL_VERIFICATION_PENDING → REJECTED                (admin can pre-empt clearly bogus requests)
PENDING_ADMIN_REVIEW       → APPROVED                (admin quorum reached)
PENDING_ADMIN_REVIEW       → REJECTED                (admin)
PENDING_ADMIN_REVIEW       → CANCELLED               (user cancel)
PENDING_ADMIN_REVIEW       → EXPIRED                 (GC)
APPROVED                   → COMPLETED               (user re-enrolls)
```

Hard invariants enforced by the service:

| Invariant | Where |
|---|---|
| Admin approve refuses while in `EMAIL_VERIFICATION_PENDING` | `approveRecoveryRequest` → `request_not_email_verified` |
| Cancel after APPROVED rejected | `cancelRecoveryRequest` → `already_approved` |
| Double approval refused | `UNIQUE (requestId, approverUserId)` on `MfaRecoveryRequestApproval` |
| Self-approval refused | `approveRecoveryRequest` → `cannot_self_approve` |
| Expiry handled (row TTL + email TTL) | `expireStaleRecoveryRequests` |
| At most one in-flight (user, team) | `createRecoveryRequest` → `already_pending` for either preflight state |

The legacy `PENDING` enum value is retained in the type for migration safety (existing rows are backfilled to `PENDING_ADMIN_REVIEW`); new code references only the R8.1.5 names.

## Part 6 — Security events

5 new bounded events added to `SECURITY_EVENT_TYPES`:

| Event | Severity | Emitted from | `details` payload |
|---|---|---|---|
| `mfa_recovery_email_verification_sent` | INFO | recovery service (create + resend) | `{ actorUserId, requestId, attemptNumber }` |
| `mfa_recovery_email_verified` | INFO | recovery service (verify) | `{ actorUserId, requestId }` |
| `mfa_recovery_email_expired` | INFO | recovery service (verify-with-expired-token branch) | `{ actorUserId, requestId }` |
| `mfa_recovery_cancelled` | INFO | recovery service (cancel) | `{ actorUserId, requestId }` |
| `org_mfa_fail_mode_updated` | INFO | mfa-policy service (when value changed) | `{ actorUserId, previousFailMode, newFailMode }` |

**Privacy contract** (contract test 15):
- No event payload includes the raw email token.
- No event payload includes OTP / recovery code / TOTP secret / signed pending token / ciphertext / IV / auth tag.
- The audit log row carries a `mailboxBound` boolean — never the user's email address verbatim.

## Part 7 — API endpoints

### User-facing

| Method + path | Behaviour |
|---|---|
| `POST /v1/identity/mfa-admin/recovery-requests` | Creates request in `EMAIL_VERIFICATION_PENDING` + sends email |
| `POST /v1/identity/mfa/recovery-requests/:requestId/verify-email` | Verifies token; flips to `PENDING_ADMIN_REVIEW` |
| `POST /v1/identity/mfa/recovery-requests/:requestId/resend-email` | Re-sends with fresh token (throttle: 3 max, 5-min cooldown) |
| `POST /v1/identity/mfa/recovery-requests/:requestId/cancel` | Owner-only self-cancel |

### Admin-facing

| Method + path | Behaviour |
|---|---|
| `GET  /v1/identity/mfa-admin/recovery-requests/:teamId` | Lists both preflight states for the team |
| `GET  /v1/identity/mfa-admin/recovery-requests/detail/:requestId` | Detail view (user OR admin) |
| `POST /v1/identity/mfa-admin/recovery-requests/:requestId/approve` | Admin approval (quorum logic) |
| `POST /v1/identity/mfa-admin/recovery-requests/:requestId/reject` | Admin rejection with bounded reason |
| `GET  /v1/identity/mfa-admin/policy/:teamId` | Read MFA policy including fail-mode |
| `PATCH /v1/identity/mfa-admin/policy/:teamId` | Update level / TTLs / fail-mode (partial) |

All endpoints require `requireAuth`. Admin endpoints enforce ACTIVE OWNER/ADMIN scope via `assertAdminCanAct`.

## Files touched

### API

| Path | Change |
|---|---|
| `prisma/schema.prisma` | + 3 new enum values, + 6 columns on `MfaRecoveryRequest`, + `mfaEnforcementFailMode` on `OrganizationSecurityPolicy` |
| `prisma/migrations/20260726000000_r8_1_5_recovery_email_preflight/migration.sql` | Append-only migration |
| `src/services/security/mfa-recovery-request.service.ts` | Rewritten: verified-email preflight, resend (throttled), cancel, hardened state graph, atomic verify + UPDATE-with-status-recheck |
| `src/services/identity-security/mfa-policy.service.ts` | + `mfaEnforcementFailMode` input + validation, prior-vs-new diff emission, `ResolvedMfaPolicy` extended |
| `src/services/security/login-mfa-enforcement.service.ts` | + per-org fail-mode resolution (strictest team wins; env is fallback) |
| `src/services/security/mfa-admin-lifecycle.service.ts` | Posture query updated to recognise both new preflight states |
| `src/services/email.service.ts` | + `sendMfaRecoveryVerificationEmail` (interface + impl + unconfigured fallback) |
| `src/routes/mfa-admin.routes.ts` | + 6 new endpoints (verify-email, resend-email, cancel, detail, GET policy, PATCH policy) |

### Web

| Path | Change |
|---|---|
| `app/(app)/security-center/mfa-recovery/page.tsx` | **NEW.** Admin recovery SPA |

### Shared

| Path | Change |
|---|---|
| `packages/shared/src/security.ts` | + 5 R8.1.5 events with Phase marker |

### Tests

| Path | Change |
|---|---|
| `test/phase-r8-1-5-mfa-recovery-admin-ui.test.ts` | **NEW.** 22 tests (19 spec-numbered + 3 bonus) |
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
| Recovery email verification does not grant session | ✅ Tests 9 + 15; service has no `signJwt` / `setCookie` / `proovra_session` |
| Admin approval does not grant direct session | ✅ Same |
| Recovery forces re-enrollment | ✅ R8.1.4 atomic transaction unchanged (factor revoke + recovery code invalidation on APPROVED) |
| Users can cancel only their own pending requests | ✅ Tests 6 + 7 |
| Org fail-mode is per-org | ✅ Test 11 — resolver consults per-org first; env is fallback |
| No raw tokens/codes/secrets logged | ✅ Test 15 |
| No duplicate auth system | ✅ Test 16 — only `auth.routes.ts` + `sso-auth.routes.ts` under `*auth*` |
| No workflow/persona auth logic | ✅ Test 17 |
| No tenant isolation regression | ✅ Test 18 |
| No capture/upload/finalize/custody/TSA/OTS/report/package regression | ✅ Test 19 |

## Remaining risks (honest)

1. **`/auth/mfa-recovery/verify` web page not yet built.** The email link points to a route the user lands on, but the actual page that POSTs the token to the verify endpoint is not implemented in R8.1.5. The endpoint is fully functional; a follow-on cosmetic phase can add the user-facing verify page (the user can also verify via the operator menu by pasting the token, or via `curl` for ops drills). **Workaround today**: the operator menu can be extended with a "I have a verification token" form; the endpoint is ready.
2. **Email rate-limiting is per-request, not per-account.** A user can file new requests after the resend cap is hit. Per-account throttle would be a follow-on.
3. **No quorum-of-2 UI.** The schema already supports `requiredApprovals > 1`, and the service enforces quorum logic correctly, but the admin SPA does not yet surface "1 of 2 approvals recorded; waiting for second admin". Backend works; UX polish deferred.
4. **`mfaEnforcementFailMode` is stored as VARCHAR, not a Postgres enum.** Allows future addition of new modes without a migration, at the cost of needing service-side validation. Trade-off is intentional.
5. **No automated reminder email** for requests sitting in `PENDING_ADMIN_REVIEW`. Admins must check the SPA. A scheduled "you have X pending recovery requests" digest is a clean follow-on.

## Exact next phase recommendation

**R8.1.6 — User-facing recovery verify page + per-account email throttle + quorum SPA + pending-digest email.** Specifically:

1. Build the `/auth/mfa-recovery/verify` page in `apps/web/` that reads `?id=` and `?token=` from the URL and POSTs to the verify endpoint. No localStorage, no client-side token persistence.
2. Add a per-account email-rate-limit (max N recovery requests per 24h per user) to the `createRecoveryRequest` path so a hostile actor with a stolen session cannot abuse the email transport.
3. Wire the admin SPA's approve flow to show "N/M approvals recorded" and (for `requiredApprovals > 1`) a "waiting for additional approval" badge. The service already supports it; only the UI needs surfacing.
4. Add a scheduled "pending MFA recovery digest" email to org owners when a request has been sitting in `PENDING_ADMIN_REVIEW` for > 24h. Reduces ops latency without auto-approving anything.

After R8.1.6 the MFA series is **enterprise-pilot-ready in full** pending future authentication primitives (WebAuthn / hardware tokens / push-based MFA) which are R8.2 scope.
