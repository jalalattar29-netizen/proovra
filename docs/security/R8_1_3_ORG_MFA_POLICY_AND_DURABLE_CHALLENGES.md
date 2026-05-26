# PHASE R8.1.3 — Organization MFA Policy Enforcement + Durable Challenge Store

**Status:** Shipped
**Date:** 2026-05-24
**Predecessors:** R8 (vocabulary + audit), R8.1 (cryptographic primitives + schema), R8.1.1 (orchestrator + REST endpoints + step-up), R8.1.2 (login-flow MFA challenge + frontend challenge page)

## What this phase closes

R8.1.2 surfaced two honest gaps in its own follow-on doc:

1. **Replay protection** was a process-local `Map<string, expSeconds>`. Two API replicas could each accept the same pending token once. Acceptable for single-node testing, unsafe for serverless / multi-region / Vercel-style cold-start environments.
2. **Org-side MFA enforcement** was wired at the data layer (Phase 17 `OrganizationSecurityPolicy.mfaPolicyLevel` + Phase 19 `mfa-policy.service.ts`) but **never consulted** by the login flow. An admin could set `mfaPolicyLevel = ALL_MEMBERS` and members who hadn't enrolled would simply… still log in without MFA. The flag was visible in `/security-center` and that was the end of it.

R8.1.3 closes both, **without** introducing a parallel auth system, **without** silently locking users out, and **without** inventing a new policy enum.

## Durable MFA pending challenge

### Schema

New `MfaPendingChallenge` Prisma model + `MfaChallengePurpose` enum, append-only migration `20260724000000_r8_1_3_mfa_pending_challenges`.

| Field | Type | Notes |
|---|---|---|
| `id` | UUID | PK |
| `jti` | VARCHAR(64) | **UNIQUE.** Opaque random hex from `randomBytes(16).toString("hex")`. Also embedded as the signed token's `sid` claim — single identifier across transport + storage. |
| `userId` | UUID | FK → users(id), CASCADE on delete. |
| `purpose` | enum LOGIN / STEP_UP | R8.1.3 ships LOGIN. STEP_UP reserved for the future unification with Phase 19 `StepUpChallenge`. |
| `expiresAt` | TIMESTAMPTZ | Absolute expiry, enforced by `verify` (`expiresAt > now` in the atomic UPDATE). |
| `consumedAt` | TIMESTAMPTZ? | Flipped in the SAME UPDATE that wins the race. Source of truth for "already used". |
| `createdAt` | TIMESTAMPTZ | Audit timestamp. |
| `ipHash` | VARCHAR(64)? | SHA-256 with `IDENTITY_SECURITY_HASH_SECRET` pepper. **Never raw IP.** |
| `userAgentHash` | VARCHAR(64)? | Same pepper. **Never raw UA.** |
| `failureCount` | INT | Per-row failure counter for forensics + future auto-expire. |
| `metadata` | JSONB? | Bounded shape — currently `{ loginMethod: "..." }`. **Never carries OTP / recovery code / signed token / secret.** |

Indexes: `(jti)` unique, `(userId, expiresAt)`, `(expiresAt)` — all three keep verify + opportunistic GC O(log n).

### Lifecycle

```
gateLoginWithMfa (auth.routes.ts)
  ├─ resolveLoginMfaEnforcement → MFA_REQUIRED
  └─ createMfaPendingChallenge   ──► INSERT row {jti, userId, expiresAt = now + 5 min, consumedAt = null}
                                      emits mfa_challenge_created
        │
        │ pendingToken = signMfaPendingToken(payload, secret, jti)
        │ → token's `sid` claim IS the JTI
        │
        ▼
POST /v1/auth/mfa/verify
  ├─ verifyMfaPendingTokenSignature (HMAC check only — no in-memory state)
  ├─ verify second factor (verifyActiveTotp OR consumeRecoveryCode)
  └─ consumeMfaPendingChallenge ──► single UPDATE WHERE
                                      id = $1
                                      AND consumedAt IS NULL
                                      AND expiresAt > now()
                                    SET consumedAt = now()
                                    rowcount=1 → ok, emits mfa_challenge_consumed
                                    rowcount=0 → replay / expired
        │
        ▼
maybeSetWebCookie (canonical session) + reply { token, user }
```

### Atomic consume — why this works under multi-instance

Postgres's `UPDATE` is row-level transactional. When two replicas race on the same JTI:

