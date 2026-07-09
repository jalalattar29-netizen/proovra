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

- S3 Object Lock is controlled by `S3_OBJECT_LOCK_ENABLED`,
  `S3_OBJECT_LOCK_MODE` (`GOVERNANCE` | `COMPLIANCE`),
  `S3_OBJECT_LOCK_RETAIN_DAYS`, `S3_OBJECT_LOCK_LEGAL_HOLD`
  (see `services/worker/src/config.ts` and
  `services/api/src/storage.ts`).
- Live status is probed by
  `services/api/src/services/operations/object-lock-status.service.ts`
  and surfaced by `GET /v1/operations/exports/object-lock` and the
  readiness posture. When the bucket does not actually support Object
  Lock, the status reports `claimed-but-unsupported` — it never
  fakes a "verified" badge.
- Startup verification: `services/api/src/bootstrap/object-lock-verification.ts`
  refuses to boot (unless `OBJECT_LOCK_VERIFICATION_BYPASS=true`) when
  `S3_OBJECT_LOCK_ENABLED=true` but the bucket cannot accept retention.

### Database backup — **[assumed / managed platform; NOT in repo]**

- There are **no** repository-level automated database backup scripts
  (no `pg_dump`, no snapshot cron). Point-in-time recovery relies on
  the **managed database platform's** backup facility.
- The readiness posture reports this honestly as
  `databaseBackup: "managed_platform_assumed"` (or `"not_configured"`
  when `DATABASE_URL` is unset). It never reports "backed up" as a
  fabricated positive.
- **Operator action required:** confirm the managed platform's backup
  retention and perform a test restore. This is not something the
  application can prove for you.

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
   Hit `GET /admin/runtime/readiness` and `GET /admin/runtime/schema-status`,
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
