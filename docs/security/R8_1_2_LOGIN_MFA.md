# PHASE R8.1.2 — Login-time MFA Challenge Integration

**Status:** Shipped
**Date:** 2026-05-24
**Predecessors:** R8 (vocabulary + audit), R8.1 (cryptographic primitives + schema), R8.1.1 (orchestrator + REST endpoints + step-up)
**Companion phase:** R8.1A (React runtime stabilization — see `docs/recovery/R8_1A_REACT_RUNTIME_STABILIZATION.md`)

## What this phase does

R8.1.2 closes the last gap in the R8.1 series: it inserts the second-factor checkpoint between primary credential validation (password / Google / Apple / OIDC) and full-session issuance. Before this phase, an operator who had enrolled a TOTP factor under R8.1.1 saw it ONLY at step-up. After this phase, the same factor is required at every login.

## What this phase deliberately does NOT do

- **Does NOT create a second login system.** The canonical Fastify auth routes in `services/api/src/routes/auth.routes.ts` + `routes/sso-auth.routes.ts` remain authoritative.
- **Does NOT duplicate verification logic.** The new `POST /v1/auth/mfa/verify` endpoint delegates verification to the same `mfa.service.ts` functions that step-up uses (`verifyActiveTotp`, `consumeRecoveryCode`). Source-contract test 11 forbids `createHmac` / `scryptSync` in the verify endpoint.
- **Does NOT introduce a new event type.** All security events flow through the bounded `SECURITY_EVENT_TYPES` vocabulary in `packages/shared/src/security.ts`.
- **Does NOT change tenant isolation.** No reads or writes are scoped differently from the primary-credential layer.
- **Does NOT touch upload / finalization / custody / TSA / OTS / report / package logic.** R8.1.2 is a pre-session gate; downstream evidence flows are unmodified.
- **Does NOT implement org-wide MFA lockout policy.** That hook point is identified in this doc (see "Future hook points" below) but its enforcement is intentionally deferred to a follow-on phase.

## Challenge session model — design rationale

Three options were considered for the "I passed password, I still owe a second factor" state:

| Option | Pro | Con | Verdict |
|---|---|---|---|
| Reuse `StepUpChallenge` (Phase 19 / Twilio Verify) | Existing row + lifecycle | Bound to a phone number + Twilio; purpose enum doesn't include `LOGIN_MFA`; conflates two distinct flows | Rejected |
| New `MfaPendingChallenge` Prisma table | Multi-instance safe out of the box | Adds a write to the auth hot path; schema migration cost; another row to GC | Rejected (overkill for 5-min single-use state) |
| **Signed JWT (`mfa: "pending"` discriminator) + in-memory JTI deny list** | Zero DB writes, replay-resistant via JTI consumption, lifecycle bounded by 5-min TTL, distinct from the session cookie | Deny list is process-local (documented limitation) | **Chosen** |

### Properties

| Property | Value |
|---|---|
| Algorithm | HS256 (identical to canonical session JWT) |
| Secret | `AUTH_JWT_SECRET` (no new env var) |
| TTL | **300 seconds** (`MFA_PENDING_TTL_SECONDS`) — exact, enforced by test 2 |
| Single-use | Enforced by `verifyAndConsumeMfaPendingToken` consuming the `sid` (JTI) into a process-local Map |
| Cross-route protection | `requireAuth` middleware refuses any token where `payload.mfa === "pending"` → 401 (test 5) |
| Carriage | HTTP-only cookie `proovra_mfa_pending` for web clients, JSON body field `mfaPendingToken` for non-cookie clients (mobile) |
| Cleanup | Cookie cleared on success, on 400 invalid_body, and on pending-token verification failure |

### Threat model coverage

| Threat | Mitigation |
|---|---|
| Replay of pending token to escalate to a session | JTI deny list — single-use; `requireAuth` refuses pending tokens at every other endpoint |
| XSS exfiltration of the pending token | HTTP-only cookie (web); pending token never lands in `localStorage` (test 19) |
| Brute-force of TOTP / recovery code at login | Per-user rate limit, 5 attempts per 60 s (`LOGIN_MFA_ATTEMPT_MAX`, test 12) |
| Pending token outliving the password-passed state | 5-min TTL (test 2) |
| Misuse of pending token at SSO callback | OIDC callback respects MFA via the same `readMfaStatus` consultation (test 15) |
| Cookie pinned to a stolen session ID | Pending cookie has `httpOnly + secure + sameSite=lax` and a SEPARATE name from the session cookie |

