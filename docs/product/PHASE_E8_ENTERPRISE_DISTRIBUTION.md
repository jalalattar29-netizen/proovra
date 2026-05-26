# PHASE E8 — Bounded External Distribution

**Status:** CLOSED_WITH_DEFERRED_ITEMS
**Closure date:** 2026-05-26
**Test suite:** `services/api/test/phase-e8-external-distribution.test.ts`
**Canonical content:** `packages/shared-evidence-presentation/src/external-access-content.ts`
**Trust Center alignment:** `automation-auditability` section extended

---

## 1. Intent

PROOVRA's external surfaces (workflow intake links, external review grants, evidence requests, public verify, the share-link stub) are already substantial and were each built by prior phases. Phase E8 does **not** redesign them, fork them per persona, or introduce a generic file-sharing platform. Instead, E8:

1. Inventories every external surface in one canonical content module so future hands have a single source of truth.
2. Codifies the six bounded external participant types with their capabilities, backing surface, and hard rules.
3. Extends the Trust Center `automation-auditability` section with explicit bounded-external-collaboration language.
4. Adds a cross-surface contract test that pins the security invariants (token hashing, feature flags, rate limits, anti-enumeration, capability registry purity).
5. Surfaces the audit gaps the inventory found as bounded LOW-severity DEFs so they stay tracked.

The phase ships zero schema changes, zero new capabilities, zero new root navigation, zero new backend routes.

---

## 2. Entry-gate report

Before any code change, three parallel audit agents mapped the workflow intake surface, the external review + evidence request surfaces, and the public verify + share-link surfaces. The audit found:

- **HMAC-SHA256 token hashing** is used for workflow intake (32 random bytes; never raw storage; constant-time verification).
- **SHA-256 hashing** is used for external reviewer grants (32 random bytes; hashed at issue time; never raw storage).
- **Feature flags** gate workflow intake (`WORKFLOW_INTAKE_LINKS_ENABLED` + `WORKFLOW_INTAKE_TOKEN_SECRET` dual guard) and evidence requests (`EVIDENCE_REQUESTS_ENABLED`).
- **Rate limits** are enforced on public intake routes (30/IP/min + 20/token/min) and the public verify route (60/IP/60s).
- **Eager revocation** is checked on every request — no background sweep required for correctness.
- **Custody events** emit for external intake (3 events: link used, consent accepted, submitted).
- **Anti-enumeration** is in place on the external review surface: identical `grant_not_active` deny code for unknown / revoked / expired tokens.
- **Legal hold blocks redemption** on external reviewer access.
- **Public verify uses ID-based access** (not token-based), with per-IP rate limit and content-access policy via env var (defaults `preview_only`). No S3 URLs leak. Custody chain is not polluted by views.
- **Share-link** is a CR1 Part 2 placeholder only — intentionally not activated in E8.

Gaps found (registered as DEFs in §6 below):
- External review reviewer-redemption routes have no rate limit.
- External review surface has no feature flag kill switch.
- Evidence request external responder submission emits no `SecurityEvent`.
- No background sweep job for expired external-review grants or expired workflow-intake links (eager runtime check denies them; DB grows monotonically).
- `external_review_grants` table has no retention/GC policy.

---

## 3. External surface inventory

The shared module exports `EXTERNAL_SURFACE_INVENTORY` — a canonical row per surface. Tests assert each row's audited properties.

| Surface | Public surface | API surface | Access shape | Feature flag | Rate-limited | Audit events | Token storage | Eager revocation |
|---|---|---|---|---|---|---|---|---|
| Workflow intake link | external-intake (token-based POST) | `/v1/external-intake/:token/*` | TOKEN | `WORKFLOW_INTAKE_LINKS_ENABLED + WORKFLOW_INTAKE_TOKEN_SECRET` | ✅ | ✅ | HMAC-SHA256 | ✅ |
| External review grant | external-review (token-based GET + accept) | `/v1/external-review/access/:token/*` | TOKEN | — *(DEF-029)* | ❌ *(DEF-028)* | ✅ | SHA-256 | ✅ |
| Evidence request | external-intake via WorkflowIntakeLink | `/v1/evidence-requests/*` + `/v1/external-intake/:token/*` | TOKEN | `EVIDENCE_REQUESTS_ENABLED` | ✅ | partial *(DEF-030)* | HMAC-SHA256 | ✅ |
| Public verify | `/verify/:id` → `/public/verify/:id` | `GET /public/verify/:id` | ID | — | ✅ (per-IP) | ✅ (analytics-only writes) | NONE | ✅ |
| Share link | `/share/[id]` (web stub) | — | STUB | — | — | — | NONE | — |

