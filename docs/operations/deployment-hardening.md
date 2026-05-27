# PROOVRA Deployment Hardening Runbook (Phase G5.6)

**Audience:** ops leads, deployment engineers, SRE.

**Purpose:** name the env vars, startup checks, and fail-fast guards that
make a production deployment safe — plus the bounded migration plan for the
gaps.

---

## 1. Environment variable reference

### 1.1 Always required

| Variable | Type | Notes |
| --- | --- | --- |
| `DATABASE_URL` | string | Prisma DSN. Postgres. Phase A1 enforces `team.organization_id NOT NULL` post-Stage-6. |
| `AUTH_JWT_SECRET` | string | Refused if shorter than 32 chars or equals a known dev sentinel. |

### 1.2 Production-only fail-fast (`NODE_ENV === "production"`)

Set via `runStartupConfigValidation()` in `services/api/src/config/index.ts`.
The API process throws `ProductionConfigError` at boot if any of these
violate.

| Check | Pass condition | Violation message |
| --- | --- | --- |
| PDF signing config | `PDF_SIGNING_ENABLED=true` OR `PDF_ARTIFACT_SIGNATURE_OPT_OUT_ACK=true` | "PDF signing must be explicitly enabled or explicitly opted out" |
| Signing provider — KMS | If `SIGNER_PROVIDER=aws-kms` → `KMS_KEY_ID` set | "KMS_KEY_ID required" |
| Signing provider — local | If `SIGNER_PROVIDER=local` → `SIGNING_PRIVATE_KEY_PATH` set + file readable | "Signing private key not found" |
| SAML ACS URL | Not `localhost` / `127.0.0.1` in production | "SAML ACS URL must not be localhost in production" |
| S3 endpoint | Not `http://localhost/*` unless `S3_ALLOW_INSECURE=true` | "S3 endpoint must not be localhost in production" |
| Stripe key | Starts with `sk_live_` or `sk_test_`, not `pk_*` | "Stripe secret key must start with sk_*" |

### 1.3 Feature-gated (validated only when the feature is enabled)

| Feature | Toggle | Required secrets when enabled |
| --- | --- | --- |
| Communications (SMS / Twilio) | `COMMUNICATIONS_ENABLED=true` | `COMMUNICATIONS_RECIPIENT_HASH_SECRET`, `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY`, `TWILIO_API_SECRET`, `TWILIO_VERIFY_SERVICE_SID` |
| Identity security | `IDENTITY_SECURITY_ENABLED=true` | `IDENTITY_SECURITY_HASH_SECRET` |
| Integrations / API keys | `INTEGRATIONS_ENABLED=true` | `API_KEY_SECRET` |
| AI (OpenAI) | `OPENAI_AI_ENABLED=true` | `OPENAI_API_KEY` |
| Notifications (Resend) | `NOTIFICATIONS_ENABLED=true` | `RESEND_API_KEY` |

### 1.4 Optional but production-recommended

| Variable | Default | Production value |
| --- | --- | --- |
| `REDIS_URL` | `redis://localhost:6379` | Required for rate-limiting + queue. Single-instance deploy uses one Redis. Multi-instance see `shared-presence-deployment.md`. |
| `CORS_ORIGINS` | hardcoded fallback set | Comma-separated allowlist for the production domain |
| `LOG_LEVEL` | `info` | `info` recommended; `warn` for low-noise prod |
| `PRESENCE_BACKEND` | `memory` (not yet implemented) | `redis` when `replicas > 1` |
| `S3_BUCKET` / `S3_ENDPOINT` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | none | Required for evidence storage |
| `TSA_URL` | none | Required if OTS / TSA timestamping enabled |

---

## 2. Startup checks (shipped)

The API boots through `services/api/src/server.ts`:

1. Load env (`src/env.js` reads `.env` files).
2. Register Prisma into shared-runtime.
3. `runStartupConfigValidation(log)` — fails fast in production.
4. Routes register.
5. Health endpoints come online.

The worker boots through `services/worker/src/index.ts`:

1. `env-loader.ts` loads `.env`.
2. Redis instance constructed (events logged: ready, error, close).
3. BullMQ queues instantiated.
4. Health server (Fastify) on configurable port — `GET /health` returns
   queue counts + Redis ping latency.

---

## 3. Startup checks — gaps + bounded migration

### 3.1 No DB connectivity probe at API boot

**Current state:** `/readyz` does a DB query, but config validation does
not. A misconfigured `DATABASE_URL` passes the config check and fails at
first request.

**Migration plan:**
1. Add `await prisma.$queryRaw\`SELECT 1\`` to
   `runStartupConfigValidation` AFTER all config checks pass.
2. Catch the error, log structured failure, throw
   `ProductionConfigError` in production with code `db_unreachable`.

**Bounded effort:** ~30 minutes.

### 3.2 No Redis probe at worker boot

**Current state:** worker constructs the IORedis instance but does not
ping. If Redis is down, queues silently fail to process.

