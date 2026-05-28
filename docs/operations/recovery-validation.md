# Recovery Validation (Phase P2.5 + P2.6)

**Audience:** SRE / platform engineers + procurement reviewers.

**Canonical path:** `/operations/recovery`.

---

## 1. Honest scope (read first)

**PROOVRA does NOT validate full disaster recovery.** The application validates ONLY what its own process can reach. The unsupported domains are explicitly enumerated in every report:

- `infrastructure_database_backups` — managed Postgres provider's backups are authoritative; validate via the provider's console.
- `infrastructure_s3_backups` — S3 versioning + cross-region replication + bucket-level Object Lock are out-of-band.
- `full_disaster_recovery_rehearsal` — must be exercised in a quarantined environment by the infrastructure provider.
- `cross_region_failover` — delegated to the cloud provider.
- `infrastructure_layer_restore_orchestration` — orchestration of an actual restore is out of scope.

If you see a "passed" overall outcome, it means **the app-layer checks passed**. It does NOT mean infra-layer DR is verified.

## 2. What IS validated

### Backup validation
1. Database connectivity (recent `User` count).
2. S3 Object Lock platform status (re-runs `verifyObjectLockConfiguration()`).
3. Recent exports — sample of 5 most recent; `headObject` each against S3.
4. Audit-trail continuity in the last 24 hours.
5. Infra DB backups: explicit `unsupported`.
6. Infra S3 backups: explicit `unsupported`.

### Restore validation (step-up gated)
1. Prisma migration history present.
2. Object Lock retention configured.
3. Audit lineage continuity in the last 7 days.
4. Queue / Redis reachability.
5. Full DR rehearsal: explicit `unsupported`.
6. Cross-region failover: explicit `unsupported`.

## 3. Backend contract

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/v1/operations/recovery?teamId` | readiness overview |
| POST | `/v1/operations/recovery/validate-backup` | run backup validation |
| POST | `/v1/operations/recovery/validate-restore` | run restore validation (step-up) |
| GET | `/v1/operations/recovery/reports?teamId` | list previous reports |
| GET | `/v1/operations/recovery/reports/:id?teamId` | single report |

## 4. Bounded outcomes

| Outcome | Operator meaning |
| --- | --- |
| `passed` | All app-layer checks passed. Unsupported domains remain out-of-scope. |
| `warning` | At least one non-fatal check produced a warning. Read the report; not necessarily a blocker. |
| `failed` | At least one check failed. Investigate immediately. |
| `unsupported` | The aggregate is `unsupported` only when EVERY check sits outside the app's authority — almost never happens in practice. Per-check unsupported is normal. |

## 5. Audit + metrics

- Audit events: `backup_validation_started`, `backup_validation_completed`, `restore_validation_started`, `restore_validation_completed`, `restore_validation_failed`, `recovery_report_generated`.
- Metrics: `backup_validation_total`, `restore_validation_total`, `restore_validation_failure_total`, `recovery_report_generation_total`.

## 6. Persistence

Reports are persisted as `SecurityEvent` rows with `eventType` in the bounded set above. The `details.report` payload carries the full structured report. The listing endpoint reads back from this table; no new Prisma model is required.

## 7. Step-up purposes

- `RESTORE_VALIDATION_EXECUTE` — gates the restore-validation run. Operator must complete a step-up challenge before the validation proceeds.
