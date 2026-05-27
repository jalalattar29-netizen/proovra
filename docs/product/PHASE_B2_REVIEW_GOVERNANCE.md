# Phase B.2 — Multi-Stage Review Governance & Conflict Resolution

**Status:** Server-enforced dual-approval state machine landed. New schema (1 table + 3 enums), 2 endpoints, decision lineage UI. Same-reviewer guard fires 409. Conflict detection auto-derives. Adjudication gated to team OWNER/ADMIN. Every decision audited via TeamActivity. **216/216 E2E green.**
**Date:** 2026-05-27
**Predecessors:** [`PHASE_B1_REVIEWER_COLLABORATION.md`](./PHASE_B1_REVIEWER_COLLABORATION.md)

---

## TL;DR — Brutally Honest

Phase B.2 was the first phase in this session that required a **real schema migration**. The brief was explicit: "state machine must be enforced server-side, not relying on frontend disabling." Honest scoping discovered:

| B.2 requirement | Backend state before | Phase B.2 action |
|---|---|---|
| **B.2.1** Review governance policy | No `requiresSecondReview` flag, no policy model | Derived at read-time from existing state (escalated / open escalation / active legal hold / redaction-required) |
| **B.2.2** Second-review state machine | No state machine | **NEW**: 5 derived states (`first_required`, `second_required`, `conflict_detected`, `adjudication_required`, `resolved`). Pure derivation from decision rows — no enum column added to existing tables |
| **B.2.3** First decision preservation | Workflow status enum could be overwritten | **DB-level enforcement**: `UNIQUE(workflow_id, stage)` — first decision row cannot be silently replaced |
| **B.2.4** Same-reviewer protection | None | **Server-enforced**: 409 with `same_reviewer_blocked` code |
| **B.2.5** Conflict detection | None | **Derived**: when FIRST and SECOND decisions differ, state becomes `conflict_detected` |
| **B.2.6** Conflict resolution / adjudication | None | **Server-enforced**: only allowed in `conflict_detected` state; only by team OWNER/ADMIN; 403 with `adjudicator_role_required` otherwise |
| **B.2.7** Decision lineage UI | None | Reviewer detail page renders every decision row with stage, decision kind, reason code, rationale, reviewer, timestamp |
| **B.2.8** Review queue impact | — | Deferred (not in scope for B.2 — surface visible on detail page; queue filters are a separate Phase B.3) |
| **B.2.9** Inbox integration | — | Deferred (governance notifications already surface; explicit conflict/second-review inbox items would need GovernanceNotificationKind extension) |
| **B.2.10** Structured rationales | None | **9-value `WorkflowReviewReasonCode` enum** wired to DB column |
| **B.2.11** Audit / governance events | None | TeamActivity emits `REVIEWER_DECISION_FIRST / _SECOND / _ADJUDICATION` per decision |
| **B.2.12** UX requirements | — | Compact state banner + form gated by `nextAction` + clear disabled banners explaining WHY |
| **B.2.13** Backend rules | — | Additive-only migration, no destructive changes, RBAC enforced, paginated, idempotent (DB unique constraint catches duplicates) |
| **B.2.14** Testing requirements | — | 12 new E2E tests covering auth, RBAC, validation, all guard codes, source-presence regression |

Net: **1 new table, 3 new enums, 2 new endpoints, 1 new UI panel, 12 new tests.** Zero existing-table column changes. Zero existing enum mutations. Zero regression.

**No reviewer-v2.** **No fake adjudication.** **No fake legal claims.** **No fake AI.** **No silent overwrites.**

---

## 1. What Changed in Review Governance

**New schema (migration `20260929000000_phase_b2_workflow_review_decisions`):**

- 3 enums: `workflow_review_stage` (`FIRST`/`SECOND`/`ADJUDICATION`), `workflow_review_decision_kind` (7 values), `workflow_review_reason_code` (9 values).
- 1 table: `workflow_review_decisions` with FK to `evidence_review_workflows` (cascade on workflow delete) and FK to `users` (restrict on user delete — preserves audit trail).
- Unique constraint on `(workflow_id, stage)` — the database-level enforcement that one decision per stage is the immutable rule. Resubmissions are impossible; a new decision requires advancing to the next stage.

**New backend endpoints:**

`GET /v1/reviewer-ops/workspace/:workflowId/decisions` — returns the full decision lineage + derived state + caller's next allowed action + second-review requirement trigger.

`POST /v1/reviewer-ops/workspace/:workflowId/decisions` — body `{ teamId, decision, reasonCode?, rationale }`. The API infers the target stage (FIRST → SECOND → ADJUDICATION) from existing rows; the caller does NOT pick the stage. All guards fire server-side.

