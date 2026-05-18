# Runbook — Reviewer queue stuck

**Slug:** `reviewer-queue-stuck`
**Owner:** Reviewer Operations on-call + Platform on-call

---

## Symptoms

- `reviewer_queue_viewed_total` is rising (operators are visiting the queue) but `reviewer_review_completed_total` is flat or near-zero.
- `reviewer_queue_unassigned` gauge climbing without `reviewer_assignment_created_total` movement.
- Multiple workflows stuck in `QUEUED` or `ASSIGNED` lifecycle states for hours.
- "Reviewer Ops" sidebar surface shows "No reviews in this queue" everywhere despite known active workflows.

## Detection

The queue is loaded by `GET /v1/reviewer-ops/queue?teamId&queue`. A "stuck" queue can mean:

1. **No reviewer-capable members exist.** The workspace has not been seeded with users holding `evidence_request.review` permission.
2. **All members are suspended.** All `TeamMember.status` values are `SUSPENDED` or `REVOKED`.
3. **Phase 22 workflow engine has not been bridged.** Workflows live in `evidence_workflow_instances` but no corresponding `evidence_review_workflow` row exists. The `ensureReviewWorkflow` helper is the bridge — Phase 13 code runs it on first reviewer action, so a brand-new evidence record may show up nowhere until someone touches it.
4. **Workspace policy blocks all actions.** `requireStepUpForApprove` + `requireStepUpForReject` true with no enrolled MFA → reviewers can't complete.
5. **Reconcile cron has stopped.** The `POST /v1/reviewer-ops/reconcile` endpoint isn't being called; SLA + escalation + reminder sweeps are silent.

## Severity decisions

| Condition | Severity |
|---|---|
| Single queue view returning empty for one operator | INFO |
| Workspace-wide stall > 1 hour | WARNING |
| Workspace-wide stall > 4 hours OR `LEGAL_HOLD` evidence stuck | HIGH |

## Operational response

1. **Confirm reviewer pool.**
   ```sql
   SELECT user_id, role, status
   FROM team_members
   WHERE team_id = $1;
   ```
   If no row has `status = 'ACTIVE'` AND a reviewer-capable role → invite or activate one.

2. **Check workflow-table bridge.** Compare the workflow instance count to the review-workflow count:
   ```sql
   SELECT
     (SELECT COUNT(*) FROM evidence_workflow_instances WHERE team_id = $1) AS instances,
     (SELECT COUNT(*) FROM evidence_review_workflows WHERE team_id = $1) AS review_workflows;
   ```
   A large gap suggests the bridge wasn't created. Trigger ensureReviewWorkflow by visiting one of the missing items in the legacy review console (Phase 13 path).

3. **Check the reconcile cron.** Look for recent `reviewer_reconcile_run_total` increments. If none in the last hour:
   - Verify `REVIEWER_OPS_CRON_SECRET` is set in the cron caller.
   - Manually trigger via `POST /v1/reviewer-ops/reconcile` with the `x-cron-secret` header for the affected team.

4. **Check policy lockouts.** `/reviewer-ops/policy` — if `requireStepUpForApprove` AND `requireStepUpForReject` are both true AND no member has MFA enrolled, reviewers can't complete. Either disable a flag or enroll MFA.

5. **Check ops dashboard.** `/ops` should show Phase 21 incidents. A `DATABASE` or `WORKER` category open incident may explain the stall.

## Mitigation

- Seed reviewers (invite + grant `evidence_request.review`).
- Restart the reconcile cron caller.
- Disable an overzealous step-up flag temporarily; re-enable once MFA enrollment completes.
- Backfill missing `evidence_review_workflow` rows by visiting each affected workflow once in the legacy `/review/operations` console.

## Escalation path

| 0-30 min | Reviewer Ops on-call assesses reviewer pool + cron health. |
| 30-90 min | Platform on-call investigates DB / worker. |
| 90 min+ | Operations lead joins to coordinate manual backfill. |

## Rollback / safety

- All mitigation actions are reversible.
- Disabling a step-up flag is itself a `GOVERNANCE_POLICY_UPDATE` step-up action — there is no path to silently weaken policy.
- DO NOT delete rows directly from `evidence_review_workflows` or `review_escalations` to "clear" the queue. Use the legacy `recordReviewDecision` with `CLOSE` or the queue console "Close" bulk action so the audit chain stays intact.

## Verification steps

```sql
-- Active queue (any reviewer should see these):
SELECT id, status, sla_status, assigned_to_user_id, priority, due_at
FROM evidence_review_workflows
WHERE team_id = $1
  AND status NOT IN ('CLOSED','REJECTED_INSUFFICIENT','APPROVED_INTERNAL')
ORDER BY priority DESC, due_at ASC
LIMIT 25;

-- Recent reconcile activity:
SELECT MAX(created_at) AS last_reconcile_event
FROM security_events
WHERE team_id = $1
  AND event_type = 'reviewer_reconcile_run'
  AND created_at > NOW() - INTERVAL '1 hour';

-- Recent completion activity:
SELECT COUNT(*) AS completed_last_hour
FROM evidence_review_workflows
WHERE team_id = $1
  AND completed_at_utc > NOW() - INTERVAL '1 hour';
```

After mitigation, `last_reconcile_event` should advance every cron tick and completion-per-hour should resume.
