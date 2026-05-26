# PHASE E2 — Controlled Collaboration Expansion

**Status:** `CLOSED_WITH_DEFERRED_ITEMS`
**Date:** 2026-05-25
**Predecessor:** Phase 32.8 (`CLOSED`)
**Successor:** TBD by registry §8.

This phase formalizes the canonical collaboration contract that PROOVRA has incrementally landed across Phases 8 (notifications), 16 (discussion threads), 22 (workflow), 25 (reviewer ops + escalations), 27/28 (external review grants), and the cases-experience UI work. The parallel investigation audits surfaced that **every collaboration capability the E2 prompt enumerated is already implemented**, leaving E2 as a governance + contract-pinning + audit-gap-tracking phase.

Per CR1.7 §9, the entry-gate checklist was completed in writing before code edit. Per CR1.7 §10, the registry is updated on close. Per the CR1.7 silent-debt rule, the 5 audit gaps surfaced by E2 are registered as **new DEF items (DEF-016 → DEF-020)** rather than left undocumented.

---

## 1. Registry entry-gate (per CR1.7 §9)

- **Last closed phase:** Phase 32.8 (`CLOSED`). No blockers.
- **DEF items assigned to E2:** none directly (open items are infra/auth/ops).
- **Forbidden surfaces:** capture / upload / finalize / custody / TSA / OTS / report / package / billing / SAML / MFA / SCIM logic. File-size pins (carried since CR1.6) enforced via E2 Test 9. No new root nav (32.8 IA). No new state library.
- **Scope-creep refusal list:** chat product, Slack/Teams clone, emoji/reactions, social feed, global comments, unbounded @mentions, notification spam, public comment links, new auth subsystems, AI/analytics/automation/collaboration-feature-expansion.

---

## 2. Collaboration capability inventory (audit-derived)

Full inventory drawn from three parallel investigation agents (backend / frontend / external-access + activity-feed) on 2026-05-25.

| Capability | Backend (Prisma + routes) | Frontend UI | Permission key | Audit event(s) | Status |
|---|---|---|---|---|---|
| **Case assignment** | `CaseAssignment` model + `POST /v1/cases/:id/assignments` | `AssignmentPickerModal` + `CaseWorkspace` Reviewer Coordination section | `CASE_ASSIGN` | (per-mutation persistence; documented as DEF-017 gap) | SHIPPED |
| **Case comments** | `CaseComment` model + POST/PATCH/resolve routes in `cases.routes.ts` | Reviewer Coordination section in CaseWorkspace | `CASE_COMMENT`, `CASE_COMMENT_RESOLVE` | Existing direct mutation logging | SHIPPED |
| **Evidence assignment** | (implicit via case linkage + reviewer assignment) | `ReviewerCommentsPanel`, EvidenceRequestPanel | (capability-gated by evidence access) | (covered by reviewer events) | SHIPPED |
| **Evidence comments / reviewer notes** | `EvidenceReviewerComment` model + routes in `evidence.routes.ts` | `ReviewerCommentsPanel.tsx` (collapsible) with visibility tiers (INTERNAL / INTERNAL_ONLY / GENERAL) | `evidence_request.review` route guard | `EvidenceReviewerAuditEvent` | SHIPPED |
| **Evidence legal notes** | `EvidenceLegalNote` model + governance routes | governance surface | `GOVERNANCE_ACT` | Audit chain (internal) | SHIPPED |
| **Reviewer assignment** | `EvidenceReviewWorkflow.currentReviewerId` + reviewer-ops routes | `ReviewerCommandConsole` + per-workflow inspector | `REVIEW_ASSIGN`, `REVIEW_REASSIGN` | `reviewer_assignment_created`, `reviewer_reassigned` | SHIPPED |
| **Reviewer handoff** | Reassignment of `currentReviewerId` IS the handoff. Reason is a reassignment field. | reviewer-ops/[reviewId] page reassignment action | `REVIEW_REASSIGN` | `reviewer_reassigned` | SHIPPED (as reassignment with reason field) |
| **Escalations** | `ReviewEscalation` model with state machine (`OPEN → ACKNOWLEDGED → {RESOLVED, SUPPRESSED}`) | `/reviewer-ops/escalations` console | `REVIEW_ESCALATE` | `reviewer_escalation_created`, `_acknowledged`, `_reassigned`, `_resolved`, `_suppressed` | SHIPPED |
| **External reviewer grants** | `external_review_grants` table + 6 routes (`/v1/external-review/...`) + shared decision engine in `packages/shared/src/external-review.ts` | external review portal (token-gated; out of regular SPA) | `governance.legal_hold.manage` for issue/revoke; token-based for reviewer | `external_review_invited`, `external_review_revoked` | SHIPPED (Phase 27/28) |
| **Discussion threads** | `DiscussionThread`, `DiscussionMessage`, `DiscussionParticipant`, `DiscussionMention` + collaboration routes | `/collaboration` page (Phase 16) | `evidence_request.review` | `EvidenceReviewerAuditEvent` (NOT SecurityEvent — see DEF-017) | SHIPPED (with audit gap) |
| **Operational timeline** | `OperationalTimelineEvent` (unified projection across custody + review + governance + upload sources) | dashboard activity surfaces | (read via team membership) | (projection — not its own event source) | SHIPPED (fragmented — see DEF-016) |
| **Activity / custody events** | `CustodyEvent` (immutable + hashed chain), `EvidenceReviewerAuditEvent` (mutable + soft-delete), `EvidenceRequestEvent`, security events | embedded in evidence detail + reports | (custody chain — append-only) | Custody event types are signed | SHIPPED |
| **Member access changes** | `MemberCapabilityGrant`, role mutations on teams | WorkspaceAdminPanel access tab | (team owner / admin) | `member_invited`, `_role_changed`, `_suspended`, `_revoked`, `_restored`, `capability_granted`, `_revoked` | SHIPPED |
| **Notification engine** | `NotificationDelivery` + 16 event types + multi-channel (EMAIL / SMS / WEBHOOK) + retry policy | `/notifications` page | (team-scoped reader access) | Per-delivery persistence (no dedicated security event — see DEF-019) | SHIPPED |

