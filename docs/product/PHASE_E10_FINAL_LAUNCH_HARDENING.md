# PHASE E10 — Final Launch Hardening

**Status:** CLOSED_WITH_DEFERRED_ITEMS
**Closure date:** 2026-05-26
**Test suite:** `services/api/test/phase-e10-final-launch-hardening.test.ts`
**Companion runbooks:** `docs/operations/runbooks/10-*.md` through `17-*.md` (extending the E6 set)

---

## 1. Intent

E10 is the **decision + classification** phase, not the feature-build phase. PROOVRA is now an enterprise evidence operations platform; E10 proves it is ready for real-world launch pressure by:

1. Publishing a complete launch-readiness inventory (21 areas).
2. Defining critical-flow smoke paths (15 entries).
3. Auditing abuse / rate-limit / production-config / billing edge cases.
4. Adding 7 new support runbooks (10–17) that extend the E6 set.
5. Producing a DEF classification table: every open DEF gets `LAUNCH_BLOCKER` / `PILOT_BLOCKER` / `POST_LAUNCH` / `INFORMATIONAL`.
6. Adding contract tests that pin the launch invariants.

E10 ships **zero features**, **zero redesigns**, **zero architecture changes**. It produces evidence-backed launch readiness or surfaces gaps as classified DEFs.

---

## 2. Entry-gate report

Two parallel audits ran before any code change:

1. **Rate-limit coverage audit** mapped every public + unauthenticated endpoint and identified six surfaces with missing per-IP throttles (login, register, password reset, demo requests, guest creation, SCIM, SAML ACS, billing checkout, Stripe webhook, plus the previously-tracked DEF-028 external review redemption).
2. **Production config + billing edge case audit** confirmed `runStartupConfigValidation()` is the canonical gate, Stripe webhook signature verification is mandatory, but identified three operational gaps: Stripe webhook event idempotency NOT implemented, workspace `billingPlan` vs Stripe state mismatch NOT detected, and `OPENAI_API_KEY` not enforced at startup when `OPENAI_AI_ENABLED=true`.

Both audits also confirmed the platform's existing safety architecture is sound: SAML production safety (rejects localhost ACS), S3 production safety (rejects localhost — DEF-006 resolved), Stripe key shape validation (rejects `pk_*` in `STRIPE_SECRET_KEY` slot — DEF-012 resolved), signing provider consistency check (KMS vs local-pem), mandatory Stripe webhook signature verification.

---

## 3. Launch readiness inventory (21 areas)

