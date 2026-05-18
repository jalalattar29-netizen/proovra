# Runbook — Database readiness failure

**Incident slug**: `database-readiness-failure` · **Category**: `DATABASE` · **Default severity**: `CRITICAL`

## Symptoms
- `/readyz` returns 503 with `reason: "db_unreachable"`.
- `/healthz` still returns 200 (the process is up; only the DB is unreachable).
- Metrics: `security_event_emit_failed` rising sharply (Phase 20 indicator).

## Dashboards / metrics
- `/readyz` — primary signal.
- `/v1/ops/health` — `ok: false`, `database: "down"`.
- Cloud DB dashboard (RDS / Cloud SQL / wherever) — connection count, IOPS, replica lag.

## Safe commands / routes
1. `curl -fsS /readyz` from outside the cluster — if 503, the load balancer should already be removing the instance.
2. `psql $DATABASE_URL -c "SELECT 1"` from the deployment host.
3. Check Prisma migration lock table for stuck migrations.

## What NOT to do
- **Do not** restart the API while a migration is in flight. Always inspect `_prisma_migrations` first.
- **Do not** roll back a migration without a tested down path. PROOVRA migrations are forward-only-additive by convention; the rollback block in each migration header is the source of truth.
- **Do not** drop the DB. (Obvious, but stating the invariant.)

## Rollback / retry guidance
- Transient outages: the LB will drain the instance and put it back when `/readyz` is healthy.
- Sustained outage: failover to standby if available; do not bring up new instances pointing at a failing primary.

## Escalation
- Any CRITICAL DB incident pages on-call immediately. Communications + identity-security + audit all depend on the DB; sustained outage means OTP / step-up / access decisions stop working.
