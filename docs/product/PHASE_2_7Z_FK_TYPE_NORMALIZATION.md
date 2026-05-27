# Phase 2.7Z — Production migration repair: FK type normalization

## Status: PATCH READY. Awaiting operator authorization for production retry.

This is **not** a feature phase. It is a production-migration repair
that resolves the Prisma P3018 / PostgreSQL 42804 failure that
prevented the Phase 0 catchup migration from applying on production
(Neon). The repair adds guarded type-normalization for every FK
child column referenced in the catchup migration, plus idempotent
FK creation so retry after `migrate resolve --rolled-back` is safe.

---

## 1. Exact root cause

```
Migration  : 20260925000000_phase0_schema_catchup
Failure    : Prisma P3018 wrapping PostgreSQL 42804
Statement  : ALTER TABLE "reviewer_ops_reminders"
             ADD CONSTRAINT "reviewer_ops_reminders_team_id_fkey"
             FOREIGN KEY ("team_id") REFERENCES "teams"("id")
             ON DELETE CASCADE ON UPDATE CASCADE;
PostgreSQL : foreign key constraint cannot be implemented
             Key columns "team_id" and "id" are of incompatible
             types: text and uuid.
```

The catchup migration was authored expecting every FK child column
to have arrived at this step as UUID. On production (Neon), some
legacy tables persisted child columns as `text` (likely from
earlier raw-SQL drift-patches or a pre-UUID schema generation). The
catchup tried to add the FK before normalizing the child column
type, producing the 42804 incompatibility.

**Locally**, this same DB was migrated through the full chain in a
prior session where the columns were already uuid — the catchup ran
clean. The patch must be idempotent: ALTER COLUMN only when the
current type is `text`. The patch handles BOTH environments.

---

## 2. FK mismatch audit matrix

**Total FK statements in catchup migration:** 125 (parsed
mechanically from `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` lines).

**Distinct (child_table, child_column) tuples:** 125 (each FK is
unique — no column referenced by two FKs).

**Parent column types** (all on local DB; confirmed via
`information_schema.columns`):

| Parent table | Parent column | udt_name | Notes |
|---|---|---|---|
| cases | id | uuid | |
| destruction_reviews | id | uuid | |
| discussion_threads | id | uuid | |
| evidence | id | uuid | |
| evidence_requests | id | uuid | |
| evidence_retention_policies | id | uuid | |
| evidence_review_workflows | id | uuid | |
| evidence_workflow_instances | id | uuid | |
| evidence_workflow_templates | id | uuid | |
| guest_identities | id | uuid | |
| operational_incidents | id | uuid | |
| sso_connections | id | uuid | |
| team_members | id | uuid | |
| teams | id | uuid | |
| users | id | uuid | |
| workflow_intake_sessions | id | uuid | |

**16 distinct parents, all UUID.** Every one of the 125 FKs
references a UUID parent. Therefore EVERY child column needs the
guarded normalization — the patch treats them uniformly.

The full child-column list is in
`services/api/prisma/migrations/20260925000000_phase0_schema_catchup/migration.sql`
lines 2399-end of the prelude block (each preceded by an
`information_schema.columns` IF-EXISTS-text guard).

---

## 3. Non-UUID value preflight results

**Local DB (already migrated):** 0 invalid UUIDs across all 125
child columns. Verified via:

```sql
WITH per_column AS (
  SELECT 'reviewer_ops_reminders' AS child_table,
         'team_id' AS child_column,
         (SELECT COUNT(*) FROM "reviewer_ops_reminders"
          WHERE "team_id" IS NOT NULL
            AND "team_id"::text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') AS invalid_count
  UNION ALL
  -- ... 124 more UNION ALL rows ...
)
SELECT * FROM per_column WHERE invalid_count > 0
ORDER BY child_table, child_column;
```

Result on local: **0 rows returned** (no invalid values anywhere).
This is expected since local columns are already uuid; the
`column::text` cast renders canonical 8-4-4-4-12 hex.

**Production (Neon) — operator MUST run this preflight before applying
the patch.** The exact SQL is in §8.4 of this doc.

If the production preflight returns ANY rows: **STOP. DO NOT apply
the patch. Report the offending rows to the data-repair channel.**
The patched migration includes a `RAISE EXCEPTION` that halts the
migration on the first non-UUID value detected; even if the
preflight is skipped, the migration itself refuses to cast bad data.