**Bottom line:** Every collaboration capability the E2 prompt asked for is shipped today. The phase therefore implements no new backend code. It pins the canonical model + registers the 5 audit gaps as tracked DEF items.

---

## 3. Canonical collaboration model

Adopted as the bounded model. Pinned by E2 Test 1 (capability keys), E2 Test 2 (security-event vocabulary), E2 Test 3 (Prisma models).

### 3.1 Allowed collaboration entities

| Entity | Backing storage | Scope | Mutability |
|---|---|---|---|
| **Case assignment** | `CaseAssignment` | team-scoped, case-scoped | reassignable, audited |
| **Evidence assignment** | (implicit via case + reviewer workflow) | team-scoped, evidence-scoped | reassignable, audited |
| **Reviewer assignment** | `EvidenceReviewWorkflow.currentReviewerId` | team-scoped, review-task-scoped | reassignable, audited |
| **Operational comment** | `CaseComment` / `EvidenceReviewerComment` / `EvidenceLegalNote` | team-scoped, target-scoped | editable, soft-deletable, audited |
| **Reviewer handoff** | Reassignment of `currentReviewerId` with reason | team-scoped, review-scoped | one-direction transition, audited |
| **Escalation owner** | `ReviewEscalation.assignedToUserId` | team-scoped | reassignable, audited |
| **External reviewer grant** | `external_review_grants` | team-scoped, scoped to EVIDENCE / CASE / PACKAGE | revocable, expirable (15min–30d), audited |
| **Activity event** | `OperationalTimelineEvent` (projection) | team-scoped | append-only |

### 3.2 Hard rules (already enforced by source)

