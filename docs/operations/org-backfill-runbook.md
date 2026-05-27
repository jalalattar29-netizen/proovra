# Phase A1 — Evidence organization tenancy runbook

**Audience:** platform operators applying Phase A1 to a production-class
database (Neon, RDS, etc.).

**Purpose:** finalize Phase 2.7X Stage 6 tenancy enforcement on the
`evidence` table without disrupting solo users.

**Hard rule:** every step here is bounded, reversible, and re-runnable.
A1 deliberately does NOT make `evidence.organization_id` NOT NULL
yet — that is Stage 7 work after a population sweep decision.

---

## 1. What A1 changes

| Surface | Change | Risk |
|---|---|---|
| `services/api/src/services/evidence.service.ts:281` | `organizationId: scope.teamId` → `organizationId: scope.organizationId` | None — fixes a real write-path bug |
| `services/api/src/services/workspace-billing.service.ts` | `WorkspaceScope.organizationId` added; both factories populate it | None — additive type field; existing callers compile via the schema additions tested in `test/phase-a1-evidence-org-tenancy.test.ts` |
| `services/api/src/services/organization/tenancy-resolver.service.ts` | New canonical resolver module | None — read-only helper |
| `services/api/prisma/schema.prisma` | `Evidence.organization` relation added with `onDelete: Restrict` | Low — additive Prisma relation; the SQL FK lands via the migration |
| `services/api/prisma/migrations/20261001000000_phase_a1_evidence_org_tenancy/migration.sql` | UPDATE backfill + FK + CHECK + composite index | See §3 — bounded |

## 2. Pre-flight checks (BEFORE running the migration)

1. **Confirm Stage 6 has landed.**
   ```sh
   pnpm --filter proovra-api db:check-org-consistency
   ```
   Expect Check 1 (`teams.organization_id is NOT NULL`) to PASS. If it
   FAILs, do not proceed; Stage 6 is the prerequisite.

2. **Size the population of mismatched evidence rows.**
   ```sh
   pnpm --filter proovra-api exec node scripts/evidence-tenancy-diagnostic.mjs \
     --export-csv ./tmp/tenancy-pre.csv
   ```
   Expect FAIL on checks 1 and 2 (the bug rows the migration will heal).
   The CSV gives you the exact `evidenceId`s — useful for incident
   ticket attachment.

3. **Backup the evidence table.**
   ```sh
   pg_dump -t evidence -t teams -t organizations \
     "$DATABASE_URL" > a1-pre-backfill.dump
   ```
   This is the rollback artifact for step 4.

4. **Re-run the org consistency validator.** No FAILs allowed.

## 3. Migration characteristics (what the SQL actually does)

| Step | What it does | Lock | Time on 10M-row table |
|---|---|---|---|
| 1 | `UPDATE evidence SET organization_id = teams.organization_id FROM teams WHERE evidence.team_id = teams.id AND organization_id IS DISTINCT FROM teams.organization_id` | Row-level only; no table rewrite | Proportional to rows needing update (mismatched + NULL). Typically a small fraction of total. |
| 2 | `ALTER TABLE evidence ADD CONSTRAINT … FOREIGN KEY (…) NOT VALID` | Brief AccessExclusiveLock (milliseconds) | Constant |
| 3 | `ALTER TABLE evidence VALIDATE CONSTRAINT …` | SHARE UPDATE EXCLUSIVE (reads + writes OK) | Full table scan, no rewrite. ~minutes on 10M rows. |
| 4 | `ADD CONSTRAINT … CHECK (…) NOT VALID` + `VALIDATE CONSTRAINT …` | Same as 2 + 3 | Constant + full scan |
| 5 | `CREATE INDEX IF NOT EXISTS … (team_id, organization_id)` | ShareLock (blocks writes) | ~minutes; **see §3.1** |

### 3.1 If your `evidence` table is too large to lock for the index build

The migration uses `CREATE INDEX IF NOT EXISTS` (NOT `CONCURRENTLY`)
because Prisma's migration runner executes inside a transaction.
For very large tables on a hot system:

1. Comment out the `CREATE INDEX IF NOT EXISTS …` line in the
   migration.
2. Apply the migration.
3. After the migration is recorded as applied, build the index
   manually in a maintenance window:
   ```sql
   CREATE INDEX CONCURRENTLY IF NOT EXISTS
     evidence_team_id_organization_id_idx
     ON evidence (team_id, organization_id);
   ```
