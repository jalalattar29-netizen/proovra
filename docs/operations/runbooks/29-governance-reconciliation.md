# Runbook 29 — Governance reconciliation

## Symptoms
- A periodic operator review or customer audit identifies a discrepancy between the platform's recorded governance state and the customer's expected state.
- `EvidenceLegalHold` row exists for an Evidence that the customer believes is not under hold.
- A `RetentionPolicyVersion` is bound to Evidence whose customer-defined retention should be different.
- Destruction lineage row exists for evidence the customer believes was retained.

## Blast radius
Per-evidence record and per-customer. Reconciliation is operator-driven against the canonical platform records and the customer's documentation.

## Detection
- Operator query: legal hold report for the customer's team.
- Operator query: retention policy report for the customer's team.
- Customer audit request.

## Logs to inspect
- `EvidenceLegalHold` rows + their lifecycle events (placed / released audit emissions).
- `RetentionPolicyVersion` snapshot bound to the Evidence (the version snapshot is immutable once bound).
- Append-only governance ledger event stream filtered to the affected Evidence.
- `appendCustodyEvent` rows for the affected Evidence (custody chain is the integrity-bound subset).

## Rollback procedure
None — governance state is forward-only. A "rollback" of a legal hold release is itself a new hold placement (auditable).

## Safe recovery procedure
1. **Identify the canonical source of truth.** For legal holds: the customer's legal team's case documentation (external to the platform). For retention: the customer's retention policy documentation.
2. **Compare to platform state.** Read the `EvidenceLegalHold` rows + their lifecycle events. Read the `RetentionPolicy` + bound `RetentionPolicyVersion` for the affected Evidence.
3. **If platform state is wrong**: the operator can correct via the standard governance UI / API:
   - To re-place a released hold: use the place-hold endpoint with a documented reason. This emits an audit event.
   - To re-bind retention: use the retention policy endpoint to change the policy assignment. This creates a new `RetentionPolicyVersion` snapshot.
   - To re-classify destruction lineage: NOT POSSIBLE post-destruction. The lineage row is permanent; the only correction is a customer-facing notification documenting the discrepancy.
4. **If the customer's source of truth is wrong**: document the platform's recorded state + provide the audit chain to the customer. The platform's append-only audit is the authoritative record of WHAT THE PLATFORM DID; the customer's documentation may be the authoritative record of WHAT THE CUSTOMER INTENDED.
5. **For discrepancies that originate from operator error** (e.g., wrong hold placed by mistake): release the hold with a documented reason. The release is an audit event; the placement remains in history.

## Validation steps
- The platform's recorded state matches the customer's expected state (or is documented as a residual).
- Every correction emits an audit event.
- The custody chain re-validates clean (runbook 09).
- No `RetentionPolicyVersion` snapshot has been mutated (the snapshot is immutable; mutation would be a real defect — escalate to incident response).

## Escalation conditions
- A discrepancy involves destruction that has executed (storage deleted) → CUSTOMER-NOTIFICATION-LEVEL. The destruction is irreversible; provide the customer the audit chain showing why the platform destroyed the evidence.
- A `RetentionPolicyVersion` snapshot appears mutated → INTEGRITY-EVENT-GRADE incident.
- The customer asks for destruction that legal hold would have blocked → operator must NOT bypass the hold. The destruction request goes into the queue for legal review.

## DO NOT DO THIS
- Do NOT modify historical audit ledger rows. The ledger is append-only.
- Do NOT mutate a `RetentionPolicyVersion` snapshot. The snapshot is the integrity-bound retention contract.
- Do NOT delete `EvidenceLegalHold` rows. Hold release is a state transition + a new audit event, not a delete.
- Do NOT bypass the destruction-review service to immediately destroy evidence on a customer's verbal request. The review service is the legal-process gate.
- Do NOT release a hold without a documented reason. The reason is the audit defense.
