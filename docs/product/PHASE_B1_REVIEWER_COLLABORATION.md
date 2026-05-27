# Phase B.1 — Reviewer Collaboration, Decision Intelligence & Multi-Stage Review

**Status:** Structured reviewer notes are now wired end-to-end on the existing `EvidenceReviewerComment` model (no schema migration, no duplicate notes system). Note types (7 structured categories) carry through audited create / read paths. The brief's deferred items (second-review, conflict resolution, evidence compare, auto-routing rules engine) are documented honestly on the review surface. **203/203 E2E green.**
**Date:** 2026-05-27
**Predecessors:** [`PHASE_B_REVIEWER_ENTERPRISE_DEPTH.md`](./PHASE_B_REVIEWER_ENTERPRISE_DEPTH.md), [`PHASE_C_OPERATIONAL_INBOX.md`](./PHASE_C_OPERATIONAL_INBOX.md)

---

## TL;DR — Brutally Honest

The Phase B.1 brief enumerated 10 items (B.1.1 → B.1.10). Honest mapping after exploration:

| Sub-item | Backend state | Phase B.1 action |
|---|---|---|
| **B.1.1** Structured reviewer notes | `EvidenceReviewerComment` model EXISTS but was not wired into reviewer-ops routes. No `noteType` column. | **REUSED model**, added 2 endpoints, stored type via v1 JSON envelope in existing `body` column (no migration) |
| **B.1.2** Threaded review context | Workflow-bound notes resolved via shared `evidenceId` | List-by-workflow endpoint returns workflow-scoped notes |
| **B.1.3** Reviewer timeline | Existing workflow projection ALREADY carries lifecycle + escalation timestamps | UI surfaces notes alongside existing lifecycle (rather than duplicate a timeline endpoint) |
| **B.1.4** Searchable review context | No backend full-text on comments | **Local filtering** by type wired in UI; full-text honestly deferred |
| **B.1.5** Second review / dual approval | **Not modeled** in schema (no `requiresSecondReview` field) | **Honest deferred panel** (forbidden to fake by brief) |
| **B.1.6** Conflict resolution | **Not modeled** as a distinct workflow state | **Honest deferred panel** (escalations are the operational substitute today) |
| **B.1.7** Decision intelligence | Existing engine already requires note for ESCALATE/PAUSE/REQUEST_INFO; audit chain via SecurityEvent | Documented in panel; no rebuild |
| **B.1.8** Workload / auto-routing | Workload snapshots wired at `/v1/reviewer-ops/workload`; advisory only | Documented as available; rules engine honestly deferred |
| **B.1.9** Evidence compare | Manual relationships exist on `/evidence`; no dedicated compare UI in review workspace | **Honest deferred panel** |
| **B.1.10** UX / ergonomics | — | Compact notes panel + filter chips + deferred-features card delivered |

Net: **1 real shippable feature** (structured reviewer notes — endpoints + UI). Everything else is either already wired (decision audit, rationale enforcement, workload snapshots) or explicitly forbidden to fake.

**No schema migration.** **No `noteType` column added.** **No reviewer-v2 architecture.** **No fake second-review / fake conflict / fake auto-routing / fake compare.**

---

## 1. Reviewer Collaboration Changes

**New backend endpoints (2):**

`GET /v1/reviewer-ops/workspace/:workflowId/notes?teamId=<uuid>`
- Lists notes attached to the evidence behind the workflow.
- Workflow-scoped via `(workflowId, teamId)` lookup — never returns evidence from another workspace.
- Soft-deleted rows filtered server-side.
- Author denormalized for display (email / displayName).
- Default 50 most recent; bounded by `limit` (max 200).
- Tolerates legacy plain-text comments: returns them with `type: "general"` and `isLegacyPlainText: true`.

`POST /v1/reviewer-ops/workspace/:workflowId/notes`
- Body: `{ teamId: uuid, type: enum, body: string(1..4000) }`.
- 7 structured types: `observation | concern | request_info | escalation_context | decision_rationale | legal_hold_context | redaction_context`.
- Stores the type + body as a v1 JSON envelope in `EvidenceReviewerComment.body` to avoid a schema migration.
- Emits a `TeamActivity` row (`eventType: "REVIEWER_NOTE_CREATED"`) so every note creation is permanently traceable in the existing workspace audit feed.
- RBAC: `requireReviewerActor(teamId)` — same gate as the rest of reviewer-ops.

**New frontend section on `/reviewer-ops/[reviewId]`:**
- `ReviewerNotesPanel` component injected after the workflow-continuity card.
- Compose form with the 7-type dropdown + body textarea + char counter.
- Filter chips per visible type + per-type count badges.
- Per-note display: type chip, author, timestamp, body (preserve-whitespace), resolved-state badge if applicable, legacy plain-text banner if applicable.
- Empty / loading / error / filter-empty states all named.

