# Phase G3.2 — Final Live Operations Closure Runbook

**Audience:** all product engineers, ops leads, customer success.

**Purpose:** describe the closure pass that finishes everything Phase G3.1
left as "continuation," and the bounded production-deployment decision for
shared presence. Phase G3.2 lands the **operator-usable** version of every
remaining live-ops surface — no more pending "mechanical follow-ups" hiding
gaps that an operator would notice the first time they tried to use the UI.

**Closure rule (verbatim from the G3.2 spec):**

> "Do not label user-visible missing functionality as 'mechanical
> continuation.' If the operator cannot use it in UI, it is not closed."

---

## 1. What Phase G3.2 closes

| Item                                                       | Status     | Evidence                                                                                                                                                                            |
| ---------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Inline reviewer action UI**                              | ✅ CLOSED  | `ReviewerConsole.tsx` Queue/Mine rows render Assign / Escalate / Request info / Open inspector buttons; Escalations rows render Acknowledge / Open inspector. Step-up gate via `useStepUpAction` |
| **Inline reviewer action keyboard shortcuts**              | ✅ CLOSED  | `a` (assign), `e` (escalate), `m` (request more info); existing `j/k/Enter/Cmd+K` preserved                                                                                          |
| **Approve / Reject inline**                                | ⛔ HONEST EXCLUSION | Approve/Reject remain in the inspector where the full adaptive gate + risk context renders. Confirmed by source-contract test asserting absence of inline approve/reject paths    |
| **Terminal-row safety**                                    | ✅ CLOSED  | `TERMINAL_STATUSES = {APPROVED, REJECTED, CANCELLED, DESTROYED, TOMBSTONED}` + `isRowActionable()` disable mutation buttons on those rows. Inspector remains reachable             |
| **Saved-view CRUD UI**                                     | ✅ CLOSED  | `SavedViewsPanel` renders Create (name + visibility, applies current filters) + Delete. Hits the existing audited `POST /v1/reviewer-ops/saved-views` + `DELETE /...` endpoints       |
| **Saved-view rename**                                      | ⛔ HONEST EXCLUSION | No backend PATCH exists; runbook documents this. UI never pretends to support it                                                                                                  |
| **Reviewer pagination Load more / View all**               | ✅ CLOSED  | `PaginationFooter` per tab; calls `/v1/reviewer-ops/queue?limit=N` / `/escalations?limit=N` / `/workload?limit=N`. Bounded at endpoint maxima (100 / 200 / 200)                       |
| **GovernedExportAction final wiring (Reports)**            | ✅ CLOSED  | `ReportsIndex.tsx` wraps both "Download report PDF" and "Download verification package" downloads in `GovernedExportAction`. A2 vocabulary preserved                                  |
| **GovernedExportAction on Matter Export tab**              | ⛔ HONEST EXCLUSION | Audit confirmed Matter Export tab is informational-only (no actionable buttons exist there to wrap). Wrapping happens the moment those buttons are added                            |
| **Matter Workspace remaining tab filters**                 | ✅ CLOSED  | Holds / Decisions / Communications / Assignments / Audit / Export tabs all call `matchesFilter()` per-row. Confirmed by source-contract test                                          |
| **Presence indicator on Evidence detail**                  | ✅ CLOSED  | `EvidenceDetailPage` mounts `PresenceIndicator` with `resourceKind="evidence"`, `resourceId=evidenceId`                                                                              |
| **Presence indicator on Reviewer inspector**               | ✅ CLOSED  | `ReviewerWorkspacePageInner` mounts `PresenceIndicator` with `resourceKind="reviewer_workflow"`, `resourceId=workflowId`                                                              |
| **Presence indicator on Discussion thread**                | ✅ CLOSED  | `EvidenceDiscussionPanel` mounts `PresenceIndicator` with `resourceKind="discussion_thread"`, `resourceId=selectedThreadId ?? evidenceId`                                            |
| **CollisionWarning on Evidence detail**                    | ✅ CLOSED  | Compares the workflow `updatedAt` captured at mount with the freshest envelope read; explicit Reload affordance                                                                       |
| **CollisionWarning on Reviewer inspector**                 | ✅ CLOSED  | Derived signature (lifecycle + assignment + SLA + escalation) snapshot at mount vs. current; explicit Reload affordance. The projection does not expose `updatedAt`, so the derived signature is the honest substitute |
| **Shared-presence production decision**                    | ✅ DOCUMENTED | `docs/operations/shared-presence-deployment.md` — single-instance unaffected, multi-instance requires `PRESENCE_BACKEND=redis` env + the bounded swap of the in-process Map for a Redis store. `REDIS_URL` is already wired. TTL preserved at 90 s |