---

## 4. External access model

Six bounded participant types codified in `EXTERNAL_ACCESS_PARTICIPANTS`. Each type lists its bounded capability set, the actual backing backend surface, and a hard-rule list every implementation MUST satisfy.

| Type | Capabilities | Backed by |
|---|---|---|
| EXTERNAL_SUBMITTER | SUBMIT_EVIDENCE, RESPOND_TO_REQUEST | `WorkflowIntakeLink (token) + WorkflowIntakeSession` |
| EXTERNAL_REVIEWER | READ_SCOPED_RESOURCE, DOWNLOAD_ORIGINAL, DOWNLOAD_PACKAGE | `ExternalReviewerGrant (SHA-256 hashed token)` |
| CLAIMANT | SUBMIT_EVIDENCE, RESPOND_TO_REQUEST | `WorkflowIntakeLink (token) with claim-context EvidenceRequest binding` |
| LAW_FIRM_PARTICIPANT | READ_SCOPED_RESOURCE, DOWNLOAD_ORIGINAL, DOWNLOAD_PACKAGE | `ExternalReviewerGrant (CASE or EVIDENCE scope)` |
| FIELD_CONTRIBUTOR | SUBMIT_EVIDENCE | `WorkflowIntakeLink (token) with capture-template binding` |
| TEMPORARY_AUDITOR | READ_SCOPED_RESOURCE, DOWNLOAD_PACKAGE | `ExternalReviewerGrant (PACKAGE or CASE scope, short-lifetime)` |

Every participant's hard rules include scope, expiry, revocation, and audit emission. Tests assert this for every type.

Hard rules common to all six types:

- External actors are bounded to a single resource (one intake link, one evidence, one case, one package).
- External actors never become implicit team members; never appear in `TeamMember`; never enter the capability resolver.
- Expiration + revocation are checked on every request (eager — no grace period).
- Anti-enumeration: unknown / revoked / expired tokens surface an identical deny code.
- Capability registry has zero external-participant input — verified by source-grep test.

---

## 5. Secure intake links (audited)

Workflow intake links (`workflow-intake-token.service.ts` + `workflow-intake-links.routes.ts` + `external-intake.routes.ts`):

- **Token generation**: 32 random bytes via `randomBytes()`, base64url-encoded.
- **Storage**: HMAC-SHA256 with `WORKFLOW_INTAKE_TOKEN_SECRET` — only the hex hash is persisted to `WorkflowIntakeLink.tokenHash` (unique index).
- **Constant-time verification**: lookup hashes the candidate token + uses `timingSafeEqual()` for comparison.
- **Feature gate**: dual guard — `WORKFLOW_INTAKE_LINKS_ENABLED == "true"` AND `WORKFLOW_INTAKE_TOKEN_SECRET` set (≥32 bytes). Either missing → all routes return 503 with `FEATURE_DISABLED`.
- **Token return**: raw token returned ONCE at link creation; never re-derivable from the DB. Operator surfaces show "show once" warning copy.
- **Lifecycle**: `WorkflowIntakeLinkStatus` enum (ACTIVE | REVOKED | EXPIRED). `usedCount`/`maxUses` enforce single-use by default.
- **Sessions**: each redemption opens a `WorkflowIntakeSession` (status enum CREATED → OPENED → UPLOAD_STARTED → UPLOAD_COMPLETED → SUBMITTED | ABANDONED | REVOKED | EXPIRED). IP stored as HMAC-hashed value — raw IP never persisted.
- **Rate limits**: 30/IP/min + 20/token/min on every public route.
- **Audit emission**: 3 custody events (`EXTERNAL_INTAKE_LINK_USED`, `EXTERNAL_INTAKE_CONSENT_ACCEPTED`, `EXTERNAL_INTAKE_SUBMITTED`) appended to the canonical custody hash chain.

---

## 6. Delegated capture sessions

Workflow intake sessions support delegated capture for insurance / legal / newsroom / investigation workflows. The session is scoped to its parent link; presigned S3 PUT URLs are short-lived (600 s) and per-part; upload is followed by submit → the canonical `completeEvidence()` pipeline (NOT a separate intake-only finalize path). Capture method is recorded on the Evidence row as `EXTERNAL_INTAKE_UPLOAD`.

Delegated capture preserves:

- The canonical custody hash chain (intake events are appended via the same hashing primitive).
- The canonical Evidence lifecycle (CREATED → UPLOADING → UPLOADED → SIGNED → REPORTED).
- The canonical integrity primitives (SHA-256 per file, Ed25519 signature, multipart manifest).
- Legal-hold semantics — a hold on an evidence record blocks finalize regardless of upload path.

Delegated capture does NOT:

- Permit the external contributor to finalize evidence (finalize remains internal-reviewer territory).
- Permit the external contributor to mutate finalized evidence.
- Expose other evidence records, other cases, or any analytics/governance/admin surface.

---

## 7. External reviewer access

External reviewer grants (`external-review.routes.ts` + `external-review-grant.service.ts`):

- **Single-scope per grant**: exactly one EVIDENCE record, one CASE, or one PACKAGE.
- **Token storage**: 32 random bytes, SHA-256 hashed; never raw.
- **Lifetime**: 15 minutes to 30 days, operator-configured.
- **State machine**: INVITED → ACTIVE; REVOKED terminal.
- **Anti-enumeration**: unknown / revoked / expired all surface the same `grant_not_active` deny code.
- **Legal-hold gate**: an active hold on the underlying evidence blocks redemption; the deny code is `grant_blocked_by_legal_hold`.
- **Download flags** (`allowOriginalDownload`, `allowPackageDownload`) are off by default; operator must explicitly enable.
- **Audit emission**: 5 security events (`external_review_invited`, `external_review_revoked`, `external_review_grant_issue_failed`, `external_review_grant_transition_failed`, `external_review_grant_lookup_failed`); per-access counter bumped (best-effort) but no per-action event.
- **External identity**: NEVER created in `TeamMember`. Never enters the capability resolver. Grants are a separate, narrowly-scoped path.

---

## 8. Evidence request workflows

Evidence requests (`evidence-requests.routes.ts` + `evidence-request.service.ts`):

- **Token reuse**: each request binds to a Phase 4 `WorkflowIntakeLink` via `intakeLinkId` FK. Token shape + security inherited from §5.
- **Lifecycle**: `EvidenceRequestStatus` enum (DRAFT → SENT → ASSIGNED → IN_REVIEW → COMPLETED | CANCELED).
- **Response review**: internal MEMBER+ marks `EvidenceRequestResponse` as RECEIVED → UNDER_REVIEW / ACCEPTED / NEEDS_MORE_INFO / REJECTED.
- **Feature gate**: `EVIDENCE_REQUESTS_ENABLED`; all routes 503 when disabled.
- **Audit**: append-only `EvidenceRequestEvent` table (event types include `EVIDENCE_REQUEST_CREATED`, `EVIDENCE_REQUEST_SENT`, `EVIDENCE_REQUEST_ASSIGNED`, response transitions). **Gap**: external responder submission does NOT emit a `SecurityEvent` (DEF-030).

---

## 9. Token / link security model

Every external token (intake link, reviewer grant, evidence-request intake) satisfies:

- ≥256 bits of cryptographic entropy (`randomBytes(32)`).
- Hashed in the database — HMAC-SHA256 (intake) or SHA-256 (reviewer grants). Raw never stored.
- Constant-time verification via `timingSafeEqual()`.
- Per-request expiration check (eager — no grace period).
- Per-request revocation check (eager — status flip to REVOKED denies immediately).
- Single-use by default (intake `maxUses=1`; reviewer grants single-grant per token).
- Anti-enumeration deny code on the reviewer surface.
- Rate-limited on every public reachable route (intake surfaces; verify surface).
- Never exposes raw storage paths or signed S3 URLs in the response body.
- Audit events on issue + revocation; lifecycle transitions on the intake side; counter bumps on reviewer side.

Forbidden patterns (test-guarded):
- Sequential / DB-id tokens.
- Query-string tokens that survive in browser history.
- Permanent / non-expiring tokens.
- Public-folder buckets or direct S3 URL exposure.
- Token reuse across unrelated surfaces.

---

## 10. Audit & custody continuity

External actions emit audit events that integrate with the canonical custody chain and the security event stream:

| Action | Event |
|---|---|
| Intake token issued | (operator-side route + `EvidenceRequestEvent.EVIDENCE_REQUEST_SENT` where applicable) |
| External submitter opens session | `EXTERNAL_INTAKE_LINK_USED` (custody event) |
| External submitter records consent | `EXTERNAL_INTAKE_CONSENT_ACCEPTED` (custody event) |
| External submitter submits | `EXTERNAL_INTAKE_SUBMITTED` (custody event) → triggers canonical `completeEvidence()` |
| Reviewer grant issued | `external_review_invited` |
| Reviewer grant revoked | `external_review_revoked` |
| Reviewer grant accept | counter bump (per-access events deferred for later DEF-tracked work) |
| Reviewer grant access failure | `external_review_grant_lookup_failed` / `_issue_failed` / `_transition_failed` |
| Public verify hit | analytics-only `verificationView.create` row + `lastPublicVerifyViewAtUtc` (custody chain intentionally NOT polluted) |