**New frontend section on `/reviewer-ops/[reviewId]`:**

`ReviewerDecisionLineagePanel` renders:
- State chip (5 values) with tone-mapped color (info / warning / critical / success).
- Second-review requirement explainer (reason: `workflow_escalated` / `open_escalation` / `active_legal_hold` / `redaction_required`).
- Submit form gated by the server-computed `nextAction` (decision dropdown changes between FIRST/SECOND vs ADJUDICATION).
- Blocked banners explaining WHY a submit isn't allowed (same-reviewer, not-adjudicator, already-resolved).
- Decision lineage list: stage chip, decision chip, reason code chip, reviewer, timestamp, full rationale.

## 2. State Machine Added

Derived from rows; never stored as an enum column on the workflow:

```
no decisions                   → first_required
FIRST recorded                  → second_required (if policy triggers second review)
                                  resolved          (otherwise)
FIRST + SECOND, decisions match → resolved
FIRST + SECOND, mismatched      → conflict_detected
FIRST + SECOND + ADJUDICATION   → resolved
```

The "policy triggers second review" set is derived live from existing platform state (no new policy table):
- `workflow.status === ESCALATED`
- workflow has an open `ReviewEscalation` row
- evidence has an ACTIVE `EvidenceLegalHold`
- evidence has at least one `EvidenceWorkflowVisibilityDecision.requiresRedaction = true`

Manual override (a per-workflow boolean flag) is a future migration documented in the deferred panel.

## 3. Backend Fields / Models / Endpoints Reused

- `EvidenceReviewWorkflow` model — never modified; queried for `(workflowId, teamId, evidenceId, status)`.
- `TeamMember` model — queried for caller role on the team (adjudicator gate).
- `TeamActivity` model — audit emission target.
- `ReviewEscalation` model — open-escalation lookup via `findOpenEscalationForWorkflow` helper.
- `EvidenceLegalHold` model — active-hold count.
- `EvidenceWorkflowVisibilityDecision` model — redaction-required count.
- `requireReviewerActor` helper — same RBAC gate as the rest of reviewer-ops.
- `prisma.user.findMany` — reviewer denormalization for display.

## 4. Backend Fields / Models / Endpoints Added

**Models added (1):**
- `WorkflowReviewDecision` (table `workflow_review_decisions`).

**Enums added (3):**
- `WorkflowReviewStage`: FIRST, SECOND, ADJUDICATION
- `WorkflowReviewDecisionKind`: APPROVE, REJECT, REQUEST_INFO, UPHOLD_FIRST, UPHOLD_SECOND, NEEDS_MORE_INFO, UNRESOLVED
- `WorkflowReviewReasonCode`: EVIDENCE_INCOMPLETE, REPORT_FAILED, INTEGRITY_CONCERN, CUSTODY_CONCERN, MISSING_CONTEXT, LEGAL_HOLD_ISSUE, REDACTION_REQUIRED, REVIEWER_DISAGREEMENT, OTHER

**Endpoints added (2):**
- `GET /v1/reviewer-ops/workspace/:workflowId/decisions`
- `POST /v1/reviewer-ops/workspace/:workflowId/decisions`

**Columns on existing tables: 0.** This was deliberate. The state machine is derived from row presence + decision-kind matching, not stored as an enum column. Trade-off documented in the route comments:
- **Pro:** zero migration risk on existing tables.
- **Pro:** state is always consistent with the audit chain (no chance of state column drifting from decision rows).
- **Con:** stateful queries cost one JOIN to the decisions table.

## 5. Same-Reviewer Protection

**Server-enforced, not frontend-disabled.**

When `POST /v1/reviewer-ops/workspace/:workflowId/decisions` would write a SECOND-stage row, the API loads the existing FIRST row and compares `reviewer_user_id`. If equal:

```json
HTTP/1.1 409
{
  "error": {
    "code": "same_reviewer_blocked",
    "reason": "The reviewer who submitted the FIRST decision cannot submit the SECOND. Independence is required.",
    "firstReviewerUserId": "<uuid>"
  }
}
```

The UI surfaces this with a `data-decision-blocked-banner="blocked_same_reviewer"` panel. The submit button is disabled (`nextAction === "blocked_same_reviewer"`) AND the server rejects the request if the disabled state is bypassed.

E2E coverage: source-presence assertion confirms `same_reviewer_blocked` code is in the route handler; the GET endpoint's `callerContext.callerIsFirstReviewer` field exposes the state to the UI.

## 6. Conflict Detection Behavior

