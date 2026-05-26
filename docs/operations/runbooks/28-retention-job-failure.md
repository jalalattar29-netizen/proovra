# Runbook 28 — Retention job failure

## Symptoms
- `retention-reconciliation.worker` heartbeat stale or recurring exceptions.
- `OperationalIncident` rows with `category=GOVERNANCE_LIFECYCLE` and `kind=RETENTION_RECONCILE_FAILED`.
- Evidence records with `expiresAt < now()` not transitioning to `PENDING_DESTRUCTION`.

## Blast radius
Per-team. Retention reconciliation is bounded (`take: 200` default; max 1000) and per-tick. A failure means the affected tick's batch is not processed; the next tick re-reads from the canonical Evidence + RetentionPolicy state.

**No corruption risk** — retention is read-only at the policy layer and tx-atomic at the lifecycle-orchestrator layer. A failed reconcile leaves Evidence rows in their pre-reconcile state.

## Detection
- `/admin/runtime/workers` heartbeat.
- `OperationalIncident` query for `GOVERNANCE_LIFECYCLE` category.
- Worker logs for `retention-reconciliation` exceptions.

## Logs to inspect
- Worker logs filtered to `retention-reconciliation`.
- The specific `RetentionPolicyVersion` row referenced in the exception.
- The specific `Evidence` row(s) the tick was processing.

## Rollback procedure
None — retention reconciliation is forward-only against the canonical Evidence + RetentionPolicy state. A failed tick does NOT mutate state.

## Safe recovery procedure
1. **Identify the root cause** from the worker logs. Common causes:
   - DB connection saturation: scale DB connection pool.
   - A `RetentionPolicyVersion` row has malformed JSON: isolate the row, file a follow-up.
   - A `RetentionPolicy` references a deleted `Team`: orphan policy. Clean up (operator action; audit-logged).
   - DEF-051 (POST_LAUNCH): auto-extension trigger window is hardcoded 7d. If a policy expects a different window, this is the gap; closure plan is to make the window per-policy.
2. **If the worker process is unhealthy**: restart (runbook 03). Reconcile resumes on the next tick.
3. **For destruction queue stalls** (PENDING_DESTRUCTION rows not progressing): the destruction-orchestrator worker is separate. Check its heartbeat + queue depth.
4. **For an active legal hold during reconciliation**: the hold check is sequential (direct hold then case-level). DEF-050 (POST_LAUNCH) tracks the TOCTOU window in destruction-review create. If a hold is placed during the same tick the reconcile is queuing destruction, the destruction-orchestrator's re-check at execution time catches it.

## Validation steps
- Worker heartbeat fresh.
- `OperationalIncident` rows for `GOVERNANCE_LIFECYCLE` stop accumulating.
- A test evidence record with `expiresAt < now()` transitions to `PENDING_DESTRUCTION` within 1 reconcile cycle.
- No double-creation of `DestructionReview` rows for the same evidence.

## Escalation conditions
- Reconcile stalls > 2 cycles after worker restart → root cause is not transient; engage incident response.
- A destruction was executed against a held evidence record → INTEGRITY-EVENT-GRADE incident. Stop the destruction-orchestrator worker, identify the affected record, audit how the hold check was bypassed.
- A customer requests immediate destruction of evidence and the policy auto-extension fires → DEF-051 closure becomes urgent.

## DO NOT DO THIS
- Do NOT manually create `DestructionReview` rows from the operator shell. Use the canonical retention-reconciliation worker.
- Do NOT delete `RetentionPolicy` rows that have linked Evidence. Orphan retention policies are a governance audit concern.
- Do NOT manipulate `Evidence.expiresAt` directly to "force destruction". The retention engine is the single source of truth.
- Do NOT mutate `activeDestructionReviewId` on the Evidence row to bypass the single-non-terminal-review rule.