### Multi-instance honesty

The JTI deny list is **process-local**. Two API replicas receiving the same pending token within 5 minutes would each accept it once. The risk is bounded because:
- Both calls must still present the SAME correct second factor (TOTP code OR a one-time recovery code).
- Recovery codes are consumed atomically in Postgres via `consumeRecoveryCode` (`mfa_recovery_codes.usedAt` set under a single UPDATE).
- TOTP codes are time-bound to a 90-second window (current step ±1) and are not invalidated after one successful use by design.

If multi-instance JTI consistency becomes required (e.g. for very high-traffic SSO logins), a follow-on phase can move the deny list to Postgres or Redis. The token shape would not change.

## Login flow — sequence diagrams

### Email / OAuth (JSON body)

```
Browser                       API                          DB
  | POST /v1/auth/email/login  |                            |
  |---------------------------►|                            |
  |                            | loginWithEmailPassword     |
  |                            |---------------------------►|
  |                            |◄---------------------------|
  |                            | gateLoginWithMfa           |
  |                            |   readMfaStatus            |
  |                            |---------------------------►|
  |                            |◄----------- hasMfa = true -|
  |                            | signMfaPendingToken        |
  |                            | setMfaPendingCookie        |
  |◄- 200 { mfaRequired,       |                            |
  |        mfaPendingToken }   |                            |
  | redirect /auth/mfa-challenge?next=/home                 |
  |                            |                            |
  | POST /v1/auth/mfa/verify   |                            |
  | (cookie carries token)     |                            |
  | body: { code: "123456" }   |                            |
  |---------------------------►|                            |
  |                            | verifyAndConsumeMfaPendingToken
  |                            | loginMfaIsRateLimited?     |
  |                            | verifyActiveTotp           |
  |                            |---------------------------►|
  |                            |◄---------------------------|
  |                            | maybeSetWebCookie (session)|
  |                            | clearMfaPendingCookie      |
  |◄- 200 { token, user }      |                            |
```

### SSO / OIDC (browser redirect)

```
Browser                       API                          DB
  | GET /v1/auth/sso/callback  |                            |
  |---------------------------►|                            |
  |                            | handleOidcCallback         |
  |                            |---------------------------►|
  |                            |◄---------------------------|
  |                            | readMfaStatus              |
  |                            |---------------------------►|
  |                            |◄----------- hasMfa = true -|
  |                            | signMfaPendingToken        |
  |                            | setCookie proovra_mfa_pending
  |◄- 302 /auth/mfa-challenge?next=/home                    |
  | (form submit → POST mfa/verify same as above flow)      |
```

## Files touched

### API (`services/api/`)

| Path | Change |
|---|---|
| `src/services/jwt.ts` | + `signMfaPendingToken`, `verifyAndConsumeMfaPendingToken`, `MFA_PENDING_TTL_SECONDS`, JTI deny list, `__resetMfaPendingDenyListForTests` |
| `src/middleware/auth.ts` | Refuse `payload.mfa === "pending"` with generic 401 |
| `src/routes/auth.routes.ts` | + `gateLoginWithMfa` helper, + `POST /v1/auth/mfa/verify`, + `setMfaPendingCookie` / `clearMfaPendingCookie`, gate wired into Google / Apple / email-password login |
| `src/routes/sso-auth.routes.ts` | OIDC callback consults `readMfaStatus` and 302-redirects to `/auth/mfa-challenge` when applicable |
| `src/services/security/mfa.service.ts` | `Buffer.from` coercions on Prisma byte fields (pre-existing TS 5.7 strictness fix; surfaced during R8.1.2 typecheck) |
| `src/services/security/mfa-secret-storage.ts` | `SealedSecret` interface widened from `Buffer` to `Uint8Array` (same pre-existing TS 5.7 fix) |
| `src/routes/mfa.routes.ts` | `ErrorCode.AUTH_REQUIRED` → `UNAUTHORIZED` (pre-existing typo fix); typed generic on DELETE handler |

