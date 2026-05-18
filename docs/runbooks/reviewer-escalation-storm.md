# Runbook — Reviewer escalation storm

**Slug:** `reviewer-escalation-storm`
**Source:** `runReconcile()` opens a GOVERNANCE incident when a single
reconcile cycle creates ≥ `REVIEWER_ESCALATION_STORM_THRESHOLD`
escalations (default 10) for one team.

## What this means

A single sweep of the reviewer reconciliation engine flipped a large
number of workflows from `DUE_SOON` to `BREACHED` at once and opened
that many `REVIEW_OVERDUE` escalations. This is the platform telling
you that workload distribution, SLA policy, or reviewer availability
is out of balance — the engine is doing what it's supposed to but the
sustained backlog needs operator attention before the dashboard fills
with red.

## First action (under 60s)

```sql
-- How many open BREACHED workflows does this team have?
SELECT count(*) FROM "evidence_review_workflows"
WHERE "teamId" = '<team>'
  AND "slaStatus" = 'BREACHED'
  AND status NOT IN ('CLOSED', 'REJECTED_INSUFFICIENT', 'APPROVED_INTERNAL');

-- Most recent escalations created in this sweep.
SELECT id, reason, severity, status, "createdAt"
FROM "review_escalations"
WHERE "teamId" = '<team>'
ORDER BY "createdAt" DESC
LIMIT 20;
```

## Triage

The storm threshold is intentionally conservative. A single tick
opening ≥ 10 escalations almost always means one of:

1. **Reviewer offline.** A single reviewer carried a large queue and
   went unavailable; everything on their queue flipped to BREACHED on
   the same SLA clock.
2. **SLA policy too aggressive.** `WorkspaceReviewerOpsSlaPolicy` was
   recently tightened (`completionDueAtUtc` window shortened) and the
   in-flight queue can't meet the new deadline.
3. **Reconcile downtime.** The worker tick was paused and resumed;
   the resume processes a "catch-up" set in one sweep.
4. **Genuine workload spike.** A burst of evidence intake exceeded
   reviewer capacity.

Check reviewer presence first via `reviewer_workload_snapshots`:

```sql
SELECT "reviewerUserId", "activeReviewCount", "overdueReviewCount",
       "capacityScore", "computedAtUtc"
FROM "reviewer_workload_snapshots"
WHERE "teamId" = '<team>'
ORDER BY "computedAtUtc" DESC
LIMIT 10;
```

If `overdueReviewCount` is heavily concentrated on one reviewer →
case 1. If it's spread across multiple reviewers → case 2 or 4.

## Containment

The platform's containment is automatic:
- Escalation engine deduplicates by `(workflowId, reason, day)`. The
  same workflow does not get a second REVIEW_OVERDUE escalation today.
- `recordIncident()` deduplicates by `(teamId, fingerprint)`. The
  storm incident itself is one row per team per day.
- No emails / pages fire from this incident class directly — the
  on-call dashboard surfaces it via `operational_incidents_open_high`.

There is nothing the platform needs you to do RIGHT NOW. The storm
incident is informational. Decide based on triage above whether to
take any of these actions:

- **Reassign workflows** away from the offline reviewer via the
  `POST /v1/reviewer-ops/reviews/:workflowId/assign` endpoint.
- **Relax SLA policy temporarily** via `POST /v1/reviewer-ops/policy`
  while you investigate root cause.
- **Add reviewer capacity** by inviting additional team members with
  `evidence_request.review` permission.

## Root cause

`runReconcile()` ([reviewer-operations-engine.service.ts:766](services/api/src/services/reviewer-ops/reviewer-operations-engine.service.ts#L766))
records this incident when `escalationsCreated >= stormThreshold`.
The threshold is read from env per call so you can tune it without
redeploying:

```
REVIEWER_ESCALATION_STORM_THRESHOLD=15   # default 10
```

The storm fingerprint is `reviewer:escalation_storm:<teamId>:<YYYY-MM-DD>` —
re-firing within the same day is suppressed (the incident's
`occurrenceCount` increments instead).

## Recovery

1. Resolve the underlying cause (reassign, adjust policy, add capacity).
2. Mark the incident resolved via `POST /v1/ops/incidents/:id/resolve`
   with a `resolutionNote` describing what was done.
3. Confirm the next reconcile tick (default every 5 min) does NOT
   re-fire — check `operational_incidents` for the same fingerprint.

## Postmortem checklist

- [ ] Cause classified (reviewer-offline / SLA-too-aggressive /
      reconcile-resume / genuine-spike).
- [ ] Confirm the storm did NOT create duplicate escalations
      (count `reviewEscalation` rows per `workflowId` for the period —
      should be ≤ 1 per day).
- [ ] If recurring, consider raising `REVIEWER_ESCALATION_STORM_THRESHOLD`
      AND opening a workload-balancing project.
- [ ] Confirm `reviewer_queue_overdue` gauge has returned below the
      `reviewer_queue_overdue > 50` alert threshold.
