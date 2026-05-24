# PHASE CR1 — Legacy & Duplicate System Purge — Final Report

**Status:** Complete.
**Scope:** Surgical stabilization. No features added. No UI redesigned.
No refactor of capture / verify / report / package / finalize / custody /
TSA / OTS / permissions / tenant isolation.

CR1 reduced the platform to **one canonical operational path** by
removing legacy systems, duplicate systems, dead registrations, ghost
orchestration paths, orphan services, fake runtime layers, and one
production-risk registration. The platform is now smaller, safer, and
clearer — but functionally and visually identical for an end user.

The execution order matches `docs/recovery/CR0_5_RECOVERY_READINESS.md`
§7 (CR1 Legacy Purge Execution Plan).

---

## 1. Deletions executed

### 1.1 Phase A — legacy `audit.routes.ts`

| Item                                           | Action                                                                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `services/api/src/routes/audit.routes.ts` (19 LoC, intentionally-empty no-op shim) | **Deleted.**                                                                                                                          |
| Importers                                      | None. CR0.5 already confirmed zero registrations. Verified again at CR1 start.                                                        |
| Frontend `/v1/audit/*` consumers               | None (`grep -R "/v1/audit/" apps/web/` → no matches).                                                                                  |
| Canonical replacement                          | `routes/admin-audit.routes.ts` (already in production, hash-chained reads via `lib/admin-audit-chain.ts`).                            |
| Risk                                           | LOW.                                                                                                                                  |

### 1.2 Phase B — legacy `webhook.routes.ts`

| Item                                                  | Action                                                                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `services/api/src/routes/webhook.routes.ts` (657 LoC) | **Deleted.**                                                                                                                          |
| `server.ts:39` import `import { webhookRoutes } from …` | **Removed** (replaced with explanatory comment).                                                                                      |
| `server.ts:511` `await app.register(webhookRoutes)`   | **Removed** (replaced with explanatory comment).                                                                                      |
| Frontend consumers                                    | None (CR0.5 grep was zero; verified again).                                                                                            |
| Canonical replacement                                 | `routes/integrations.routes.ts` + `services/integrations/webhooks.service.ts` + `services/integrations/webhook-dispatcher.ts` (UI uses this path). |
| Risk                                                  | MEDIUM (was production-registered, but FE-orphan) → mitigated by zero-FE-consumer verification.                                        |

### 1.3 Phase D — `auditMiddleware` hook + `audit.service.ts` tombstone

| Item                                                       | Action                                                                                                                                |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `server.ts:14` `import { auditMiddleware }`                | **Removed.**                                                                                                                          |
| `server.ts:344` `app.addHook("onRequest", auditMiddleware)` | **Removed** (replaced with explanatory comment).                                                                                      |
| `middleware/audit.middleware.ts` (164 LoC)                 | **Deleted.**                                                                                                                          |
| `services/audit.service.ts` (~360 LoC in-memory tombstone) | **Deleted.**                                                                                                                          |
| Canonical replacement                                      | Per-route `appendPlatformAuditLog()` calls into `services/platform-audit-log.service.ts` (DB-backed, hash-chained — already wired).    |
| Risk                                                       | HIGH risk REMOVED. The hook was running on every state-mutating request in production and writing to in-memory state lost on restart. |

This is the single highest-impact CR1 change for safety: the platform
no longer pretends to write audit events to a tombstone on every
mutation. Canonical audit chain is unchanged and unaffected (per-route
writers were always the real path).

### 1.4 Phase E — legacy `webhook.service.ts` orphan

| Item                                                          | Action                                                                                                                                |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `enterprise.routes.ts:14` `import { getWebhookService }`      | **Removed.**                                                                                                                          |
| `enterprise.routes.ts:833-841` dead try/catch (`const webhookService = getWebhookService(); … void webhookService;`) | **Removed** (replaced with explanatory comment).                                                                                      |
| `services/webhook.service.ts` (in-memory `Map`-backed orphan) | **Deleted** (zero remaining importers after the dead block was excised).                                                              |
| Canonical replacement                                         | `services/integrations/webhooks.service.ts` + `webhook-dispatcher.ts` (production-grade, DB-backed, signed delivery).                  |
| Risk                                                          | LOW (consumer was dead code; only registered usage was a `void` discard).                                                              |