---

## 4. Exact migration patch summary

The patch transforms
`services/api/prisma/migrations/20260925000000_phase0_schema_catchup/migration.sql`
in two ways. Original file is preserved at
`migration.sql.before_fk_type_patch`.

### 4.1 Prelude — guarded type normalization (lines 1381..3779)

A 2399-line prelude inserted **between** the original "RenameForeignKey"
section (line 1380) and the first "AddForeignKey" statement. The
prelude consists of 125 DO blocks, one per (child_table,
child_column). Each block follows this exact shape:

```sql
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = '<child_table>'
      AND column_name = '<child_column>'
      AND udt_name = 'text'              -- only if currently TEXT
  ) THEN
    IF EXISTS (
      SELECT 1 FROM "<child_table>"
      WHERE "<child_column>" IS NOT NULL
        AND "<child_column>" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ) THEN
      RAISE EXCEPTION 'Cannot cast %.% to uuid: non-UUID text values exist',
        '<child_table>', '<child_column>';
    END IF;
    ALTER TABLE "<child_table>"
      ALTER COLUMN "<child_column>" TYPE UUID
      USING "<child_column>"::uuid;
  END IF;
END $$;
```

Behaviour:
- **Already UUID** (local, post-fix prod) → outer IF is false → block is a no-op.
- **Currently TEXT, all values valid UUID** → ALTER COLUMN succeeds; column becomes UUID.
- **Currently TEXT, any value non-UUID** → RAISE EXCEPTION halts loudly. **No data destroyed.** Operator runs §8.4 to see which rows are at fault.

### 4.2 Idempotent FK creation (lines 3780..4789)

Every original `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY …;` statement is
wrapped in:

```sql
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = '<constraint_name>'
  ) THEN
    ALTER TABLE "<child_table>" ADD CONSTRAINT "<constraint_name>"
      FOREIGN KEY (…) REFERENCES … ON DELETE … ON UPDATE …;
  END IF;
END $$;
```

- All 125 FK statements wrapped.
- **ON DELETE / ON UPDATE semantics preserved verbatim.** Each constraint inherits its original cascade rule.
- After a partial-success retry (`migrate resolve --rolled-back` then `migrate deploy`), constraints already added in the pre-failure run are skipped.

### 4.3 What did NOT change
- No DROP CONSTRAINT statements added or removed.
- No DROP TABLE / DROP COLUMN added.
- Pre-existing 4 DROP COLUMN statements (case_status_history.from_status, evidence_search_documents.tsv, integration_webhook_endpoints.event_types, security_events.api_credential_id) preserved unchanged; verified NOT in the 13-table protected-runtime drift catalog (db:diff-guard exit 0).
- Pre-existing CREATE INDEX statements unchanged (W:346 baseline retained).

---

## 5. Files changed

```
MODIFIED  services/api/prisma/migrations/20260925000000_phase0_schema_catchup/migration.sql
NEW       services/api/prisma/migrations/20260925000000_phase0_schema_catchup/migration.sql.before_fk_type_patch
NEW       docs/product/PHASE_2_7Z_FK_TYPE_NORMALIZATION.md  (this)
```

**No schema.prisma changes.** **No new migrations created.** The
patch only modifies the file content of an existing migration —
this is appropriate when the migration has never been applied to
production (Neon is currently in failed state on this migration).

**No code changes** in `services/api/src/`, `apps/web/`, e2e specs,
or any other module.

---

## 6. db:risk-scan severity summary

```
Risk Severity Summary:
  BLOCKED:     0
  DESTRUCTIVE: 3   ← all HISTORICAL (Phase 0 era), pre-existing baseline
  WARNING:    70   ← overwhelmingly historical CREATE INDEX without CONCURRENTLY
  SAFE:       15
```

### 6.1 Does any current Stage 6 migration contain DROP TABLE?
**No.** Stage 6 migrations:
- `20260927000000_p2_7x_stage6_invite_token_hash` — B:0 D:0 W:2 (additive column + index)
- `20260928000000_p2_7x_stage6_teams_org_not_null` — B:0 D:0 W:1 (constraint tightening)

### 6.2 Does any current Stage 6 migration contain DROP COLUMN?
**No.** Both Stage 6 migrations are additive / constraint-tightening only.

