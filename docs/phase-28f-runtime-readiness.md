# Phase 28-F — Runtime Validation Hardening + Enterprise Empty States

## Overview

This phase expands the runtime validation surface from a single
`schema-status` endpoint into a full enterprise readiness aggregator,
adds dedicated migration-drift detection, and ships reusable
empty-state components for fail-closed UI consumption — without
redesigning any page or starting Enterprise Search.

## Readiness aggregator

**Module:** [`services/api/src/runtime/runtime-readiness.ts`](../services/api/src/runtime/runtime-readiness.ts)

`runReadinessCheck(prisma, requestId)` returns one
`RuntimeReadinessReport` with 10 subsystem checks:

| Subsystem | Source | Status policy |
|-----------|--------|---------------|
| `schema` | Delegates to `runSchemaValidation` | CRITICAL on missing critical objects |
| `migrations` | Queries `_prisma_migrations` | CRITICAL on rolled-back; DEGRADED on pending |
| `database` | `SELECT 1` | CRITICAL on unreachable |
| `redis` | Env presence (`REDIS_URL`) | DEGRADED if unset |
| `s3_object_lock` | S3 env vars + `S3_OBJECT_LOCK_ENABLED` | CRITICAL on missing S3 env; DEGRADED if Object Lock disabled |
| `queues` | Open WORKER incidents at HIGH/CRITICAL severity | DEGRADED on >0; UNKNOWN on query failure |
| `workers` | Most recent `reviewer_reconcile_run` audit row age | DEGRADED if older than 3× interval; UNKNOWN on query failure |
| `metrics` | `METRICS_SCRAPE_TOKEN` env | HEALTHY (token or open path) |
| `sentry` | `SENTRY_DSN` env | DEGRADED if unset (never CRITICAL) |
| `cron_secrets` | `REVIEWER_OPS_CRON_SECRET` / `INTEGRATION_CRON_SECRET` env | DEGRADED if neither set |

### Fail-safe properties

- Every check is bounded by a **2-second timeout** via `withTimeout`. Slow probes never stall the aggregator.
- Every check returns a typed `SubsystemReadiness` projection with bounded fields. No secret values surface.
- The aggregator never throws. Errors map to `UNKNOWN` / `DEGRADED` / `CRITICAL` with an operator-readable detail.
- `rollUpStatus` precedence: **CRITICAL > DEGRADED > HEALTHY > UNKNOWN**.

## Migration drift detector

**Module:** [`services/api/src/runtime/migration-drift.ts`](../services/api/src/runtime/migration-drift.ts)

`runMigrationDriftCheck(prisma)` returns a `MigrationDriftReport` that classifies each migration into one of:

| Source | Meaning |
|--------|---------|
| `disk_only` | Migration exists on disk but never applied to DB |
| `db_only` | DB row exists but no directory on disk (working tree stale) |
| `rolled_back` | DB row has `rolled_back_at != null` |
| `in_progress` | DB row has `started_at != null` but `finished_at == null` (failed mid-apply) |

Plus a stable FNV-1a fingerprint over the disk migration list for change detection.

**Read-only.** Reports only; never auto-runs migrations. No `INSERT` / `UPDATE` / migrate-deploy is performed.

## Routes

| Endpoint | Purpose | Auth |
|----------|---------|------|
| `GET /admin/runtime/readiness?teamId=…` | Full aggregator | session + `audit.read` |
| `GET /admin/runtime/queues?teamId=…` | Queues + Redis subset | session + `audit.read` |
| `GET /admin/runtime/workers?teamId=…` | Workers + cron secrets subset | session + `audit.read` |
| `GET /admin/runtime/migrations?teamId=…` | Migration drift detail | session + `audit.read` |

(The existing `GET /admin/runtime/schema-status` from Phase 28-A remains its own route in `ops.routes.ts`.)

Each endpoint:
- 404 on non-member tenants (anti-enum).
- Bumps the appropriate metric counter.
- Returns operator-safe details + remediation hints.

## Metrics

Eight new counters added to [`metrics.service.ts COUNTER_NAMES`](../services/api/src/services/ops/metrics.service.ts):

| Counter | Bumped when |
|---------|-------------|
| `runtime_readiness_check_total` | Each readiness call |
| `runtime_readiness_degraded_total` | Readiness rolls up to DEGRADED |
| `runtime_readiness_critical_total` | Readiness rolls up to CRITICAL |
| `runtime_queue_health_check_total` | `/admin/runtime/queues` hit |
| `runtime_migration_drift_detected_total` | Migration drift report has ≥ 1 entry |
| `enterprise_empty_state_rendered_total` | UI renders an empty-state preset (reserved for client wiring) |
| `governance_snapshot_ui_loaded_total` | UI loads the snapshot endpoint (reserved) |
| `operational_timeline_ui_loaded_total` | UI renders the timeline (reserved) |

## Enterprise empty-state components

**Module:** [`apps/web/components/operational/OperationalEmptyState.tsx`](../apps/web/components/operational/OperationalEmptyState.tsx)

Reusable React component with three variants (`neutral`, `degraded`, `unknown`) plus seven bounded presets:

- `NoEscalationsEmptyState`
- `NoWorkloadSnapshotsEmptyState`
- `NoGovernanceIncidentsEmptyState`
- `NoSlaBreachesEmptyState`
- `NoOperationalTimelineEmptyState`
- `RuntimeDegradedNotice`
- `GovernanceSnapshotUnavailableNotice`