### 1.5 Phase F — env-guard `opsSeedRoutes`

| Item                                              | Action                                                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `server.ts:476` `await app.register(opsSeedRoutes)` (unguarded) | **Wrapped** in `if (process.env.OPERATIONAL_SEEDING_ENABLED === "true")`.                                                              |
| Existing in-route hardening                       | Preserved — handlers continue to require `requireAuth` + `governance.policy.manage` + shared seed-secret header.                       |
| Defense-in-depth gain                             | Production deployments do not even mount the surface unless explicitly opted in.                                                       |
| Risk                                              | LOW.                                                                                                                                  |

### 1.6 Part 2 — 8 backward-compat redirect pages → `next.config.js`

Migrated from per-page `next/navigation` `redirect()` JSX stubs to
canonical Next.js `redirects()` config (308 permanent, exact-match):

| Source                  | Destination                  |
| ----------------------- | ---------------------------- |
| `/dashboard`            | `/home`                      |
| `/archive`              | `/evidence?filter=archived`  |
| `/deleted`              | `/evidence?filter=deleted`   |
| `/locked`               | `/evidence?filter=locked`    |
| `/operations`           | `/ops`                       |
| `/review`               | `/reviewer-ops`              |
| `/reviewer-ops/policy`  | `/governance/policy`         |
| `/security`             | `/security-center`           |

- 8 page.tsx files **deleted** (14-15 LoC each, single-purpose).
- Subroutes preserved: `/dashboard/api-keys`, `/dashboard/quotas`,
  `/dashboard/insights`, `/dashboard/batch-analysis`,
  `/operations/reliability`, `/review/operations`,
  `/reviewer-ops/{escalations,sla,[reviewId]}` continue to resolve to
  their own pages (Next.js `redirects()` is exact-match only).
- `DOCUMENTED_EXEMPTIONS` in `phase-cr0-system-freeze-baseline.test.ts`
  updated to drop the 8 entries.

### 1.7 Schema comment refresh

`prisma/schema.prisma` had two stale comments stating that the legacy
TypeScript files `audit.service.ts` and `webhook.service.ts` "remain
unchanged" alongside the deleted Prisma enums. Comments updated to note
that CR1 Phase D + Phase E deleted those TypeScript files too.

No schema enum was migrated in CR1. Per the CR1 spec, Part 4 (schema
enum cleanup) is "flag-only" inside this phase; live enum deprecation
belongs to a dedicated migration phase.

---

## 2. Explicit deferrals — CR1 looked at these and chose NOT to touch them

### 2.1 `identity/page.tsx` (Phase 17 legacy identity console)

- **613 LoC** of real operational UI (members, capability grants,
  service accounts, access review queue, org security policy).
- Has live API calls (`/v1/identity/members`, `/v1/identity/service-accounts`,
  `/v1/identity/access-reviews`, `/v1/identity/policy`).
- Folding into `/admin/identity` OR gating behind PageRouteGate is a
  **UX-level decision** that CR1's surgical-stabilization charter
  explicitly excludes.
- Action: `revisitPhase` in `DOCUMENTED_EXEMPTIONS` bumped from `CR1`
  to **`CR2`**.

### 2.2 `review/operations/page.tsx` (Phase 13 legacy review-ops queue)

- **634 LoC** of real operational UI (stage filter, bulk actions, SLA
  badges, claim flow).
- Has live API calls (`/v1/review-operations/queue`,
  `/v1/review-operations/queue-counts`, `/v1/review-operations/bulk`,
  `/v1/review-operations/evidence/:id/claim`).
- Same situation as identity — UX folding decision, not a deletion.
- Action: `revisitPhase` bumped to **`CR2`**.

