# Runbook — Reviewer escalation backlog

**Slug:** `reviewer-escalation-backlog`
**Owner:** Reviewer Operations on-call
**Severity (default):** WARNING — escalates to HIGH if open count > 25 for 1+ hour

---

## Symptoms

- `reviewer_escalations_open` gauge climbing without corresponding `reviewer_escalation_resolved_total` movement.
- Phase 21 incident `Reviewer escalation — <REASON>` opened by the reconcile job.
- SLA dashboard shows "Open escalations" with critical count > 0.
- Reviewer ops console "Escalated" queue is large.

## Detection

The Phase 25 escalation engine writes one durable row per `(workflow, reason, dayBucket)`. The fingerprint dedup prevents storms — when this backlog grows, it usually means:

1. The workspace is under genuine reviewer load (see also `reviewer-inactivity` runbook).
2. The reconcile sweep is running but escalations are not being resolved / suppressed.
3. There is a category of escalation the team has not triaged (e.g. `INTEGRITY_RISK`).

## Severity decisions

| Condition | Severity |
|---|---|
| 5-15 open escalations | WARNING |
| 16-25 open | WARNING |
| > 25 open for 1+ hour | HIGH |
| Any escalation with `severity=CRITICAL` open > 30 min | CRITICAL — page reviewer-ops on-call |

## Operational response

1. **Group by reason.** `/reviewer-ops/sla` → "Escalation analytics" → "Reason hotspots". Identify which reason dominates.

2. **Address by reason:**

| Reason | First-line action |
|---|---|
| `REVIEW_OVERDUE`, `FIRST_REVIEW_OVERDUE`, `COMPLETION_OVERDUE` | See `reviewer-sla-breach` runbook. |
| `WORKFLOW_STALLED` | Check the workflow instance — likely awaiting a contributor response. Resolve or pause. |
| `EVIDENCE_REQUEST_UNRESOLVED` | Re-prompt the contributor via communications. Resolve the escalation with the contact attempt note. |
| `INTEGRITY_RISK` | Manual reviewer review of the evidence. Do NOT bulk-resolve. |
| `VERIFICATION_MISMATCH` | Confirm with the trust-decision team. Reviewer should escalate to admin. |
| `REVIEWER_INACTIVE` | See `reviewer-inactivity` runbook. |
| `GOVERNANCE_BLOCKED` | Workspace admin must adjust policy via `/reviewer-ops/policy`. |
| `REPEATED_REJECTION_LOOP` | Suspend the workflow; involve workspace admin. |

3. **Bulk-resolve where safe.** For `WORKFLOW_STALLED` escalations that have an unrelated workflow already in `APPROVED_INTERNAL`, use the escalation console multi-select → "Resolve". Each resolve requires a non-empty resolution note (operator audit trail).

4. **Suppress only as last resort.** `SUPPRESSED` removes the row from backlog metrics; use it for known false positives. Suppression reason is mandatory + audited.

## Mitigation

- **Short-term:** assign a focused responder to the highest-count reason.
- **Medium-term:** review the workspace's reviewer headcount + capacity scores at `/reviewer-ops/sla`.
- **Long-term:** tune SLA thresholds at `/reviewer-ops/policy` if the same reason recurs daily.

## Escalation path

| 0-30 min | Reviewer Ops on-call begins triage. |
| 30-90 min | Workspace admin joins; reviews reason hotspots. |
| 90 min+ | Operations lead reviews capacity + SLA policy. |

## Rollback / safety

- `acknowledge` / `reassign` are reversible; `resolve` / `suppress` are terminal.
- Suppression reason text is bounded (400 chars) and scrubbed by the engine; you cannot accidentally leak overclaim wording.
- All escalation history is retained — no rows are ever deleted.

## Verification steps

```sql
-- Open backlog by reason:
SELECT reason, COUNT(*) AS open_count
FROM review_escalations
WHERE team_id = $1
  AND status IN ('OPEN','ACKNOWLEDGED','REASSIGNED')
GROUP BY reason
ORDER BY open_count DESC;

-- Resolution rate in the last 24h:
SELECT
  COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS opened_24h,
  COUNT(*) FILTER (WHERE resolved_at_utc > NOW() - INTERVAL '24 hours') AS resolved_24h
FROM review_escalations
WHERE team_id = $1;
```

Expected post-mitigation: opened_24h ≈ resolved_24h within a tolerance of ~25%. If the gap widens after 4 hours, escalate.