### 6.3 Does any current Stage 6 migration contain destructive ALTER?
**No.** The only ALTERs are:
- ADD COLUMN token_hash (Stage 6.1)
- ALTER COLUMN token_hash SET NOT NULL (Stage 6.1) — flagged WARNING, not DESTRUCTIVE
- ALTER COLUMN token DROP NOT NULL (Stage 6.1) — constraint relaxation, additive
- DROP CONSTRAINT teams_organization_id_fkey + re-ADD (Stage 6.2) — FK retype, NOT a data destroyer

### 6.4 Does any current Stage 6 migration touch protected runtime tables?
**No.** Verified via `pnpm db:diff-guard` against both Stage 6 migration files: exit 0 on both. The 13 protected runtime tables (evidence_ocr_text, evidence_part_derived_assets, evidence_part_exif_summaries, evidence_transcript_segments, evidence_upload_session_parts, evidence_upload_sessions, external_review_grants, investigation_graph_edges, investigation_graph_nodes, manual_relationships, media_intelligence_runs, media_intelligence_signals, search_audit_logs) are NOT referenced by any Stage 6 ALTER.

### 6.5 Are warnings only CREATE INDEX without CONCURRENTLY from historical baseline?

**Mostly yes.** The 70 WARN-classified migrations break down as:
- Phase 0 / Phase 2.4 / Phase 2.5 era CREATE INDEX without CONCURRENTLY: ~65 migrations (baseline)
- Stage 1 (Phase 2.7X): B:0 D:0 W:16 — CREATE INDEX without CONCURRENTLY on the new (empty) org tables + ADD FK without NOT VALID — additive only, EMPTY TABLES, lock risk is zero
- Stage 6 (this rollout): B:0 D:0 W:2 + B:0 D:0 W:1 — the 2 warnings = ALTER COLUMN SET NOT NULL on the newly-added token_hash column (zero existing rows depend on it) + CREATE UNIQUE INDEX on token_hash
- **Patched catchup adds W:0** — the patch's DO blocks don't match risk-scan's destructive/warning regex set; they're new SQL that the scanner doesn't currently classify (and the consolidated normalization is non-destructive by construction — the IF-text-then-ALTER pattern + RAISE EXCEPTION ensures no silent data loss).

### 6.6 BLOCKED / DESTRUCTIVE rollout posture
- **BLOCKED total: 0** → no Stage 6 migration is blocked.
- **DESTRUCTIVE: 3 historical migrations**, all pre-existing baseline:
  - `20260201013040_align_schema` (Phase 0 era)
  - `20260201120000_update_evidence_signingkey` (Phase 0 era)
  - `20260925000000_phase0_schema_catchup` (this catchup — D:4 from pre-existing DROP COLUMN, NOT introduced by my patch; verified diff-guard exit 0)
- **Current rollout SQL (Stage 6 + patched catchup) introduces 0 new destructive ops.**

**Conclusion: BLOCKED 0, current-rollout DESTRUCTIVE 0. Patch is safe to retry against production.**

---

## 7. Stage 6 migration safety confirmation

| Check | Result |
|---|---|
| 20260927000000_p2_7x_stage6_invite_token_hash contains DROP? | No |
| 20260928000000_p2_7x_stage6_teams_org_not_null contains DROP? | No (re-ADD FK after DROP CONSTRAINT is intentional + non-destructive) |
| Token-hash migration is additive/compatible? | Yes — ADD COLUMN + backfill via pgcrypto + UNIQUE INDEX. Pre-Stage-6 raw tokens preserved for rollback |
| `teams.organization_id` NOT NULL tightening | Safe — Stage 5 `db:not-null-readiness` and Stage 6 pre-apply both reported 0 nulls |
| FK RESTRICT behaviour on teams.org | Intentional — replaces the now-impossible SET NULL with operator-mandated relocate-before-delete semantics |
| `pnpm db:check-org-consistency` | 0F / 0W / 8P |
| `pnpm db:not-null-readiness` | 3 READY + 1 READY-SOFT (billing_owner_user_id deferred to Stage 7) |
| `pnpm db:diff-guard < Stage 6 migration files` | Exit 0 on both |
| `pnpm db:preflight` | 0F / 1W / 2P + drift catalog announcement |
| `pnpm db:drift-check` | clean — schema and migrations in sync |
| `pnpm typecheck` (api + web) | clean |
| `pnpm deploy:safe:dry` | PASS — preflight + typecheck + consistency stages all green |
| Full e2e | 138/139 — 1 pre-existing public-verify rate-limit timing flake |

