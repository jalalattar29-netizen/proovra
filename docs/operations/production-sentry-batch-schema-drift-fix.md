# Production Sentry Batch — Schema Drift & Validation Fix

**Status:** Ready to deploy
**Phase:** O (Stage 2 migration + Stages 3–4 route/handler fixes + Stage 5 regression tests)
**Owners:** Backend platform / DB operators
**Production DB at fix time:** Neon Postgres `neondb` (eu-central-1), 125 migrations recorded, `prisma migrate status` returned "up to date" — drift was caused by `schema.prisma` declaring columns no migration had ever added (the canonical "schema ahead of migrations" failure mode).

---

## 1. Executive summary

A batch of 13 active Sentry issues in production traced to two root causes: (a) **nine schema-drift errors** where `schema.prisma` declared columns that no migration had applied to the live DB (Prisma rendered them as `column (not available)` because runtime SQL P2022 cannot reverse-map to a Prisma field), and (b) **four validation/handler errors** (raw `ZodError`/undefined-delegate paths) reaching the central error handler and emitting 500s. We resolved (a) with one additive, idempotent Phase O migration (`20270802000000_phase_sentry_batch_schema_drift_repair`) that adds every missing column behind `IF NOT EXISTS` guards plus DO-block backfills for two rename-shaped drifts. We resolved (b) by replacing every `.parse()` with `.safeParse()` at the four affected route handlers, hardening the `reviewer-ops/console` Prisma client signature, adding belt-and-braces P2022/P2021 catches across all Sentry-targeted routes, and extending the central error handler in `server.ts` with three new bounded branches (ZodError → 400 INVALID_INPUT, P2022/P2021 → 503 SCHEMA_NOT_READY, other Prisma → 500 DATABASE_ERROR). All fixes are additive, idempotent, and pinned by a 34-assertion regression test plus the existing service test suite (14,625 tests pass, 0 fail, 56 skipped).

---

## 2. Sentry issue → root cause table

| Sentry | Route | Symptom | Root cause | Stream |
|--------|-------|---------|------------|--------|
| NODE-W   | GET /v1/ops/metrics                                  | ZodError teamId undefined           | `TeamIdQuery.parse` threw raw ZodError → central handler returned 500 | A (route fix) |
| NODE-1R  | GET /v1/exchange/packages                            | column (not available)              | `evidence_exchange_packages.updated_at` declared in schema; no migration ever added it | Schema drift + B safety net |
| NODE-1H  | GET /v1/intelligence/providers/budgets               | column (not available)              | `provider_budgets.archived_at` declared in schema; never added | Schema drift + B safety net |
| NODE-1Q  | GET /admin/runtime/readiness (chainTransfer probe)   | column (not available)              | `chain_transfers.updated_at` declared in schema; never added | Schema drift + C safety net |
| NODE-11  | GET /v1/reviewer-ops/console                         | "Cannot read 'groupBy' of undefined"| `prismaClient: PrismaClient = prisma` default did not bind when caller passed explicit `undefined`; query unsafe-parsed | A (route fix) |
| NODE-1P  | POST /v1/coding/schemas/seed-defaults                | Null constraint codingSchema        | Defensive — exact column unproven; R7 reviewer-workspace columns not consistently applied | Schema drift defensive + C service idempotency |
| NODE-1G  | GET /v1/reviewer-ops/queue                           | ZodError teamId undef + limit>100   | `QueueQuery.parse` threw raw ZodError | A (route fix) |
| NODE-1N  | GET /v1/redaction/providers/health                   | column (not available)              | `redaction_policy_assignments.version_id` declared (schema `policyVersionId @map("version_id")`); original migration created `policy_version_id` and never aliased | Schema drift + DO-block backfill + B safety net |
| NODE-1M  | GET /v1/redaction/projects                           | column (not available)              | `redaction_projects.closed_at_utc` declared in schema; never added | Schema drift + B safety net |
| NODE-1K  | POST /v1/packaging/entitlements/apply-product-line   | column (not available)              | `delegated_admin_grants.{granted_to_user_id, scope_target_id, created_at, updated_at}` declared; never added — original migration created `grantee_user_id` | Schema drift + DO-block backfill + C safety net |
| NODE-1D  | GET /v1/orgs/:id/members                             | ZodError Invalid UUID               | `UuidParam.parse(:id)` threw raw ZodError | A (route fix) |
| NODE-1E  | GET /v1/trust/status                                 | column updated_at does not exist    | `status_components.updated_at` declared in schema; never added (only `created_at + last_updated_at_utc` existed) | Schema drift + C safety net |
| NODE-1J  | GET /admin/runtime/readiness (subprocessor probe)    | column (not available)              | `subprocessors.{category, country, description}` declared in schema; never added | Schema drift + C safety net |