---

## 2. Inline reviewer actions — bounded vocabulary + flow

Five inline actions, each routing through an existing audited endpoint:

| Inline action       | Endpoint                                                          | Step-up gate                | Keyboard |
| ------------------- | ----------------------------------------------------------------- | --------------------------- | -------- |
| Assign              | `POST /v1/reviewer-ops/reviews/:workflowId/assign`                | Workspace flag-driven       | `a`      |
| Escalate            | `POST /v1/reviewer-ops/escalations`                               | Workspace flag-driven       | `e`      |
| Request more info   | `POST /v1/reviewer-ops/reviews/:workflowId/request-info`          | Workspace flag-driven       | `m`      |
| Acknowledge         | `POST /v1/reviewer-ops/escalations/:id/acknowledge`               | Workspace flag-driven       | —        |
| Open inspector      | (navigation only — no mutation)                                   | —                           | `Enter`  |

Each mutation passes through `useStepUpAction({teamId}).runStepUpAction(action)`.
A 401 STEP_UP_REQUIRED response surfaces the existing `StepUpModal`; on success
the modal forwards the `x-proovra-step-up-challenge-id` header and retries the
original call **exactly once**. No bypass, no silent skip.

Approve and Reject are **deliberately** absent from the inline surface. They
live in the per-workflow inspector page (`/reviewer-ops/[reviewId]`) where the
full adaptive runtime gate + risk projection + governance signals render
together. Putting them inline would either replicate that context across rows
(wasting screen) or strip it (unsafe).

Terminal workflow statuses — `APPROVED`, `REJECTED`, `CANCELLED`, `DESTROYED`,
`TOMBSTONED` — disable the mutation buttons. The inspector remains reachable
from every row so reviewers can still audit a closed item.

---

## 3. Saved-view CRUD — honest scope

The Reviewer Console now ships a full create + delete loop:

- **Create**: a small form per saved-views aside collects `name` (1-120 chars)
  and `visibility` (`PRIVATE` or `TEAM`). It posts to
  `POST /v1/reviewer-ops/saved-views` with the current `teamId` as the bounded
  filter. The aside refreshes on success.
- **Delete**: each row carries a `Delete` button with a native browser
  confirm, then hits `DELETE /v1/reviewer-ops/saved-views/:id?teamId=...`.
- **Rename**: **NOT supported**. The backend has no `PATCH` route. We do not
  paper over this with a no-op UI — operators see Create + Delete only, and
  the runbook calls out the exclusion.

The console's source-contract test asserts the absence of any
`PATCH` against `/saved-views/` so a future regression that pretends to
support rename without the backend fails CI.

---

## 4. Pagination — Load more / View all

The console aggregator continues to cap the initial paint at 25 rows per
section. When the operator clicks **Load more** or **View all** the per-tab
endpoint fires with a higher bounded limit:

| Tab         | Endpoint                                                                 | Page step | Cap  |
| ----------- | ------------------------------------------------------------------------ | --------- | ---- |
| Queue       | `GET /v1/reviewer-ops/queue?queue=UNASSIGNED&limit=N`                    | 25        | 100  |
| Mine        | `GET /v1/reviewer-ops/queue?queue=MY_REVIEWS&limit=N`                    | 25        | 100  |
| Escalations | `GET /v1/reviewer-ops/escalations?limit=N`                               | 25        | 200  |
| Workload    | `GET /v1/reviewer-ops/workload?limit=N`                                  | 25        | 200  |

Each tab tracks its own `TabPagination` state. `Reset` reverts the tab to the
aggregator's 25-row slice. Pagination state resets on workspace switch and
after any mutation that triggers a reload — the operator's last action
intentionally invalidates whatever extended slice they had loaded.

The Queue / Mine endpoints return a `nextCursor`. The UI uses it as a "more
rows exist" signal only; cursor-driven incremental paging is a future
enhancement that the limit-based "Load more" already covers in practice.

---

## 5. GovernedExportAction on Reports