### 2.3 `services/api-keys.service.ts` (in-memory orphan with live consumer)

- In-memory `Map<>` API-key store; comment in source literally says
  "Store in memory (production would use database)".
- BUT it has a live consumer chain:
  `services/api-keys.service.ts` →
  `routes/enterprise.routes.ts` (`apiKeyService.{create,list,revoke,rotate,updateRateLimit}Key`) →
  frontend `dashboard/api-keys/page.tsx` + `dashboard/batch-analysis/page.tsx`
  (both PageRouteGate-wrapped in Phase 38.14).
- Deleting this file requires either (a) migrating
  `enterprise.routes.ts` to a canonical service or (b) deleting the
  consumer pages. Both are UX-touching changes CR1 forbids.
- Action: **deferred to R8** (enterprise security activation) or **R9**
  (enterprise operations activation). A CR1 guardrail test pins the
  current state so the file cannot be silently deleted without first
  migrating the consumer (which would 500 the page).

### 2.4 Schema enum migrations

- CR1 only refreshed stale comments in `schema.prisma`.
- No enum drop. No model drop. No column drop.
- Per CR1 spec Part 4, schema migrations belong to a dedicated phase.

### 2.5 Phase C — `enterprise.routes.ts` keystone

- 1156 LoC across 14 endpoints (api-keys, batch-analysis, quotas).
- The CR1 inspection (Phase C) decided: REMOVE the dead `getWebhookService`
  import (done in Phase E), KEEP the rest because it has live FE
  consumers. No structural refactor.

---

## 3. Guardrails added (`phase-cr1-legacy-purge.test.ts`)

23 source-contract assertions across 7 parts:

1. **Phase A pins** — audit.routes.ts gone; no `auditRoutes` symbol in
   server.ts.
2. **Phase B pins** — webhook.routes.ts gone; no `webhookRoutes` symbol
   or `webhook.routes.js` import in server.ts.
3. **Phase D pins** — audit.middleware.ts gone; audit.service.ts gone;
   no `auditMiddleware` symbol in server.ts; canonical
   `platform-audit-log.service.ts` still present.
4. **Phase E pins** — webhook.service.ts gone; no `getWebhookService`
   symbol in enterprise.routes.ts; canonical integrations webhook
   subsystem still present.
5. **Phase F pins** — `opsSeedRoutes` registration is inside an
   `if (process.env.OPERATIONAL_SEEDING_ENABLED === "true")` block; no
   unguarded top-level registration exists.
6. **Part 2 pins** — 8 redirect pages deleted; `next.config.js`
   declares an `async redirects()` block with all 8 canonical
   source→destination pairs; surviving subroutes still present.
7. **Deferral pins** — `identity/page.tsx`, `review/operations/page.tsx`,
   `services/api-keys.service.ts`, and the enterprise.routes
   `apiKeyService` consumer are all still present (so no one quietly
   deleted them without doing the prerequisite UX/migration work).

The CR0 and CR0.5 guardrail tests were updated in lockstep to flip
their "still here as debt" assertions to "must NOT be here" assertions
for the symbols CR1 removed.

---

## 4. Files touched

### Deleted (13)

```
services/api/src/routes/audit.routes.ts
services/api/src/routes/webhook.routes.ts
services/api/src/middleware/audit.middleware.ts
services/api/src/services/audit.service.ts
services/api/src/services/webhook.service.ts
apps/web/app/(app)/dashboard/page.tsx
apps/web/app/(app)/archive/page.tsx
apps/web/app/(app)/deleted/page.tsx
apps/web/app/(app)/locked/page.tsx
apps/web/app/(app)/operations/page.tsx
apps/web/app/(app)/review/page.tsx
apps/web/app/(app)/reviewer-ops/policy/page.tsx
apps/web/app/(app)/security/page.tsx
```

### Modified (7)