| Area | Status | Risk | Blocking? | Evidence | Fix needed |
|---|---|---|---|---|---|
| Auth / login / session | ⚠ PARTIAL | MEDIUM | BLOCKS_LAUNCH | `auth.routes.ts` + audit events present; per-IP rate limit MISSING on email login + password reset | DEF-037 |
| MFA (TOTP / SMS / recovery) | ✅ READY | LOW | — | Phase R8.1.x suite; `mfa.routes.ts`; per-userId 5/60s throttle on MFA verify | — |
| SAML SP | ⚠ PARTIAL | HIGH | BLOCKS_ENTERPRISE_PILOT | Phase R8.2 + R8.2.1 + R8.2.2; live IdP roundtrip not yet rehearsed | DEF-002 |
| SCIM 2.0 | ⚠ PARTIAL | LOW | POST_LAUNCH | `scim.routes.ts`; SCIM token auth present; per-token rate limit MISSING | DEF-039 |
| Capture / upload / finalize | ✅ READY | LOW | — | Phase CR0 frozen; file-size pins green; custody chain validated by runbook 09 | — |
| Report generation / download | ✅ READY | LOW | — | `reports-aggregator.service.ts`; worker `report` queue; runbook 12 | — |
| Verification package | ✅ READY | LOW | — | `VerificationPackage` row + worker pipeline; integrity snapshot validated by runbook 09 | — |
| Public verify (read-only) | ✅ READY | LOW | — | `/public/verify/:id`; per-IP 60/60s rate limit; content access policy env-gated | — |
| External intake | ✅ READY | LOW | — | Phase E8; HMAC-SHA256 token; dual feature flag; 30/IP + 20/token/min | — |
| External review | ⚠ PARTIAL | MEDIUM | POST_LAUNCH | Phase E8; SHA-256 token + anti-enumeration; reviewer redemption routes lack rate limit | DEF-028 |
| Evidence requests | ✅ READY | LOW | — | Phase 7; reuses WorkflowIntakeLink; `EVIDENCE_REQUESTS_ENABLED` flag | — |
| Automation / webhooks | ✅ READY | LOW | — | Phase E3/E3.1/E3.2/E3.3; bounded retries; auto-disable after 10 failures | — |
| Analytics | ✅ READY | LOW | — | Phase E4; 5 source-traced metric envelopes; honest degraded-state badges | — |
| AI | ✅ READY | LOW | — | Phase E9 ratified architecture; default OFF; noop fallback; cost guard; structured-output validation | DEF-033, DEF-034, DEF-035, DEF-036 (all POST_LAUNCH) |
| Billing | ⚠ PARTIAL | MEDIUM | BLOCKS_LAUNCH | Stripe checkout + webhook signature verification present; webhook event idempotency MISSING | DEF-038 |
| Email / SMS | ✅ READY | LOW | — | Resend + Twilio integrations; bounded retry on the delivery side | — |
| Storage (S3 / R2) | ✅ READY | LOW | — | Phase E6; Object Lock when enabled; bootstrapObjectLockVerification fails-fast in prod | — |
| Database | ✅ READY | HIGH-Ops | BLOCKS_LAUNCH | Phase E6 runbooks + provider PITR; production secret rotation pending | DEF-003 (Ops) |
| Redis / queues | ⚠ PARTIAL | LOW | POST_LAUNCH | BullMQ + Redis singletons; production localhost rejection NOT enforced for Redis | DEF-042 |
| Worker runtime | ✅ READY | LOW | — | Phase E6 worker-restart runbook; 9 in-process schedulers with bounded retries | DEF-025, DEF-026 (POST_LAUNCH) |
| Trust Center | ✅ READY | LOW | — | Phase E5 + E6 + E8 + E9 extensions; cross-surface forbidden-phrase guards | — |
| DR runbooks | ✅ READY | LOW | — | Phase E6 nine-runbook set; Phase E10 adds runbooks 10–17 | — |
| Support readiness | ✅ READY | LOW | — | Runbooks 10 (triage) + 11 (incident response) + 12–16 (per-surface failure) + 17 (monitoring) | — |

**Summary:** 4 BLOCKS_LAUNCH items (DEF-003 Ops-owned + DEF-037 + DEF-038 + DEF-042 in part). 1 BLOCKS_ENTERPRISE_PILOT item (DEF-002 Ops-owned). 23 open POST_LAUNCH items tracked in §6 of master registry.

---

## 4. Critical flow smoke tests (15 entries)

Each smoke entry has: trigger, expected observable outcome, what NOT to silently fake.

