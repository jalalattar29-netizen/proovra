# Runbook — Legal hold override

**Failure modes:** FM-HOLD-001 (direct hold), FM-HOLD-002 (case hold), FM-HOLD-003 (hold placed during destruction).

## What this means

A legal hold (direct evidence-level or case-level) is in force and the
platform must refuse destruction. If a hold-protected record reached
DESTROYED, or the destruction worker proceeded against a held record,
the hold contract was bypassed.

## First action (under 60s)

Check for held records that reached DESTROYED:

```sql
SELECT e.id, e."lifecycleState", h.id AS hold_id, h.status AS hold_status
FROM "Evidence" e
JOIN "EvidenceLegalHold" h ON h."evidenceId" = e.id
WHERE h.status = 'ACTIVE'
  AND e."lifecycleState" = 'DESTROYED';
```

Same for case holds:

```sql
SELECT e.id, e."lifecycleState"
FROM "Evidence" e
JOIN "CaseLegalHold" h ON h."caseId" = e."caseId"
WHERE h.status = 'ACTIVE'
  AND e."lifecycleState" = 'DESTROYED';
```

Either query returning a row is a real failure.

## Triage

A normal "destruction was blocked" signal looks like:
- `destruction_blocked_by_hold_total` metric incrementing.
- `DestructionExecution.status = 'FAILED'` rows with
  `failureCode = 'BLOCKED_BY_HOLD'` or `'BLOCKED_BY_CASE_HOLD'`.

If destruction was BLOCKED, this runbook is informational only — the
platform's controls fired.

If destruction PROCEEDED with a hold active, escalate to security
immediately.

## Containment

1. **Place a workspace-level hold** on the related case to freeze any
   in-flight destruction reviews:

   ```sql
   UPDATE "DestructionReview"
   SET status = 'CANCELLED', "decisionNote" = 'hold override investigation'
   WHERE "teamId" = '<team>'
     AND status IN ('PENDING', 'UNDER_REVIEW', 'APPROVED');
   ```

   (This is a containment-only action — it stops new destruction
   without altering past ones.)
2. **Scale destruction orchestrator to 0** until investigation completes.

## Root cause

The hold check fires in three places:
- `canonicalCanEnterPendingDestruction` returns blocked_by_hold /
  blocked_by_case_hold (pure formula).
- `destruction-review.service.ts` refuses APPROVED / EXECUTED when a
  hold is active.
- `destruction-orchestrator.worker.ts` re-runs the formula INSIDE its
  execution transaction (defense in depth — see FM-HOLD-003).

For all three to fail, the EvidenceLegalHold row was either:
- Created after the destruction transaction committed (timing — verify
  hold `createdAt` vs. `DestructionExecution.completedAt`).
- Manually flipped to STATUS=RELEASED then back to ACTIVE.
- Written to a different team's row by mistake.

## Recovery

- Open a CRITICAL OperationalIncident.
- Re-issue the destruction certificate as VOIDED — append a new ledger
  row with `eventType = 'destruction_voided'` (operator note required).
- If the evidence material was already purged, no recovery is possible;
  document the loss in the postmortem.

## Postmortem checklist

- [ ] Hold creation time vs. destruction execution time (verify
      ordering).
- [ ] Confirm the canonical formula was actually called by the worker
      (search worker logs for the `canonicalEvaluateLifecycleTransition`
      decision label).
- [ ] Confirm the orchestrator did NOT pre-fetch the hold state outside
      its transaction.
- [ ] Add a regression test in `phase-z-hardening.test.ts` that
      simulates a hold placed mid-flight.
