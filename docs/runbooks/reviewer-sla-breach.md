# Runbook — Reviewer SLA breach

**Slug:** `reviewer-sla-breach`
**Owner:** Reviewer Operations on-call
**Severity (default):** HIGH — escalates to CRITICAL if breach count > 10 in a 15-minute window

---

## Symptoms

- Phase 21 operational incident with title `Reviewer escalation — REVIEW_OVERDUE` (or `FIRST_REVIEW_OVERDUE` / `COMPLETION_OVERDUE`).
- Spike in `reviewer_sla_breached_total` counter.
- `reviewer_queue_overdue` gauge climbing.
- SecurityEvent `reviewer_sla_breached` appearing repeatedly for the same team.
- Reviewer Ops dashboard "Overdue" stat lit red.

## Detection

The Phase 25 reconcile job (`POST /v1/reviewer-ops/reconcile`) flips
`evidence_review_workflows.slaStatus` from `OVERDUE` → `BREACHED` when
`now - dueAtUtc > breachAfterMinutes` (default 1440 minutes / 24h).
On each `BREACHED` transition the engine:

1. Emits `reviewer_sla_breached` SecurityEvent.
2. Bumps `reviewer_sla_breached_total`.
3. Opens a `REVIEW_OVERDUE` `ReviewEscalation` (HIGH severity) — which itself opens a Phase 21 `OperationalIncident` with this runbook slug.

## Severity decisions

| Condition | Severity |
|---|---|
| 1-3 breaches in 60 min | WARNING |
| 4-10 breaches in 60 min | HIGH |
| > 10 breaches in 15 min | CRITICAL — page reviewer-ops on-call |
| Breach is on a `LEGAL_HOLD` workflow | HIGH (regardless of count) |

## Operational response

1. **Identify scope.**
   - Visit `/reviewer-ops/escalations?status=OPEN&severity=HIGH`.
   - Filter by reason `REVIEW_OVERDUE` / `FIRST_REVIEW_OVERDUE` / `COMPLETION_OVERDUE`.
   - Note the affected reviewers (group by `assignedToUserId`).

2. **Triage by reviewer.**
   - If a single reviewer is responsible for the bulk of breaches, check `/reviewer-ops/sla` → "Reviewer workload (latest snapshots)". A reviewer with `capacityScore < 25` may have legitimately been overloaded.
   - Reassign via the queue console multi-select → "Assign…" or per-row "Reassign…".

3. **Triage by SLA policy.**
   - Visit `/reviewer-ops/policy`. If the workspace SLA is unrealistic (e.g. 4h completion for a research workflow), edit the policy — saving requires step-up.

4. **Acknowledge escalations.**
   - For each open escalation in scope, click **Acknowledge** on the escalation console row. This silences the workspace pressure indicators while the team works on resolution.

## Mitigation

- **Short-term:** bulk reassign overdue reviews via the queue console; pause non-critical workflows with a clear pause reason.
- **Medium-term:** add reviewer capacity (invite more team members with the `evidence_request.review` permission, or grant existing members).
- **Long-term:** raise the per-template SLA via `EvidenceWorkflowTemplate.reviewPolicyJson.sla`; the workflow-template override wins over the workspace default.

## Escalation path

| Hour 0-1 | Reviewer Ops on-call acknowledges + reassigns. |
| Hour 1-3 | Workspace admin reviews SLA policy on `/reviewer-ops/policy`. |
| Hour 3+  | Operations lead reviews the runbook → `reviewer-escalation-backlog`. |

## Rollback / safety

- All actions here are reversible. `acknowledge` does not change workflow state; only `resolve` / `suppress` move the escalation terminal. Errant reassignments can be reversed via another reassignment.
- DO NOT delete `review_escalations` rows directly in the database — they are immutable audit history.

## Verification steps

After mitigation:

```sql
-- Outstanding HIGH/CRITICAL escalations for the team:
SELECT id, reason, status, severity, created_at
FROM review_escalations
WHERE team_id = $1
  AND status IN ('OPEN','ACKNOWLEDGED','REASSIGNED')
ORDER BY created_at DESC;

-- Breach count over the last hour:
SELECT COUNT(*) FROM evidence_review_workflows
WHERE team_id = $1
  AND sla_status = 'BREACHED'
  AND updated_at > NOW() - INTERVAL '1 hour';
```

The breach count should drop after reassignment. If it does not within
30 minutes of mitigation, escalate to operations lead.
