# Phase 2.7X Stage 1 — Additive Organization schema APPLIED

## Status: COMPLETE on local audit DB. Production DB not touched.

The Phase 2.5C/D/E/F migration safety stack remained engaged throughout;
host classification = LOCAL was reverified before any SQL was sent to
Postgres. Neon was not contacted.

---

## What was applied

A single additive migration was created and applied via the Phase 2.5C
safe wrapper:

```
prisma/migrations/20260926000000_p2_7x_stage1_org_model_additive/migration.sql
```

The migration introduces the Organization tenant boundary as
**additive-only**:

| Object | Kind | Notes |
|---|---|---|
| `OrganizationStatus` | enum | ACTIVE, SUSPENDED, ARCHIVED |
| `OrganizationRole` | enum | ORG_OWNER → ORG_ADMIN → ORG_SECURITY_ADMIN → ORG_BILLING_ADMIN → ORG_AUDITOR → ORG_MEMBER |
| `organizations` | table | 13 columns; `verification_state` reuses pre-existing `OrganizationVerificationState` |
| `organization_memberships` | table | unique(organization_id, user_id) + role index |
| `organization_invites` | table | unique token + email index |
| `organization_audit_events` | table | (organization_id, created_at DESC) index |
| `organization_policies` | table | unique(organization_id, key) |
| `teams.organization_id` | column | nullable UUID with `ON DELETE SET NULL` |
| 6 × foreign keys | constraints | CASCADE for org-owned children; SET NULL for `teams` |

**Zero destructive operations.** No table dropped, no column dropped, no
enum reshaped, no data mutated.

---

## How the safety chain held

```
operator runs:              pnpm --filter proovra-api prisma:migrate
↓
node scripts/safe-migrate.mjs deploy
↓
parses DATABASE_URL host → "localhost"
classifyHost("localhost") → "local"
shouldAllowMigration({classification:"local", ...}) → allow
prints banner with host/db/classification
↓
spawns pnpm exec prisma migrate deploy
↓
prisma.config.ts in-process hook (Phase 2.5D) verifies host again
↓
applies migrations/20260926000000_p2_7x_stage1_org_model_additive
↓
records in _prisma_migrations table
```

The Phase 2.5E `db:preflight` aggregator was run before AND after the
apply — both passes returned `0 fail / 1 warn / 2 pass` with the warning
attributable to historical baseline patterns (CREATE INDEX without
CONCURRENTLY, ADD FOREIGN KEY without NOT VALID) — none destructive.

---

## How the broken shadow-DB replay was handled