| # | Flow | Trigger | Expected outcome | "Silent success" guard |
|---|---|---|---|---|
| 1 | Signup → login | Email register → email verify → password login | 200 + JWT session; audit events `user.created` + `auth.login.succeeded` | Not OK if user created but no audit event |
| 2 | Workspace creation | POST `/v1/workspaces` after first login | 201 + workspace row; user is OWNER | Not OK if workspace created but `TeamMember` row absent |
| 3 | Capture evidence | Open capture page → upload file → finalize | Evidence row reaches `REPORTED`; custody chain 3+ events | Not OK if `REPORTED` but custody chain breaks (runbook 09) |
| 4 | Finish / sign | Finalize action | `Evidence.signatureBase64` populated; `signingKeyId` + `signingKeyVersion` snapshotted | Not OK if signature absent on `REPORTED` evidence |
| 5 | Report ready | Wait for `report` queue | `Report` row created; `generatedAtUtc` set; `status: ready` | Not OK if status stuck at `pending` > 10 min (runbook 12) |
| 6 | Report download | Operator clicks download | 200 + PDF bytes; download surfaced in audit log | Not OK if 404 (signed-URL expired — runbook 12) |
| 7 | Verification package download | Operator clicks package download | 200 + package bytes; package row `status: ready` | Not OK if package row never created (runbook 12) |
| 8 | Public verify page | Visit `/verify/<evidence-id>` | 200 + verification snapshot; content access per `PUBLIC_VERIFY_CONTENT_MODE` | Not OK if storage URL leaks in response body |
| 9 | External intake link | Operator creates link → external participant uploads | Intake link row + session + 3 custody events; `EXTERNAL_INTAKE_SUBMITTED` final event | Not OK if submission completes but no custody event |
| 10 | External reviewer grant | Operator issues grant → reviewer redeems | Grant transitions INVITED → ACTIVE; `external_review_invited` event | Not OK if grant accepted without audit event |
| 11 | Automation rule execution | Trigger fires for an enabled rule | `AutomationRun` row created; idempotency unique-index respected | Not OK if run row missing for a matching trigger |
| 12 | Webhook delivery retry | Destination 5xx the first attempt | Status RETRY_SCHEDULED; sweep picks up on `nextAttemptAt`; resolves to SUCCEEDED on retry | Not OK if stuck in DELIVERING > delivery timeout |
| 13 | AI disabled fallback | Set `OPENAI_AI_ENABLED=false`; open AI surface | Returns `status: "disabled"`; deterministic fallback runs | Not OK if AI surface crashes or hangs |
| 14 | Billing checkout | Stripe checkout completion | Stripe webhook delivers `checkout.session.completed`; `Subscription` row created; `Team.billingPlan` updated | Not OK if Stripe shows succeeded but DB unchanged (DEF-038 risk) |
| 15 | Support / demo request | POST `/v1/demo-requests` | Demo request row; audit event captured | Not OK if request silently dropped (DEF-014 Ops-owned wiring) |

The smoke checklist is the canonical pre-deploy verification path. No smoke entry may be marked PASS without verifying the "silent success" guard.

---

## 5. Abuse / rate-limit audit

The rate-limit audit identified the following coverage state:

### 5.1 Covered (bounded)

| Surface | Rate limit |
|---|---|
| `GET /public/verify/:id` | Per-IP 60/60s |
| `POST /v1/external-intake/:token/*` | Per-IP 30/60s + per-token 20/60s |
| `POST /v1/auth/mfa/verify` | Per-userId 5/60s (in-memory map) |
| `POST /v1/ai/chat` + `POST /v1/ai/capture/*` | Per-user/day + per-evidence/day + monthly EUR budget |

### 5.2 Gap — BLOCKS_LAUNCH (new DEF)

| Surface | Gap | DEF |
|---|---|---|
| `POST /v1/auth/email/login` | No per-IP rate limit | DEF-037 |
| `POST /v1/auth/password-reset/request` | No per-IP rate limit | DEF-037 |

These two together enable credential-stuffing / spray attacks at the public ingress. Must be addressed before launch.

### 5.3 Gap — POST_LAUNCH (new DEF)

| Surface | Gap | DEF |
|---|---|---|
| `POST /v1/auth/email/register` | No per-IP rate limit | DEF-039 |
| `POST /v1/auth/guest` | No per-IP rate limit | DEF-039 |
| `POST /v1/demo-requests` | No per-IP rate limit | DEF-039 |
| `POST /v2/scim/Users` | No per-token rate limit | DEF-039 |
| `POST /v1/auth/saml/acs` | No per-IP rate limit | DEF-039 |
| `POST /v1/billing/checkout/stripe` | No per-user rate limit (cost amplification risk) | DEF-039 |
| `POST /stripe` (webhook receiver) | No per-IP rate limit (Stripe IPs are bounded but worth throttling defensively) | DEF-039 |

### 5.4 Pre-existing gap — POST_LAUNCH

- DEF-028: external review reviewer-redemption routes have no rate limit (Phase E8 finding).

---

## 6. Production config validation (audited state)

