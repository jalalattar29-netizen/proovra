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

No RPO or RTO has been approved. Nothing below may be quoted to a customer.

| Objective | Target | Basis |
|-----------|--------|-------|
| RPO (recovery point) | **Not approved.** With the `pg-backup` service running it is at most `BACKUP_INTERVAL_SECONDS` (default 6 hours) plus the time to the next off-host copy (default 1 hour) | **[configured, once started]** — a provider's point-in-time recovery, if there is one, can only be finer; verify it out-of-band |
| RTO (recovery time) | **Not approved and not measured on production data.** Restore + migrate-forward + artifact regeneration | **[not measured]** — the local drill proves the restore works, on test data, on a workstation |

These are planning figures. They become real when the owner approves them and a
drill has run against the production database's backup.

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

### Database backup — **[in the deployment; started by the operator]**

The scripts in `scripts/ops` are run by two services in
`infra/docker/docker-compose.prod.yml`, under the `backup` profile. The release
deploy does not start them, and warns while they are not running:

```bash
docker compose --env-file /opt/proovra/app/.env \
  -f infra/docker/docker-compose.prod.yml --profile backup up -d
```

- `pg-backup` runs `pg-backup-cycle.sh --loop`. Each cycle takes a logical backup
  of `DIRECT_URL` (`pg-backup.sh`: `pg_dump` custom format from ONE exported
  snapshot, plus a SHA-256, exact per-table row counts and a schema fingerprint from
  the same snapshot), keeps the newest `BACKUP_RETAIN` (default 14) under
  `/opt/proovra/backups/postgres`, and records the outcome.
- Every `BACKUP_DRILL_EVERY_SECONDS` (default weekly) the same cycle restores the
  newest backup into a throwaway server inside its own container
  (`pg-restore-drill-local.sh`), requires row counts and the schema fingerprint to
  match exactly, and records the outcome. The drill cannot reach production.
- `pg-backup-offhost` copies the directory to `BACKUP_S3_URI` with its own
  credentials (`BACKUP_AWS_ACCESS_KEY_ID`, `BACKUP_AWS_SECRET_ACCESS_KEY`,
  `BACKUP_AWS_REGION`, `BACKUP_S3_ENDPOINT_URL`), confirms the newest dump arrived,
  and leaves the result for the next cycle to record. Use a bucket outside the
  evidence bucket's account or region. Retention there is that bucket's lifecycle.
- The image is `pgvector/pgvector:pg16`: the client major version must be at least
  the server's, so a server above 16 needs a newer image here first.
- Each outcome is a row in `platform_backup_records` (counts and a checksum, never
  data). The readiness posture reads those rows:

| `databaseBackup` | Means |
|---|---|
| `restore_verified` | a backup and an off-host copy within 48 hours, and a drill within 35 days |
| `backup_recorded` | a backup is recorded; the reason names what is missing or stale |
| `provider_declared_unverified` | no run recorded; `DATABASE_BACKUP_PROVIDER` names a provider, which cannot be seen from here |
| `no_backup_recorded` | nothing recorded and nothing declared |
| `not_configured` | `DATABASE_URL` is unset |

A provider's point-in-time recovery, where available, remains the finer-grained
option. `DATABASE_BACKUP_LAST_VERIFIED_AT` and `DATABASE_RESTORE_TESTED_AT` remain
the operator's statement about backups this process cannot see.

**Proved locally on 2026-11-01** by
`services/api/test/pg-backup-restore-drill.integration.test.ts`: the real cycle on
a fully migrated disposable database, its drill, and the off-host copy to a local
MinIO. **Not proved:** that these services run on the production host, that a real
off-host bucket exists, or that the production database's server version suits this
client. See `docs/operations/deployed-topology.md`.

### Signing keys — **[not in repo]**

The package signing key is a PEM mounted from
`/opt/proovra/app/services/worker/keys`. It is not in the database, so these
backups do not contain it. A key that is lost cannot seal new packages under its
identity; historical packages still verify from their registered public key. Keep an
offline copy under the owner's control. No such copy can be seen from the repository.

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
