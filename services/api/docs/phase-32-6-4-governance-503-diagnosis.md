# Phase 32.6.4 — Governance 503 Diagnostic Runbook (READ-ONLY)

## Purpose

The read-only investigation in Phase 32.6.4 confirmed that `/v1/governance/legal-holds`, `/v1/governance/case-legal-holds`, and `/v1/governance/policy` have returned `503 governance_schema_unavailable` in production. This document gives operators a bounded, **read-only** procedure for determining whether the root cause is **schema drift** (a column or table that Prisma queries but the live DB does not have) and, if so, what migration would resolve it.

**This document does NOT auto-apply any SQL.** All commands are read-only `SELECT`s against the live database. Any actual migration must follow the platform's standard `prisma migrate deploy` pipeline, with explicit operator review.

## Why this matters

`runGovernanceHandler` ([services/api/src/routes/_governance-error-bound.ts](../src/routes/_governance-error-bound.ts)) catches **only** three Prisma error codes and maps them to a bounded 503:

- `P2022` — Prisma expected a column the live DB does not have
- `P2021` — Prisma expected a table the live DB does not have
- `P2025` — Prisma expected a row that does not exist (rare governance-side path)

Any other unhandled exception would surface as a generic 500. So a 503 from these routes is **always** a schema mismatch between the deployed Prisma client and the live database — never a bug in the route handler itself.

Phase 32.6.2 (reviewer_ops naming drift repair) and Phase 32.6.3 (Team billing column drift repair) both shipped migrations that create snake_case columns Prisma now reads. **If those migrations have not been applied to production yet**, the post-32.6.2 / post-32.6.3 Prisma client will hit P2022 on queries that touch:

- `review_escalations.safe_summary`, `resolution_note`
- `reviewer_workload_snapshots.safe_note`
- `reviewer_ops_reminders.dedup_key`, `safe_summary`
- `teams.billing_plan`, `billing_status`, `included_seats`, `over_seat_limit`

The governance routes touch `teams` via `loadWorkspaceGovernancePolicy()`, and the reviewer_ops endpoints touch all five reviewer_ops fields. So a missing 32.6.2 or 32.6.3 migration is the **highest-probability root cause** of the 503s.

## Step 1 — capture the exact 503 response body

Operator action: open the browser DevTools Network panel while logged in to the affected workspace, then visit `/governance`. For each request that returns 503, capture the response body. Expected bounded shape:

```json
{
  "error": {
    "code": "governance_schema_unavailable",
    "message": "..."
  }
}
```

The presence of this exact `code` confirms the 503 came from `runGovernanceHandler` and is therefore one of `P2022 / P2021 / P2025`. Any other 503 shape (e.g. `{ code: "GOVERNANCE_CHECK_FAILED", ... }`) is a separate path through `enforceSensitiveAction` and points at `loadWorkspaceGovernancePolicy` specifically.

## Step 2 — find the matching server log

