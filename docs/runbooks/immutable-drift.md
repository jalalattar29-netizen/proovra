# Runbook — Immutable storage drift

**Failure modes:** FM-RET-001 (immutable retention bypass).
**Alert:** `immutable_storage_drift_open` (HIGH).

## What this means

A retention policy version with `immutable=true` is bound to an
evidence record, but S3 Object Lock metadata for that storage object
disagrees — either the DB thinks it's immutable and S3 doesn't (or
vice versa). The platform refuses destruction of immutable records,
but if the storage layer doesn't share that view, an out-of-band tool
could still delete the object.

## First action (under 60s)

```sql
SELECT er."id", er."evidenceId", er."retentionPolicyId", erv.immutable,
       e."storageBucket", e."storageKey", e."storageObjectLockMode"
FROM "EvidenceRetentionPolicyBinding" er
JOIN "EvidenceRetentionPolicyVersion" erv
  ON erv."policyId" = er."retentionPolicyId"
 AND erv."version" = er."retentionPolicyVersion"
JOIN "Evidence" e ON e.id = er."evidenceId"
WHERE erv.immutable = true
  AND e."storageObjectLockMode" IS NULL
LIMIT 50;
```

Any row returned indicates DB-vs-S3 disagreement.

## Triage

The `immutable-storage-reconciliation` worker runs on a sweep and:
- Writes an `OperationalIncident` row when it finds drift.
- Bumps `immutable_storage_drift_open` gauge.

Check `OperationalIncident` for the most recent drift entries:

```sql
SELECT id, category, severity, "summary", "createdAt"
FROM "OperationalIncident"
WHERE category = 'governance'
  AND "runbookSlug" = 'immutable-drift'
  AND "resolvedAt" IS NULL
ORDER BY "createdAt" DESC
LIMIT 10;
```

## Containment

1. **Block destruction reviews** for the affected evidence:
   ```sql
   UPDATE "DestructionReview"
   SET status = 'CANCELLED', "decisionNote" = 'immutable drift containment'
   WHERE "evidenceId" IN (<list>)
     AND status NOT IN ('EXECUTED', 'CANCELLED', 'DENIED', 'RESTORED');
   ```
2. Do NOT manually fix S3 Object Lock — every change must go through
   the retention engine.

## Root cause

Likely sources:
- Storage object was created BEFORE the policy version flipped to
  immutable (and the bind-time worker hasn't caught up).
- A bucket-level Object Lock configuration change (S3 admin level —
  out of scope for the application).
- A manual S3 deletion attempt that flipped the `storageObjectLockMode`
  to NULL.

## Recovery

The recovery path depends on direction of drift:

- **DB says immutable, S3 says no:** issue an Object Lock PutObjectRetention
  call to bring S3 in sync. This is operator-only via AWS CLI; the
  application has no endpoint to do this (intentionally — immutable
  semantics are not a runtime parameter).
- **S3 says immutable, DB says no:** update the policy version to set
  immutable=true via the retention engine API. The engine emits a
  `policy_attached` lifecycle event; the chain is preserved.

## Postmortem checklist

- [ ] Identify the source of drift (timing race, manual S3 change,
      bucket policy change).
- [ ] Confirm `canonicalCanEnterPendingDestruction` returned
      `blocked_by_immutable` for any destruction attempt during the
      window.
- [ ] Run the immutable-storage-reconciliation worker once after
      remediation to confirm `immutable_storage_drift_open` returns to 0.