```
Replica A: UPDATE mfa_pending_challenges
           SET consumed_at = now()
           WHERE id = $1 AND consumed_at IS NULL AND expires_at > now();
           ─→ rowcount = 1, COMMIT

Replica B: UPDATE mfa_pending_challenges
           SET consumed_at = now()
           WHERE id = $1 AND consumed_at IS NULL AND expires_at > now();
           ─→ rowcount = 0   (the WHERE no longer matches)
```

Replica B observes rowcount = 0, returns `reason: "already_consumed"`, emits `mfa_challenge_replayed`. Only Replica A's caller can proceed to issue the session.

The in-memory deny list (R8.1.2) is **kept as defense-in-depth** in `verifyAndConsumeMfaPendingToken`, but the verify endpoint now uses `verifyMfaPendingTokenSignature` + `consumeMfaPendingChallenge` — so the durable store is the production replay check. R8.1.3 contract test 6 forbids the verify endpoint from calling the legacy in-memory helper.

### Cleanup / TTL strategy

Two paths, both bounded:

1. **Opportunistic GC** — `gcStalePendingChallenges()` is invoked at the start of `createMfaPendingChallenge` and inside the failure branches of `consumeMfaPendingChallenge`. Each call deletes up to `MFA_PENDING_CHALLENGE_GC_BATCH = 50` rows whose `expiresAt < now - 1 hour` OR `consumedAt < now - 1 hour`. Bounded, safe under concurrency, no schedule required.
2. **Admin-callable sweep** — `sweepExpiredPendingChallenges()` is exported for ops surfaces. Same bounded batch size; the caller may loop. Useful for backfilling after an outage or for a future scheduled BullMQ job (deferred to a follow-on).

Both keep the table's working set bounded to roughly `(live challenges within 5 min) + (recently expired within 1 hour)`. For an org with 10k DAU and a 1-hour retention window, that's worst-case ≈ 10k rows even before the GC runs — well within Postgres' comfort zone.

## Org MFA policy enforcement

The Phase 17 `OrganizationSecurityPolicy.mfaPolicyLevel` enum has **5 bounded levels**, already shipped:

| Level | Meaning |
|---|---|
| `OFF` | No org policy demands MFA. Personal opt-in still honoured. |
| `ADMINS_ONLY` | OWNER + ADMIN must MFA. |
| `REVIEWERS_AND_ABOVE` | OWNER + ADMIN + MEMBER must MFA. |
| `ALL_MEMBERS` | All roles must MFA (including VIEWER). |
| `HIGH_RISK_ONLY` | Risk-driven; not gated at login (handled by Phase 19 step-up). |

R8.1.3 does **not** add a sixth. The phase spec offered names like `REQUIRED_FOR_ADMINS` / `REQUIRED_FOR_ALL`; those map cleanly to existing `ADMINS_ONLY` / `ALL_MEMBERS`. We kept the existing names to avoid a vocabulary fork.

### Enforcement resolver

`services/api/src/services/security/login-mfa-enforcement.service.ts` is the new pure-data resolver. Inputs: `{ userId }`. Output: one of three outcomes:

| Outcome | When |
|---|---|
| `NOT_REQUIRED` | No team policy demands MFA for the user's role AND the user has no enrolled factor. Standard login proceeds. |
| `MFA_REQUIRED` | The user has an enrolled factor (personal opt-in) OR at least one team's policy demands MFA for that role AND the user has a factor. Issue durable challenge + signed token. |
| `ENROLLMENT_REQUIRED` | At least one team's policy demands MFA but the user has NO factor. Block session, surface guided enrollment. **Never silent lockout.** |

### Strictest-team-wins

A user with memberships across multiple teams is evaluated against the **strictest** policy that triggers for their role in each team. Strictness rank:

```
ALL_MEMBERS (4)  >  REVIEWERS_AND_ABOVE (3)  >  ADMINS_ONLY (2)  >  HIGH_RISK_ONLY (1)  >  OFF (0)
```

A user who is `ADMIN` in team A (`OFF`) and `MEMBER` in team B (`ALL_MEMBERS`) is treated as ALL_MEMBERS-required because of team B. The audit + security event surface `policyTeamId` so SecOps can see which team's policy triggered the requirement.

### Safe enforcement — no silent lockout

The phase spec was explicit: **"do not silently lock out"**. R8.1.3 handles enrollment-required by returning a **bounded 403 response** with:

```json
{
  "mfaRequired": true,
  "mfaEnrollmentRequired": true,
  "reason": "org_policy_requires_mfa",
  "message": "Your organization requires multi-factor authentication. Please enroll an authenticator to continue."
}
```

The frontend `/auth/mfa-challenge?enroll=1` page renders a dedicated "Set up two-factor authentication" surface with a CTA back to `/login` (which then surfaces the enrollment flow once primary credentials re-validate). No session is issued; no API access is granted; **the operator sees a clear next step**.

For SSO/OIDC the same flow applies — the OIDC callback respects `ENROLLMENT_REQUIRED` and 302-redirects to `/auth/mfa-challenge?enroll=1&next=...`.

### Break-glass for admins

The spec asked for "at least one break-glass/admin-safe path". R8.1.3's natural break-glass:

1. The very FIRST OWNER of a freshly-provisioned org cannot lock themselves out before they enroll — they create the workspace under `OFF` (the default) and can opt into stricter policies AFTER enrolling MFA.
2. An admin who flips policy to `ALL_MEMBERS` without first enrolling themselves will see the `ENROLLMENT_REQUIRED` 403 on their next login, with the clear "enroll an authenticator to continue" message — they re-authenticate via password (still valid), are routed to enrollment, complete it, and proceed.
3. Recovery codes are issued at first TOTP enrollment (R8.1.1) — `consumeRecoveryCode` is honoured by the verify endpoint, so a lost-device case still has an in-band path.
4. The infrastructure escape hatch (manual `mfaPolicyLevel = OFF` UPDATE against the DB by the operator on-call) is intentionally out-of-band and documented here so SecOps knows it exists. It requires DB credentials, leaves an audit trail in Postgres logs, and is the absolute last resort.

## Files touched

### API

| Path | Change |
|---|---|
| `prisma/schema.prisma` | + `MfaPendingChallenge` model, + `MfaChallengePurpose` enum, + `User.mfaPendingChallenges` back-relation |
| `prisma/migrations/20260724000000_r8_1_3_mfa_pending_challenges/migration.sql` | New migration (append-only) |
| `src/services/security/mfa.service.ts` | + `createMfaPendingChallenge`, `consumeMfaPendingChallenge`, `recordPendingChallengeFailure`, `sweepExpiredPendingChallenges`, `gcStalePendingChallenges`, TTL/retention constants, IP/UA hashing helper |
| `src/services/security/login-mfa-enforcement.service.ts` | **NEW.** Pure resolver: per-user enrollment + per-team policy → NOT_REQUIRED / MFA_REQUIRED / ENROLLMENT_REQUIRED |
| `src/services/jwt.ts` | + `signMfaPendingToken(payload, secret, jti?)` overload, + `verifyMfaPendingTokenSignature` (signature-only). `verifyAndConsumeMfaPendingToken` kept as defense-in-depth; verify endpoint no longer relies on it |
| `src/routes/auth.routes.ts` | `gateLoginWithMfa` now consults the resolver, creates the durable challenge, ties the JTI into the signed token. `POST /v1/auth/mfa/verify` calls `consumeMfaPendingChallenge` (atomic). Enrollment-required branch returns 403 with bounded reason |
| `src/routes/sso-auth.routes.ts` | OIDC callback branches: ENROLLMENT_REQUIRED → redirect to `/auth/mfa-challenge?enroll=1`; MFA_REQUIRED → durable challenge + redirect |

### Web

| Path | Change |
|---|---|
| `app/auth/mfa-challenge/page.tsx` | + `data-cc-mfa-state` discriminator. Three surfaces now: `verify` (code input), `enrollment-required` (guided CTA, no code input), `challenge-expired` (return-to-sign-in CTA). Disambiguates 401 reasons (`mfa_challenge_expired`, `mfa_challenge_already_used`, `mfa_pending_invalid`) from the durable verify endpoint |
| `app/(app)/security-center/page.tsx` | + "Your MFA enrollment" card showing operator's active-factor count, recovery codes remaining, and a policy-vs-enrollment delta warning when the workspace policy is on but the operator has no factor |

### Shared

