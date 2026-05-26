# Runbook 01 — Database restore + post-restore validation

**Scope:** restore the PROOVRA PostgreSQL database from a provider-managed backup snapshot and validate that the application can boot against the restored state.

**Prerequisites:**

- Operator access to the database provider console (Neon / RDS / managed Postgres).
- `pnpm` installed in the deployment environment.
- The `services/api` package built or runnable from source.
- A target environment (staging is the default — do NOT rehearse against production).

**Forbidden:**

- Restoring to production from a backup older than the current production state without an explicit incident-response approval. PROOVRA does not include code that automatically rolls back the production database.
- Bypassing `prisma migrate deploy` after restore. The application assumes the schema matches the latest committed migration.

---

## Steps

1. **Identify the target snapshot.**
   - In the database provider console, list available snapshots (PITR window + named snapshots).
   - Pick the snapshot whose timestamp matches the target recovery point. Record the snapshot id + timestamp.

2. **Restore the snapshot to a new database instance.**
   - Use the provider's "restore to new database" flow. Do NOT overwrite the running database.
   - Capture the new connection string (`DATABASE_URL`).

3. **Point the target environment at the restored DB.**
   - Update the staging environment's `DATABASE_URL` to the restored instance.
   - Do NOT update production until the restored DB has passed validation.

4. **Apply schema migrations.**
   - From the deployment box, run:
     ```
     pnpm --filter proovra-api exec prisma migrate deploy
     ```
   - Expected outcome: migrations apply cleanly OR report "already applied".
   - If `prisma migrate deploy` reports drift (`P3009` / `P3018`), do NOT proceed. Investigate; resolve via `prisma migrate resolve` only after confirming the drift is intentional.

5. **Boot the API.**
   - Start the API process. Confirm startup completes without errors.
   - Confirm `runStartupConfigValidation()` does not throw.

6. **Hit health endpoints.**
   - `GET /health` — expect `{ok: true, db: "up"}`.
   - `GET /readyz` — expect 200 with `{ready: true}`.
   - `GET /admin/runtime/readiness` (authenticated, requires `audit.read`) — expect rollup status HEALTHY or DEGRADED. CRITICAL is a fail condition; investigate.

7. **Confirm migration parity.**
   - `GET /admin/runtime/migrations` — expect zero pending or rolled-back migrations.
   - If the response lists any drift, re-apply via `prisma migrate deploy` or follow the documented `prisma migrate resolve` path. Do not silently mark a migration as applied without verifying the SQL.

8. **Boot the worker.**
   - Start the worker process. Confirm `bootstrapObjectLockVerification()` succeeds in prod-like environments.
   - Confirm the first `WORKER_HEARTBEAT` security event lands within the configured reconcile interval (default 5 min).

9. **Sample a custody chain.**
   - Pick one finalized evidence record from the restored DB.
   - Run runbook 09 (audit / custody continuity validation) against that record.
   - Expected: chain re-validates clean.

10. **Sign off.**
    - Record the rehearsal in `00-rehearsal-log.md`.
    - If any step failed, capture the failure mode in the log row's `Notes / follow-up` column and open an Ops ticket.

---

## What this runbook does NOT cover

- Restoring object storage. See runbook 02.
- Restoring signing keys. See runbook 06.
- Re-running async work that was in flight at backup time. The DB-backed lifecycle state for webhook deliveries + automation runs will resume from where the snapshot captured it; setTimeout-scheduled retries will be re-picked-up by the next sweep tick.

---

## Honest gaps

- The exact backup cadence and retention window are provider-managed. PROOVRA does not back up the DB itself; we rely on the provider's published policy.
- Without a recurring rehearsal, "backup exists" is assumed; only restore-rehearsal proves recoverability.
