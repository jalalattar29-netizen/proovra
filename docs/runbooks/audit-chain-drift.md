# Runbook — Audit chain drift

**Failure modes:** FM-AUD-001, FM-AUD-002.
**Alert:** `audit_chain_drift` (CRITICAL).

## What this means

The `AdminAuditLog` chain integrity verifier walks the chain and
computes each row's hash from `(prev hash, canonical metadata,
timestamp, action ...)`. If the recomputed hash disagrees with the
stored `hash`, the chain is broken. This is the platform's strongest
detection of tampering, accidental row mutation, or insert-order
violation.

This alert is CRITICAL by design. **Stop destructive operations
immediately.**

## First action (under 60s)

1. Scale destruction-orchestrator to 0.
2. Identify the first broken row:

   ```sql
   SELECT id, "createdAt", "prevHash", "hash"
   FROM "AdminAuditLog"
   WHERE id = (
     SELECT id FROM "AdminAuditLog"
     ORDER BY "createdAt" ASC
     LIMIT 1
   );
   ```

   Then re-walk the chain in operator tooling (the verify endpoint is
   under `/v1/ops/audit/verify`).

## Triage

The verifier returns the first id where recomputed != stored. From
there:

- If the offending row's `metadata` looks plausible (no tamper
  pattern), the issue may be a hash-version mismatch — verify
  `chainVersion = 2` is being used to recompute.
- If the offending row's `prevHash` doesn't match the previous row's
  `hash`, an insert-order violation occurred (advisory lock failure
  or non-transactional insert).
- If the offending row was inserted manually, you can see it: it'll
  carry `source` outside the catalog or no `requestId`.

## Containment

1. **HALT destruction worker and retention-reconciliation** (set
   replicas to 0 in deploy).
2. **HALT lifecycle transitions** by tripping the maintenance flag on
   the api (set `MAINTENANCE_LIFECYCLE_GATED=true`).
3. **Open a CRITICAL OperationalIncident**. Audit chain drift is a
   security event — page the security on-call.
4. Do NOT delete or modify the offending row. The investigation
   requires the row in place.

## Root cause

The chain hash is computed by `computeAuditLogChainHash` in
`services/api/src/lib/admin-audit-chain.ts`. Inputs:
- Canonical sorted JSON of metadata (depth-bounded to 8).
- All audit fields concatenated with `|` separator (v2 chain).
- Previous row's hash.

For drift to occur, one of the following happened:
- A row was UPDATEd in place (the chain hash is recomputed only on
  insert; UPDATE breaks the chain).
- A row was inserted without holding the advisory lock
  (`ADMIN_AUDIT_ADVISORY_LOCK_KEY`).
- A row was inserted with the wrong `prevHash` (concurrent insert
  serialization bug).
- A schema migration changed the canonical encoding.

## Recovery

There is no in-place chain repair. The recovery procedure is:

1. Snapshot the offending range to a separate audit table for
   forensics.
2. Append a `chain_drift_acknowledged` row (operator-authored) that
   re-anchors the chain at a fresh `prevHash` set to the LAST KNOWN
   GOOD row's hash. The `metadata` records the drift range and the
   incident id.
3. Re-run the verifier. The chain should be clean from the
   acknowledgement row onward.
4. Restart the destruction worker only after security has cleared the
   incident.

The drift range itself remains in the table — it is the evidence of
the incident.

## Postmortem checklist

- [ ] Identify the failing insert site (which service, which commit).
- [ ] Confirm the advisory lock was held for the insert (search code
      for `ADMIN_AUDIT_ADVISORY_LOCK_KEY`).
- [ ] Confirm `sanitizeAuditMetadata` was called before the insert.
- [ ] Add a regression test that fails on the specific drift pattern.
- [ ] Confirm the `audit_chain_drift` alert fired within the expected
      window.