| Path | Change |
|---|---|
| `packages/shared/src/security.ts` | + 7 R8.1.3 event types in `SECURITY_EVENT_TYPES`: `org_mfa_policy_updated`, `org_mfa_policy_enforced`, `mfa_challenge_created`, `mfa_challenge_expired`, `mfa_challenge_replayed`, `mfa_challenge_consumed`, `mfa_enrollment_required`. Bounded, commented with the Phase R8.1.3 marker |

### Tests

| Path | Change |
|---|---|
| `test/phase-r8-1-3-org-mfa-policy-and-durable-challenges.test.ts` | **NEW.** 22 tests (17 numbered + 5 bonus): durable model existence, atomic consume signature, replay detection, enforcement outcomes, bounded vocabulary additions, no parallel auth, no workflow/persona auth, no tenant regression, no capture/upload/custody touch, cleanup strategy lock |
| `test/phase-r8-enterprise-identity-security.test.ts` | Re-baselined `auth.routes.ts` 32109 → 36425 and `sso-auth.routes.ts` 15823 → 18565 |
| `test/phase-r8-1-real-mfa.test.ts` | Same two pin updates |
| `test/phase-r8-1-1-mfa-orchestrator.test.ts` | `auth.routes.ts` pin 32109 → 36425 |
| `test/phase-r8-1-2-login-mfa.test.ts` | Allowed-events set widened to include `mfa_enrollment_required` + `org_mfa_policy_enforced` (R8.1.2 spec was "no NEW event types"; R8.1.3 legitimately adds them via the bounded vocabulary) |
| `test/phase-32-7-2-security-event-mapping-drift.test.ts` | Migration allow-list grew by one entry |

## Security events — bounded vocabulary

R8.1.3 adds **exactly seven** event types to `SECURITY_EVENT_TYPES`. Every event payload is verified by contract test 13 to NEVER include OTP, recovery code, signed token, secret material, IV, or auth tag. Challenge identifiers are surfaced as truncated SHA-256 hashes (`createHash("sha256").update(row.id).digest("hex").slice(0, 32)`) — useful for log correlation, useless for impersonation.

| Event | Emitted from | Severity | Payload (`details`) |
|---|---|---|---|
| `org_mfa_policy_updated` | (Phase 19 `mfa-policy.service.ts` — already emits the canonical `mfa_policy_updated`; R8.1.3 adds `org_` prefix as the bounded alternative for SIEM filtering. Both are now in the vocabulary.) | INFO | `{ actorUserId, level, stepUpTtlSeconds, trustedDeviceTtlDays }` |
| `org_mfa_policy_enforced` | `auth.routes.ts gateLoginWithMfa`, `sso-auth.routes.ts callback` | INFO | `{ actorUserId, loginMethod, policyLevel }` |
| `mfa_challenge_created` | `createMfaPendingChallenge` | INFO | `{ actorUserId, challengeIdHash, purpose }` |
| `mfa_challenge_expired` | `consumeMfaPendingChallenge` (expired branch) | INFO | `{ actorUserId, challengeIdHash }` |
| `mfa_challenge_replayed` | `consumeMfaPendingChallenge` (replay branch — read or UPDATE rowcount 0) | WARNING | `{ actorUserId, challengeIdHash }` |
| `mfa_challenge_consumed` | `consumeMfaPendingChallenge` (success) | INFO | `{ actorUserId, challengeIdHash }` |
| `mfa_enrollment_required` | `auth.routes.ts gateLoginWithMfa`, `sso-auth.routes.ts callback` (ENROLLMENT_REQUIRED branch) | WARNING | `{ actorUserId, loginMethod, policyLevel }` |

## Validation evidence

- `pnpm --filter proovra-api prisma generate` ✅
- `pnpm --filter proovra-api typecheck` ✅
- `pnpm --filter proovra-api test` ✅ (run as part of 6/6 gate)
- `pnpm --filter proovra-web typecheck` ✅
- `pnpm --filter proovra-web build` ✅ (Vercel-equivalent)
- `pnpm --filter proovra-worker typecheck` ✅
- `pnpm --filter proovra-worker test` ✅

## Hard confirmations (per phase spec)