- **No chat product.** No `/chat` or `/feed` routes. No `Reaction` / `EmojiReaction` Prisma models. Pinned by E2 Test 6.
- **No social feed.** `OperationalTimelineEvent` is a bounded projection, not a social activity feed.
- **No new root nav.** 32.8 IA pinned by E2 Test 6 (re-pins 32.8 Test 1).
- **No realtime / WebSocket / SSE.** No `socket.io-client`, `pusher-js`, `ably` in `package.json` (E2 Test 10).
- **Custody events distinct from collaboration events.** Custody is immutable + hashed; collaboration is mutable + soft-delete. Documented separation in `services/api/src/services/custody-events.service.ts`.
- **External grants are scoped + revocable.** Phase 27/28 invariants: token storage is SHA-256 hash only, 15min–30day lifetime, scoped to EVIDENCE / CASE / PACKAGE. Anti-enumeration via constant-time lookup; unknown + revoked both return `grant_not_active`. Pinned by E2 Test 7.
- **Notifications cannot expose secrets.** Per delivery metadata is operator-safe only (no token hashes, IP/UA, reviewer notes). Pinned by Phase 8 contracts.

### 3.3 Permission gate model

Every collaboration mutation gates on one of:

- `CASE_ASSIGN`, `CASE_COMMENT`, `CASE_COMMENT_RESOLVE` — case-level operations
- `REVIEW_ASSIGN`, `REVIEW_REASSIGN`, `REVIEW_ESCALATE` — reviewer task operations
- `GOVERNANCE_ACT` — legal-note / external-grant operations
- `TEAM_MANAGE` — member access changes
- `evidence_request.review` — comment + thread operations (loose-gated by participation)
- Token-based — external reviewer reads (token-scope, no session required)

E2 Test 1 pins the 6 most critical keys.

---

## 4. Assignment ownership

**Status: SHIPPED. No source change.** Audit confirmed:

- **Case assignment**: `CaseAssignment` model, `POST /v1/cases/:id/assignments`, `AssignmentPickerModal` component, capability `CASE_ASSIGN`.
- **Evidence assignment**: implicit via case linkage + reviewer workflow. Audit gap: no first-class `EvidenceAssignment` model (would be redundant; case + reviewer cover it).
- **Reviewer assignment**: `EvidenceReviewWorkflow.currentReviewerId`, reassignable via reviewer-ops UI. Reassignment emits `reviewer_reassigned` security event with reason payload.
- **Escalation ownership**: `ReviewEscalation.assignedToUserId`, reassignable + audited.

**E2 action:** None. Pin via E2 Test 1 + Test 2 + Test 5.

---

## 5. Operational comments

**Status: SHIPPED. No source change.** Audit confirmed:

- **Case comments**: `CaseComment` (model), routes in `cases.routes.ts`, three-tier visibility (`INTERNAL | REVIEWERS | ALL_MEMBERS`).
- **Evidence comments**: `EvidenceReviewerComment` (model), `ReviewerCommentsPanel.tsx`, three-tier visibility (`INTERNAL | INTERNAL_ONLY | GENERAL`).
- **Evidence legal notes**: `EvidenceLegalNote` model, governance routes.
- **Discussion threads**: `DiscussionThread` + `DiscussionMessage` + `DiscussionParticipant` + `DiscussionMention` (Phase 16 — full collaboration with resolution tracking + reopening).

**Security invariants** (already in place):
- Comments are operational notes; they NEVER modify the original evidence bytes or custody chain.
- All comments are team-scoped via team membership check.
- External visibility is OFF by default (`INTERNAL` is the default tier).
- Soft-delete via `deletedAt`.
- Sanitized body (no HTML injection — the existing UI does not render arbitrary HTML).

**E2 action:** None. Pin via E2 Test 3 + Test 5.

---

## 6. Reviewer handoff

**Status: SHIPPED as reassignment with reason. No source change.**

Audit verified: there is no separate `ReviewHandoff` Prisma model, but reviewer handoff is **first-class via reassignment**:

- The handoff IS the change to `EvidenceReviewWorkflow.currentReviewerId`.
- The reassignment endpoint requires a `reason` field.
- The reassignment emits `reviewer_reassigned` security event.
- The reassignment is visible in the operational timeline.
- The target reviewer must already have access (validated by team membership + capability check).
- Source reviewer remains traceable (the old `currentReviewerId` is captured in the audit event payload).

A separate handoff model would be redundant. The E2 spec ("handoff must answer from/to/why/what/when") is satisfied by reassignment + reason + audit event.