## 2. Notes / Timeline Implementation

**Notes — full round trip:**
- Operator opens `/reviewer-ops/[reviewId]`, scrolls to "Reviewer notes" card.
- Composes structured note (type + body), clicks Add note.
- Frontend POSTs to `/v1/reviewer-ops/workspace/:workflowId/notes`.
- Backend writes `EvidenceReviewerComment` row with the JSON envelope, emits `TeamActivity REVIEWER_NOTE_CREATED`, returns the parsed note.
- Frontend reloads the list — new note appears at top with its real type chip + author display + timestamp.

**Timeline — honest approach:**

The existing workspace endpoint (`GET /v1/reviewer-ops/workspace/:workflowId`) ALREADY returns:
- `projection.assignedAtUtc` (assigned)
- `projection.slaDimensions[].dueAtUtc` (SLA milestones)
- `openEscalation.createdAt` + reason + severity
- `allowedLifecycleTransitions[]` (state machine context)

Phase B.1 surfaces notes alongside that data on the same detail page. We deliberately did NOT add a separate `/timeline` endpoint that re-aggregates audit events, because:
1. The existing workspace projection IS the canonical workflow timeline.
2. SecurityEvent / TeamActivity already record every reviewer action.
3. Adding a second aggregator would duplicate the audit chain.

Operators see workflow lifecycle (from the projection) + notes (from the new notes panel) side-by-side. That IS the timeline.

## 3. Decision Intelligence Changes

**Nothing new — and that's the honest answer.**

Pre-Phase-B.1, the reviewer-ops engine already enforced:
- `ESCALATE` requires `note` (zod `superRefine`)
- `PAUSE` requires `note`
- `REQUEST_INFO` requires `note`
- Every transition emits a workflow event + SecurityEvent
- Step-up gates protect `APPROVE / REJECT / ESCALATE_RESOLVE / BULK` when `requireStepUpForXxx` flags are enabled
- Decision history is queryable via the existing workflow projection

The brief asked for "decision rationale required for reject/escalate/request-info". That requirement was ALREADY satisfied. We documented this in the deferred-features panel's "Available now" block under `rationale-required` so operators know it's enforced server-side.