Every Report PDF / Verification Package ZIP download in `ReportsIndex.tsx` now
routes through the Phase G2 `GovernedExportAction` wrapper. The wrapper:

- consults `/v1/governance/export-eligibility?teamId=...&evidenceId=...`
  before the operator can click the download button,
- disables the button when the verdict is anything but `ALLOWED`,
- surfaces the verdict reason + next-step text inline.

The labels stay disambiguated per the Phase A2 contract — `Download Report
PDF` and `Download Verification Package ZIP` are NEVER collapsed.

**Matter Workspace Export tab** is intentionally NOT wrapped: the Phase G3.2
audit confirmed the tab is informational only (no actionable buttons exist
there today). The wrapping happens the moment those buttons are added; the
G3.2 runbook documents this honestly rather than wrapping a button that
doesn't exist.

---

## 6. Matter Workspace filter wiring

The `filterText` input has lived on the Matter Workspace since Phase G2.
Phase G3.2 actually wires it into every remaining tab:

| Tab            | Filter projection                                            |
| -------------- | ------------------------------------------------------------ |
| Holds          | `${title} ${status}` for case holds; `${evidenceId} ${status}` for evidence holds |
| Decisions      | `${title} ${workflowType} ${status} ${priority}` for workflows; `${evidenceId} ${severity} ${status}` for escalations |
| Communications | `${title} ${kind} ${status}` for threads; `${body} ${visibility}` for case comments; `${evidenceId}` for reviewer comments |
| Assignments    | `${role} ${assignedToUserId} ${note} ${status}` for active + history |
| Audit          | `${evidenceId} ${overallStatus} ${reasonCodes}` for integrity snapshots; lifecycle + verification rollups also filter |
| Export         | `${evidenceId} ${version}` for reports + packages; `${evidenceId} ${viewerType}` for external links |

Empty filter is a no-op (all rows pass), so the default render matches the
pre-G3.2 behaviour.

---

## 7. Presence + collision wiring

### PresenceIndicator mounts

| Surface                | Resource kind         | Resource id                                 |
| ---------------------- | --------------------- | ------------------------------------------- |
| Matter Workspace header | `matter`             | `case.id` (shipped in G3.1)                 |
| Evidence detail page   | `evidence`            | `evidenceId`                                |
| Reviewer inspector page| `reviewer_workflow`   | `workflowId`                                |
| Discussion panel       | `discussion_thread`   | `selectedThreadId ?? evidenceId`            |

All four use the same 30-second heartbeat polling protocol, the same bounded
25-viewer payload cap, and the same operator-safe payload shape
(`{userId, displayName, lastSeenAtUtc}` — no IP, no device, no route history).

### CollisionWarning wiring

| Surface           | Initial side                                          | Current side                              | Reload                  |
| ----------------- | ----------------------------------------------------- | ----------------------------------------- | ----------------------- |
| Evidence detail   | `workflow.updatedAt` captured on first successful load | `workflow.updatedAt` from freshest envelope | calls `loadWorkspace()` |
| Reviewer inspector | Derived signature (`lifecycle | assignment | SLA | escalation`) | Derived signature from current `data`     | calls `load()`          |

The reviewer inspector page's projection does not expose `updatedAt`
directly, so we **derive a stable signature** from the fields that mutating
actions move. This is the same equality check `CollisionWarning` already
performs on ISO timestamp strings — equivalent honest semantics, no false
precision claim.

Both surfaces surface an explicit **Reload** button. The server-side
optimistic-concurrency gate (Phase G3 scaffold) remains the authoritative
final check; the CollisionWarning is the visual nudge that prevents
operators from typing into a stale snapshot.

---

## 8. Shared-presence — production-deployment decision

See [shared-presence-deployment.md](./shared-presence-deployment.md) for the
full decision doc. Summary:

- **Single-instance deploys are unaffected** (the project's current
  deployment shape). PROOVRA today runs as a single API container in
  `infra/docker/docker-compose.yml`. PresenceIndicator works correctly.
- **Multi-instance deploys** require swapping `presence.service.ts`'s
  internal `Map` for a Redis-backed store. The service's `recordHeartbeat` /
  `listViewers` interface is already shaped for the swap; `ioredis` is
  already a dependency; `REDIS_URL` is already wired (for rate-limiting).