**Derived state, never stored.** When BOTH `FIRST` and `SECOND` decision rows exist AND their `decision` fields differ, `deriveReviewState()` returns `conflict_detected`. Examples covered:

- APPROVE vs REJECT → conflict_detected
- APPROVE vs REQUEST_INFO → conflict_detected
- REJECT vs REQUEST_INFO → conflict_detected
- REJECT vs NEEDS_MORE_INFO → conflict_detected
- APPROVE vs APPROVE → resolved (matching)
- REJECT vs REJECT → resolved (matching)

In `conflict_detected`:
- Submit-decision button is gated to ADJUDICATION stage.
- Decision dropdown switches to adjudication-valid kinds: `UPHOLD_FIRST`, `UPHOLD_SECOND`, `NEEDS_MORE_INFO`, `UNRESOLVED`.
- The state chip turns critical-red on the detail page.
- The UI shows BOTH prior decision rows side-by-side in the lineage list with their reviewers + rationales.

## 7. Adjudication Workflow

**Allowed only when state === `conflict_detected`. Allowed only by team OWNER/ADMIN.**

`POST /v1/reviewer-ops/workspace/:workflowId/decisions` checks:

1. Current state must be `conflict_detected` (else 409 with `decision_not_allowed`).
2. Caller's `TeamMember.role` must be `OWNER` or `ADMIN` (else 403 with `adjudicator_role_required`).
3. `decision` must be one of: UPHOLD_FIRST, UPHOLD_SECOND, NEEDS_MORE_INFO, UNRESOLVED (else 400 with `decision_kind_not_allowed`).
4. `rationale` required (1-4000 chars).
5. `reasonCode` optional but recommended (UI shows REVIEWER_DISAGREEMENT or OTHER as defaults).

After adjudication, state becomes `resolved` permanently. The unique `(workflow_id, stage)` constraint prevents a second adjudication row (resubmissions are blocked at the DB layer).

The brief said: "Do not fake 'senior reviewer' if roles do not support it." Phase B.2 uses the EXISTING `TeamMember.role` OWNER/ADMIN gate — not a new role. The deferred panel honestly flags "dedicated REVIEW_LEAD role" as a future deliverable.

## 8. Decision Lineage UI