Each preset shows:
1. **Kicker** — operational area (e.g. "Reviewer Ops").
2. **Title** — one line.
3. **Reason** — why the area is empty.
4. **Runtime dependency** — what system must run for data to appear.
5. **Actions** — links to related pages / runbooks.

### Fail-closed behavior

`GovernanceSnapshotUnavailableNotice` (variant `unknown`) explicitly tells the operator:
> "The platform is failing closed — treat as blocked until the snapshot is available."

`RuntimeDegradedNotice` (variant `degraded`) surfaces the failing subsystem list to the operator.

The test suite enforces:
- No preset claims "all clear" / "everything is healthy" when data is missing.
- The fail-closed variants use the appropriate severity tone.
- No marketing copy (rocket emojis, "amazing", "welcome to…") is allowed.
- No private notes / secrets appear in any preset.

## Tests

[`services/api/test/runtime-validation-enterprise.test.ts`](../services/api/test/runtime-validation-enterprise.test.ts) — **45 tests, all passing**:

- 10 tests on the readiness aggregator (10 subsystems, rollup precedence, timeouts, S3 fail-closed, Sentry no-CRITICAL, no-secret-leak)
- 2 tests on pure-helper Redis behavior (configured / unconfigured)
- 5 tests on migration drift (classification, read-only, fingerprint)
- 6 tests on route registration + gating + metric bumps
- 8 tests on metrics catalog
- 6 tests on empty-state components (5 presets + 2 variants + bounded codes + no-success-when-missing + no-marketing)
- 3 tests on fail-closed UI behavior (blocked-treatment, failing-subsystems exposure, severity tones)
- 3 tests on privacy invariants (no secret values, no SQL body content, bounded type contract)
- 2 tests on scope guards (no search engine started)

## Files changed

| File | Type |
|------|------|
| `services/api/src/runtime/runtime-readiness.ts` | **NEW** — 10-subsystem aggregator |
| `services/api/src/runtime/migration-drift.ts` | **NEW** — migration drift detector |
| `services/api/src/routes/runtime-readiness.routes.ts` | **NEW** — 4 endpoints |
| `services/api/src/server.ts` | modified — register routes |
| `services/api/src/services/ops/metrics.service.ts` | modified — 8 new counters |
| `apps/web/components/operational/OperationalEmptyState.tsx` | **NEW** — 7 reusable presets |
| `services/api/test/runtime-validation-enterprise.test.ts` | **NEW** — 45 regression tests |
| `docs/phase-28f-runtime-readiness.md` | **NEW** — this doc |

## SQL required

**None.** Read-only over existing tables.

## Env variables required

**None new.** Existing env stack is sufficient. Optional envs documented in the readiness checks themselves:
- `REDIS_URL`, `SENTRY_DSN`, `METRICS_SCRAPE_TOKEN`, `S3_OBJECT_LOCK_ENABLED`, `REVIEWER_OPS_CRON_SECRET`, `INTEGRATION_CRON_SECRET`, `REVIEWER_OPS_RECONCILIATION_INTERVAL_MS`.

## Operator verification

```bash
# 1. Full readiness check.
curl -fsS -H "Authorization: Bearer $OP_TOKEN" \
  "$API_BASE/admin/runtime/readiness?teamId=<team>" | jq '.status, (.subsystems | map({id, status}))'

# 2. Queue subset.
curl -fsS -H "Authorization: Bearer $OP_TOKEN" \
  "$API_BASE/admin/runtime/queues?teamId=<team>" | jq .

# 3. Worker subset.
curl -fsS -H "Authorization: Bearer $OP_TOKEN" \
  "$API_BASE/admin/runtime/workers?teamId=<team>" | jq .

# 4. Migration drift.
curl -fsS -H "Authorization: Bearer $OP_TOKEN" \
  "$API_BASE/admin/runtime/migrations?teamId=<team>" \
  | jq '.status, .diskCount, .dbCount, (.drift | length)'

# 5. Metrics counters.
curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" \
  "$API_BASE/v1/ops/metrics" \
  | jq '.metrics.counters
        | {runtime_readiness_check_total,
           runtime_readiness_degraded_total,
           runtime_readiness_critical_total,
           runtime_migration_drift_detected_total}'
```

## What this phase did NOT do

- ❌ Built Enterprise Search.
- ❌ Built AI / OCR / semantic ranking / federation / mobile / analytics.
- ❌ Redesigned app-shell-v2.
- ❌ Modified existing reviewer-ops / governance pages — the empty-state components are **available for consumption**, not yet wired into every page (that's a focused UI consumption phase).
- ❌ Modified report-v2 / verify / package / OTS / TSA semantics.
- ❌ Added new Prisma migrations.

## Production readiness assessment

**The runtime validation surface is enterprise-grade.** Specifically:

- Schema + migration + database + Redis + S3 + queue + worker + metrics + Sentry + cron-secret readiness all surfaced through one aggregator.
- Each subsystem fails closed where appropriate: S3 env missing → CRITICAL; Object Lock disabled → DEGRADED; Sentry missing → DEGRADED (never CRITICAL — business logic continues).
- Migration drift detection runs without auto-applying anything.
- Empty-state components are bounded-catalog, fail-closed, and never imply success when data is missing.
- All 8 new metric counters are registered and exposed via `/v1/ops/metrics` + `/metrics` (Prometheus).
- No SQL schema changes. No env changes. Deployable immediately.