**Migration plan:**
1. Add `await redis.ping()` immediately after construction.
2. If it fails, log + exit with non-zero code (Kubernetes / fly will
   restart and either succeed or surface the failure).

**Bounded effort:** ~15 minutes.

### 3.3 Fallback strategy undocumented

**Current state:** the rate-limiter has an in-memory fallback when Redis
is unreachable. The signing layer has dev-key fallback. Operators don't
know when each fires.

**Migration plan:** the `--prod-config` log line emitted at startup now
includes the active provider for each feature. Add an explicit
"degraded providers" gauge for runtime visibility.

**Bounded effort:** ~half day.

### 3.4 Health endpoints fragmented

**Current state:** `/healthz`, `/readyz`, `/v1/ops/health` are separate
endpoints with different scopes. No single "golden signal".

**Migration plan:** keep all three (they serve distinct probe scopes —
liveness, readiness, deep health) and document them as such. Add a
single Grafana panel that combines all three into one panel for ops.

**Bounded effort:** dashboard-only.

### 3.5 No graceful-degradation flags

**Current state:** the platform's behavior on subsystem outage is
implicit (some 503, some silent fallback).

**Migration plan:** introduce a `FEATURE_OBSERVABILITY_DEGRADED_BLOCKING`
env that, when set to `1`, refuses to serve traffic if observability
provider (e.g. Sentry, structured-log sink) is offline. Default off —
operator opts in for environments that require it.

**Bounded effort:** ~1 day.

---

## 4. Migration readiness

### 4.1 Database migrations

- All migrations in `services/api/prisma/migrations/`.
- Migration discipline: see [MIGRATION_DISCIPLINE.md](./MIGRATION_DISCIPLINE.md).
- Phase A1 tightened `team.organization_id` to NOT NULL — operators run
  the diagnostic script first (`services/api/scripts/evidence-tenancy-diagnostic.mjs`)
  to size the legacy population before applying.

### 4.2 Worker / API version compatibility

- API and Worker share Prisma schema. Deploy in lockstep — never deploy a
  Worker that references a Prisma column the API DB does not yet have.
- Worker → API direction: the Worker only reads/writes via Prisma; the
  API serves operator HTTP. They do not share an internal HTTP API.
- BullMQ queue contracts: the job payload schema is implicit. Adding
  fields is safe; removing fields is breaking. Document in the queue
  module when a payload changes.

### 4.3 Rollback notes

Per migration:

1. Always create the rollback SQL alongside the forward migration in the
   migration directory (operator notebook).
2. Test the rollback on a staging restore before production migration.
3. If a migration ships a NOT NULL constraint, the rollback drops the
   constraint (data is preserved).
4. Phase A1 included a CHECK constraint
   `team_id IS NOT NULL OR organization_id IS NOT NULL` — the rollback
   drops the CHECK.

---

## 5. Production deployment checklist

Before announcing a release in production:

- [ ] Confirm `NODE_ENV=production` in the API process env.
- [ ] Confirm `runStartupConfigValidation` passes (check logs for
      `production config validated`).
- [ ] Confirm `/healthz` returns 200.
- [ ] Confirm `/readyz` returns 200 (DB reachable).
- [ ] Confirm worker `GET /health` returns 200 with non-empty queue
      counts.
- [ ] Confirm `PDF_SIGNING_ENABLED=true` (or opt-out ack flag set).
- [ ] Confirm `REDIS_URL` points at the production Redis.
- [ ] Confirm `CORS_ORIGINS` includes the production domain only (or
      uses the safe fallback).
- [ ] Confirm CI passes: G3.2, G4, G5 contract suites.
- [ ] Confirm the latest DB migration has been applied to production
      (Prisma `migrate deploy`).
- [ ] Smoke test the six critical paths (see `test-strategy.md`).
- [ ] Notify on-call.

---

## 6. Acceptance criteria (Phase G5.6)

- [x] Env var reference catalog enumerated above.
- [x] Production fail-fast guards documented.
- [x] Feature-gated secrets documented.
- [x] Startup-check inventory + 5 bounded gaps with migration plans.
- [x] Migration readiness + rollback notes.
- [x] Production deployment checklist.
- [x] No fake claims — every check in §1 / §2 reflects shipped code.

---

## 7. Reference

- Config validator: [services/api/src/config/index.ts](../../services/api/src/config/index.ts)
- API server: [services/api/src/server.ts](../../services/api/src/server.ts)
- Worker boot: [services/worker/src/index.ts](../../services/worker/src/index.ts)
- Ops routes: [services/api/src/routes/ops.routes.ts](../../services/api/src/routes/ops.routes.ts)
- Migration discipline: [MIGRATION_DISCIPLINE.md](./MIGRATION_DISCIPLINE.md)
- Post-deploy verification: [POST_DEPLOY_VERIFICATION.md](./POST_DEPLOY_VERIFICATION.md)
- Phase A1 runbook: [phase-a1-runbook.md](./phase-a1-runbook.md)
- Shared presence: [shared-presence-deployment.md](./shared-presence-deployment.md)