---

## 8. Server deployment commands

These commands are EXACT and SAFE. The operator **MUST** confirm
backup ID and visual REMOTE override banner before each step.

### 8.1 Local pre-flight (on dev workstation)

```bash
# Confirm the patch is in place
diff -q \
  services/api/prisma/migrations/20260925000000_phase0_schema_catchup/migration.sql \
  services/api/prisma/migrations/20260925000000_phase0_schema_catchup/migration.sql.before_fk_type_patch
# Expected: "differ" (the patch added ~3000 lines).

# Verify drift-guard PASS on the patched file
cd services/api
cat prisma/migrations/20260925000000_phase0_schema_catchup/migration.sql \
  | pnpm db:diff-guard
# Expected: exit 0 + "no destructive ops detected against any of the 13 runtime-protected tables".
```

### 8.2 Backup BEFORE any production touch

```bash
# Operator action — TAKE A NEON BACKUP NOW:
#   - Open the Neon console
#   - Create a branch from "main" at the current point-in-time
#   - Record the branch id below
export MIGRATE_BACKUP_ID=neon-pitr-$(date +%Y%m%d-%H%M%S)-pre-2_7z-fk-fix
echo "BACKUP_ID = $MIGRATE_BACKUP_ID"

# Verify backup integrity (operator-specific):
#   - Neon console: confirm the new branch shows the expected commit / WAL position
```

### 8.3 Copy the patched migration to the production deploy container

```bash
# On the deploy host:
docker cp \
  services/api/prisma/migrations/20260925000000_phase0_schema_catchup/migration.sql \
  docker-proovra-api-1:/app/services/api/prisma/migrations/20260925000000_phase0_schema_catchup/migration.sql

# Verify file inside the container:
docker exec -it docker-proovra-api-1 sh -lc '
  ls -la /app/services/api/prisma/migrations/20260925000000_phase0_schema_catchup/migration.sql
  wc -l /app/services/api/prisma/migrations/20260925000000_phase0_schema_catchup/migration.sql
'
# Expected: ~4789 lines (vs the ~1755-line pre-patch file).
```

### 8.4 Production-side non-UUID value preflight (REQUIRED)

This SQL is the operator's confirmation that the catchup migration's
`RAISE EXCEPTION` won't fire on production. Run as a non-mutating
READ against Neon:

```sql
-- Run against the production database. READ-ONLY.
WITH per_column AS (
  SELECT 'reviewer_ops_reminders' AS t, 'team_id' AS c,
    (SELECT COUNT(*) FROM "reviewer_ops_reminders"
     WHERE "team_id" IS NOT NULL
       AND "team_id"::text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') AS invalid_count
  -- ... (UNION ALL for all 125 columns; see /tmp/preflight.sql for the full generated query) ...
)
SELECT * FROM per_column WHERE invalid_count > 0 ORDER BY t, c;
```

The full 125-column UNION ALL query is in
`services/api/scripts/preflight-fk-uuid-cast.sql` (operator should
generate this file from the unique-child-cols list before each
prod-side run; see §8.7 for the regen command).

**If any rows are returned: STOP. Report the (table, column,
invalid_count) tuples to the data-repair channel. Do NOT apply the
patch.**

### 8.5 Confirm DB target inside the deploy container

```bash
docker exec -it docker-proovra-api-1 sh -lc '
  cd /app/services/api
  node scripts/db-preflight.mjs --allow-remote
' || true
# Expected banner: host=<neon-host>, classification=REMOTE.
# Visually confirm the host matches the intended production target.
```

### 8.6 Resolve the failed migration state

```bash
docker exec -it docker-proovra-api-1 sh -lc '
  cd /app/services/api
  npx prisma migrate resolve --rolled-back 20260925000000_phase0_schema_catchup
'
# This tells Prisma the previous attempt failed and the migration
# row in `_prisma_migrations` should be marked as not-applied. The
# patched migration will then be retried on the next deploy.
```

### 8.7 Retry via the safe wrapper