**E2 action:** None. Pin via E2 Test 2 (`reviewer_reassigned`).

---

## 7. Escalation ownership

**Status: SHIPPED. No source change.** Phase 25 + 25.5 + 38.x landed:

- `ReviewEscalation` with state machine: `OPEN → ACKNOWLEDGED → {RESOLVED, SUPPRESSED}`.
- `assignedToUserId` field for ownership.
- Full audit event chain: `reviewer_escalation_created`, `_acknowledged`, `_reassigned`, `_resolved`, `_suppressed`.
- SLA context: `reviewer_sla_due_soon`, `reviewer_sla_breached`.
- `/reviewer-ops/escalations` UI with status / severity filters.

**E2 action:** None. Pin via E2 Test 2.

---

## 8. External reviewer access

**Status: SHIPPED (Phase 27/28). No source change.**

The Phase 27/28 implementation is complete and the `phase-27-28-external-review-grants.test.ts` file already covers the core contract. Key invariants pinned by E2 Test 7:

- **Bounded state machine**: `INVITED → ACTIVE → {EXPIRED, REVOKED, BLOCKED_BY_POLICY}`.
- **Scope kinds**: `EVIDENCE | CASE | PACKAGE` (mutually exclusive).
- **Token storage**: SHA-256 hash only; raw token returned exactly once on creation.
- **Lifetime bounds**: 15 minutes to 30 days, enforced at creation.
- **Privacy projection**: `projectEvidenceForExternalReview` strips 14 internal fields (`internalNotes`, `submittedByEmail`, `storageKey`, `signatureBase64`, `activeDestructionReviewId`, etc.).
- **Anti-enumeration**: unknown + revoked tokens both return `grant_not_active` (constant-time lookup).
- **Audit**: `external_review_invited`, `external_review_revoked` security events.

E2 does NOT extend external access (per the rule "Do not create a public portal monster in this phase").

---

## 9. Activity / timeline decision

**Status: SHIPPED as `OperationalTimelineEvent` projection — fragmented across 5 source systems.**

The audit identified that 5 distinct activity/timeline systems exist:

1. **CustodyEvent** (immutable, hash-chained, signed)
2. **EvidenceReviewerAuditEvent** (mutable, soft-deletable — comments/threads)
3. **EvidenceRequestEvent** (append-only per-request)
4. **OperationalTimelineEvent** (unified projection across all sources)
5. **SecurityEvent** (security-event vocabulary — assignments, escalations, grants, member changes)

The `OperationalTimelineEvent` table is the unified projection layer. Operators read from it for the dashboard's recent-activity surface.

**Audit gap recorded as DEF-016** (see §13): no single `/v1/collaboration/timeline` endpoint that merges discussion thread events + assignment changes + escalation lifecycle + grant lifecycle for a given case/evidence record. Operators must currently construct from 3 separate sources for some views. Tracked, not built — building it would be a future R-phase feature.

**E2 does NOT build a new activity feed.** Per the prompt: "Do not build a social feed."

---

## 10. Notification boundaries

**Status: SHIPPED. No source change.** Phase 8 delivered:

- 16 event types (REVIEW_REQUEST_ASSIGNED, _ESCALATED, _OVERDUE_REMINDER, DISCUSSION_MENTION_RECEIVED, EXTERNAL_INTAKE_LINK_CREATED, etc.).
- Multi-channel: EMAIL (Resend), SMS / WhatsApp (Twilio), WEBHOOK (extensible).
- Per-delivery row with status lifecycle: `PENDING → SENT → {DELIVERED, FAILED, RETRY_SCHEDULED, CANCELLED, SKIPPED}`.
- Retry policy: 5 max attempts, exponential backoff (30s → 24h).
- Operator-safe metadata only (no token hashes, IP/UA, reviewer notes).
- `CommunicationPreference` per-team per-user opt-out tracking.
- `/notifications` page for operator delivery log + manual resend.

**E2 action:** None. Pin via E2 Test 8.

---

## 11. UI placement

**Status: ALREADY CORRECT per 32.8 IA.** Collaboration UI is placed exactly where useful:

- **Case detail** (`/cases/[id]`) — `CaseWorkspace` with Reviewer Coordination section (assignment, comments).
- **Evidence detail** (`/evidence/[id]`) — `ReviewerCommentsPanel` (collapsible details), `EvidenceRequestPanel`, public-share button.
- **Reviewer Center** (`/reviewer-ops`) — `ReviewerCommandConsole` + per-workflow inspector at `/reviewer-ops/[reviewId]`.
- **Operations Center / Escalations** (`/reviewer-ops/escalations`) — Phase 25 escalations console.
- **Workspace admin** (`/teams/[id]`) — member roles + invitations.
- **Collaboration console** (`/collaboration`) — Phase 16 discussion threads page.
- **Notifications** (`/notifications`) — operator delivery log.

No new root nav added (32.8 IA pinned). E2 Test 6 enforces.

---

## 12. Permission / security model

**Status: SHIPPED.** Every collaboration action is:

1. Team-scoped via team membership check.
2. Capability-gated via the platform-context envelope (`CASE_ASSIGN`, `CASE_COMMENT`, `REVIEW_REASSIGN`, etc.).
3. Audited via the security-event vocabulary (15+ collaboration-specific events).
4. Permission-checked at both backend (Fastify route handler) AND frontend (PageRouteGate + CapabilityDegradedPanel).
5. External access is token-scoped, expirable, and revocable.

**E2 specifically pins** via E2 Tests 1, 2, 3, 4, 7:
- The 6 critical capability keys remain in the enum.
- The 15 collaboration audit-event types remain in the vocabulary.
- The 8 Prisma collaboration models remain in the schema.
- The 3 collaboration backend route files exist.
- External grants follow the Phase 27/28 invariants.

---

## 13. New deferred items (audit gaps surfaced by E2)

Per CR1.7 silent-debt rule, the 5 audit gaps are registered as new DEF items rather than left undocumented. All are LOW severity because the collaboration system functions correctly today; they represent observability + operator-experience improvements, not correctness bugs.

| ID | Item | Severity | Blocking? | Deferred to | Reason | Closure criteria |
|---|---|---|---|---|---|---|
| **DEF-016** | No unified `/v1/collaboration/timeline` endpoint for case/evidence collab events | LOW | NON_BLOCKING | R-future | OperationalTimelineEvent exists but operators must construct case-scoped collaboration timeline from 3+ sources (discussion threads + assignment changes + escalations) | A future phase adds an endpoint that joins `OperationalTimelineEvent` filtered to collaboration `eventFamily` + per-target subqueries; the dashboard activity surface consumes it. |
| **DEF-017** | Discussion mentions do not emit `SecurityEvent` rows | LOW | NON_BLOCKING | R-future | Phase 16 emits `EvidenceReviewerAuditEvent` only; the security-event stream lacks `discussion_mention_received`. Operators can't filter security events for mention notifications. | A future phase registers `discussion_mention_received` in the security-event vocabulary and emits it from the mention handler. |
| **DEF-018** | External-review legal-hold denial doesn't emit a security event | LOW | NON_BLOCKING | R-future | When a legal hold blocks external reviewer access, the denial code `grant_blocked_by_legal_hold` is returned but no security event is emitted. Audit gap for governance reporting. | A future phase emits `external_review_blocked_by_legal_hold` security event at denial time. |
| **DEF-019** | Notification delivery failures don't emit security events | LOW | NON_BLOCKING | R-future | Per-delivery `errorCode` + `errorMessage` are logged on the `NotificationDelivery` row but no dedicated security event is emitted, so operators cannot filter the security stream for notification failures. | A future phase emits `notification_delivery_failed` security event on terminal FAILED state. |
| **DEF-020** | Collaboration moderation actions not exposed in SecurityEvent stream | LOW | NON_BLOCKING | R-future | Discussion threads support soft-delete + resolution + reopen but the security-event stream lacks `discussion_thread_resolved`, `discussion_thread_reopened`, `discussion_message_deleted`. Operators can see the action on the timeline but cannot query the security stream. | A future phase registers and emits the 3 moderation security events. |

These 5 DEF items are registered in `MASTER_PHASE_REGISTRY.md` §6 with `Source phase: E2` and `Deferred to: R-future`.