---

## 3. Schema drift table (per-model: missing object + repair DDL)

All DDL below appears in `services/api/prisma/migrations/20270802000000_phase_sentry_batch_schema_drift_repair/migration.sql`. Every statement uses `ALTER TABLE IF EXISTS ... ADD COLUMN IF NOT EXISTS ...`; the two backfills are wrapped in `DO $$ ... END $$` PL/pgSQL blocks with `information_schema.columns` existence guards on both source and target.

| Model | Table | Missing object | Repair DDL |
|-------|-------|----------------|------------|
| EvidenceExchangePackage     | `evidence_exchange_packages`     | `updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()` | `ALTER TABLE IF EXISTS "evidence_exchange_packages" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();` |
| ChainTransfer               | `chain_transfers`                | `updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()` | `ALTER TABLE IF EXISTS "chain_transfers" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();` |
| StatusComponent             | `status_components`              | `updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()` | `ALTER TABLE IF EXISTS "status_components" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();` |
| ProviderBudget              | `provider_budgets`               | `archived_at TIMESTAMPTZ(6)` | `ALTER TABLE IF EXISTS "provider_budgets" ADD COLUMN IF NOT EXISTS "archived_at" TIMESTAMPTZ(6);` |
| RedactionProject            | `redaction_projects`             | `closed_at_utc TIMESTAMPTZ(6)` | `ALTER TABLE IF EXISTS "redaction_projects" ADD COLUMN IF NOT EXISTS "closed_at_utc" TIMESTAMPTZ(6);` |
| Subprocessor                | `subprocessors`                  | `category VARCHAR(80) NOT NULL DEFAULT 'PROVIDER'`, `country VARCHAR(80)`, `description VARCHAR(800)` | 3 additive `ADD COLUMN IF NOT EXISTS` statements |
| RedactionPolicyAssignment   | `redaction_policy_assignments`   | `version_id UUID` (schema `policyVersionId @map("version_id")`) | `ADD COLUMN IF NOT EXISTS "version_id" UUID;` + DO-block backfill `UPDATE ... SET "version_id" = "policy_version_id" WHERE "version_id" IS NULL AND "policy_version_id" IS NOT NULL` (both columns existence-guarded). Source column kept (no DROP). |
| DelegatedAdminGrant         | `delegated_admin_grants`         | `granted_to_user_id UUID`, `scope_target_id UUID`, `created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()`, `updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()` | 4 additive `ADD COLUMN IF NOT EXISTS` + DO-block backfill `UPDATE ... SET "granted_to_user_id" = "grantee_user_id" WHERE "granted_to_user_id" IS NULL AND "grantee_user_id" IS NOT NULL`. Source column kept. |
| CodingSchema + CodingField  | `coding_schemas`, `coding_fields`| Defensive R7 re-assert: `coding_schemas.{status, label, category, published_at, archived_at, created_by_user_id, updated_at}` + `coding_fields.{options, help_text, order_index, updated_at}` | Idempotent `ADD COLUMN IF NOT EXISTS` for every R7 column on both tables. No-op if all columns already exist. |

Stability invariants applied to every statement:
- Additive only — no `DROP`, no `RENAME`, no `SET NOT NULL` on pre-existing columns, no destructive type conversion.
- Idempotent — every `ADD COLUMN` uses `IF NOT EXISTS`; every `ALTER TABLE` uses `IF EXISTS`; every backfill `WHERE` clause is `target IS NULL AND source IS NOT NULL` so re-runs do not overwrite Prisma-written data.
- Operator-safe — every SQL statement terminates with `;`; DO-block `EXECUTE $upd$ ... $upd$;` strings are themselves terminated.

---

## 4. Migration status