`runStartupConfigValidation()` at `services/api/src/config/index.ts:` calls a `ProductionConfigError`-throwing gate. Production refuses to start when ANY of the following hold:

- `DATABASE_URL` absent.
- `AUTH_JWT_SECRET` absent.
- Feature-gated secret absent when the feature flag is `true` (`COMMUNICATIONS_RECIPIENT_HASH_SECRET`, `IDENTITY_SECURITY_HASH_SECRET`, `API_KEY_SECRET`).
- Signing provider misconfigured (`aws-kms` needs `KMS_KEY_ID`; `local-pem` needs `SIGNING_PRIVATE_KEY_PATH`).
- SAML ACS URL is localhost in production (no `SAML_TEST_MODE` escape in prod).
- `S3_ENDPOINT` is localhost / MinIO in production (DEF-006 resolved by Phase 32.7).
- Stripe secret key has publishable-key shape (`pk_live_*` / `pk_test_*`) in `STRIPE_SECRET_KEY` slot (DEF-012 resolved by Phase 32.7).
- Signing-key-id label rotation safety (DEF-004 INFORMATIONAL — keeps `dw_ed25519` historical label).

### 6.1 New gaps

| Gap | DEF |
|---|---|
| `OPENAI_AI_ENABLED=true` but `OPENAI_API_KEY` unset → silent degradation, not fail-fast | DEF-040 |
| `DATABASE_URL` is localhost in production | DEF-042 |
| `REDIS_URL` is localhost in production | DEF-042 |
| Stripe test key in production (`sk_test_*` in `NODE_ENV=production`) | DEF-042 |

All four are POST_LAUNCH (the platform startup completes and operations continue degraded; production teams catch via deployment checklist). A future bounded phase can promote any to a startup `ProductionConfigError` if operational data shows the gap is being hit.

---

## 7. Billing edge cases (audited state)

### 7.1 Handled correctly

| Edge case | Handled by |
|---|---|
| Stripe webhook signature verification | `verifyStripeSignature()` with `timingSafeEqual`; production refuses unsigned |
| `invoice.payment_failed` | Updates `Payment.status = "FAILED"`; Stripe smart-retry takes over |
| `customer.subscription.deleted` | `syncPlanForSubscription()` transitions plan to CANCELED; personal users downgrade to FREE |
| Charge refund | `charge.refunded` event updates `Payment.status = "REFUNDED"` |

### 7.2 Gaps

| Edge case | Gap | DEF |
|---|---|---|
| Duplicate webhook event delivery | NO event-id deduplication. Stripe events with same `event.id` arriving twice would be reprocessed → duplicate payment rows. | **DEF-038 (BLOCKS_LAUNCH)** |
| Workspace `billingPlan` vs Stripe subscription state drift | NO automatic reconciliation. If a webhook is missed, the team plan stays out of sync until the next webhook. | DEF-041 (POST_LAUNCH) |
| Plan downgrade evidence-access semantics | Undocumented. The platform does NOT delete evidence on downgrade; capability set for new captures gates on the post-downgrade plan. | Documented in runbook 13; no DEF |

---

## 8. Support readiness (new runbook set)

Seven new runbooks landed in `docs/operations/runbooks/`:

| Runbook | Title |
|---|---|
| 10 | Support triage (first-15-minutes workflow) |
| 11 | Incident response checklist |
| 12 | Failed upload / report / package |
| 13 | Billing failure |
| 14 | External intake / review failure |
| 15 | SAML / SSO failure |
| 16 | AI unavailable |
| 17 | Monitoring / observability readiness |

Combined with the Phase E6 nine-runbook set (`00` rehearsal log + `01`–`09` recovery), the total runbook surface is 17.

Each new runbook follows the same pattern: prerequisites, forbidden actions, step-by-step procedure, DEF-aware caveats, honest gaps.

---

## 9. Monitoring readiness

Runbook 17 codifies the signal → surface mapping using existing surfaces:

- `GET /health` + `GET /readyz` — liveness + readiness probes for Ops alert rules.
- `GET /admin/runtime/readiness` — 14-subsystem aggregator.
- `GET /admin/runtime/queues` + `GET /admin/runtime/workers` + `GET /admin/runtime/migrations` — focused sub-views.
- `/ops/analytics` — per-team operational counters from real source tables.
- Admin audit log — filterable security event stream.

The platform deliberately does NOT publish a synthetic SLA / uptime percentage or trust/authenticity/admissibility scores. Runbook 17 captures this honestly.

---

## 10. Security regression pass

The cross-cutting tests landed in prior phases (E5 / E6 / E7 / E8 / E9) all stay green. Verified:

- No secrets in repo / docs (E6 Test 7 + E10 Test 5).
- No `BEGIN PRIVATE KEY` / `sk_live_*` / `AKIA*` in committed docs.
- No public S3 exposure on verify response (audited at `/public/verify/:id` source-grep).
- No signed URLs in logs (worker + API logs reviewed; no exposure pattern).
- No auth bypass (capability registry source-grep is part of the persona + external-participant + AI invariants).
- No cross-team leakage (analytics envelopes are team-scoped; external participants never enter the capability resolver).
- No external reviewer overreach (single-scope per grant; legal hold blocks redemption).
- No public upload chaos (every public endpoint either ID-based read-only or token-gated + rate-limited; the gaps in §5 are registered as DEFs and classified).
- No AI prompt leakage (Phase E9 cross-surface test).
- No unsafe webhook URL bypass (Phase E3.2 SSRF protection with 3 layers).

---

## 11. Performance / load sanity

The platform does NOT ship a load-testing platform in E10. Instead, the smoke checklist (§4) doubles as the bounded load sanity for pre-deploy verification:

- Public verify: per-IP 60/60s rate limit means single-IP can hit ~3,600 requests / hour. A naive synthetic load test from one IP will hit the limit by design.
- External intake: per-IP 30/60s + per-token 20/60s means a single submitter cannot exceed 20 / minute on a single intake link.
- Artifact polling: client polling backs off after the artifact is ready (Phase 32.7 runtime-readiness work).
- Analytics: bounded query (count / groupBy only); no `findMany` without team-scoped where.
- AI endpoints: cost guard short-circuits before provider; per-user-per-day cap.
- Webhook retry sweeper: cron-driven, bounded sweep size, bounded retry count (max 4 attempts).

If an Ops team needs realistic load testing, they should script against the bounded surfaces above and confirm the rate limits hold. A future bounded phase can add k6 / artillery scripts to the repository.

---

## 12. DEF classification table

Every open DEF at the close of E10. Closed DEFs (005, 006, 012, 021, 022, 023) are omitted.