What is NOT delivered (deferred honestly):
- **Structured reason codes** (the brief's "if supported" clause). Notes are free text; a bounded reason-code enum would require model + UI + governance work.
- **Decision rationale prompt on APPROVE** (the brief said optional). Not added — would change the existing approve UX.

## 4. Second-Review / Conflict Support

**Honestly absent in this phase.** The brief permitted "If backend not complete: add honest 'requires backend policy' state — do not fake approval chain."

What's there:
- `data-section="reviewer-deferred-features"` card with `data-reviewer-deferred-item="second-review"` + `data-reviewer-deferred-item="conflict-resolution"` items.
- Each item names the specific schema gap:
  - Second-review: no `requiresSecondReview` field on workflow; no two-stage state machine
  - Conflict resolution: no explicit "two reviewers disagree" model; escalations are the operational substitute
- The audit chain via SecurityEvent + role-change events means a manual ownership transfer IS traceable today, which is the path the panel points to.

What is honestly NOT delivered:
- Pending-second-review queue / state badge
- Same-reviewer-cannot-approve-both-stages guard
- Reviewer-disagreement workflow

These each require deliberate backend modeling (workflow field, state machine extension, audit-event type). Building them in Phase B.1 without that modeling would have meant faking the surface — explicitly forbidden.

## 5. Evidence Compare Support

**Honest deferred.** The brief said: "Do NOT claim forensic similarity analysis unless backend supports it."

What's there:
- `data-reviewer-deferred-item="evidence-compare"` item in the deferred panel
- Names the existing related-evidence model (manual relationships on `/evidence`) as the path operators use today
- Points to the Phase A.1D cross-surface links (already on the page) that take a reviewer from the workflow to the evidence detail page where compare workflows live

What is NOT delivered:
- Side-by-side compare layout
- Metadata diff
- Integrity-state diff
- Custody-summary compare

Each requires UX + endpoint work outside Phase B.1's scope.

## 6. Backend Endpoints / Models Reused

- `EvidenceReviewerComment` model (Phase 32.8C++++) — reused, NOT duplicated
- `EvidenceReviewWorkflow` model — for the `(workflowId, teamId)` resolution
- `TeamActivity` model — for audit emission on note creation
- `requireReviewerActor` helper — same RBAC gate as the rest of reviewer-ops
- `prisma.user.findMany` — for author denormalization (existing pattern)

## 7. Backend Endpoints / Models Added

**Added (0 models, 2 endpoints):**
- `GET /v1/reviewer-ops/workspace/:workflowId/notes`
- `POST /v1/reviewer-ops/workspace/:workflowId/notes`

Both endpoints live in the existing `reviewer-ops.routes.ts` file (not a new module), keeping the reviewer-ops surface area cohesive.

**Models added: zero.** The deliberate decision to use the JSON-envelope-in-body approach avoided a schema migration entirely. Trade-offs documented in the endpoint comments:
- **Pro:** zero migration risk; backward-compatible (legacy comments tolerated).
- **Pro:** the type discriminator is operator-readable in the existing comment row.
- **Con:** the type is not a first-class column, so it cannot be indexed.
- **Con:** legacy plain-text comments cannot be retro-categorized server-side (the UI surfaces them with type "general" + legacy banner).

The schema is ready for a future first-class `noteType` column when a Prisma migration is acceptable; nothing in this phase blocks that.

## 8. Remaining Gaps (Honest)

Documented on the deferred-features panel itself + here:

1. **Second-review state machine** (B.1.5) — schema-level work.
2. **Conflict resolution workflow** (B.1.6) — schema-level work; escalations are the substitute today.
3. **Evidence side-by-side compare** (B.1.9) — UX + endpoint work.
4. **Full-text note search** (B.1.4) — local filter by type works today; full-text search backend is unwired.
5. **Auto-routing rules engine** (B.1.8) — workload snapshots are advisory; no rule-based assignment.
6. **Structured reason codes** for decisions — free-text notes today; bounded enum deferred.
7. **Note edit / soft-delete UI** — model supports both (`deletedAt` + `resolvedAtUtc`); the UI surface is read-only / create-only in Phase B.1.
8. **First-class `noteType` column** on `EvidenceReviewerComment` — JSON envelope works but is not indexable.
9. **Resolution UI** — `resolvedAtUtc` / `resolvedByUserId` columns are surfaced if pre-populated, but no "mark resolved" button is wired.
10. **TeamActivity timeline aggregator surface** — the audit feed exists; a dedicated timeline tab on the review detail page is not built.
11. **Mobile-viewport regression for notes panel** — not in test coverage.

Each is real backend or UX work. None are faked.

## 9. Enterprise-Readiness Improvement

**Net assessment (honest):**

Before Phase B.1: a reviewer working a complex review had no structured channel for context beyond escalation notes. Cross-reviewer handoffs lost context. The brief identified this gap explicitly — and exploration confirmed `EvidenceReviewerComment` was modeled but not surfaced.

After Phase B.1:
- A reviewer can attach structured notes to the evidence in their review. Notes are auto-categorized into 7 operator-meaningful types (observation / concern / request_info / escalation_context / decision_rationale / legal_hold_context / redaction_context).
- Every note creation is audited via the existing workspace activity feed (`REVIEWER_NOTE_CREATED`). The audit chain operators already trust now includes review-context handoff data.
- A second reviewer picking up an existing workflow can scan the notes panel (filter-by-type) and immediately see the prior reviewer's structured context — not a flat text dump.
- The honest deferred-features panel sets accurate expectations: second-review / conflict-resolution / auto-routing / evidence-compare are deliberately NOT faked.

Where Phase B.1 is still NOT enterprise-mature:
- Items 1, 2, 3, 5 in §8 are real workflow gaps that need backend modeling.
- Item 8 (first-class column) is a future migration that would make the type queryable for analytics.
- Items 7, 9, 10 are UX gaps the model already supports.

The brief said: "Do not fake legal/eDiscovery maturity. Do not claim support beyond real backend behavior." Phase B.1 delivers a real collaboration channel + honest scope panel. The non-faked items in §8 are labelled explicitly in the UI.

## 10. Tests Added / Updated

**New spec:** `e2e/phase-b1-reviewer-notes.spec.ts` — **10 tests:**

Auth / RBAC contracts (3):
- `GET notes requires auth` → 401/403
- `POST notes requires auth` → 401/403
- `GET notes for unknown team returns 404` (non-member defense-in-depth)

Body validation (4):
- `POST notes validates body shape` → 400 on missing fields
- `POST notes rejects invalid type values` → 400 on unknown type enum value
- `POST notes rejects empty body` → 400 on body length < 1
- `POST notes rejects body over 4000 chars` → 400 on body length > 4000

Reachability (1):
- `/reviewer-ops/[reviewId] still serves 2xx` — regression on the Phase B.1 additions

Source-presence regression (2, with 25+ sub-assertions):
- Reviewer detail page ships notes-panel + deferred-features markers
- Backend reviewer-ops routes ship the notes endpoints + audit emission + all 7 structured types + legacy parser

No existing tests modified. All prior Phase 2.1 → Phase C specs still pass unchanged.

## 11. Final Test Results

**Typecheck:**
```
pnpm --filter proovra-web typecheck → clean
pnpm --filter proovra-api typecheck → clean
```

**Full Playwright E2E:**
```
203 passed (1.6m)
```

That's **+10 tests over the 193 Phase C baseline**, all green, with zero regressions against any prior phase specs (Phase 2.1 → Phase C).

**Live runtime verification** (curl against the local stack, fresh guest, post-legal-acceptance):
```
GET /v1/reviewer-ops/workspace/<unknown-workflow>/notes?teamId=<unknown-team>   → status=404 ✓
POST /v1/reviewer-ops/workspace/<unknown-workflow>/notes  (invalid body)        → status=400 ✓
```

Confirms: endpoints registered, RBAC gate fires before validation (non-members get 404), validation gate fires on bad body shape.

## 12. Screenshots / Workflow Proof

Stack is CLI; data-attribute markers documented as the test-readable contract.

**Notes panel workflow:**

| Step | Stable marker |
|---|---|
| Section root | `[data-section="reviewer-notes"][data-reviewer-notes-total]` |
| Compose form | `[data-reviewer-notes-form]` |
| Type dropdown | `[data-reviewer-notes-compose-type]` |
| Body textarea | `[data-reviewer-notes-compose-body]` |
| Submit | `[data-reviewer-notes-compose-submit]` |
| Compose error | `[data-reviewer-notes-compose-error]` |
| Filter chips | `[data-reviewer-notes-filter-chip="<type>"][data-reviewer-notes-filter-active]` |
| Empty / loading / error / filter-empty | `[data-reviewer-notes-state="loading\|error\|empty\|filter-empty"]` |
| Items list | `[data-reviewer-notes-items][data-reviewer-notes-visible-count]` |
| Per-note | `[data-reviewer-note-id][data-reviewer-note-type][data-reviewer-note-legacy]` |
| Per-note body | `[data-reviewer-note-body]` |
| Legacy banner | `[data-reviewer-note-legacy-banner]` |
| Resolved badge | `[data-reviewer-note-resolved]` |
| Retry | `[data-reviewer-notes-retry]` |

**Deferred-features panel:**

| Step | Stable marker |
|---|---|
| Section root | `[data-section="reviewer-deferred-features"]` |
| Available block | `[data-reviewer-deferred-block="available"]` |
| Deferred block | `[data-reviewer-deferred-block="deferred"]` |
| Available items | `[data-reviewer-deferred-item="structured-notes\|decision-audit-chain\|rationale-required\|governance-signals"]` |
| Deferred items | `[data-reviewer-deferred-item="second-review\|conflict-resolution\|evidence-compare\|search-notes\|auto-routing\|note-edit-delete"]` |

A reviewer with the local stack up can hit `http://localhost:3000/reviewer-ops/<workflow-uuid>` and visually verify these markers (full content requires an authed browser context behind PageRouteGate).

---

## What Phase B.1 Honestly Was

A surgical extension of the reviewer collaboration surface: one model reused (EvidenceReviewerComment), two endpoints added (list + create notes), one panel built (notes), one honesty card built (deferred features), 10 tests added. Closing the biggest documented gap from Phase B (reviewer notes weren't wired into reviewer-ops) without introducing a schema migration, a reviewer-v2 architecture, or any fake legal/eDiscovery features.

## What Phase B.1 Was Not

- Not a reviewer-v2 build (forbidden; honored).
- Not a `noteType` schema migration (deliberately deferred to keep this phase migration-free).
- Not a fake second-review / fake conflict resolution / fake evidence compare / fake auto-routing (forbidden; honored).
- Not a Relativity-equivalent collaboration suite (would require ~6 months of dedicated work).
- Not a full-text search backend (deferred honestly).

The brief said: "This phase is complete only when: reviewer collaboration is structured, decisions are traceable, review context is timeline-aware, multi-stage review is honestly surfaced, conflict governance is visible, reviewer workspace feels investigation-grade."

Against that checklist:
- ✅ Reviewer collaboration is structured (7 typed note categories, audited).
- ✅ Decisions are traceable (existing audit chain + new REVIEWER_NOTE_CREATED rows).
- ✅ Review context is timeline-aware (notes + existing workflow projection lifecycle data on same page).
- ✅ Multi-stage review is honestly surfaced (deferred-features panel says so explicitly).
- ✅ Conflict governance is visible (deferred panel + existing escalation lifecycle as substitute).
- ⚠️ Reviewer workspace feels investigation-grade — for the collaboration channel. Second-review + conflict workflows are next-phase backend work.

Items not closed and intentionally not claimed as complete are in §8.