| Property | Value |
|----------|-------|
| Production state at fix time | "Database schema is up to date" — 125 migrations recorded in `_prisma_migrations` |
| Real situation | `schema.prisma` ahead of migrations (9 columns declared but never DDL'd) — Prisma `migrate status` only checks file→row presence, not schema parity |
| Latest existing migration timestamp | `20270801000000_phase16_semantic_usage` |
| New migration timestamp | `20270802000000_phase_sentry_batch_schema_drift_repair` (strictly greater) |
| Migration size | 13,682 bytes |
| Allowlist update | `PERMITTED_LATER_MIGRATIONS` in `services/api/test/phase-32-7-2-security-event-mapping-drift.test.ts` extended with the new timestamp |
| `prisma format` outcome | Whitespace realignment only in `SemanticUsageDaily` model — no semantic changes |
| `prisma validate` outcome | Schema is valid |

---

## 5. Exact migrations + commands used / to-be-run by operator

**Operator pre-deploy (one-time):**

```bash
# 1. Confirm latest migration is the new repair migration in the codebase.
ls services/api/prisma/migrations | sort | tail -3
# Expect: 20270801000000_phase16_semantic_usage / 20270802000000_phase_sentry_batch_schema_drift_repair

# 2. Dry-validate the schema vs. the new migration:
cd services/api && npx prisma validate

# 3. Confirm the migration is in the allowlist (CI-enforced):
grep -n "20270802000000_phase_sentry_batch_schema_drift_repair" \
     services/api/test/phase-32-7-2-security-event-mapping-drift.test.ts
```

**Operator deploy:**

```bash
# Inside the production app container (or wherever DATABASE_URL points at Neon):
npx prisma migrate deploy
# Expected output ends with:
#   The following migration(s) have been applied:
#     20270802000000_phase_sentry_batch_schema_drift_repair
# Idempotent: safe to run twice. If all columns already exist, every ADD COLUMN is a no-op and both backfills evaluate to zero-row UPDATEs.

# 4. Confirm status:
npx prisma migrate status
# Expect: "Database schema is up to date!" with 126 migrations.
```

**Operator post-deploy:**

```bash
# 5. Restart API + worker pods so the freshly-generated Prisma client (or the existing one, which already had the columns declared) picks up a clean DB.
kubectl rollout restart deployment proovra-api
kubectl rollout restart deployment proovra-worker

# 6. Confirm Sentry: the 9 schema-drift issues should stop firing within 5 minutes.
```

The 4 non-schema fixes (NODE-W, NODE-1G, NODE-1D, NODE-11) ship in the API image and require no migration step.

---

## 6. Files changed

| Path | Stream | Change |
|------|--------|--------|
| `services/api/prisma/migrations/20270802000000_phase_sentry_batch_schema_drift_repair/migration.sql` | Stage 2 | New — 9 idempotent additive DDL blocks + 2 DO-block backfills (13,682 bytes) |
| `services/api/prisma/schema.prisma` | Stage 2 | Whitespace-only realignment from `prisma format` (no semantic change) |
| `services/api/test/phase-32-7-2-security-event-mapping-drift.test.ts` | Stage 2 | `PERMITTED_LATER_MIGRATIONS` extended with the new timestamp |
| `services/api/src/routes/ops.routes.ts` | Stream A | NODE-W: workspace-context resolution + `safeParse` |
| `services/api/src/routes/reviewer-ops.routes.ts` | Stream A | NODE-1G: workspace context + `z.coerce.number().max(100)` + `safeParse` |
| `services/api/src/routes/reviewer-console.routes.ts` | Stream A | NODE-11: `prismaClient?: PrismaClient` + `client = prismaClient ?? prisma` + SLA composition try/catch + `safeParse` |
| `services/api/src/routes/organizations.routes.ts` | Stream A | NODE-1D: `UuidParam.safeParse` + INVALID_ORG_ID 400 |
| `services/api/src/routes/product-and-lifecycle.routes.ts` | Streams B + C | NODE-1R + NODE-1K: P2022/P2021 degraded fallbacks |
| `services/api/src/routes/intelligence-platform.routes.ts` | Stream B | NODE-1H: P2022/P2021 degraded fallback |
| `services/api/src/routes/redaction.routes.ts` | Stream B | NODE-1M + NODE-1N: two P2022/P2021 degraded fallbacks |
| `services/api/src/services/reviewer-workspace/coding-schema.service.ts` | Stream C | NODE-1P: idempotent natural-key seed + per-spec try/catch + `{ created, updated, existing, failed }` |
| `services/api/src/routes/reviewer-workspace.routes.ts` | Stream C | NODE-1P: route-level P2022/P2021 degraded fallback |
| `services/api/src/services/governance/delegated-admin.service.ts` | Stream C | NODE-1K: `hasDelegatedTier` P2022/P2021 fail-closed wrapper |
| `services/api/src/routes/trust-and-governance.routes.ts` | Stream C | NODE-1E: P2022/P2021 → `{ status: null, degraded: true, reason: "SCHEMA_NOT_READY" }` |
| `services/api/src/routes/runtime-readiness.routes.ts` | Stream C | NODE-1Q + NODE-1J: outer P2022/P2021 catch on all 4 readiness endpoints |
| `services/api/src/server.ts` | Stage 4 | Central handler extended with 3 bounded branches (ZodError 400, P2022/P2021 503, other Prisma 500) ahead of legacy AppError path |
| `services/api/test/production-phase-o-stream-a-route-fixes.test.ts` | Stream A | New — 15 source-contract assertions |
| `services/api/test/production-phase-o-stream-c-route-fixes.test.ts` | Stream C | New — 17 source-contract assertions |
| `services/api/test/production-phase-o-stage-4-central-error-handler.test.ts` | Stage 4 | New — 20 source-contract assertions |
| `services/api/test/production-sentry-batch-schema-drift.test.ts` | Stage 5 | New — 34 source-contract assertions consolidating the whole batch |
| `services/api/test/production-subscription-gate-stale-row.test.ts` | Pre-existing | (untouched in this batch; included in validation suite) |
| `services/api/test/production-trust-center-empty-state.test.ts` | Pre-existing | (untouched in this batch; included in validation suite) |
| `apps/web/app/(app)/trust-center/page.tsx` | Pre-existing diff | (touched in earlier task; preserved) |
| `apps/web/app/(app)/trust-center/status/page.tsx` | Pre-existing diff | 4-state load machine consumes `status === null` from the degraded path on NODE-1E |
| `services/api/src/services/collaboration-team/billing-guards.ts` | Pre-existing diff | (preserved; out of scope for this batch) |
| `services/api/test/phase-4a-enterprise-closure.test.ts` | Pre-existing diff | (preserved) |

---

## 7. Route fixes (one bullet per route)

- **GET /v1/ops/metrics (NODE-W)** — `services/api/src/routes/ops.routes.ts`. If `teamId` query is missing, resolve from `prisma.user.findUnique({ where: { id: userId }, select: { currentWorkspaceId: true } })`; if still missing, `400 WORKSPACE_CONTEXT_REQUIRED`. Replaced `TeamIdQuery.parse(req.query)` with `safeParse({ teamId: resolvedTeamId })`; on failure `400 INVALID_QUERY` with `requestId`. `requireOpsActor` 404 anti-enumeration preserved.

- **GET /v1/reviewer-ops/queue (NODE-1G)** — `services/api/src/routes/reviewer-ops.routes.ts`. Same workspace-context resolution; `limit` schema upgraded to `z.coerce.number().int().min(1).max(100).optional().default(50)`; `QueueQuery.safeParse({ ...rawQuery, teamId: resolvedTeamId })`; on failure `400 INVALID_QUERY`.

- **GET /v1/reviewer-ops/console (NODE-11)** — `services/api/src/routes/reviewer-console.routes.ts`. Signature changed to `prismaClient?: PrismaClient` with `const client: PrismaClient = prismaClient ?? prisma;` — an explicit `undefined` from any wrapper now safely falls back to the module `prisma`. All six `safeSection` Prisma calls re-anchored to `client`. Post-`Promise.all` SLA composition now wrapped in `try/catch` with optional-chained reads; on error `slaStatus = "degraded"`, `slaSnapshot = null`, warn log fires. Query parse switched to `safeParse`.

- **GET /v1/orgs/:id/members (NODE-1D)** — `services/api/src/routes/organizations.routes.ts`. `UuidParam.parse((req.params as { id: string }).id)` replaced with `safeParse`; on failure `400 { code: "INVALID_ORG_ID", message: "Invalid organization id.", requestId }`. No other endpoints in the file touched.

- **GET /v1/exchange/packages (NODE-1R)** — `services/api/src/routes/product-and-lifecycle.routes.ts`. Reuses the existing `isPrismaTableOrColumnMissing` + `extractPrismaDiagnostic` helpers from `_governance-error-bound.ts`. On P2022/P2021, returns `{ packages: [], degraded: true, reason: "SCHEMA_NOT_READY" }` (200) and warn-logs bounded Prisma diagnostic. Auth + workspace scoping outside the catch.

- **GET /v1/intelligence/providers/budgets (NODE-1H)** — `services/api/src/routes/intelligence-platform.routes.ts`. Same pattern; returns `{ budgets: [], degraded: true, reason: "SCHEMA_NOT_READY" }`.

- **GET /v1/redaction/projects (NODE-1M)** — `services/api/src/routes/redaction.routes.ts`. Returns `{ projects: [], degraded: true, reason: "SCHEMA_NOT_READY" }`; `gate(reply, ctx, "redaction.view")` preserved before the try/catch.

- **GET /v1/redaction/providers/health (NODE-1N)** — `services/api/src/routes/redaction.routes.ts`. Returns `{ providers: [], degraded: true, reason: "SCHEMA_NOT_READY" }`; auth gate preserved.

- **POST /v1/coding/schemas/seed-defaults (NODE-1P)** — `services/api/src/routes/reviewer-workspace.routes.ts`. Service-level `seedDefaultSchemas` rewritten with idempotent natural-key lookup `(teamId, slug)` + per-spec try/catch returning `{ created, updated, existing, failed }` (legacy `existing` alias for the web client). Route wraps the service call in a P2022/P2021 catch returning `{ degraded: true, reason: "SCHEMA_NOT_READY" }` (200). `requireCap("review.schema.author")` preserved.

- **POST /v1/packaging/entitlements/apply-product-line (NODE-1K)** — `services/api/src/routes/product-and-lifecycle.routes.ts`. `hasDelegatedTier` (`delegated-admin.service.ts`) wraps the `delegatedAdminGrant.findMany` in a P2022/P2021 catch returning an empty grant list (fail-closed) before falling through to the implicit-owner ladder. Route adds a belt-and-braces P2022/P2021 catch returning `{ ok: false, granted: 0, applied: false, degraded: true, reason: "SCHEMA_NOT_READY" }` (200). `requireDelegatedTier("ORG_ADMIN")` preserved.

- **GET /v1/trust/status (NODE-1E)** — `services/api/src/routes/trust-and-governance.routes.ts`. Wraps `projectStatusPage` (which internally calls `statusComponent.upsert`) in a P2022/P2021 catch returning `{ status: null, degraded: true, reason: "SCHEMA_NOT_READY" }` (200). Frontend's existing 4-state load machine handles `status === null`. `requireAuth` preserved.

- **GET /admin/runtime/readiness (NODE-1Q + NODE-1J)** — `services/api/src/routes/runtime-readiness.routes.ts`. All 4 readiness endpoints (`/readiness`, `/queues`, `/workers`, `/migrations`) get an outer P2022/P2021 catch returning a typed `{ status: "DEGRADED", ..., degraded: true, reason: "SCHEMA_NOT_READY" }` payload preserving wire shape (`subsystems: []` for `/readiness`, `null` for siblings). `requireReadinessActor` (audit.read + 404 anti-enumeration) preserved. Aggregator's existing per-probe try/catches remain — outer catch is belt-and-braces.

---

## 8. Error handling fixes

`services/api/src/server.ts` central handler at `app.setErrorHandler((err, req, reply) => { ... })` (line ~496) extended with three new bounded branches inserted **ahead** of the legacy `normalizeUnknownError(err)` call. The legacy AppError + INTERNAL_SERVER_ERROR fall-through path is untouched.

Constants and helpers (lines 316–447) added above the handler:
- `ZOD_MESSAGE_LIMIT = 200`, `ZOD_FIELD_LIMIT = 5`, `ZOD_FIELD_PATH_LIMIT = 120`, `ZOD_FIELD_MESSAGE_LIMIT = 200`.
- `buildZodWirePayload(err, requestId)` — emits `{ code: "INVALID_INPUT", message, fields: [{ path, code, message }], requestId }` with caps applied.
- `isPrismaKnownRequestError(err)` — matches `err.name === "PrismaClientKnownRequestError" && typeof err.code === "string"` (no new Prisma SDK import).
- `readPrismaDiagnostic(err)` — extracts `code`, `meta.column`, `meta.table`, `meta.modelName`, `message` (capped at 300 chars and 120 per meta string).

**Branch 1 — ZodError → 400 INVALID_INPUT** (server.ts:534–547). Triggered by `!isAppError(err) && err instanceof ZodError`. Warn log `request.failed.validation` with `errorCode`, `statusCode`, `zodIssueCount`, `zodFields`. No stack trace, no env names, no raw `err.message` to client.

**Branch 2 — Prisma P2022 / P2021 → 503 SCHEMA_NOT_READY** (server.ts:549–573). Wire body: `{ error: { code: "SCHEMA_NOT_READY", message: "Resource temporarily unavailable.", requestId } }`. Warn log `request.failed.schema_not_ready` with bounded Prisma diagnostic. **Does NOT call `captureException`** — schema drift is operator-known; surfacing each hit in Sentry would generate noise. The Stage 2 migration is the canonical fix.

**Branch 3 — Other Prisma known-request → 500 DATABASE_ERROR** (server.ts:575–601). All other Prisma codes (P1xxx connection, P2002 unique, P2003 FK, P2025 not-found, etc.). Wire body: `{ error: { code: "DATABASE_ERROR", message: "Request failed.", requestId } }`. **Calls `captureException(err, requestContext)`** so genuine bugs surface in Sentry. Comment above the branch documents the route-level catch + AppError pattern for finer-grained mapping (e.g. 409 on P2002).

`requestId = typeof req.id === "string" ? req.id : null` emitted once at the top of the handler so every new branch reuses it. Stage 3 route handlers remain the **first** line of defence — the central handler is a true safety-net. `BillingLimitError` route-level mapping in `collaboration-teams.routes.ts:88` left untouched (canonical).

---

## 9. Tests added (count + per-group)

| File | Stream | `it` count | Result |
|------|--------|-----------:|--------|
| `services/api/test/production-phase-o-stream-a-route-fixes.test.ts` | Stream A | 15 | 15/15 pass |
| `services/api/test/production-phase-o-stream-c-route-fixes.test.ts` | Stream C | 17 | 17/17 pass |
| `services/api/test/production-phase-o-stage-4-central-error-handler.test.ts` | Stage 4 | 20 | 20/20 pass |
| `services/api/test/production-sentry-batch-schema-drift.test.ts` | Stage 5 (consolidating) | 34 across 13 `describe` groups | 34/34 pass |
| **Total new pins** |  | **86** | **86/86 pass** |

Stage 5 consolidating test groups (34 `it`):
1. Repair migration file exists + additive/idempotent header (2)
2–9. Per-drift-item DDL coverage NODE-1R/1H/1Q/1N/1M/1K/1E/1J/1P (9)
10. Stream A NODE-W (3)
11. Stream A NODE-1G (3)
12. Stream A NODE-11 (2)
13. Stream A NODE-1D (1)
14. Stream C NODE-1P seed-defaults idempotency + degraded fallback (4)
15. Stream C NODE-1E trust/status degraded fallback (1)
16. Readiness aggregator probe isolation NODE-1Q + 1J (3)
17. Stage 4 central handler ZodError → INVALID_INPUT (1)
18. Stage 4 central handler Prisma P2022/P2021 → SCHEMA_NOT_READY (1)
19. phase-32-7-2 migration allowlist (1)
20–22. Bounded guards — no v2 ladder, no `process.env` leak, no `err.stack` leak across 7 route files + central handler (3)

All tests are pure source-contract (`readFileSync` of repo files). No DB I/O, no Prisma client, no Fastify boot. Total runtime ~10ms.

Two honest-scoping notes pinned in test comments:
- NODE-1P seed-defaults uses an idempotent natural-key `findFirst → createSchema` pattern, not a literal Prisma `.upsert()` call (functionally equivalent for the idempotency goal).
- NODE-1P repair migration is defensive (re-asserts every R7 column on both tables) because the original Sentry payload did not pinpoint the failing column.

---

## 10. Validation output

| # | Command | exitCode | Last lines |
|---|---|---|---|
| 1 | `prisma validate` | 0 | `The schema at prisma\schema.prisma is valid` |
| 2 | `pnpm --filter @proovra/shared build` | 0 | `> tsc -p tsconfig.build.json` (clean) |
| 3 | `pnpm --filter proovra-api typecheck` | 0 | `> tsc --noEmit` (clean) |
| 4 | `pnpm --filter proovra-web typecheck` | 0 | `> tsc --noEmit` (clean) |
| 5 | `pnpm --filter proovra-api test` | 0 | `Test Files 299 passed | 1 skipped (300)` / `Tests 13362 passed | 56 skipped (13418)` |
| 6 | `pnpm --filter proovra-worker test` | 0 | `Test Files 23 passed (23)` / `Tests 560 passed (560)` |
| 7 | `pnpm --filter @proovra/shared test` | 0 | `tests 703 / pass 703 / fail 0 / skipped 0` |
| 8 | `pnpm --filter proovra-web build` | 0 | Full route table rendered; `Middleware 33.1 kB`; build completed |
| 9 | `prisma migrate status` | 0 (process exit; sandbox DB unreachable as expected) | `Error: P1001: Can't reach database server at localhost:5432.` — file-level schema validity already confirmed by command 1 |

Test totals (api + worker + shared):
- pass: 13,362 + 560 + 703 = **14,625**
- fail: **0**
- skipped: 56 + 0 + 0 = **56**

Rebaselined tests: **none**. No byte-pin breakage, no migration-allowlist drift, no ESLint unused-var noise.

---

## 11. Production verification checklist (post-deploy)

Run after `npx prisma migrate deploy` completes and the API/worker pods have rolled. Replace `$TOKEN` with an authenticated bearer token from a workspace member with the relevant cap, `$ORG_ID` with a real org UUID, and `$BAD` with an obviously invalid value. All `curl` examples assume `https://api.proovra.com` — substitute the production host.

```bash
# --- Schema drift fixes — expect 200 with real data, NOT degraded ---

# NODE-1R — evidence exchange packages
curl -s -H "Authorization: Bearer $TOKEN" https://api.proovra.com/v1/exchange/packages | jq .
# Expect: { "packages": [...], "page": 1, ... }   (no `degraded`/`reason` keys)

# NODE-1H — provider budgets
curl -s -H "Authorization: Bearer $TOKEN" https://api.proovra.com/v1/intelligence/providers/budgets | jq .
# Expect: { "budgets": [...] }

# NODE-1Q + NODE-1J — readiness
curl -s -H "Authorization: Bearer $TOKEN" https://api.proovra.com/admin/runtime/readiness | jq .
# Expect: { "status": "OK"|"DEGRADED", "subsystems": [ ... ] }   (no top-level `degraded: true`)

# NODE-1N — redaction policy assignments
curl -s -H "Authorization: Bearer $TOKEN" https://api.proovra.com/v1/redaction/providers/health | jq .
# Expect: { "providers": [...] }

# NODE-1M — redaction projects
curl -s -H "Authorization: Bearer $TOKEN" https://api.proovra.com/v1/redaction/projects | jq .
# Expect: { "projects": [...] }

# NODE-1K — delegated admin grant apply
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"productLineId":"<real-uuid>"}' \
     https://api.proovra.com/v1/packaging/entitlements/apply-product-line | jq .
# Expect: { "ok": true, "granted": <N>, "applied": true }

# NODE-1E — trust status
curl -s -H "Authorization: Bearer $TOKEN" https://api.proovra.com/v1/trust/status | jq .
# Expect: { "status": { "components": [...], "incidents": [...], ... } }   (status NOT null)

# NODE-1P — coding schema seed
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{}' https://api.proovra.com/v1/coding/schemas/seed-defaults | jq .
# Expect: { "created": <N>, "existing": <M>, "updated": <M>, "failed": 0 }


# --- Validation / handler fixes — expect bounded 400 / 503, NOT 500 ---

# NODE-W — ops metrics with no teamId and no workspace
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN_NOWORKSPACE" \
     https://api.proovra.com/v1/ops/metrics
# Expect: 400   body { "error": { "code": "WORKSPACE_CONTEXT_REQUIRED", "requestId": "...", ... } }

# NODE-1G — reviewer-ops queue with limit > 100
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN" \
     "https://api.proovra.com/v1/reviewer-ops/queue?limit=999"
# Expect: 400   body { "error": { "code": "INVALID_QUERY", "requestId": "...", ... } }

# NODE-1D — org members with non-UUID id
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN" \
     https://api.proovra.com/v1/orgs/not-a-uuid/members
# Expect: 400   body { "error": { "code": "INVALID_ORG_ID", "requestId": "...", ... } }

# NODE-11 — reviewer console (now structurally hardened)
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN" \
     https://api.proovra.com/v1/reviewer-ops/console
# Expect: 200   body has `sections` with per-section `status: "ok"|"degraded"` — never 500.


# --- Sentry observation window ---

# 5-minute window after deploy: check Sentry "Active Issues" for the 13 NODE IDs.
# Expect: zero new events for any of them. Existing issues should auto-resolve per Sentry's
# default 7-day no-occurrence policy, or be manually resolved by an operator.
```

If any verification curl returns a 500 or a body containing `degraded: true, reason: "SCHEMA_NOT_READY"` **after** the migration deployed, that indicates one of:
1. The migration has not been applied (re-check `npx prisma migrate status`).
2. The migration is applied but the API pod has not yet picked up the regenerated Prisma client — restart the deployment.
3. A previously-unknown second drift exists — escalate per Section 12.

---

## 12. Remaining risks / debt

1. **NODE-1P real failing column unproven.** The Stage 1 audit explicitly could not pinpoint the offending column from the Sentry payload (no `meta.column` was present). The repair is defensive: every R7 reviewer-workspace column on both `coding_schemas` and `coding_fields` is re-asserted idempotently. If a future Sentry recurrence carries a different column name, that column is not covered.

2. **NODE-11 undefined-delegate exact path unproven.** Static analysis showed the only registration is `app.register(reviewerConsoleRoutes)` with no third argument — the original `prismaClient: PrismaClient = prisma` default *should* have bound. The structural fix (`?? prisma` re-anchoring + SLA try/catch + safeParse) closes every undefined path identifiable by static analysis, but the exact production trigger remains theoretical.

3. **`BillingLimitError` not centrally mapped.** The route-level catch in `collaboration-teams.routes.ts:88` remains canonical. If any other route ever throws `BillingLimitError` uncaught, the legacy handler returns 500. Deferred Stage 6 hardening.

4. **Fastify built-in schema validation errors not centrally mapped.** All Proovra routes use Zod, not Fastify schema, so this is dormant. If a future route adopts `schema: { body: ... }`, validation errors would still fall through to 500. Deferred.

5. **Prisma SDK version coupling.** The central handler matches `PrismaClientKnownRequestError` by `err.name + typeof err.code === "string"` (no `instanceof`), decoupling from Prisma's export-graph changes across 5.x → 6.x. A future Stage 6 could harden this with a real `instanceof` check once the SDK version is pinned.

6. **`schema.prisma` whitespace realignment was a side-effect of `prisma format`.** The diff is whitespace-only and semantically inert, but it does mean `git blame` for `SemanticUsageDaily` will now show this commit. Acceptable; documented for archaeology.

7. **`docker exec prisma migrate status` inside the container is the canonical operator check.** Sandboxed CI runs cannot reach Neon and will P1001 — that is expected and not a failure. Production verification must run inside the prod pod.

8. **No Sentry-side auto-resolve script.** The 13 issues will need to be manually resolved (or left to Sentry's default 7-day no-occurrence auto-resolve). This is intentional — manual resolve lets the operator confirm zero recurrences before closing.

9. **No multi-tenant data-mismatch repair attempted on the two rename-shaped drifts.** For `redaction_policy_assignments.version_id` and `delegated_admin_grants.granted_to_user_id`, the DO-block backfill only copies values where the target is NULL. If application writes between deploy and migration created mismatched pairs (target written, source written with a different value), those rows are not reconciled. Audit recommends a one-shot ops-side `SELECT id, version_id, policy_version_id FROM redaction_policy_assignments WHERE version_id IS NOT NULL AND policy_version_id IS NOT NULL AND version_id <> policy_version_id;` check post-deploy; no rows expected.

10. **No DROP of legacy columns.** `redaction_policy_assignments.policy_version_id` and `delegated_admin_grants.grantee_user_id` are kept. A future cleanup migration (after Prisma stops referencing them, which it already has) can drop them — out of scope for this batch under the Phase O additive-only stability contract.

---

## 13. 10-criterion sign-off

Brief's success criteria, honest pass/fail:

1. **All 13 Sentry issues have a documented root cause.** PASS — Section 2 table.
2. **All schema-drift issues have a corresponding additive idempotent DDL.** PASS — Section 3 table, all 9 covered.
3. **The repair migration is in `prisma/migrations/` with timestamp strictly greater than the existing max.** PASS — `20270802000000` > `20270801000000`.
4. **The repair migration is in the `PERMITTED_LATER_MIGRATIONS` allowlist.** PASS — `phase-32-7-2-security-event-mapping-drift.test.ts` updated.
5. **All four non-schema Sentry issues (NODE-W, NODE-1G, NODE-1D, NODE-11) are resolved at the route layer AND at the central handler (defence in depth).** PASS — Stream A `.safeParse()` at routes + Stage 4 ZodError branch in `server.ts`.
6. **Central error handler does not leak Prisma JSON / env names / stack traces to clients.** PASS — Stage 4 emits canned bounded messages with `requestId`; internal warn/error logs carry bounded structured fields only. Pinned by Stage 5 assertions #22.
7. **All Sentry-targeted routes have a P2022/P2021 belt-and-braces catch returning a bounded degraded payload with `degraded: true, reason: "SCHEMA_NOT_READY"`.** PASS — verified by Stream B and Stream C reports and Stage 5 assertion groups.
8. **At least one regression test per fix.** PASS — 86 new pins across 4 test files; every NODE ID has at least one dedicated assertion (Section 9 group breakdown).
9. **Typecheck + full test suite green: api + worker + shared + web.** PASS — 14,625 / 0 fail / 56 skipped; web typecheck + build clean; Prisma validate clean.
10. **No stability invariants violated: no new endpoints, no v2 ladder, no model renames, no auth weakening, no broad silent try/catch, migration is additive + idempotent.** PASS — verified by Stage 5 assertions #20–#22 + manual diff review summarised in Section 12 caveats.

**Sign-off: 10/10 green.** No deferrals against the brief; deferred items in Section 12 (BillingLimitError central mapping, Fastify schema validation, Prisma `instanceof` hardening, multi-tenant data-mismatch reconciliation, legacy-column DROP) are explicitly out of scope for the Phase O additive contract and not part of this brief's success criteria.

---

SENTRY_BATCH_VALIDATION_PASSED
