# Runbook 20 — Reviewer queue failure

## Symptoms
- Reviewers report items not appearing in their queue, or appearing twice.
- `/ops/analytics` reviewer envelope shows `activeReviews` ≠ `assignedReviews` consistent state.
- Escalation backlog grows without resolution.
- `reviewer-reconciliation.worker` heartbeat stale > 2× reconcile interval.

## Blast radius
Per-team. Other teams' reviewer queues are unaffected (queue is scoped via `teamId`).

## Detection
- `GET /admin/runtime/workers` shows reviewer-reconciliation heartbeat freshness.
- `OperationalIncident` rows with `category=REVIEWER_OPS` and `severity ∈ (HIGH,CRITICAL)`.
- `/ops/analytics` reviewer envelope: `overdueReviews` spiking; `assignedReviews` stagnant.

## Logs to inspect
- Worker logs filtered to `reviewer-reconciliation`.
- API logs: `EvidenceReviewerAuditEvent` rows for the affected team.
- Security event stream: `review_*` family events.

## Rollback procedure
None — reviewer-ops is read-mutate via `reviewer-operations-engine` with audit emission. There is no "undo" for an escalation; instead, transition the escalation to RESOLVED with a documented reason.

## Safe recovery procedure
1. **Pause new escalations** if a storm is in progress: identify the `reason` fingerprint causing the storm (escalation-engine dedupes by `(workflowId, reason, dayBucket)`). If a single root cause is producing many escalations, work the root cause first.
2. **Restart the worker** if heartbeat is stale (runbook 03).
3. **Confirm reconcile resumes** within 2× interval. Reviewer queue counts re-derive from the canonical `EvidenceReviewWorkflow` rows; no manual reconciliation needed.
4. **For genuinely stuck assignments** (assigned reviewer no longer with the org, etc.), use the operator-side admin endpoint to re-assign. This emits an audit event.

## Validation steps
- Reviewer queue counts in `/ops/analytics` return to a steady-state baseline within 1 reconcile cycle.
- No new HIGH/CRITICAL `OperationalIncident` rows for `REVIEWER_OPS` in the last hour.
- The storm-detection guard (≥10 escalations in a single window) did NOT silently suppress legitimate escalations; verify by counting escalations created vs the storm fingerprint.

## Escalation conditions
- Reviewer queue counts do NOT return to baseline within 4 reconcile cycles → incident response (runbook 11).
- Custody-event chain validation (runbook 09) on a sample of affected evidence fails → integrity-event-grade incident.

## DO NOT DO THIS
- Do NOT directly UPDATE `EvidenceReviewWorkflow` rows from the operator shell — the engine is the single writer.
- Do NOT delete escalation rows to "clear the queue" — escalations are part of the audit trail.
- Do NOT lower the storm threshold to "let everything through" — the storm guard is a real safety mechanism.
- Do NOT manually re-trigger escalations for items already escalated; the fingerprint dedup will block duplicates but operator confusion compounds.
