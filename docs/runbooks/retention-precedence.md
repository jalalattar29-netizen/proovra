# Runbook — Retention precedence wrong

**Failure mode:** FM-RET-002.

## What this means

Multiple retention policies match an evidence record. The platform
resolves precedence deterministically:
`CASE → EVIDENCE_TYPE → REGULATORY → WORKSPACE`. An operator reports
the wrong policy is in force — for example, a WORKSPACE policy
shortening retention when a more-specific CASE policy should have won.

## First action (under 60s)

Get the effective policy and the full match set for the evidence:

```sql
SELECT erp.id, erp.scope, erp.status, erp."displayName"
FROM "EvidenceRetentionPolicy" erp
WHERE erp."teamId" = '<team>'
  AND erp.status = 'ACTIVE'
ORDER BY array_position(ARRAY['CASE','EVIDENCE_TYPE','REGULATORY','WORKSPACE']::text[], erp.scope::text);

SELECT er."policyId", erv."retentionDays", erv.immutable
FROM "EvidenceRetentionPolicyBinding" er
JOIN "EvidenceRetentionPolicyVersion" erv
  ON erv."policyId" = er."retentionPolicyId"
 AND erv."version" = er."retentionPolicyVersion"
WHERE er."evidenceId" = '<evidence id>';
```

Compare the binding's policy id against `pickHighestPrecedencePolicy`
applied to the team's ACTIVE policies. If they disagree, the binding
was made before the higher-precedence policy was created.

## Triage

The `pickHighestPrecedencePolicy` formula (also exposed as
`canonicalPickHighestPrecedencePolicy`) ONLY considers ACTIVE-status
policies. Verify the suspect policy is actually ACTIVE — a PAUSED or
SUPERSEDED policy is invisible to the picker.

## Containment

If a CASE-scope policy was created AFTER an evidence binding, no
automatic recomputation happens. Trigger a retention reconciliation
sweep with the operator's case filter:

```bash
curl -X POST -H "X-Internal-Api-Key: $INTERNAL_API_KEY" \
  "$API_BASE/v1/internal/governance/retention-reconciliation/run?teamId=<team>"
```

The sweep re-runs `pickHighestPrecedencePolicy` for every binding and
upserts the binding to the new winner (with a lifecycle event for
audit).

## Root cause

Bindings are immutable point-in-time decisions. The platform creates
them at evidence-ingest time and on policy attach. The recompute path
is the retention-reconciliation worker; it runs on a cron schedule but
also accepts a manual trigger.

If the sweep doesn't pick up the change, look for:
- A `RetentionPolicy` row whose `status` is not ACTIVE (PAUSED counts
  as inactive).
- A `RetentionPolicyVersion` row whose effective dates don't include
  the evidence's `capturedAt`.

## Recovery

Re-run reconciliation with the team filter and audit the resulting
`policy_attached` lifecycle events. The audit chain captures the
before/after; no data is lost.

## Postmortem checklist

- [ ] Confirm `canonicalPickHighestPrecedencePolicy` returns the
      expected policy for the input set.
- [ ] Verify the reconciliation run produced a `GovernanceReconciliationRun`
      row showing the binding upserts.
- [ ] Add a fixture-driven test in `phase-z-hardening.test.ts`
      reproducing the precedence pattern if it represents a new
      scenario.