Custody continuity is preserved end-to-end: an external submission flows through the same finalize pipeline as an internal submission. The verification chain is identical.

---

## 11. Frontend / UX

The external UX surfaces are intentionally minimal — task-focused, no workspace shell, no navigation chrome.

- **Workflow intake redemption page**: collects optional pseudonym / email, presents consent, uploads, submits. No sidebar. No team browsing. Branded with the workspace name + intake purpose.
- **External reviewer redemption page**: presents bounded scope context (which evidence / case / package; expiration; download permissions). Read-only by default.
- **Public verify page**: ID-based read-only render of the verification snapshot. Content access policy controlled by env var.
- **Share link**: `/share/[id]` stub directs users to the in-product Share Evidence flow on the evidence detail page.

The external UI:

- Surfaces organization identity (workspace name).
- Surfaces scope of access (intake link purpose, reviewer grant scope).
- Surfaces expiration when applicable.
- Surfaces upload / review purpose.
- Surfaces operational trust language (see §13) — never overclaims.

The external UI is NOT:

- A full workspace shell.
- A dashboard for the external participant.
- Navigation-heavy.
- A chat / messaging surface.

---

## 12. Notification / delivery alignment

External flows integrate with the Phase E3.2 / E3.3 webhook delivery runtime and the operator-facing notification surfaces:

- Intake link send (operator-driven) may trigger an outbound email via the bounded delivery runtime (request review, expiry warning, etc.).
- No new external-only notification channel is introduced.
- No spam workflows, no marketing automation, no arbitrary outbound messaging surface.
- All outbound webhook deliveries respect E3.2 / E3.3 bounds (HTTPS-only, HMAC-signed, 32 KiB payload cap, [5, 30, 300] s retry backoffs, auto-disable after 10 consecutive failures).

---

## 13. Governance & retention alignment

External submissions inherit the workspace's governance state:

- **Legal hold**: active hold on an evidence record blocks operator-side finalize AND blocks external reviewer redemption (`grant_blocked_by_legal_hold`).
- **Retention policy**: external submissions land under the workspace's retention rules from the moment `completeEvidence()` records them; Object Lock retention metadata round-trips when the bucket supports it.
- **Lifecycle**: the canonical Evidence lifecycle (CREATED → UPLOADING → UPLOADED → SIGNED → REPORTED) is unchanged. Externally-submitted evidence goes through the same finalize, signing, timestamp, and reporting pipeline.
- **Automation**: existing rule triggers (e.g. evidence-finalized) fire identically for externally-submitted evidence.
- **Analytics**: E4 analytics counters include externally-submitted evidence in their `evidenceCreated` / `evidenceFinalized` source counts (no separate "external" silo metric is invented).

No external flow bypasses governance.

---

## 14. Trust-language alignment

External-facing copy is gated by `EXTERNAL_ACCESS_FORBIDDEN_PATTERNS` — 13 regex patterns blocking marketing-shape trust claims:

- `legally verified evidence`
- `court-certified upload`
- `authenticity guaranteed`
- `tamper-proof forever`
- `tamper-proof`
- `forensically validated by AI` / `forensically validated`
- `court-ready link / upload / submission`
- `AI-validated`
- `SOC 2 compliant/certified`
- `zero-trust guaranteed/certified`
- `permanent share link`
- `public evidence bucket/folder/repository`

The Trust Center `automation-auditability` section now carries the bounded-external-collaboration paragraph (see §6 of the Trust Center surface).

---

## 15. Architecture invariants preserved

- 32.8 IA: root nav still exactly the 6 canonical primaries (asserted by Test 7).
- No new client-state / queue / pubsub library.
- No new Prisma migration in E8 (no schema change).
- No mutation of capture / custody / finalize / signing / timestamp / report / package — file-size pins remain green (Test 8).
- No mutation of auth / MFA / SAML / SCIM.
- No new capability key.
- No new root navigation item.
- Capability registry has zero external-participant dependency — verified by source-grep (Test 5).

---

## 16. Deferred items opened by Phase E8

All five are LOW severity, NON_BLOCKING, and tracked as operational housekeeping. None affects correctness or security.