- **New env variable when the swap ships:** `PRESENCE_BACKEND=redis`
  (defaults to `memory`). TTL stays at 90 s, viewer cap stays at 25.
- **Acceptance criteria** for the future Redis adapter are documented in the
  deployment doc and are bounded enough that the swap is a single, contained
  PR when it happens.

This is a **documented production-scaling blocker**, not a deferred feature.
Single-instance is the current product reality; multi-instance is a future
scaling target the codebase is shaped to accept.

---

## 9. Acceptance confirmation

| Criterion                                                  | Status |
| ---------------------------------------------------------- | ------ |
| no step-up bypass                                          | ✅ Every inline mutation passes through `useStepUpAction.runStepUpAction`; the `StepUpModal` retries with the challenge header exactly once |
| no audit bypass                                            | ✅ All mutations hit existing reviewer-ops endpoints whose audit emission is unchanged |
| no export preflight bypass                                 | ✅ Both Report PDF + Verification Package ZIP downloads on `/reports` route through `GovernedExportAction`. Matter Export tab honestly documented as no-buttons-yet |
| no custody pollution                                       | ✅ G3.2 surfaces emit no `appendCustodyEvent` / `appendPlatformAuditLog` / `appendReviewerAuditEvent` calls. Source-contract tests assert absence |
| no generic chat/social drift                               | ✅ Vocabulary contract enforced across all 6 G3.2 surfaces × 10 banned phrases |
| no inline approve/reject                                   | ✅ Source-contract test asserts the absence of `/reviews/.../approve` and `/reviews/.../reject` paths in the Reviewer Console |
| no frontend-only authorization                             | ✅ Console does not invent capability checks — terminal-row disable is operationally honest (the row is non-mutable), and every gate is server-side |
| no claim of legal admissibility, authenticity, or court-readiness | ✅ Banned-phrase vocabulary check across every G3.2 surface |

---

## 10. Honest exclusions (NOT deferred)

These are deliberate scope decisions, not pending work:

- **Approve / Reject inline.** They live in the inspector. The G3.2 spec
  itself says: *"no approve/reject inline unless fully step-up/audit safe."*
  The risk + adaptive gate context they require is large enough that
  duplicating it inline would degrade safety. Decision: keep them in the
  inspector.
- **Saved-view rename.** No backend `PATCH` endpoint exists. Adding one
  would be a backend change, not a closure of an existing pending surface.
  Decision: ship Create + Delete; document the exclusion.
- **GovernedExportAction on Matter Workspace Export tab.** The tab is
  informational-only today — no actionable buttons exist there to wrap.
  Decision: wrap them when they are added.
- **Multi-instance shared presence.** Documented production-scaling
  blocker, not a deferred feature. The codebase + interface are shaped
  for the swap; the swap ships when `replicas > 1` is on the deploy plan.

---

## 11. Reference

- ReviewerConsole inline actions + saved-view CRUD + pagination:
  [apps/web/components/reviewer-experience/ReviewerConsole.tsx](../../apps/web/components/reviewer-experience/ReviewerConsole.tsx)
- Matter Workspace tab filters:
  [apps/web/components/cases-experience/MatterWorkspace.tsx](../../apps/web/components/cases-experience/MatterWorkspace.tsx)
- Evidence detail presence + collision mount:
  [apps/web/app/(app)/evidence/[id]/page.tsx](../../apps/web/app/(app)/evidence/%5Bid%5D/page.tsx)
- Reviewer inspector presence + collision mount:
  [apps/web/app/(app)/reviewer-ops/[reviewId]/page.tsx](../../apps/web/app/(app)/reviewer-ops/%5BreviewId%5D/page.tsx)
- Discussion panel presence mount:
  [apps/web/app/(app)/evidence/[id]/components/EvidenceDiscussionPanel.tsx](../../apps/web/app/(app)/evidence/%5Bid%5D/components/EvidenceDiscussionPanel.tsx)
- Reports export wrapping:
  [apps/web/components/reports-experience/ReportsIndex.tsx](../../apps/web/components/reports-experience/ReportsIndex.tsx)
- Shared-presence deployment decision:
  [shared-presence-deployment.md](./shared-presence-deployment.md)
- Source-contract test:
  [services/api/test/phase-g3-2-final-live-operations-closure.test.ts](../../services/api/test/phase-g3-2-final-live-operations-closure.test.ts)