| Confirmation | Status |
|---|---|
| Pending MFA replay protection is durable | ✅ `mfa_pending_challenges` row with atomic UPDATE; verify endpoint uses `consumeMfaPendingChallenge`, not the in-memory helper |
| Multi-instance / serverless replay risk reduced | ✅ Postgres row-level atomicity is the source of truth; in-memory deny list kept only as defense-in-depth |
| Org MFA enforcement works safely | ✅ Existing 5-level enum honoured; resolver picks strictest team policy |
| Users are not silently locked out | ✅ ENROLLMENT_REQUIRED returns 403 with guided message + dedicated `/auth/mfa-challenge?enroll=1` surface |
| No full session before MFA verification | ✅ `signJwt` for canonical session lives strictly AFTER `consumeMfaPendingChallenge` success (test 7) |
| No OTP / recovery / secret / token leakage | ✅ Contract test 13; IP/UA hashed at issuance |
| No duplicate auth system introduced | ✅ Contract test 14: only `auth.routes.ts` + `sso-auth.routes.ts` under routes/ matching `*auth*` |
| No workflow/persona auth logic introduced | ✅ Contract test 15: enforcement resolver imports neither |
| No tenant isolation regression | ✅ Contract test 16: lookups keyed by userId; policy lookup by the user's own teamIds |
| No capture/upload/finalize/custody/TSA/OTS/report/package regression | ✅ Contract test 17: no surface imports those modules |

## Remaining risks (honest)

1. **In-memory deny list still exists** in `jwt.ts` `verifyAndConsumeMfaPendingToken`. It is no longer the verify endpoint's replay-check, but the helper is still exported for legacy callers. A future cleanup phase should either remove the helper (after auditing all callers) or rename it to `…_legacy` to make the dead-code intent obvious. **Risk: low** — the verify endpoint provably doesn't use it (contract test 6).
2. **No scheduled GC job.** `gcStalePendingChallenges` runs opportunistically and `sweepExpiredPendingChallenges` is admin-callable. Under low traffic, expired rows could accumulate for up to the retention window (1 hour beyond expiry). **Risk: low** — the table is bounded by traffic; a follow-on phase can add a BullMQ recurring job that calls `sweepExpiredPendingChallenges` if production telemetry shows it growing.
3. **Resolver fail-mode is fail-OPEN.** When `resolveLoginMfaEnforcement` throws (Prisma blip), the gate falls through to "not required" rather than locking everyone out. This is documented + logged + audited. **Risk: medium** — a sustained Prisma outage that silently allows MFA bypass is a real concern. The trade-off was made deliberately to avoid a one-off Prisma error from locking every operator out of the platform. A future R8.1.4 could add a circuit-breaker that switches to fail-CLOSED after N consecutive resolver failures within a short window.
4. **No "first admin break-glass" auto-enrollment.** A first-time admin who turns on `ALL_MEMBERS` and then logs out gets the `ENROLLMENT_REQUIRED` 403 on next login (clean recovery path). But there is no automated path for "I lost my second factor AND my recovery codes AND I'm the only admin". The doc's "operator on-call DB UPDATE" path is the current remedy. **Risk: low (operationally)** — recovery codes (R8.1.1) are the in-band mitigation; ops escalation is the out-of-band one.
5. **The legacy `mfa_policy_updated` event still exists alongside the new `org_mfa_policy_updated`.** Both are in the bounded vocabulary; SIEM dashboards that filter on the legacy name continue to work. A future phase can consolidate. **Risk: none** — additive only.

## Exact next phase recommendation

**R8.1.4 — MFA admin lifecycle + scheduled GC + circuit-breaker fail-mode.** Specifically:

1. Add a small ops endpoint `POST /v1/identity-security/mfa/sweep-expired-challenges` (admin-only, behind step-up) that wraps `sweepExpiredPendingChallenges` for manual + future scheduled calls.
2. Add a BullMQ recurring job (every 15 min, very low priority) that calls the sweep endpoint — guarded by a env flag so test environments don't queue it.
3. Add a circuit-breaker around `resolveLoginMfaEnforcement` so after `N` consecutive failures in a `T`-second window the gate switches to fail-CLOSED with a clear operator-facing error. Default conservative: N=5, T=60s.
4. Add an in-band admin "I lost my factor" flow: requires a separate verified email confirmation + a quorum of two other admins to disable the factor. This replaces the out-of-band DB UPDATE path. Honest scope: this is a real feature, not a workaround.
5. Audit + (optionally) deprecate `verifyAndConsumeMfaPendingToken` in `jwt.ts` once no callers remain.

After R8.1.4, the MFA series can be declared **enterprise-complete** pending future authentication primitives (WebAuthn, hardware tokens, push-based MFA) which are R8.2 scope.