| ID | Title | Notes |
|---|---|---|
| DEF-028 | External review reviewer-redemption routes have no rate limit | Operator routes use auth middleware; unauthenticated reviewer redemption routes are unbounded. Bounded by the per-request DB lookup but lacks the per-IP / per-token throttle that intake surfaces enjoy. |
| DEF-029 | External review surface has no feature flag kill switch | Cannot 503-short-circuit the surface during incident response without a route-level disable. |
| DEF-030 | Evidence request external response emits no `SecurityEvent` | The per-request `EvidenceRequestEvent` table receives the event, but the security event stream does not — operators cannot filter the security stream for external responder activity. |
| DEF-031 | No background sweep for expired external-review grants or expired workflow-intake links | Eager runtime check denies them correctly; DB grows monotonically. Companion to DEF-024 (SecurityEvent retention). |
| DEF-032 | `external_review_grants` table has no retention / GC policy | Operational housekeeping; same shape as DEF-024 / DEF-031. |

A future bounded phase can close 028 + 029 together (rate-limit + flag for the external review surface), 030 standalone (emit one security event from the external responder submission code path), and 031 + 032 together (a single retention worker that respects expired-link + expired-grant + SecurityEvent retain-days).

---

## 17. Test inventory

`services/api/test/phase-e8-external-distribution.test.ts` covers 9 test groups:

1. External participant types are bounded + complete (parametrised across 6 types).
2. External surface inventory covers the 5 known surfaces with stable shape (parametrised).
3. Forbidden external-facing trust-claim wording is absent everywhere (parametrised over types × forbidden patterns).
4. Backend code matches the audited contract — HMAC-SHA256 + timingSafeEqual + feature flag + rate limit + anti-enumeration + legal-hold deny code (10 grouped cases).
5. Capability registry has zero external-participant input (source-grep).
6. Trust Center extension landed cleanly — title + bullets + limitations (4 cases).
7. 32.8 IA preserved (1 case).
8. Protected core files unchanged (5 cases).
9. Documentation + registry — phase doc exists, registry row present, 5 new DEFs registered (3 cases).

Total: **~145 cases**.

---

## 18. CR1.7 closure summary

- **Entry-gate checklist**: completed in writing before any code edit. Three parallel audits.
- **Files added:**
  - `packages/shared-evidence-presentation/src/external-access-content.ts` (canonical content + helpers + inventory).
  - `services/api/test/phase-e8-external-distribution.test.ts` (145+ cases).
  - `docs/product/PHASE_E8_ENTERPRISE_DISTRIBUTION.md` (this file).
- **Files modified:**
  - `packages/shared-evidence-presentation/src/index.ts` — barrel re-export.
  - `packages/shared-evidence-presentation/src/trust-center-content.ts` — `automation-auditability` section extended with bounded-external-collaboration bullets + limitations.
  - `docs/recovery/MASTER_PHASE_REGISTRY.md` — Phase E8 row added; DEF-028 → DEF-032 added to §6.
- **No new DEFs resolved.** No prior phase deferred external-distribution work to E8.
- **5 new DEFs opened (all LOW, NON_BLOCKING).** See §16.

---

## 19. Remaining risks

- Provider-managed boundaries (S3 presigned URL TTL, KMS key availability, TSA / OTS provider availability) apply to external flows identically to internal flows.
- Operator discipline matters: revoking a grant immediately denies redemption, but the operator must DO the revocation. A future bounded phase could add a self-service revocation surface for external participants in narrow cases.
- Restore-rehearsal must include at least one external flow (intake redemption + reviewer grant) so the recovery path is validated end-to-end. Currently captured in §5 of E6 runbook 01 (db-restore) by reference; a future rehearsal log entry should document an explicit external-flow walk.

---

## 20. Next safe phase

Phase E9 (if planned) candidates, in priority order:

1. **External review hardening** — closes DEF-028 + DEF-029 (rate limit on reviewer-redemption routes + feature flag kill switch). Smallest surface, highest security value.
2. **External responder audit event** — closes DEF-030 (emit one `external_intake_response_submitted` SecurityEvent from the responder submission path). One file change.
3. **External grant + intake retention worker** — closes DEF-031 + DEF-032 (and naturally extends DEF-024 from E6). Single bounded retention service.
4. **External UX brand-consistency pass** — if customer feedback warrants it, tighten the external intake redemption page styling.

E8 itself is intentionally finished as a v1 surface. Its value comes from being calm, complete, and authoritative — not from constant churn.