4. Verify with `\d+ evidence` that the index exists.

## 4. Apply

```sh
# Local first — same DB the integration tests target.
pnpm --filter proovra-api db:migrate

# After local validation: production with the standard guardrails
# (Phase 2.5C wrapper requires --allow-remote + MIGRATE_ALLOW_REMOTE=1
# + MIGRATE_BACKUP_ID).
MIGRATE_ALLOW_REMOTE=1 \
MIGRATE_BACKUP_ID=<your-pg_dump-id-or-snapshot-id> \
pnpm --filter proovra-api db:migrate -- --allow-remote
```

## 5. Post-flight (AFTER the migration)

1. **Re-run the tenancy diagnostic.**
   ```sh
   pnpm --filter proovra-api exec node scripts/evidence-tenancy-diagnostic.mjs \
     --export-csv ./tmp/tenancy-post.csv
   ```
   All four checks must PASS. If WARN appears on check 4
   (`personal_mode_rows_with_team`), record the count for Stage 7
   planning — it does not block A1.

2. **Re-run the org consistency validator.**
   ```sh
   pnpm --filter proovra-api db:check-org-consistency
   ```
   Expect every check to PASS or unchanged WARN compared to pre-flight.

3. **Run the integration test suite.**
   ```sh
   pnpm --filter proovra-api test phase-a1
   pnpm --filter proovra-api test phase-30
   pnpm --filter proovra-api test forensic
   ```

4. **Smoke-test the public verify + solo upload paths.**
   - Sign up as a brand-new solo user, capture evidence, finalize,
     download the verification package. Confirm there is no org
     setup blocker.
   - As an existing team-workspace user, repeat the same. Confirm
     `evidence.organization_id` on the new row matches
     `team.organization_id`.

## 6. Rollback

A1 is reversible. The rollback IS available because the migration
adds constraints + corrects values; it does not destroy data.

```sql
-- Step 1 — drop the index.
DROP INDEX IF EXISTS evidence_team_id_organization_id_idx;

-- Step 2 — drop the CHECK and FK.
ALTER TABLE evidence DROP CONSTRAINT IF EXISTS evidence_team_implies_org_chk;
ALTER TABLE evidence DROP CONSTRAINT IF EXISTS evidence_organization_id_fkey;

-- Step 3 — DO NOT undo the UPDATE. The correction is structurally
-- correct; reverting it would re-introduce the Phase A1 write-path
-- bug. Leave evidence.organization_id with the healed values.

-- Step 4 — record the rollback in your incident log. The Prisma
-- _prisma_migrations row should be marked rolled-back manually so
-- the next deploy does not re-apply automatically.
DELETE FROM _prisma_migrations
  WHERE migration_name = '20261001000000_phase_a1_evidence_org_tenancy';
```

## 7. What A1 does NOT change

This is the most-asked operator question. A1 does **not**:

- Make `evidence.organization_id` NOT NULL. (Stage 7 work.)
- Migrate legacy `team_id IS NULL` evidence to a personal Team.
  Those rows remain owner-scoped, exactly as they were.
- Force organization setup on solo users. The personal-team
  bootstrap (Phase EMERGENCY-RECOVERY) already runs invisibly.
- Touch reviewer-ops, cases, reports, verification packages,
  governance, or any other table's tenancy. Those have their own
  Stage / Phase work.
- Change RBAC. Organization role grants do not unlock evidence or
  case access — that remains team-scoped.

## 8. Audit trail

A1 lands two operator-visible artifacts:

- An entry in the migrations table: row
  `20261001000000_phase_a1_evidence_org_tenancy` in `_prisma_migrations`.
- An entry in `AdminAuditLog` per `evidence.create()` write going
  forward (the existing per-route audit already captures this). The
  difference: `metadata.organizationId` is now the real org id, not
  the team id.

## 9. Reference

- Migration SQL:
  `services/api/prisma/migrations/20261001000000_phase_a1_evidence_org_tenancy/migration.sql`
- Tenancy resolver:
  `services/api/src/services/organization/tenancy-resolver.service.ts`
- Diagnostic:
  `services/api/scripts/evidence-tenancy-diagnostic.mjs`
- Tests:
  `services/api/test/phase-a1-evidence-org-tenancy.test.ts`
- Source-of-truth schema declaration:
  `services/api/prisma/schema.prisma` (`Evidence` model, the
  `organization` relation block)
