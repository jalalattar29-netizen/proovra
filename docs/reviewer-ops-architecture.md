# Reviewer Ops — Architecture & Activation

This document records the wired state of the reviewer-operations
subsystem after the consolidation phase, the relationship between its
five engines, and how an operator can verify it is alive.

## Engines

| Engine | File | Purpose |
|--------|------|---------|
| Review queue | [`review-operations.service.ts`](../services/api/src/services/review-operations/review-operations.service.ts) (Phase 13) | `listReviewQueue`, `assignReviewer`, `recordReviewDecision`. Owns the queue projection + lifecycle transitions. |
| SLA progression | `review-operations.service.ts::reconcileReviewSlas` (Phase 13) | Walks active workflows, flips `slaStatus` from `ON_TRACK` → `DUE_SOON` → `BREACHED` based on `dueAt` / `firstResponseDueAtUtc`. |
| Escalation | [`escalation-engine.service.ts`](../services/api/src/services/reviewer-ops/escalation-engine.service.ts) | Opens `REVIEW_OVERDUE` escalation when a workflow flips to `BREACHED` and has no open escalation. Fingerprint-dedup per `(teamId, workflowId, reason, day)`. HIGH/CRITICAL escalations fan out to `OperationalIncident` via `recordIncident()`. |
| Workload | [`workload.service.ts`](../services/api/src/services/reviewer-ops/workload.service.ts) | Computes per-reviewer capacity score; writes immutable `reviewer_workload_snapshots` rows. |
| Reminders | [`reminder-engine.service.ts`](../services/api/src/services/reviewer-ops/reminder-engine.service.ts) | `sweepDueSoonReminders`, `sweepInactivityReminders`; fans out to notification service. |

The five engines are orchestrated by **one master function**:

```
runReconcile({ teamId, batchSize })
  → legacyReconcileReviewSlas         // SLA progression
  → createEscalation(...) per breached  // escalation generation
  → snapshotWorkspaceWorkload(...)     // workload snapshot
  → sweepDueSoonReminders(...)         // due-soon fan-out
  → sweepInactivityReminders(...)      // inactivity fan-out
  → recordIncident(...) if storm       // storm detection
  → setGauge(...) for queue depth      // operational visibility
```

Located in [`reviewer-operations-engine.service.ts`](../services/api/src/services/reviewer-ops/reviewer-operations-engine.service.ts).

## How the engine gets invoked

Three callers (all hit the same `runReconcile` orchestrator):

1. **Worker tick** — `services/worker/src/reviewer-ops/reviewer-reconciliation.worker.ts`
   - Started by `startReviewerReconciliationScheduler()` in
     `services/worker/src/index.ts`.
   - Interval: `REVIEWER_OPS_RECONCILIATION_INTERVAL_MS` (default 5
     minutes).
   - Calls `POST /v1/reviewer-ops/reconcile` with `{ allTeams: true }`
     and the cron secret. The route enumerates teams that have at
     least one review workflow and runs reconcile per team.
   - **This is the missing wire that was added in this phase.**
2. **Manual operator trigger** — same endpoint with `{ teamId }`.
3. **External cron** (legacy) — same endpoint with `{ teamId }`.

## Configuration

| Env | Default | Effect |
|-----|---------|--------|
| `REVIEWER_OPS_RECONCILIATION_ENABLED` | `true` | Master switch for the worker tick. |
| `REVIEWER_OPS_RECONCILIATION_INTERVAL_MS` | `300000` (5m) | Tick cadence. |
| `REVIEWER_OPS_RECONCILIATION_BATCH_SIZE` | `200` | `batchSize` passed to `runReconcile` per team. |
| `REVIEWER_OPS_MAX_TEAMS_PER_SWEEP` | `500` | Upper bound on teams per tick. |
| `REVIEWER_OPS_CRON_SECRET` | — | Worker auth to the api endpoint. Falls back to `INTEGRATION_CRON_SECRET`. |
| `INTERNAL_API_BASE_URL` | — | Worker's URL to the api. Falls back to `API_BASE_URL`. |
| `REVIEWER_ESCALATION_STORM_THRESHOLD` | `10` | Escalations per single sweep that trigger a GOVERNANCE incident. |

## Operational visibility

After each reconcile pass:
- `reviewer_reconcile_run_total` counter increments.
- `reviewer_sla_breached_total` increments per newly-breached workflow.
- `reviewer_escalation_created_total` increments per new escalation.
- `reviewer_workload_computed_total` increments per reviewer scored.
- `reviewer_queue_overdue` gauge is set to the current count.
- `reviewer_workload_max_active` gauge is set.

The Phase Y alert catalog
([`packages/shared/src/observability-runtime.ts`](../packages/shared/src/observability-runtime.ts))
already fires on `reviewer_queue_overdue > 50`. No new alert is
needed.

## Schema validation

The api startup runs
[`services/api/src/runtime/schema-validation.ts`](../services/api/src/runtime/schema-validation.ts)
against the live database. If any reviewer-ops critical table or
column is missing, the api refuses to boot (unless
`SCHEMA_VALIDATION_FAIL_FAST=false`). The same module powers
`GET /admin/runtime/schema-status` for dashboard polling.

The reviewer-ops critical objects checked at startup:

- `evidence_review_workflows` + the Phase 25 additive columns
  (`assignment_due_at_utc`, `completion_due_at_utc`, `paused_reason`,
  `active_escalation_id`).
- `evidence_review_workflow_events`.
- `review_escalations` + the unique fingerprint index
  (`review_escalations_team_fingerprint_uk`).
- `reviewer_workload_snapshots`.

These are flagged `critical` rather than `important` because the
production P2022 outage that triggered this consolidation phase was
caused by their absence.

## Operator verification — is the engine alive?

```bash
# 1. Schema validation is green for reviewer-ops.
curl -fsS -H "Authorization: Bearer $OP_TOKEN" \
  "$API_BASE/admin/runtime/schema-status?teamId=<team>" \
  | jq '.subsystems[] | select(.subsystem == "reviewer_ops")'
# Expect: status: "healthy", missingCritical: 0.

# 2. Reconcile endpoint accepts both modes.
curl -fsS -X POST \
  -H "x-cron-secret: $REVIEWER_OPS_CRON_SECRET" \
  -H "content-type: application/json" \
  -d '{"teamId":"<team>"}' \
  "$API_BASE/v1/reviewer-ops/reconcile" | jq .

# 3. Worker scheduler is logging completions.
docker compose logs proovra-worker --since 10m | grep reviewer_reconcile
# Expect a "reviewer_reconcile.completed" line every 5 minutes.

# 4. Metrics show movement.
curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" \
  "$API_BASE/v1/ops/metrics" | jq '.metrics.counters.reviewer_reconcile_run_total'
# Expect a number that grows over time.
```

If any of the above returns zero / missing / failed, see:
- Schema drift: [`audit-chain-drift`](./runbooks/audit-chain-drift.md)
  for chain integrity; the new `/admin/runtime/schema-status` for
  table presence.
- Worker dead: [`worker-wedged`](./runbooks/worker-wedged.md).
- Escalation storm: [`reviewer-escalation-storm`](./runbooks/reviewer-escalation-storm.md).

## What this phase did NOT change

- No new product features.
- No UI redesign — the existing reviewer-ops pages already render
  empty states; the activation makes them populate.
- No new Prisma models or columns.
- No change to OTS / TSA / report / verify / package semantics.
- No change to governance lifecycle, retention, or destruction logic.
- No AI / search / federation features.