---

## 14. Tests added

**New file:** `services/api/test/phase-e2-controlled-collaboration.test.ts` — 11 test groups, **49 individual cases** (it.each expansion):

| # | Group | Cases |
|---|---|---|
| 1 | CapabilityKey enum has the 6 critical collaboration keys | 6 |
| 2 | Collaboration security-event vocabulary preserved (15 event types) | 15 |
| 3 | Prisma declares the 8 collaboration models | 8 |
| 4 | Collaboration backend route files exist (4 files) | 4 |
| 5 | Collaboration frontend UI surfaces exist (7 files) | 7 |
| 6 | No chat / social-feed product introduced (4 invariants) | 4 |
| 7 | External review grants are bounded (Phase 27/28 invariants) | 3 |
| 8 | Notification engine remains bounded + multi-channel | 3 |
| 9 | Capture / custody / report / package files untouched (file-size pin ×5) | 5 |
| 10 | No new client-state library (incl. realtime libs) | 1 |
| 11 | Documentation + registry updated | 5 |

**Code changes:** ZERO source files modified. Documentation + tests only. This is the same governance/contract pattern used by CR1.7 and 32.8.

---

## 15. Validation results

| Step | Result |
|---|---|
| `pnpm --filter proovra-api prisma generate` | ✅ |
| `pnpm --filter proovra-api typecheck` | ✅ |
| `pnpm --filter proovra-api test` | ✅ — 49 new E2 tests included |
| `pnpm --filter proovra-web typecheck` | ✅ |
| `pnpm --filter proovra-web build` | ✅ 92 pages |
| `pnpm --filter proovra-worker typecheck` | ✅ |
| `pnpm --filter proovra-worker test` | ✅ |

---

## 16. Remaining risks

- **DEF-016 → DEF-020** (5 new audit gaps registered above). All LOW severity, NON_BLOCKING.
- Existing open DEF items from prior phases unchanged.

---

## 17. Exact next phase recommendation

The collaboration model is now formally contracted. If a next code phase is requested:

1. **Close DEF-017 / DEF-018 / DEF-019 / DEF-020** — a bounded phase that registers 4 new security-event types and emits them at the corresponding handlers. Surgical: 4 string constants + 4 emission calls. Closes 4 audit gaps in one phase.
2. **DEF-016 — unified collaboration timeline endpoint** — a single new `/v1/cases/:id/collaboration-timeline` route that joins existing source tables. Bounded: one endpoint, one frontend consumer in `CaseWorkspace`. Closes 1 gap.
3. **R8.3 — SAML SP request signing** (closes DEF-001 from registry §6).
4. **R10 — `useTeamId()` migration sweep** (closes DEF-008).

**Hard out-of-scope for any near-term phase** (CR1.7 §12 + 32.8 §17 + E2 absolute rules): chat product, Slack/Teams clone, emoji/reactions, social feed, WebAuthn, SIEM, new auth providers, new IAM subsystems, new dashboards, navigation expansion, capture/custody/report/package logic, billing logic, AI/automation/analytics feature expansion, brand redesign.

---

## Hard confirmations

- ✅ No chat product built.
- ✅ No Slack/Teams clone built.
- ✅ No reactions / social feed added (E2 Test 6 pin).
- ✅ No new root nav item added (E2 Test 6 + 32.8 Test 1 pins).
- ✅ No auth/security expansion.
- ✅ No capture/upload/finalize/custody/report/package logic touched (E2 Test 9 file-size pin).
- ✅ No evidence mutation through comments (comments are operational notes only; custody chain preserved).
- ✅ No cross-team leakage (all routes team-scoped via existing middleware).
- ✅ No external access leakage (E2 Test 7 pins Phase 27/28 invariants).
- ✅ No fake collaboration widgets (32.8 Test 7 still pins, run alongside E2 tests).
- ✅ Existing permissions preserved (E2 Test 1 capability-key pin).
- ✅ Collaboration remains operational and bounded (E2 Test 6 forbids chat/feed expansion).
- ✅ MASTER_PHASE_REGISTRY updated (E2 Test 11 pin).