Operator action: take the `requestId` from the response header `x-request-id` (or from the body's `error.requestId` if surfaced) and search the API logs for that ID. The Fastify error handler logs Prisma error codes — look for:

- `P2022` followed by `Column ... does not exist in the current database`
- `P2021` followed by `Table ... does not exist in the current database`

The specific column or table name in the message **identifies the drift exactly**. No guessing required.

## Step 3 — confirm migration state on the live DB

All queries below are read-only `SELECT`s. Run via the platform's standard read-only psql connection (e.g. a Neon read replica) — do **not** run on a primary that has write traffic.

### 3.1 — list applied migrations

```sql
SELECT
  migration_name,
  started_at,
  finished_at,
  rolled_back_at
FROM _prisma_migrations
ORDER BY started_at DESC
LIMIT 30;
```

**Healthy outcome**: every recent row has a non-null `finished_at` and a null `rolled_back_at`.

**Unhealthy outcomes**:
- Any row with `finished_at IS NULL` → migration was started but never completed. This is what `checkMigrations()` flags as DEGRADED in the readiness probe.
- Any row with `rolled_back_at IS NOT NULL` → migration was applied then explicitly rolled back. Flagged as CRITICAL.
- The expected Phase 32.6.2 / 32.6.3 migration names (`20260620200000_reviewer_ops_naming_drift_repair`, `20260620300000_team_billing_naming_drift_repair`) **not appearing in the list at all** → those migrations have not been deployed to this environment yet.

### 3.2 — confirm reviewer_ops snake_case columns exist

```sql
SELECT
  table_name,
  column_name
FROM information_schema.columns
WHERE table_schema = current_schema()
  AND table_name IN (
    'review_escalations',
    'reviewer_workload_snapshots',
    'reviewer_ops_reminders'
  )
  AND column_name IN (
    'safe_summary',     'safeSummary',
    'resolution_note',  'resolutionNote',
    'safe_note',        'safeNote',
    'dedup_key',        'dedupKey'
  )
ORDER BY table_name, column_name;
```

**Healthy outcome**: every snake_case column is present (`safe_summary`, `resolution_note`, `safe_note`, `dedup_key`, plus `safe_summary` on `reviewer_ops_reminders`). The camelCase columns may also still be present — this is intentional (preserved for rollback by Phase 32.6.2's non-destructive repair).

**Unhealthy outcome**: any of the five snake_case columns is missing. Apply migration `20260620200000_reviewer_ops_naming_drift_repair`.

### 3.3 — confirm Team billing snake_case columns exist

```sql
SELECT
  column_name
FROM information_schema.columns
WHERE table_schema = current_schema()
  AND table_name = 'teams'
  AND column_name IN (
    'billing_plan',     'billingPlan',
    'billing_status',   'billingStatus',
    'included_seats',   'includedSeats',
    'over_seat_limit',  'overSeatLimit'
  )
ORDER BY column_name;
```

**Healthy outcome**: all four snake_case columns present. CamelCase versions may also still exist (preserved for rollback by Phase 32.6.3's non-destructive repair).

**Unhealthy outcome**: any of the four snake_case columns is missing. Apply migration `20260620300000_team_billing_naming_drift_repair`.

### 3.4 — confirm the `TeamBillingStatus` enum exists

```sql
SELECT typname FROM pg_type WHERE typname = 'TeamBillingStatus';
```

**Healthy outcome**: one row returned. **Unhealthy outcome**: empty result. Apply migration `20260620300000_team_billing_naming_drift_repair` (which creates the enum idempotently inside a `DO` block).

### 3.5 — sanity check the governance models

```sql
SELECT
  table_name
FROM information_schema.tables
WHERE table_schema = current_schema()
  AND table_name IN (
    'workspace_governance_policies',
    'evidence_legal_holds',
    'case_legal_holds',
    'evidence_retention_policies',
    'evidence_retention_policy_versions',
    'destruction_reviews',
    'evidence_lifecycle_events'
  )
ORDER BY table_name;
```

All seven tables must be present. Any missing table → the governance migrations (Phase 9 / 13.5 / 14 / 27) are not fully applied. This is a much larger gap than a single column.

## Step 4 — apply only the necessary migration

If Step 2 named a specific column from a Phase 32.6.2 / 32.6.3 table, apply only the corresponding migration via the standard pipeline:

```bash
# Reviewer_ops naming drift (Phase 32.6.2)
pnpm --filter proovra-api exec prisma migrate deploy

# This applies any unapplied migrations including:
#   20260620200000_reviewer_ops_naming_drift_repair
#   20260620300000_team_billing_naming_drift_repair
```

Both migrations are **idempotent** (`information_schema`-guarded backfills, `ADD COLUMN IF NOT EXISTS`, `IF NOT EXISTS` for enum creation) — re-running on an already-migrated database is a no-op.

Neither migration drops the camelCase columns. The rollback path is to revert the four/five `@map(...)` annotations in `schema.prisma` and redeploy — production data is preserved by the residual camelCase columns.

## Step 5 — verify the 503s clear

After the migration is applied, the same operator action that reproduced the 503 should return 200 with the expected response body. If the 503 persists, return to Step 2 — there is a different column or table that the log will name.

## What this document deliberately does NOT do

- Does not auto-apply any migration.
- Does not write to the database.
- Does not weaken or bypass the bounded 503 (it remains the correct fail-closed behavior when the underlying schema is mismatched).
- Does not modify any governance gate, billing gate, OTS/TSA path, report generation, or verification package generation.

## Related code paths

- 503 emitter: [services/api/src/routes/_governance-error-bound.ts](../src/routes/_governance-error-bound.ts) `runGovernanceHandler`
- Migrations directory: [services/api/prisma/migrations/](../prisma/migrations/)
- Readiness probe migrations check: [services/api/src/runtime/runtime-readiness.ts:188-266](../src/runtime/runtime-readiness.ts)
- Frontend behavior on 503: per Phase 32.6.4, the governance page now renders each widget independently — a 503 on `/policy` no longer leaves `/legal-holds` / case-holds / retention candidates stuck on "Loading…" forever.