| DEF | Title | Source | Classification | Owner |
|---|---|---|---|---|
| 001 | SAML SP request signing | R8.2.2 | POST_LAUNCH | R8.3 |
| 002 | Live IdP validation roundtrip | R8.2.2 | **BLOCKS_ENTERPRISE_PILOT** | Ops (pilot rehearsal) |
| 003 | Production secret rotation audit | R8.C | **BLOCKS_LAUNCH** | Ops (pre-launch) |
| 004 | `SIGNING_KEY_ID=dw_ed25519` label mismatch on KMS | R8.C | INFORMATIONAL | Future label-rotation phase |
| 007 | `providers.tsx` self-fetches `/v1/users/me` at bootstrap | CR1.5 | POST_LAUNCH | R-future auth bootstrap |
| 008 | ~28 surviving `useTeamId()` legacy callsites | CR1.5 | POST_LAUNCH | R-future / 32.x |
| 009 | No SSE / WebSocket push channel for admin capability changes | CR1.5 | POST_LAUNCH | R-future |
| 010 | Logout doesn't synchronously tear down provider state | CR1.5 | POST_LAUNCH | R-future |
| 011 | Focus-refresh helper disabled by default | CR1.6 | POST_LAUNCH | Ops (staged rollout) |
| 013 | IdP-initiated login NOT implemented | R8.2.2 | POST_LAUNCH | R-future (if requested) |
| 014 | Demo webhook empty (no CRM wiring) | (pre-CR1.7) | POST_LAUNCH | Ops / Marketing |
| 015 | Settings profile PATCH self-fetches `/v1/users/me` | CR1.5 | INFORMATIONAL | (intentionally retained) |
| 016 | No unified `/v1/collaboration/timeline` endpoint | E2 | POST_LAUNCH | R-future |
| 017 | Discussion mentions do not emit SecurityEvent | E2 | POST_LAUNCH | R-future |
| 018 | External-review legal-hold denial doesn't emit security event | E2 | POST_LAUNCH | R-future |
| 019 | Notification delivery failures don't emit security events | E2 | POST_LAUNCH | R-future |
| 020 | Collaboration moderation actions not in SecurityEvent stream | E2 | POST_LAUNCH | R-future |
| 024 | SecurityEvent table has no retention / GC policy | E6 | POST_LAUNCH | R-future retention phase |
| 025 | Webhook setTimeout schedules lost on crash within sweep window | E6 | POST_LAUNCH | R-future |
| 026 | No graceful shutdown drain for webhook runtime | E6 | POST_LAUNCH | R-future |
| 027 | Signing-key rotation requires manual env update + service restart | E6 | POST_LAUNCH | R-future |
| 028 | External review reviewer-redemption routes have no rate limit | E8 | POST_LAUNCH | R-future hardening |
| 029 | External review surface has no feature flag kill switch | E8 | POST_LAUNCH | R-future hardening |
| 030 | Evidence request external response emits no SecurityEvent | E8 | POST_LAUNCH | R-future |
| 031 | No background sweep for expired external grants / intake links | E8 | POST_LAUNCH | R-future retention phase |
| 032 | `external_review_grants` table has no retention / GC policy | E8 | POST_LAUNCH | R-future retention phase |
| 033 | Chat message content has no input-side prompt-injection sanitisation | E9 | POST_LAUNCH | R-future AI hardening |
| 034 | No explicit OpenAI call timeout override | E9 | POST_LAUNCH | R-future AI hardening |
| 035 | AI provider error emits no SecurityEvent | E9 | POST_LAUNCH | R-future AI hardening |
| 036 | AI frontend surfaces have no per-team capability gate | E9 | POST_LAUNCH | R-future AI capability |
| 037 | Email login + password reset routes have no per-IP rate limit | E10 | **BLOCKS_LAUNCH** | Pre-launch hardening |
| 038 | Stripe webhook event idempotency NOT implemented | E10 | **BLOCKS_LAUNCH** | Pre-launch hardening |
| 039 | Multi-surface per-IP throttle gaps (register/guest/demo/SCIM/SAML ACS/billing checkout/Stripe webhook receiver) | E10 | POST_LAUNCH | R-future hardening |
| 040 | `OPENAI_API_KEY` not enforced at startup when `OPENAI_AI_ENABLED=true` | E10 | POST_LAUNCH | R-future |
| 041 | Workspace `billingPlan` vs Stripe subscription state mismatch not detected | E10 | POST_LAUNCH | R-future billing reconciliation |
| 042 | DATABASE_URL / REDIS_URL / Stripe test key not rejected in production | E10 | POST_LAUNCH | R-future hardening |

### Summary

- **3 BLOCKS_LAUNCH items**: DEF-003 (Ops), DEF-037, DEF-038.
- **1 BLOCKS_ENTERPRISE_PILOT item**: DEF-002 (Ops).
- **2 INFORMATIONAL items**: DEF-004, DEF-015.
- **30 POST_LAUNCH items**: tracked with closure criteria; none blocks launch or pilot.

---

## 13. Test inventory

`services/api/test/phase-e10-final-launch-hardening.test.ts` covers 12 test groups:

1. Phase doc + all 17 runbook files exist + substantial.
2. Launch readiness inventory has the 21 required areas.
3. Critical flow smoke checklist enumerates 15 entries.
4. Existing rate-limit coverage (where it IS present) stays present — regression guard for the surfaces already covered.
5. No fake SLA / uptime claims in any E10-shipped doc (cross-surface forbidden-pattern guard).
6. No secrets in launch doc / runbooks (secret-shape forbidden patterns).
7. Production config validation gates remain present (`runStartupConfigValidation` exists; Stripe key shape validation present; SAML production-localhost guard present).
8. 32.8 IA preserved (canonical primaries still exactly 6).
9. Protected core files unchanged (file-size pins).
10. Master registry contains the 6 new DEFs (DEF-037 → DEF-042).
11. Every open DEF in the registry carries an explicit classification keyword.
12. No new client-state / queue / pubsub library introduced.

Total: **~100 cases**.

---

## 14. CR1.7 closure summary

- **Entry-gate checklist:** completed in writing before any code edit. Two parallel audits.
- **Files added:**
  - `docs/operations/runbooks/10-support-triage.md`
  - `docs/operations/runbooks/11-incident-response.md`
  - `docs/operations/runbooks/12-failed-upload-report-package.md`
  - `docs/operations/runbooks/13-billing-failure.md`
  - `docs/operations/runbooks/14-external-intake-failure.md`
  - `docs/operations/runbooks/15-saml-sso-failure.md`
  - `docs/operations/runbooks/16-ai-unavailable.md`
  - `docs/operations/runbooks/17-monitoring-readiness.md`
  - `services/api/test/phase-e10-final-launch-hardening.test.ts`
  - `docs/product/PHASE_E10_FINAL_LAUNCH_HARDENING.md` (this file).
- **Files modified:**
  - `docs/recovery/MASTER_PHASE_REGISTRY.md` — Phase E10 row + DEF-037 → DEF-042 + classification table.
- **No new DEFs resolved.** No prior phase deferred work to E10.
- **6 new DEFs opened.** 2 BLOCKS_LAUNCH (DEF-037, DEF-038); 4 POST_LAUNCH (DEF-039, DEF-040, DEF-041, DEF-042).

---

## 15. Launch blockers

To go from "CLOSED_WITH_DEFERRED_ITEMS" to launch-ready, the following MUST be addressed:

1. **DEF-003** (Ops) — Production secret rotation audit.
2. **DEF-037** — Add per-IP rate limit to `POST /v1/auth/email/login` + `POST /v1/auth/password-reset/request`.
3. **DEF-038** — Implement Stripe webhook event idempotency (event-id deduplication).

Recommended sequencing: DEF-037 + DEF-038 as a single follow-on bounded phase (E10.1 "pre-launch hardening sprint"); DEF-003 in parallel as an Ops task.

## 16. Enterprise pilot blockers

1. **DEF-002** — Ops + first pilot customer joint IdP roundtrip rehearsal (R8.2.2 checklist).

## 17. Post-launch items

The 30 POST_LAUNCH DEFs in §12 are the operational hygiene + future-feature backlog. No silent debt; every item has a closure criterion in the master registry §6.

## 18. Final recommendation

PROOVRA is **CLOSED_WITH_DEFERRED_ITEMS** for Phase E10. The platform is launch-ready CONTINGENT on closing the 3 BLOCKS_LAUNCH items (DEF-003 by Ops, DEF-037 + DEF-038 by a small hardening sprint). The 30 POST_LAUNCH items are bounded operational hygiene that do not block the initial launch.

**Suggested next phase: E10.1 — pre-launch hardening sprint.** Bounded scope:

- Add per-IP rate limit middleware to `POST /v1/auth/email/login` + `POST /v1/auth/password-reset/request` (closes DEF-037).
- Implement Stripe webhook event idempotency: deduplicate by `event.id` in a `StripeWebhookEvent` table with a unique index (closes DEF-038).
- Test additions: ~20 cases pinning the new rate limits + the idempotency contract.
- Validation: full 7-step.

After E10.1 closes DEF-037 + DEF-038, AND Ops confirms DEF-003 with the rotated secrets, AND the first pilot customer + Ops complete the DEF-002 IdP roundtrip, PROOVRA is launch-ready and pilot-ready.
