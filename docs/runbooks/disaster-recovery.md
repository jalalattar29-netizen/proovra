# Disaster Recovery (DR) — posture, targets, and restore procedure

> **Honesty note.** This document describes the DR posture **as
> configured and as intended**. It does **not** assert any uptime
> guarantee, SLA, or certification. RPO/RTO figures below are stated
> **targets / assumptions**, not contractual guarantees. Each item is
> explicitly marked as **[configured]**, **[assumed / managed
> platform]**, or **[not in repo]** so an operator or reviewer can tell
> what is proven from what is delegated.

## Scope

Covers recovery of the PROOVRA platform after data loss, region
outage, or corruption. The live, machine-computed posture is available
to platform admins at **`/operations/readiness`** (backend
`GET /v1/operations/readiness`).

## Recovery objectives (targets — NOT guarantees)

| Objective | Target | Basis |
|-----------|--------|-------|
| RPO (recovery point) | Bounded by the managed database platform's backup cadence | **[assumed / managed platform]** — depends on the hosting provider's configured backup frequency; verify out-of-band |
| RTO (recovery time) | Restore + migrate-forward + artifact regeneration | **[assumed]** — dominated by managed-platform restore time, which is outside this repo |

These are planning targets. They become real only when the operator
has configured and **tested** the managed platform's backup/restore
facility. Until then, treat them as unverified assumptions.

## What is configured vs assumed vs not-in-repo

### Evidence object preservation — **[configured, verifiable]**

- Evidence originals are retained under S3 Object Lock in **COMPLIANCE**
  mode for at least **2,920 days** from sealing. Production requires
  `S3_OBJECT_LOCK_ENABLED=true`, `S3_OBJECT_LOCK_MODE=COMPLIANCE` and
  `S3_OBJECT_LOCK_RETAIN_DAYS` unset or >= 2920; anything else is a
  startup violation for the API and the worker
  (`objectLockPostureViolations`, `@proovra/shared`).
- Live status is probed by
  `services/api/src/services/operations/object-lock-status.service.ts`
  and surfaced by `GET /v1/operations/exports/object-lock` and the
  readiness posture. When the bucket does not actually support Object
  Lock, the status reports `claimed-but-unsupported` — it never
  fakes a "verified" badge.
- Startup verification (API and worker) refuses to boot in production
  when the bucket cannot hold COMPLIANCE locks, cannot be verified, or
  carries a default retention weaker than the contract. There is no
  bypass. `/readyz` reports `storage_unreachable` /
  `object_lock_unverified` while the bucket is unreachable or wrong.
- **[infrastructure-owned]** The durability, versioning and any
  cross-region replication of the evidence bucket belong to the storage
  provider's configuration. The database backup below does NOT back up
  S3 objects.

### Database backup — **[configured: `scripts/ops`; schedule is operator-owned]**

- `scripts/ops/pg-backup.sh` takes a logical backup of `DATABASE_URL`:
  `pg_dump` custom format from ONE exported snapshot, plus a SHA-256
  (`.dump.sha256`), exact per-table row counts (`.counts`) and a schema
  fingerprint (`.schema`) taken from the same snapshot. Keeps the newest
  `BACKUP_RETAIN` (default 14).
- `scripts/ops/pg-restore-drill.sh` proves a backup restores: checksum
  first, then `pg_restore --exit-on-error` into a fresh database on a
  DISPOSABLE server (`DRILL_ADMIN_URL`; it refuses the production
  server), then requires the row counts and schema fingerprint to match
  exactly, then drops the drill database.
- Both are exercised against disposable PostgreSQL 16 containers by
  `services/api/test/pg-backup-restore-drill.integration.test.ts`.
- Run on the host with a PostgreSQL 16 client, or in the client image:
  ```bash
  docker run --rm --network host -e DATABASE_URL -e BACKUP_DIR=/backups \
    -v /opt/proovra/backups/postgres:/backups -v "$PWD/scripts/ops:/ops:ro" \
    postgres:16 bash /ops/pg-backup.sh
  docker run --rm --network host -e DATABASE_URL -e DRILL_ADMIN_URL \
    -e BACKUP_FILE=/backups/proovra-<stamp>.dump \
    -v /opt/proovra/backups/postgres:/backups:ro -v "$PWD/scripts/ops:/ops:ro" \
    postgres:16 bash /ops/pg-restore-drill.sh
  ```
- **Operator action required:** schedule `pg-backup.sh` (cron/systemd
  timer), copy the backups off the host, and run the restore drill on a
  schedule. Managed-platform point-in-time recovery, where available,
  remains the finer-grained option.
- The readiness posture still reports `databaseBackup:
  "managed_platform_assumed"` (or `"not_configured"` when `DATABASE_URL`
  is unset): the application cannot see whether the schedule runs, so it
  never reports "backed up" as a fabricated positive.

### Artifact regeneration — **[configured]**

- Signed reports and verification packages are **deterministic**
  artifacts re-derivable from immutable evidence + the stored manifest.
  They can be **regenerated** rather than restored. The reproducibility
  verifier lives at
  `services/api/src/services/operations/export-reproducibility.service.ts`
  (`POST /v1/operations/exports/:id/verify`).

### Full DR rehearsal / cross-region failover — **[not in repo]**

- Cross-region replication and failover are infrastructure-layer
  concerns exercised through the hosting provider's tooling. The
  application layer validates only what it can prove.

## Restore procedure

The safe-migration and preflight scripts referenced below already
exist in `services/api/scripts/`.

1. **Provision the database from the managed-platform backup.**
   Use the hosting provider's restore facility to bring up a database
   at the desired recovery point. *(Managed platform — outside this
   repo.)*

2. **Preflight the restored database.**
   ```bash
   node services/api/scripts/db-preflight.mjs
   ```
   Confirms connectivity and basic invariants before any migration is
   applied.

3. **Check for schema drift.**
   ```bash
   node services/api/scripts/drift-check.mjs
   ```
   Compares the live schema against the expected catalog
   (`services/api/src/runtime/schema-validation.ts`).

4. **Apply migrations forward safely.**
   ```bash
   node services/api/scripts/safe-migrate.mjs
   ```
   (or `deploy-safe.mjs` for the full deploy-guarded path). Do **not**
   hand-edit the schema.

5. **Confirm runtime readiness.**
   Hit `GET /v1/admin/runtime/readiness` and `GET /v1/admin/runtime/schema-status`,
   or view `/operations/readiness`. All load-bearing subsystems should
   report `HEALTHY`; `DEGRADED`/`CRITICAL` items carry remediation
   hints.

6. **Verify evidence integrity + regenerate artifacts.**
   Object Lock status should read `verified`. Regenerate any reports /
   verification packages as needed and run the reproducibility verifier
   to confirm the manifest still matches.

## Verification checklist

- [ ] Managed-platform database restore completed to the target RPO.
- [ ] `db-preflight.mjs` passed.
- [ ] `drift-check.mjs` shows no unexpected drift.
- [ ] `safe-migrate.mjs` applied cleanly.
- [ ] `/operations/readiness` runtime status is HEALTHY (or degraded
      items understood).
- [ ] Object Lock status reads `verified`.
- [ ] A sample report / verification package regenerates and verifies.

## What this document does NOT claim

- No uptime percentage or SLA.
- No SOC 2 / ISO 27001 certification.
- No penetration-test pass.
- No guarantee of a specific RPO/RTO — only the configured/assumed
  posture above.