```
services/api/src/server.ts                                       (removed 2 imports + 2 registrations + 1 hook; added 1 env-guard)
services/api/src/routes/enterprise.routes.ts                     (removed dead getWebhookService import + dead try-block)
services/api/prisma/schema.prisma                                (refreshed 2 stale comments)
apps/web/next.config.js                                          (added redirects() with 8 entries)
services/api/test/phase-cr0-system-freeze-baseline.test.ts       (pinned absences for webhookRoutes; removed 8 exemptions)
services/api/test/phase-cr0-5-recovery-readiness.test.ts         (pinned absences for webhookRoutes + auditMiddleware)
services/api/test/phase-tenant-isolation-scale.test.ts           (removed webhook.routes.ts allow-list entry)
```

### Created (2)

```
services/api/test/phase-cr1-legacy-purge.test.ts                 (new — CR1 guardrails)
docs/recovery/CR1_LEGACY_PURGE.md                                (this file)
```

---

## 5. What is unchanged (safety invariants preserved)

- Authentication / authorization — `requireAuth`, `authorizeOrFail`,
  `requireMember*` helpers untouched.
- Tenant isolation — every operational route still consumes the
  canonical authorize helper OR carries an approved
  `TENANT_SCOPE_EXCEPTION` (pinned by tenant-isolation-scale tests).
- Custody chain — `pg_advisory_xact_lock` + hash chain semantics
  unchanged; 128 custody call sites untouched.
- TSA + OTS Bitcoin anchoring — unchanged.
- Upload pipeline (capture → process → finalize → package) — unchanged.
- Permissions / RBAC / billing / governance — unchanged.
- Canonical audit log (`appendPlatformAuditLog`) — unchanged; per-route
  writers were always the real path. The legacy middleware that wrote
  to the tombstone has been removed without affecting any user-visible
  audit data.
- Canonical webhook subsystem (`services/integrations/`) — unchanged.
- Reviewer-ops + governance + reports + verify — unchanged.

---

## 6. Validation

**Target:** 6/6 validation gates green.

- `services/api` typecheck
- `services/api` test (all source-contract suites + the new
  `phase-cr1-legacy-purge.test.ts`)
- `apps/web` typecheck
- `apps/web` build (must succeed with the new `next.config.js` redirects)
- `services/worker` typecheck
- `services/worker` test

The new `next.config.js` `redirects()` is a build-time config — `next
build` validates that all 8 entries are well-formed and that no source
collides with an existing route.

---

## 7. Locked recovery roadmap position

CR1 is complete. The next phase per the locked roadmap is **CR1.5**
(remaining quick wins) or, if CR1.5 is skipped, **R1** (the two
single-line state-management fixes diagnosed in CR0.5: CommandCenter
`useTeamWorkspaceGate → useActiveSpaceId` and persona-save envelope
refresh).

The full locked phase order is in
`docs/recovery/CR0_5_RECOVERY_READINESS.md` §10.

---

## 8. Honest assessment

What CR1 accomplished:

- **Removed 13 dead files** (3 routes, 1 middleware, 2 services, 8
  redirect pages).
- **Removed 1 production-risk hook** (`auditMiddleware` writing to
  in-memory tombstone on every state mutation).
- **Env-guarded 1 production-risk registration** (`opsSeedRoutes`).
- **Made redirects framework-canonical** (next.config.js, exact-match
  308s).
- **Pinned 23 new source-contract invariants** so the deleted surfaces
  cannot quietly come back.

What CR1 did NOT accomplish — and refused to fake:

- Did NOT fold the two real legacy operator pages (identity,
  review/operations). They are real ~600-LoC consoles with live API
  calls; folding is a UX-level decision deferred to CR2.
- Did NOT migrate `services/api-keys.service.ts` off in-memory
  storage. Live consumer chain forbids this without a coordinated
  enterprise-security phase (R8).
- Did NOT touch schema enums beyond comment refresh.
- Did NOT redesign UI / sidebar / dashboard / capture / verify /
  finalize / custody / TSA / OTS / permissions / tenant isolation.

The platform after CR1 is **smaller, safer, and more canonical** — but
visually and functionally identical to the one before CR1. That is
exactly what the spec required.