Initial attempt via `prisma migrate dev --name p2_7x_stage1_...`
attempted to validate the new migration against a freshly-built shadow
DB. Replay of historical migration
`20260726000000_r8_1_5_recovery_email_preflight` fails because it uses
a new enum value in the same transaction it is added — a known
PostgreSQL restriction ("New enum values must be committed before they
can be used").

This is **not** a regression introduced by Stage 1 — the broken
migration predates Phase 2.7. The actual proovra_audit DB never replays
that migration (it was applied incrementally during normal forward
progress).

**Resolution:** generated the additive SQL with `prisma migrate diff
--from-config-datasource --to-schema prisma/schema.prisma --script`
(read-only diff), trimmed the output to additive-only sections (the
unfiltered diff contained pre-existing schema-vs-DB drift unrelated to
Stage 1), saved as a manual migration file, and applied via
`prisma migrate deploy` — which skips the shadow DB entirely.

This is the documented "advanced workflow" for schemas whose historical
migrations cannot be re-played from empty.

A separate concern surfaced during the diff: the schema is missing
model definitions for 13 tables that still exist in the DB
(`evidence_ocr_text`, `evidence_transcript_segments`,
`manual_relationships`, `media_intelligence_*`, `search_audit_logs`,
several `evidence_upload_*`, etc.). These models were removed from
schema.prisma in some prior phase but the underlying DB tables remain.
This drift is **out of scope for Stage 1** and is tracked as a separate
schema-DB reconciliation item — applying the unfiltered diff would have
been catastrophic.

---

## Environment fixes shipped alongside Stage 1

The active `services/api/.env` was already swapped to LOCAL credentials
by the operator (via the Phase 2.7X helper). One residual bug was
fixed:

- `SHADOW_DATABASE_URL` in `.env`, `.env.audit-local`, the repo-root
  `.env.audit-local.example` template, **and** the
  `prepare-local-env.mjs` helper all used a non-existent `proovra` user
  for the shadow DB. The docker container only provisions an `audit`
  user (which has `rolcreatedb` + `rolsuper`). All four files were
  corrected to use the same `audit:audit_local_password` creds with the
  `_shadow` database suffix.
- The `proovra_audit_shadow` database was created in the docker
  container.

These fixes mean future `prisma migrate dev` invocations (which use the
shadow DB) will work once the historical broken migration is itself
fixed or replayed against a more permissive shadow.

---

## Verification matrix

| Check | Result |
|---|---|
| `db:preflight` (post-apply) | 0 fail / 1 warn / 2 pass, classification=local |
| `\d organizations` | 13 columns + 2 indexes + 5 referenced-by FKs ✓ |
| `teams.organization_id` | column added, nullable, UUID ✓ |
| `prisma:generate` | Prisma 7.4.2 client regenerated ✓ |
| `pnpm --filter proovra-api typecheck` | clean ✓ |
| `pnpm --filter proovra-web typecheck` | clean ✓ |
| `pnpm exec playwright test` | **85/86 passing** ✓ |
| The 1 e2e failure | Phase 2.3 `/settings` HMR flake — observed across 2.5D/E/F, 2.6, 2.6B/C/D, 2.7A/X. Same test passes in isolation; infra-level Next.js dev-server race. NOT a Stage 1 regression. |
| `db:risk-scan` on new migration | B:0 D:0 W:16 (warnings only: CREATE INDEX without CONCURRENTLY, ADD FK without NOT VALID — both expected for empty new tables) ✓ |
| Neon contacted? | **No.** safe-migrate banner showed `host=localhost` for every prisma invocation. |
| Workspace isolation preserved? | Yes — teams.organization_id is nullable with `ON DELETE SET NULL`, evidence ownership unchanged. |
| Custody chain preserved? | Yes — no evidence-bearing tables touched. |

---

## What was NOT done (Stage 2-6 remain)

Per the Phase 2.7 §10 staged plan:

- ❌ **Stage 2 (backfill):** no personal-team → org-of-1 promotion. No
  Organization rows created. No memberships seeded.
- ❌ **Stage 3 (dual-read endpoints):** no `/v1/orgs/*` routes wired.
  No RBAC matrix extended for org roles.
- ❌ **Stage 4 (frontend org surface):** no `/organizations` page, no
  org-switcher UI.
- ❌ **Stage 5 (constraint tightening):** `teams.organization_id`
  remains nullable; will become NOT NULL after backfill verifies
  100% coverage.
- ❌ **Stage 6 (destructive cutover):** no columns removed, no legacy
  org-shaped tables renamed.

All five subsequent stages have precise designs in
`docs/product/PHASE_2_7_ORGANIZATION_ARCHITECTURE.md` §3-10.

---

## Files changed this session

### Schema + migration
- `services/api/prisma/schema.prisma` — added 5 models + 2 enums + 1
  column + 1 relation (additive; previously edited but uncommitted).
- `services/api/prisma/migrations/20260926000000_p2_7x_stage1_org_model_additive/migration.sql`
  — NEW. The applied DDL.

### Operator-helper script
- `services/api/scripts/prepare-local-env.mjs` — now also rewrites
  `SHADOW_DATABASE_URL` so it uses the same docker `audit` creds with
  the `_shadow` DB suffix.

### Env templates (residual SHADOW_DATABASE_URL fix)
- `.env.audit-local.example` (repo root) — fixed all three DB URLs to
  use `audit:audit_local_password`.
- `services/api/.env.audit-local` — same fix to the API sibling.
- `services/api/.env` — corrected `SHADOW_DATABASE_URL`.

### Documentation
- `docs/product/PHASE_2_7X_STAGE_1_ORG_SCHEMA_APPLIED.md` — this file.

### Database (local audit only — Neon NOT touched)
- Created `proovra_audit_shadow` database in docker container.
- Applied 1 new migration row in `_prisma_migrations` table.
- 5 new tables, 2 new enum types, 1 new column on `teams`.

---

## Stage 2 readiness checklist

Before starting Stage 2 (backfill), the following must be true:

- [x] Stage 1 schema applied on local audit DB
- [x] No e2e regression beyond the known HMR flake
- [x] Prisma client regenerated; typecheck clean
- [x] Migration file committed in additive-only form
- [ ] **Operator decision** — whether to backfill against the local DB
      only (Phase 2.7X Stage 2A) OR also produce a forward-compatible
      backfill SQL for the Neon DB (Phase 2.7X Stage 2B, requires
      `--allow-remote` + `MIGRATE_ALLOW_REMOTE=1` + a real backup ID)
- [ ] **Schema-vs-DB drift cleanup decision** — the 13 missing model
      definitions in schema.prisma need either re-modeling (to match
      DB) or explicit removal migration. This must be resolved before
      Stage 5 (constraint tightening) but is orthogonal to Stage 2
      (backfill).

---

## Phase 2.7X Stage 1 required final output

1. **Environment verification matrix:** all checks passing as LOCAL.
2. **Migration applied:** yes, additively, via Phase 2.5C wrapper.
3. **Schema changes:** 5 new tables, 2 new enums, 1 new column, 6 FKs.
4. **Backfill executed:** **no** (Stage 2 work).
5. **Dual-read endpoints:** **no** (Stage 3 work).
6. **Frontend org surface:** **no** (Stage 4 work).
7. **Workspace isolation:** preserved (nullable FK + SET NULL).
8. **Custody chain:** preserved (no evidence tables touched).
9. **Deploy-safety:** all Phase 2.5C/D/E/F guards held.
10. **E2E tests:** 85/86 (HMR flake unchanged from prior phases).
11. **Is Organization runtime operational?** **No** — schema only.
    Backend + frontend will activate it in Stages 3 + 4.
12. **Is production rollout safe?** **No** — local-only validation
    so far. Stage 2-6 must run before any Neon migration is planned.
13. **Is PROOVRA structurally enterprise-ready now?** Single-team:
    yes (Phase 2.6D). Multi-workspace tenancy: **schema foundation in
    place; runtime activation pending Stages 2-4.**
14. **Recommended next phase:** Phase 2.7X Stage 2 — personal-team →
    org-of-1 backfill (local only; produce SQL for review only —
    do not execute against Neon).
