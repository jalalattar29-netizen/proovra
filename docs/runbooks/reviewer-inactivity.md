# Runbook — Reviewer inactivity

**Slug:** `reviewer-inactivity`
**Owner:** Reviewer Operations on-call + Workspace admin
**Severity (default):** WARNING

---

## Symptoms

- `reviewer_inactivity_detected_total` counter ticking up.
- Phase 25.5 `REVIEWER_INACTIVE` reminders appearing in `/reviewer-ops/sla` activity.
- A reviewer's `capacityScore` is high (idle) but their `activeReviewCount` is non-zero — they hold assignments but are not touching them.
- Workflow rows where `lastReviewedAt` is older than the workspace's `reviewerInactivityHours` threshold.

## Detection

The Phase 25.5 reconcile sweep calls `sweepInactivityReminders(teamId, thresholdHours)` when the workspace governance policy sets `reviewer_inactivity_hours > 0`. It scans `evidence_review_workflows` where:

- `assignedToUserId IS NOT NULL`
- Status is not `CLOSED` / `REJECTED_INSUFFICIENT` / `APPROVED_INTERNAL`
- `lastReviewedAt <= now - thresholdHours` (or `assignedAtUtc <= now - thresholdHours` when never touched)

For each match it schedules a `REVIEWER_INACTIVE` reminder via the `reviewer_ops_reminders` table. The unique `(teamId, kind, dedupKey)` constraint prevents the same reminder from appearing twice in the same UTC day for the same workflow.

## Severity decisions

| Condition | Severity |
|---|---|
| 1-5 inactive reviewers | WARNING |
| > 5 inactive reviewers OR a single reviewer with > 10 inactive assignments | HIGH |
| Inactive assignments include a `LEGAL_HOLD` workflow | HIGH |

## Operational response

1. **Identify the inactive reviewer(s).**
   - `/reviewer-ops/sla` → "Reviewer performance" table. Look for rows with `Mean (h)` blank but `Active > 0`.
   - Cross-reference reviewer last sign-in via `users.lastSeenAtUtc` or your IdP — they may be on vacation / left the team.

2. **Outreach (if appropriate).** Use existing Phase 18 communications to ping the reviewer (the queue console's reminder is metric-only — operators close the loop).

3. **Reassign.** From the queue console:
   - Filter by the inactive reviewer (queue type `MY_REVIEWS` is per-actor; use `UNASSIGNED` after reassign).
   - Multi-select all their assignments → "Assign…" to a healthier reviewer (use the suggestions panel).

4. **Adjust threshold.** If the workspace's `reviewerInactivityHours` is too short (false-positive heavy) or too long (incidents discovered late), tune at `/reviewer-ops/policy`.

5. **Suspend if necessary.** If a reviewer is genuinely gone (e.g. left org), the workspace admin should suspend their TeamMember via the identity surface (Phase 17). Reviewer-ops then auto-stops counting their assignments toward backlog.

## Mitigation

- Reassign stale assignments to active reviewers with high capacity scores.
- Lower the threshold if reviewers are routinely inactive >24h for a fast-paced workspace.
- Raise the threshold (or disable entirely by setting null) for low-tempo / batch-style review workspaces.

## Escalation path

| 0-1 hour | Reviewer Ops on-call reassigns. |
| 1-4 hours | Workspace admin assesses whether the reviewer's account should be suspended. |
| 4+ hours | Operations lead reviews workspace headcount + intake rate. |

## Rollback / safety

- Reminders are insert-only and bounded (one per workflow+kind per day). Even a misconfigured threshold cannot spam.
- Reassignment writes a new `EvidenceReviewWorkflowEvent` of type `REASSIGNED`; the previous assignee remains in audit history.
- Suspending a reviewer via the identity surface is reversible (you can `RESTORE` them).

## Verification steps

```sql
-- Inactive assignments still outstanding:
SELECT id, assigned_to_user_id, last_reviewed_at, assigned_at_utc
FROM evidence_review_workflows
WHERE team_id = $1
  AND assigned_to_user_id IS NOT NULL
  AND status NOT IN ('CLOSED','REJECTED_INSUFFICIENT','APPROVED_INTERNAL')
  AND COALESCE(last_reviewed_at, assigned_at_utc) <= NOW() - ($2 || ' hours')::INTERVAL;

-- Reminder volume in the last day:
SELECT COUNT(*) FROM reviewer_ops_reminders
WHERE team_id = $1
  AND kind = 'REVIEWER_INACTIVE'
  AND created_at > NOW() - INTERVAL '24 hours';
```

After mitigation the inactive-assignment count should fall. Verify the reminder count plateaus — continued growth means the underlying capacity problem is unresolved.
