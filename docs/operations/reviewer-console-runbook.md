# Reviewer Console — Phase C0 Runbook

**Audience:** reviewer leads, ops leads, sales engineering, customer success.

**Purpose:** describe how PROOVRA's new canonical reviewer surface works, what's keyboard-accessible, and how it composes the existing per-domain endpoints.

---

## 1. The console at a glance

The new `/review` page is the **canonical reviewer workspace**. It consolidates the legacy `/reviewer-ops`, `/reviewer-ops/escalations`, `/reviewer-ops/sla` surfaces into one operational environment with five tabs:

| Tab | Source | What it shows |
|---|---|---|
| **Queue** | `listReviewerOpsQueue(queue=UNASSIGNED)` | Top 25 unassigned reviews |
| **Mine** | `listReviewerOpsQueue(queue=MY_REVIEWS)` | Top 25 reviews assigned to you |
| **Escalations** | `listEscalations(status=OPEN)` | Top 25 open escalations |
| **SLA** | `buildDashboard` | Unassigned / due-soon / overdue counters + open / critical escalations |
| **Workload** | `listLatestWorkloadSnapshots` | Top 25 reviewer load snapshots |

All five sections come from **one** request — `GET /v1/reviewer-ops/console?teamId=...` — composed in parallel server-side. Each section has its own try/catch so a single failure degrades only its tab.

---

## 2. Keyboard shortcuts

Reviewers can drive the console primarily from the keyboard.

| Key | Action |
|---|---|
| `j` | Move selection down |
| `k` | Move selection up |
| `Enter` | Open the focused row in the per-workflow inspector (`/reviewer-ops/[reviewId]`) |
| `/` | Focus the in-tab filter input |
| `Cmd+K` / `Ctrl+K` | Open the reviewer command palette |
| `Escape` | Close the command palette |

The console **never mutates** evidence directly. Every action (assign / escalate / decide) is performed inside the per-workflow inspector so audit, custody, and step-up enforcement remain on a single canonical surface.

The reviewer command palette is a bounded action list: switch tabs. Inline mutations (assign / escalate from a row without opening it) are recorded as **C0.1** in the deferred follow-ups registry.

---

## 3. Density modes

The console respects `personaProfile.operationalDensityPreference` from the platform-context envelope. Operators set it via `/settings/persona`.

- **compact** — tight rows (~6px padding). Default for enterprise reviewers. Maximum throughput.
- **comfortable** — default for mixed-use reviewers. ~10px padding.
- **spacious** — accessibility / casual review. ~16px padding.

Density never changes which columns render — only padding. Filter logic and selection state are identical across modes.

---

## 4. Sensitive review actions — step-up enforcement

Phase C0 added step-up enforcement to the legacy decision endpoint:

```
POST /v1/review-operations/evidence/:evidenceId/decision
```

When the workspace governance flag `requireStepUpForApprove` is set, any `APPROVE_INTERNAL` decision requires a fresh step-up token (`StepUpPurpose: REVIEW_APPROVAL_HIGH_RISK`).

When `requireStepUpForReject` is set, `REJECT_INSUFFICIENT` decisions require a fresh step-up token (`StepUpPurpose: REVIEWER_OPS_REJECT`).

Flag-off paths are a **no-op** — backwards compatible.

The newer `/v1/reviewer-ops/*` workflow endpoints already had step-up enforcement (Phase 25.5); C0 brings the legacy endpoint to parity so reviewer decision security is uniform.

---

## 5. Section degradation

Each console section returns `{ status: "ok" | "degraded", rows, count }`. The envelope also carries:

```json
"diagnostics": {
  "sectionStatus": {
    "queue": "ok" | "degraded",
    "mine": "ok" | "degraded",
    ...
  },
  "sectionLimit": 25
}
```

The frontend renders a small `degraded` badge on the tab when its section returned an error. The reviewer can still use the rest of the console.

This pattern means a single Prisma timeout doesn't blank-screen the reviewer. The legacy multi-page surface returned 500 in this case.

---

## 6. Backwards compatibility

- `/reviewer-ops` and its sub-routes continue to work unchanged.
- Per-workflow inspector at `/reviewer-ops/[reviewId]` is unchanged and remains the canonical mutation surface.
- Saved queue views (CRUD endpoints) are unchanged; the console surfaces them as a read-only sidebar with C0.2 (CRUD in console) deferred.
- `GET /v1/reviewer-ops/queue`, `GET /v1/reviewer-ops/dashboard`, etc. unchanged.

---

## 7. What's NOT in C0

Recorded as deferred follow-ups in `docs/architecture/deferred-followups.md` (C0.1–C0.5):

- Inline reviewer actions (`a` to assign, `e` to escalate) directly on row.
- Saved-view CRUD from inside the console.
- Console aggregator pagination ("View all" links per tab).
- Reviewer presence + collision indicators.
- Reviewer analytics dashboard.

---

## 8. Reference

- Console aggregator route: `services/api/src/routes/reviewer-console.routes.ts`
- Reviewer Console component: `apps/web/components/reviewer-experience/ReviewerConsole.tsx`
- Canonical page: `apps/web/app/(app)/review/page.tsx`
- Tests: `services/api/test/phase-c0-reviewer-console.test.ts`
- Backing services (unchanged by C0):
  - `services/api/src/services/reviewer-ops/reviewer-operations-engine.service.ts`
  - `services/api/src/services/reviewer-ops/escalation-engine.service.ts`
  - `services/api/src/services/reviewer-ops/workload.service.ts`
  - `services/api/src/services/reviewer-ops/saved-queue-views.service.ts`
- Step-up middleware: `services/api/src/services/identity-security/step-up-middleware.ts`