### Web (`apps/web/`)

| Path | Change |
|---|---|
| `app/auth/mfa-challenge/page.tsx` | **NEW.** Reads `next` from query, renders TOTP + recovery code input, POSTs to `/v1/auth/mfa/verify`. No localStorage, no secret echoes to URL |
| `app/login/page.tsx` | Detects `data.mfaRequired === true` from login response; routes to `/auth/mfa-challenge?next=...` |
| `app/register/page.tsx` | Same MFA-detect branch (OAuth registration of an existing MFA-enrolled user) |
| `components/command-center/CommandCenter.tsx` | (R8.1A — see companion doc) |
| `app/pricing/page.tsx` | (R8.1A — see companion doc) |

### Tests

| Path | Change |
|---|---|
| `test/phase-r8-1-2-login-mfa.test.ts` | **NEW.** 20 contract tests (the spec called for 19; one bonus sentinel test guards against file truncation) |
| `test/phase-r8-enterprise-identity-security.test.ts` | File-size pin on `auth.routes.ts` (17211 → 32109) and `sso-auth.routes.ts` (12496 → 15823) |
| `test/phase-r8-1-real-mfa.test.ts` | Same two pin updates |
| `test/phase-r8-1-1-mfa-orchestrator.test.ts` | Test 7 flipped: was "no login integration"; now "login integration live". Endpoint regex tolerates `app.delete<...>(`. |

## Bounded security event vocabulary

R8.1.2 uses **only** these events from `SECURITY_EVENT_TYPES` (no additions):
- `mfa_verification_succeeded` — emitted by `verifyActiveTotp` / `consumeRecoveryCode` on success (orchestrator-owned)
- `mfa_verification_failed` — emitted by the orchestrator on any verify failure
- `auth_login_failed` — emitted by `POST /v1/auth/mfa/verify` on pending-token invalidity or factor-verification failure, with `phase: "mfa_verify"` in details

The "challenge issued" event is captured in the **platform audit log** (`auth.mfa_challenge_issued`), not as a security event — none of the bounded vocabulary cleanly maps to "challenge issued" without misleading SIEM dashboards.

## Future hook points (deferred)

| Concern | Status | Notes |
|---|---|---|
| Org-wide MFA-required policy enforcement | **Deferred.** `gateLoginWithMfa` consults per-user MFA status; an org policy that REQUIRES MFA for all members would need to: (1) check org policy at login, (2) refuse credentials when policy=required AND user has no factor enrolled, (3) redirect to /auth/enroll-mfa | Hook point in `gateLoginWithMfa` between `readMfaStatus` and the `hasMfa` branch |
| Multi-instance JTI deny list | **Deferred.** Process-local is sufficient for current traffic (see "Multi-instance honesty" above) | Move `mfaPendingDenyList` to a shared store; token shape unchanged |
| Trusted-device "remember this browser" exemption | **Deferred.** Would skip MFA for 30 days on a device that previously verified | Requires a separate signed `device_id` cookie + DB row; intentionally not bundled into R8.1.2 |
| WebAuthn / FIDO2 as a TOTP alternative | **Out of scope.** R8.1 series targets TOTP + recovery codes only | A future R8.2 could add WebAuthn as a parallel factor kind under the same `MfaFactor.kind` enum |

## Validation evidence

- **API typecheck:** ✅ Clean
- **API tests:** 164/164 across R8 + R8.1 + R8.1.1 + R8.1.2 + security-event drift (full suite runs in 6/6)
- **Web typecheck:** ✅ Clean
- **Web build (Vercel-equivalent):** ✅ Clean (see R8.1A doc for build-fix details)
- **Worker:** Untouched

## Roll-back surface

If R8.1.2 needs to be rolled back (e.g. an SSO IdP misbehaves), the minimum reversal is:
1. Remove the `if (gate.mfaIssued) return;` line from the three login endpoints in `auth.routes.ts`.
2. Remove the `if (mfaStatus.hasMfa) { ... }` block from the OIDC callback in `sso-auth.routes.ts`.

Doing so leaves the verify endpoint dormant (callable only with a freshly-signed pending token that nothing else mints) and reverts the user-visible flow to pre-R8.1.2 behavior. The schema, the orchestrator, and the step-up usage all continue to work unmodified.