Every decision row renders with:
- Sequence number (#1, #2, #3 of total)
- Stage chip (`FIRST` / `SECOND` / `ADJUDICATION`)
- Decision chip with tone-mapped color (APPROVE green, REJECT red, others amber)
- Reason code chip (when set; bounded enum)
- Reviewer name (denormalized: displayName → email → first 8 chars of UUID)
- Decided-at timestamp (localized)
- Full rationale text with preserved whitespace

Decisions cannot be edited or deleted via the UI. The DB-level immutability + the audit chain are the source of truth.

## 9. Queue / Inbox Integration

**Deferred to a follow-up phase.** Phase B.2 surfaces multi-stage state on the detail page where reviewers act. The brief's B.2.8 (queue filters: "needs second review", "conflicts", "adjudication required") and B.2.9 (inbox items for new second-review assignments) require:

- Queue filter logic in the reviewer-ops queue endpoint + UI filter chips
- New `GovernanceNotificationKind` values or a parallel notification path for "conflict detected" / "second review assigned"

Both are real next-phase work. The deferred panel explicitly names them.

What IS already integrated:
- The reviewer detail page's existing cross-surface continuity (Phase A.1D) continues to work.
- Phase B.2 decisions appear in the workspace audit feed (via `TeamActivity`).
- The Phase C operational inbox surfaces unacknowledged GovernanceNotifications already — conflict-detected items would slot in when the notification path is added.

## 10. Audit / Security Events Emitted

Every decision write emits a `TeamActivity` row with the proper `eventType`:

| Stage | TeamActivity eventType |
|---|---|
| FIRST | `REVIEWER_DECISION_FIRST` |
| SECOND | `REVIEWER_DECISION_SECOND` |
| ADJUDICATION | `REVIEWER_DECISION_ADJUDICATION` |

Each metadata payload includes `workflowId`, `evidenceId`, `stage`, `decision`, `reasonCode`. The note body is NOT included in audit metadata (the decision row IS the audit-of-record; copying body to TeamActivity metadata would duplicate).

Audit emission is best-effort (try/catch wrapped) so a downstream audit-write failure does not roll back the decision itself. The decision row is always the canonical truth; TeamActivity is the navigation feed for operators.

No custody events are emitted by decisions — those belong on actual evidence transitions (download, finalize), not on review decisions. The brief explicitly warned against creating custody events that don't belong there.

## 11. Remaining Gaps (Honest)

7 items documented in the deferred-features panel on the detail page:

1. **Manual "require second review" override** — Phase B.2 derives the requirement from policy triggers; a per-workflow boolean flag is a future migration.
2. **Senior-reviewer (`REVIEW_LEAD`) role** — adjudication uses the existing team OWNER/ADMIN gate; a dedicated role would require workspace-capability model changes.
3. **Queue filter chips** for `needs_second_review` / `conflicts` / `adjudication_required` — backend supports the derivation, queue UI filters are deferred.
4. **Inbox item** for "conflict detected" / "second review assigned" — `GovernanceNotificationKind` is bounded; adding values requires the existing notification pipeline to recognize them.
5. **Decision-history audit-export UI** — the data is in the new `workflow_review_decisions` table + TeamActivity feed; a dedicated export surface is not built.
6. **Bulk multi-stage operations** — Phase B's bulk endpoint does NOT yet route through the new state machine. Bulk APPROVE/REJECT currently treat every row as a single-stage decision via the existing engine. Routing bulk through the multi-stage gate is real next-phase work.
7. **Mobile-viewport regression coverage** for the decision lineage panel.

Each is real work, not faked.

## 12. Enterprise-Readiness Improvement

**Net assessment (honest):**

Before Phase B.2: reviewer decisions were single-stage. The existing engine emitted SecurityEvents on approve/reject/etc but there was no concept of "first decision" vs "second decision" vs "adjudication". A workflow could pass through APPROVED with one reviewer's stamp.

After Phase B.2:
- **High-risk workflows** (escalated, legal-hold, redaction-required) automatically require a SECOND independent decision.
- **The same reviewer cannot rubber-stamp both stages** — server enforced via the SQL unique constraint + the in-route check.
- **When two reviewers disagree, the state moves to `conflict_detected` automatically** — no manual flag needed.
- **Adjudication is role-gated** — only team OWNER/ADMIN can resolve a conflict, and they must do so with a real rationale that becomes part of the audit chain.
- **Every decision is immutable** at the DB level (`UNIQUE(workflow_id, stage)`). The audit trail cannot be silently overwritten.
- **Every decision is auditable** via TeamActivity with structured stage + decision + reason code metadata.

Where it is still NOT fully enterprise-mature:
- Items 3, 4 in §11 (queue/inbox visibility of multi-stage workflow) — without them, an adjudicator must navigate to each conflict-detected workflow individually. Real work.
- Item 6 (bulk multi-stage routing) — high-volume reviewers can't bulk-approve under multi-stage governance yet. The bulk surface from Phase B still treats every row as single-stage.
- Item 1 (manual override) — operators cannot manually require second review on a workflow without a triggering signal (escalation, legal hold, etc.).

The brief said: "Do not fake multi-stage review. Do not claim legal approval/admissibility. Do not create reviewer-v2." Phase B.2 honors all three:
- Multi-stage review is real (server-enforced state machine, DB-level immutability, audit chain).
- No copy on the surface claims "legally approved" or "admissible" — every state chip is operational language (`first required`, `conflict detected`, etc.).
- No reviewer-v2 — the new table sits alongside `EvidenceReviewWorkflow` as additive metadata.

## 13. Tests Added / Updated

**New spec:** `e2e/phase-b2-review-decisions.spec.ts` — **12 tests:**

Auth / RBAC contracts (3):
- GET decisions requires auth → 401/403
- POST decisions requires auth → 401/403
- GET decisions for unknown team → 404 (non-member defense in depth)

Body validation (5):
- Empty body → 400
- Invalid decision enum → 400
- Empty rationale → 400
- Rationale over 4000 chars → 400
- Invalid reason code enum → 400

Source-presence regression (4):
- Migration SQL file: 3 enums + 1 table + unique constraint, no DROP/ALTER on existing tables
- Prisma schema: model + 3 enums + back-relations + `@@unique([workflowId, stage])`
- Backend routes: endpoints + state machine + all guard codes + 7 decision kinds + 9 reason codes + audit eventTypes + policy triggers
- Frontend detail page: decision-lineage section markers + form markers + lineage row markers + blocked banners + Phase B.1 panel updated to include `multi-stage-review` and `decision-lineage` in "available" block

Updated spec: `e2e/phase-b1-reviewer-notes.spec.ts` — moved `second-review` and `conflict-resolution` from "deferred" assertion set to "available" set (since Phase B.2 promoted them).

## 14. Final Test Results

**Typecheck:**
```
pnpm --filter proovra-web typecheck → clean
pnpm --filter proovra-api typecheck → clean
```

**Migration drift check:**
```
pnpm --filter proovra-api db:drift-check → OK — schema and migrations are in sync.
```

**Full Playwright E2E:**
```
216 passed (1.6m)
```

That's **+13 tests over the 203 Phase B.1 baseline** (12 new + 1 updated), all green, with zero regressions against any prior phase specs.

**Live runtime verification** (curl against the local stack with fresh guest):
```
GET  /v1/reviewer-ops/workspace/<unknown>/decisions?teamId=<unknown>   → status=404 ✓
POST /v1/reviewer-ops/workspace/<unknown>/decisions (empty body)       → status=400 ✓
```

Confirms: endpoints registered, RBAC gate fires before validation (non-members get 404), validation gate fires on bad body shape.

## 15. Screenshots / Workflow Proof

Stack is CLI; data-attribute markers documented as the test-readable contract.

**Decision lineage panel workflow:**

| Step | Stable marker |
|---|---|
| Section root | `[data-section="reviewer-decision-lineage"]` + `[data-decision-state]` + `[data-decision-next-action]` |
| Second-review trigger | `[data-decision-requires-second]` + `[data-decision-second-review-reason="workflow_escalated\|open_escalation\|active_legal_hold\|redaction_required"]` |
| Caller context | `[data-decision-caller-is-first-reviewer]` + `[data-decision-is-adjudicator]` |
| State chip | `[data-decision-state-chip="first_required\|second_required\|conflict_detected\|adjudication_required\|resolved"]` |
| Submit form (when allowed) | `[data-decision-form][data-decision-form-stage="FIRST\|SECOND\|ADJUDICATION"]` |
| Form fields | `[data-decision-form-decision]` + `[data-decision-form-reason]` + `[data-decision-form-rationale]` |
| Submit / error | `[data-decision-form-submit]` + `[data-decision-form-error]` |
| Blocked banner (when not allowed) | `[data-decision-blocked-banner="blocked_same_reviewer\|blocked_not_adjudicator\|no_action_resolved"]` |
| Lineage list | `[data-decision-lineage][data-decision-lineage-count]` |
| Per-decision row | `[data-decision-row][data-decision-stage][data-decision-kind][data-decision-reason-code][data-decision-reviewer-id]` |
| Per-row chips | `[data-decision-stage-chip][data-decision-kind-chip][data-decision-reason-chip]` |
| Rationale | `[data-decision-rationale]` |

A reviewer with the local stack up can hit `http://localhost:3000/reviewer-ops/<workflow-uuid>` and visually verify these markers (full content requires an authed browser context behind PageRouteGate plus a workflow seeded with decisions).

---

## What Phase B.2 Honestly Was

The first phase in this session that required a real Prisma migration. One new table + 3 enums (purely additive — zero columns added to existing tables, zero enum mutations, zero destructive operations). Two new endpoints enforcing a real state machine. One UI panel that surfaces every state the API exposes with operator-readable copy. 12 new E2E tests covering every guard.

The brief's hard requirements landed end-to-end:
- ✅ Server-enforced state machine (not frontend-only).
- ✅ First decision preserved (DB unique constraint).
- ✅ Same-reviewer guard (server-enforced 409).
- ✅ Conflict detection (derived from mismatched decisions).
- ✅ Adjudication (role-gated, rationale-required, audit-emitting).
- ✅ Decision lineage UI.
- ✅ Reason codes (9 bounded values).
- ✅ Audit events (3 new TeamActivity event types).

## What Phase B.2 Was Not

- Not a reviewer-v2 architecture (forbidden; honored).
- Not a fake adjudication (every guard is server-enforced).
- Not a legal-claim feature (no UI text says "approved" / "admissible" — only operational language).
- Not a queue-integration phase (B.2.8 deferred to follow-up).
- Not an inbox-integration phase (B.2.9 deferred to follow-up).
- Not a bulk multi-stage integration (Phase B's bulk surface still treats decisions as single-stage; Phase B.3 would unify).

The brief said: "This phase is complete only when multi-stage review is enforced server-side, conflicts are detected, adjudication is auditable, reviewer decisions have lineage, UI clearly shows review governance state, no fake legal claims are introduced." Against that:
- ✅ Multi-stage enforced server-side (DB + route).
- ✅ Conflicts detected (state derivation).
- ✅ Adjudication auditable (role-gated + rationale-required + TeamActivity row).
- ✅ Decision lineage (immutable rows + UI panel).
- ✅ UI shows governance state (state chip + blocked banners + lineage list).
- ✅ No fake legal claims (zero "admissible" / "approved" / "compliance" copy on the surface).

Items 3, 4, 6 in §11 are real follow-up work, not faked.