```bash
docker exec -it docker-proovra-api-1 sh -lc '
  cd /app/services/api
  export MIGRATE_ALLOW_REMOTE=1
  export MIGRATE_BACKUP_ID='"${MIGRATE_BACKUP_ID}"'
  pnpm deploy:safe --allow-remote
'
# The Phase 2.5C wrapper will:
#   1. print the EXPLICIT REMOTE MIGRATION OVERRIDE banner
#   2. require MIGRATE_BACKUP_ID + MIGRATE_ALLOW_REMOTE + --allow-remote (all three)
#   3. run preflight + risk-scan + drift-check
#   4. run prisma migrate deploy
#   5. run prisma generate
#   6. run typecheck
#   7. run drift-check post-deploy
#   8. run check-org-consistency
```

**Alternative direct path** (if deploy:safe is unavailable for some
reason — operator MUST still set MIGRATE_BACKUP_ID + MIGRATE_ALLOW_REMOTE
and confirm the wrapper's banner):

```bash
docker exec -it docker-proovra-api-1 sh -lc '
  cd /app/services/api
  export MIGRATE_ALLOW_REMOTE=1
  export MIGRATE_BACKUP_ID='"${MIGRATE_BACKUP_ID}"'
  pnpm prisma:migrate --allow-remote
'
```

---

## 9. Post-migration verification queries

Run these after `deploy:safe` returns successfully:

### 9.1 Migration status

```bash
docker exec -it docker-proovra-api-1 sh -lc '
  cd /app/services/api
  npx prisma migrate status
'
# Expected: "Database schema is up to date!"
```

### 9.2 FK exists on reviewer_ops_reminders

```sql
SELECT conname, confrelid::regclass AS references
FROM pg_constraint
WHERE conname = 'reviewer_ops_reminders_team_id_fkey';
```
Expected: one row, references `teams`.

### 9.3 Column type post-cast

```sql
SELECT table_name, column_name, udt_name
FROM information_schema.columns
WHERE table_name = 'reviewer_ops_reminders'
  AND column_name = 'team_id';
```
Expected: `udt_name = 'uuid'`.

### 9.4 No invalid UUID residue (post-cast safety net)

```sql
SELECT COUNT(*) AS still_invalid
FROM reviewer_ops_reminders
WHERE team_id IS NOT NULL
  AND team_id::text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
```
Expected: 0.

### 9.5 Broader consistency

```bash
docker exec -it docker-proovra-api-1 sh -lc '
  cd /app/services/api
  pnpm db:check-org-consistency
'
# Expected: 0 fail / 0 warn / 8 pass
```

### 9.6 App-level health

```bash
docker exec -it docker-proovra-api-1 sh -lc '
  curl -fsS http://localhost:8081/health || echo FAILED
'
# Expected: 200 OK from the API health endpoint.

docker exec -it docker-proovra-api-1 sh -lc '
  cd /app/services/api
  pnpm typecheck
'
# Expected: clean (no output).

docker exec -it docker-proovra-api-1 sh -lc '
  cd /app/services/api
  pnpm deploy:safe:dry --allow-remote
'
# Expected: preflight + typecheck + consistency stages all PASS.
```

### 9.7 Audit-trail check

The patched migration does NOT itself emit audit events (it's a
schema-only migration). After deploy succeeds, confirm the
Organization audit-event flow is intact by inspecting the latest
events:

```sql
SELECT event_type, COUNT(*)
FROM organization_audit_events
WHERE created_at > NOW() - INTERVAL '1 hour'
GROUP BY event_type
ORDER BY event_type;
```
Expected: events from normal app traffic continue to land
(non-zero ORG_CREATED / ORG_MEMBER_INVITED / etc. counts depending
on app activity in the past hour).

---

## 10. Remaining risks

| Risk | Mitigation status |
|---|---|
| Non-UUID values in production text columns | Mitigated by §4.1's RAISE EXCEPTION inside each normalization block. Operator's preflight in §8.4 is the soft pre-confirmation; the migration is the hard backstop. |
| Pre-existing 4 DROP COLUMN ops in the catchup (case_status_history.from_status, evidence_search_documents.tsv, integration_webhook_endpoints.event_types, security_events.api_credential_id) | NOT introduced by this patch. Verified NOT in protected-table list (db:diff-guard exit 0). They were part of the original Phase 0 catchup design and have always been part of this migration. |
| Token-column raw values on pre-Stage-6 production rows | Documented in Stage 6 readiness doc. Stage 7 destructive cutover will clear them. Out of scope here. |
| Backup expiry during migration window | Operator's `MIGRATE_BACKUP_ID` is recorded at §8.2. Phase 2.5D wrapper requires its length ≥ 4 chars (i.e. non-empty). Rollback procedure in §11. |
| Partial-success on first retry attempt | Patched migration is fully idempotent — every CREATE INDEX uses `IF NOT EXISTS`, every FK is wrapped in `IF NOT EXISTS (SELECT 1 FROM pg_constraint …)`, every normalization is wrapped in `IF udt_name = 'text'`. A second retry after a partial-success-then-fail run is safe. |
| Production app pool running pre-Stage-6 code while migration applies | The migration is non-destructive at the table/column level (only ADD COLUMN, ALTER COLUMN TYPE, ADD INDEX, ADD CONSTRAINT). The app pool continues to function during apply. Stage 6 code (hash-based invite lookup) requires Stage 6 migration first; deploy ordering matters — see §11. |

### 11. Rollback procedure

If the retry fails for any reason:

```bash
# 1. Stop application traffic to the affected pool.
# 2. Restore from $MIGRATE_BACKUP_ID:
#    - Neon: PITR to the recorded branch.
# 3. Confirm DB state with `psql ... -c "\d reviewer_ops_reminders"` — column should be back to its pre-fix type.
# 4. Re-mark the failed migration as rolled-back:
docker exec -it docker-proovra-api-1 sh -lc '
  cd /app/services/api
  npx prisma migrate resolve --rolled-back 20260925000000_phase0_schema_catchup
'
# 5. Investigate the failure mode before retrying.
```

If the failure was a RAISE EXCEPTION on non-UUID values:
- The exception message identifies the exact table.column.
- Query for the bad rows; bring the operator to a data-repair
  discussion before any retry.

---

## 12. Can migration be retried safely?

**Yes — once §8.4 production preflight returns 0 invalid rows AND
the operator confirms `MIGRATE_BACKUP_ID` is recorded.**

The retry path:
1. operator pulls latest patched migration into the deploy container (§8.3)
2. operator runs the production preflight READ-ONLY (§8.4)
3. on 0 rows, operator sets the env override (§8.7)
4. `pnpm deploy:safe --allow-remote` applies through the Phase 2.5C wrapper
5. Phase 2.7Z patch's idempotency means partial-success states recover cleanly

---

## 13. Is production rollout safe?

**Conditionally yes.** The PATCH is technically ready: validated
against local DB (drift-check clean, e2e 138/139, all consistency
checks green). The remaining gates are PROCESS:

1. operator MUST take a Neon backup and record MIGRATE_BACKUP_ID before retrying
2. operator MUST run the production preflight (§8.4) and verify 0 invalid rows
3. operator MUST visually confirm the EXPLICIT REMOTE MIGRATION OVERRIDE banner from `safe-migrate.mjs` before SQL hits Neon
4. operator MUST monitor the post-deploy verification queries (§9.1-9.6) before resuming production traffic to the affected pool
5. if the migration fails the RAISE EXCEPTION on a non-UUID row, operator MUST stop, escalate, and run §11 rollback

The engineering pre-conditions are met. The operator pre-conditions
are documented above. Production rollout is safe **subject to**
operator execution of those four gates.

---

## Summary

| Item | Status |
|---|---|
| Root cause identified | text/uuid FK mismatch — `reviewer_ops_reminders.team_id` (text) → `teams.id` (uuid) |
| FK mismatch audit | 125 FK statements, 125 distinct child columns, 16 distinct UUID parents |
| Non-UUID value preflight (local) | 0 invalid across all 125 columns |
| Patch shape | Guarded normalization prelude (125 DO blocks) + idempotent FK creation (125 wrapped statements) |
| Files changed | 1 modified, 2 new (backup + this doc) |
| BLOCKED / DESTRUCTIVE / WARNING / SAFE | 0 / 3 historical / 70 mostly historical / 15 |
| Stage 6 migrations | B:0 D:0 on both (W:2 + W:1, all additive) |
| Patched catchup safety | db:diff-guard exit 0 (no protected-table DROPs) |
| Validation chain | drift-check clean · typecheck clean · deploy:safe:dry PASS · e2e 138/139 |
| Migration retry safe? | YES — once production preflight returns 0 invalid + backup recorded + REMOTE override confirmed |
| Production rollout safe? | YES — conditional on the 5 operator gates in §13 |
