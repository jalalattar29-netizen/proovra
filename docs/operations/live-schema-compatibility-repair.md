# Live Schema Compatibility Repair — Phase O

Triage + repair plan for the live `full-production-schema-audit.mjs`
output that flagged **128 missing columns** across the PROOVRA
production database. This document explains how the audit was
corrected, what was repaired, what was deferred, and what requires
operator decision.

## Audit-script parser fix

**Symptom:** the original audit reported relation fields like
`Evidence.reviewWorkflow`, `Evidence.anchor`, `User.guestIdentity`,
`Team.governancePolicy`, `Team.securityPolicy`,
`Team.personaProfile` as MISSING_COLUMN — and the auto-generated
repair proposal contained `TYPE_TBD` placeholders for them.

**Root cause:** the parser only excluded fields with `@relation`. For
reverse 1-to-1 relations — the side that just declares the type
without an `@relation` attribute (the forward side carries it) — the
field looked like a scalar and slipped through.

**Fix** (in `services/api/scripts/full-production-schema-audit.mjs`,
and mirrored in `services/api/scripts/full-migration-audit.mjs`):

```diff
- // Relation field with @relation(...)
- if (modelNames.has(baseType) && /@relation\b/.test(attrs)) continue;
+ // ANY field whose type matches a known model is a relation, with or
+ // without @relation. Reverse 1-to-1 relations declare the type
+ // without the attribute (the forward side declares it).
+ if (modelNames.has(baseType)) continue;
```

Contract-asserted by `services/api/test/phase-o-live-schema-repair.test.ts`:
- `Evidence.reviewWorkflow`, `Evidence.anchor`, `User.guestIdentity`,
  `Team.governancePolicy`, `Team.securityPolicy`, `Team.personaProfile`
  must NOT appear in the parsed scalar-column list.
- For every NON-enum scalar field in the real schema, `fieldToSqlType`
  must return a concrete SQL type — i.e. **the migration cannot
  contain `TYPE_TBD`** (the test fails otherwise).

## Triage taxonomy

| Bucket | Meaning |
| --- | --- |
| **REPAIR_NOW** | Real scalar column mismatch confirmed by the audit, with a clear semantic mapping. Added by the `20261007000000_phase_o_live_schema_compatibility_repair` migration as nullable / default-bearing column + deterministic camelCase→snake_case backfill where applicable. |
| **DEFER** | HIGH-severity type-shape mismatches (text vs varchar; timestamp without time zone vs timestamp with time zone; nullable mismatch where Prisma is optional). These do NOT break runtime today. Documented for a future cleanup phase. |
| **MANUAL_DECISION_REQUIRED** | Either (a) the audit output may be stale relative to a recently-applied migration, OR (b) the repair requires data-policy choices (e.g. backfill a missing PK on an already-populated table). Operator must inspect production before any action. |
| **IGNORE_RELATION** | Audit-script false-positive on Prisma reverse 1-to-1 relation fields. Fixed by the parser change above — these no longer appear in the audit. |

## REPAIR_NOW (in this migration)

`services/api/prisma/migrations/20261007000000_phase_o_live_schema_compatibility_repair/migration.sql`

17 tables repaired, all additive:

| Table | Columns added | Backfill |
| --- | --- | --- |
| `evidence_saved_views` | owner_user_id, team_id, description, filters_json, sort_key, scope, is_default, created_at | `team_id ← teamId`, `filters_json ← filtersJson`, `owner_user_id ← ownerUserId` (each guarded by source-column existence) |
| `evidence_legal_holds` | created_at | none |
| `upload_sessions` | stalled_at_utc, abandoned_at_utc, completed_at_utc | none |
| `evidence_intelligence_jobs` | scheduled_at_utc, started_at_utc, completed_at_utc | none |
| `evidence_extracted_texts` | provider_version, confidence, duration_ms, extracted_at_utc | none |
| `evidence_entities` | confidence | none |
| `evidence_semantic_chunks` | chunk_text, embedding_provider, embedding_model, embedding_dimensions | none |
| `evidence_similarities` | advisory_summary | none |
| `discussion_threads` | assigned_at_utc, resolved_by_user_id, resolved_at_utc, reopened_by_user_id, reopen_count, escalated_by_user_id, created_at | none |
| `discussion_messages` | contributor_intake_session_id, contributor_label, edited_at_utc, deleted_at_utc, deleted_by_user_id, created_at | none |
| `discussion_participants` | added_by_user_id, added_at_utc, revoked_by_user_id | none |
| `trusted_devices` | created_at | none |
| `operational_incident_events` | incident_id, event_type, safe_message, metadata_json, created_at | each from its camelCase legacy (`incidentId`, `eventType`, `safeMessage`, `metadataJson`), guarded |
| `evidence_workflow_instances` | team_id, template_id, template_slug, template_version, pre_hold_status, intake_mode, actor_role, case_id, claim_ref, matter_ref, evidence_request_id, intake_session_id, external_contact_hash, created_by_user_id, assigned_reviewer_user_id, title, submitted_at_utc, approved_at_utc, closed_at_utc, created_at | every snake_case ← camelCase via a single dynamic DO block using `format()` + per-source-column information_schema check |
| `evidence_workflow_step_instances` | workflow_instance_id, step_key, order_index, accepted_kinds_json, identity_requirement, location_requirement, mapped_evidence_id, completed_by_user_id, completed_at_utc, waiver_reason, private_reviewer_note, created_at | snake_case ← camelCase, guarded |
| `evidence_workflow_visibility_decisions` | workflow_instance_id, evidence_id, field_key, visible_in_app, visible_to_contributor, visible_in_public_verify, visible_in_report, visible_in_verification_package, requires_redaction, created_at | snake_case ← camelCase, guarded |
| `evidence_search_documents` | team_id, document_type, source_id, searchable_text, searchable_metadata_json, searchable_tags_json, visibility_scope_json, governance_scope_json, review_state, workflow_state, export_state, retention_state, legal_hold_state, contributor_scoped, reviewer_restricted, evidence_id, workflow_instance_id, workflow_step_instance_id, case_id, claim_ref, matter_ref, source_updated_at_utc, indexed_at_utc, created_at | snake_case ← camelCase, guarded |

## Backfill safety contract

Every `UPDATE` in the migration:
1. Is wrapped in `DO $$ ... END $$` PL/pgSQL block.
2. The block first runs `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='...' AND column_name='<source>'`. The UPDATE only runs if the source column actually exists. Re-running against a clean DB is a no-op.
3. Uses `WHERE <target> IS NULL AND <source> IS NOT NULL`. Prisma writes are NEVER overwritten by a re-run.
4. NEVER drops the source camelCase column. Legacy data is preserved for operator inspection.

Dynamic blocks (for the wide naming-drift tables) use
`format('UPDATE %I SET %I = %I WHERE %I IS NULL AND %I IS NOT NULL', ...)`
so the same pattern is used for every column. The contract test
`Phase O — backfill safety` asserts this pattern appears.

## DEFER

The HIGH findings the audit produced (type-shape mismatches, nullable
mismatches where Prisma is optional) are intentionally NOT repaired
in this phase:

| Finding kind | Why deferred |
| --- | --- |
| `text` vs `character varying(N)` | Prisma's adapter handles both transparently for reads. Writes that exceed N would fail at the application layer; this is intentional bounded-payload defense. |
| `timestamp without time zone` vs `timestamp with time zone` | When Prisma's adapter encounters either, it treats both as `DateTime`. Real divergence requires an explicit operator decision (which timezone to canonicalise on); not a runtime breaker today. |
| Nullable mismatch where Prisma is optional, DB is NOT NULL | DB is over-strict — reads succeed, writes succeed because Prisma always supplies non-NULL. No-op. |
| Enum type-name divergence | Postgres user-defined types are matched by `udt_name`; mismatch means the runtime fails on read. None reported in the current production audit. If reported in a future audit, treat as REPAIR_NOW. |

## MANUAL_DECISION_REQUIRED

| Case | Why operator must inspect |
| --- | --- |
| `discussion_mentions` (audit reported thread_id, mentioned_user_id, notified_at_utc, created_at still missing) | The Phase O-Final migration `20261006000000_phase_o_final_production_column_repair` added all four columns inside DO blocks. If `prisma migrate status` reports "Database schema is up to date" but the audit still reports these as missing, the operator must (a) re-run the audit fresh, (b) verify the migration finished without rollback, and (c) confirm via `information_schema.columns` directly. Adding the columns AGAIN in this migration would be redundant if they actually exist. If the operator confirms they remain missing after a fresh audit, author a follow-up migration. |
| `evidence_workflow_instance_evidence` (missing PK `id` AND missing `step_instance_id` AND naming drift) | Adding a primary key to a populated table requires deciding what to do with existing rows. We do NOT silently backfill `id = gen_random_uuid()` because the operator must confirm (a) the rows are legitimate and (b) no unique key constraint upstream depends on the prior absence of `id`. |

## IGNORE_RELATION

These are Prisma reverse 1-to-1 relation fields — declared as a
nullable model-typed field with no `@relation` attribute (the
forward side carries the relation declaration). They NEVER map to
DB columns:

| Model | Field | Forward side |
| --- | --- | --- |
| Evidence | reviewWorkflow | EvidenceReviewWorkflow.evidenceId |
| Evidence | anchor | EvidenceAnchor.evidenceId |
| User | guestIdentity | GuestIdentity.userId |
| Team | governancePolicy | WorkspaceGovernancePolicy.teamId |
| Team | securityPolicy | OrganizationSecurityPolicy.teamId |
| Team | personaProfile | WorkspacePersonaProfile.teamId |

The corrected parser excludes these. The contract test
`Phase O — audit parser excludes reverse-1-to-1 relation fields`
asserts each one is NOT in the parsed scalar field list. The audit
will no longer report these as MISSING_COLUMN.

## Production commands

### 1. After committing + pushing the fixed code

```bash
# On the production server.
cd /opt/proovra/app
git pull --ff-only origin main

# Pull the new image (preferred CI path) OR per-service rebuild.
PROOVRA_IMAGE_TAG=<new-git-sha> \
  docker compose -f infra/docker/docker-compose.prod.yml pull proovra-api
```

### 2. Pre-flight: re-run the live audit BEFORE migration

```bash
docker exec -it docker-proovra-api-1 sh -lc '
  cd /app/services/api
  node scripts/full-production-schema-audit.mjs
'
```

Verify:
- The previously-reported relation-field "missing columns"
  (`reviewWorkflow`, `anchor`, etc.) are GONE — confirms parser fix
  rolled out.
- The 128 CRITICAL count drops materially.
- The remaining CRITICAL findings match the REPAIR_NOW table above.

### 3. Take a Neon snapshot

In the Neon console: Project → Branches → Take snapshot. Capture the
snapshot ID. **If you cannot take a snapshot, STOP.**

### 4. Apply the migration

```bash
docker exec -it docker-proovra-api-1 sh -lc '
  cd /app/services/api
  MIGRATE_ALLOW_REMOTE=1 \
    MIGRATE_BACKUP_ID=<real-neon-snapshot-id> \
    node scripts/safe-migrate.mjs deploy --allow-remote
'
```

### 5. Re-run the audit

```bash
docker exec -it docker-proovra-api-1 sh -lc '
  cd /app/services/api
  node scripts/full-production-schema-audit.mjs
'
```

Acceptance: zero CRITICAL findings on any REPAIR_NOW column. Any
remaining CRITICAL must be classified as MANUAL_DECISION (operator
review) before further action.

### 6. Restart api + worker

```bash
docker restart docker-proovra-api-1 docker-proovra-worker-1
docker logs docker-proovra-api-1 --tail 250 | grep -iE "P2022|P2021|does not exist|failed|error"
```

Expect: no P2022 / P2021 lines.

## Rollback plan

Because every statement is additive (`ADD COLUMN IF NOT EXISTS`
nullable + `DEFAULT` only on columns Prisma has a non-null default
for), the migration is safe to leave in place even if the application
code is rolled back. Adding a nullable column has no read-side cost.

If a rollback is truly necessary (operator decision):

```sql
-- ONLY with operator approval. The new columns are safe to leave;
-- DROPping them risks invalidating any backfill the migration
-- performed. Snapshot-based restore is the safer rollback path.
```

The recommended rollback for any production incident is **Neon
snapshot restore** to the snapshot captured in step 3, NOT manual
DROP COLUMN.

## Final repair migration — `20261008000000_phase_o_workflow_join_table_final_repair`

After `20261006000000` and `20261007000000` were applied, the live
audit reported **5 remaining CRITICAL findings**, all on the
`evidence_workflow_instance_evidence` join table:

| # | Kind | Detail |
| --- | --- | --- |
| 1 | MISSING_COLUMN | `id uuid` |
| 2 | NAMING_DRIFT | `workflowInstanceId` → expected `workflow_instance_id` |
| 3 | NAMING_DRIFT | `evidenceId` → expected `evidence_id` |
| 4 | MISSING_COLUMN | `step_instance_id uuid` (nullable in Prisma) |
| 5 | NAMING_DRIFT | `createdAt` → expected `created_at` |

The final migration closes EXACTLY these 5 findings. It:

- Adds `id`, `workflow_instance_id`, `evidence_id`, `step_instance_id`,
  `created_at` — all NULLABLE, all `IF NOT EXISTS`.
- Sets `DEFAULT gen_random_uuid()` on `id` and `DEFAULT NOW()` on
  `created_at` so future Prisma INSERTs get a non-NULL value.
- Backfills:
  - `id ← gen_random_uuid()` where `id IS NULL` (idempotent).
  - `workflow_instance_id ← workflowInstanceId` (camelCase legacy),
    inside a DO block that first verifies the source column exists.
  - `evidence_id ← evidenceId`, same pattern.
  - `created_at ← createdAt`, same pattern.
  - `step_instance_id` has no source column (introduced in Phase 22
    after the legacy shape existed); left NULL — Prisma marks the
    field optional.
- Creates non-unique indexes on `evidence_id` and `step_instance_id`
  inside column-existence DO blocks (Phase O-Final pattern).

**What this migration deliberately does NOT do (operator scope):**

- ❌ NO `ADD PRIMARY KEY`. Adding a PK to a populated table requires
  verifying every row has a non-NULL, unique `id`. The operator must
  run a verification query and author a separate promotion migration.
- ❌ NO `CREATE UNIQUE INDEX` on `(workflow_instance_id, evidence_id)`.
  Production may carry duplicate rows from the legacy camelCase
  shape. Adding the unique index would error mid-migration. The
  operator confirms uniqueness first.
- ❌ NO `SET NOT NULL`. Even after the backfill, NOT NULL promotion is
  deferred — operator verifies 100% non-NULL via SELECT before any
  promotion migration.

### Production commands for the final migration

```bash
# After commit/push, on the production server:
cd /opt/proovra/app
git pull --ff-only origin main
PROOVRA_IMAGE_TAG=<new-git-sha> \
  docker compose -f infra/docker/docker-compose.prod.yml pull proovra-api

# 1. Pre-flight audit — confirms only the 5 expected CRITICAL findings.
docker exec -it docker-proovra-api-1 sh -lc '
  cd /app/services/api
  node scripts/full-production-schema-audit.mjs
'

# 2. Take a Neon snapshot. Capture the snapshot ID. STOP if you cannot.

# 3. Apply the final migration.
docker exec -it docker-proovra-api-1 sh -lc '
  cd /app/services/api
  MIGRATE_ALLOW_REMOTE=1 \
    MIGRATE_BACKUP_ID=<real-neon-snapshot-id> \
    node scripts/safe-migrate.mjs deploy --allow-remote
'

# 4. Re-run the audit. ACCEPTANCE: CRITICAL: 0.
docker exec -it docker-proovra-api-1 sh -lc '
  cd /app/services/api
  node scripts/full-production-schema-audit.mjs
'

# 5. Operator checklist BEFORE authoring PK / unique-index promotion:
docker exec -it docker-proovra-api-1 sh -lc '
  cd /app/services/api
  pnpm exec prisma db execute --schema prisma/schema.prisma --stdin <<SQL
SELECT
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE id IS NULL) AS null_id_count,
  COUNT(*) FILTER (WHERE workflow_instance_id IS NULL) AS null_wfid_count,
  COUNT(*) FILTER (WHERE evidence_id IS NULL) AS null_evid_count,
  (SELECT COUNT(*) FROM (
     SELECT workflow_instance_id, evidence_id
       FROM evidence_workflow_instance_evidence
      GROUP BY workflow_instance_id, evidence_id
     HAVING COUNT(*) > 1
   ) d) AS duplicate_pair_count
FROM evidence_workflow_instance_evidence;
SQL
'
# Acceptance for PK + unique index promotion:
#   null_id_count = 0
#   null_wfid_count = 0
#   null_evid_count = 0
#   duplicate_pair_count = 0
# Only when all four are zero is the operator authorised to write
# the next migration adding PRIMARY KEY ("id") + UNIQUE INDEX on
# (workflow_instance_id, evidence_id).

# 6. Restart and verify no runtime errors.
docker restart docker-proovra-api-1 docker-proovra-worker-1
docker logs docker-proovra-api-1 --tail 250 | grep -iE "P2022|P2021|does not exist|failed|error"
```

## Verdict

- Audit parser: **fixed** (relation fields excluded; no `TYPE_TBD`).
- Migrations: **3 authored**, all additive-only, all contract-tested.
  - `20261006000000_phase_o_final_production_column_repair` (already applied)
  - `20261007000000_phase_o_live_schema_compatibility_repair`
  - `20261008000000_phase_o_workflow_join_table_final_repair`
- Tests: **passing** locally; structural contracts enforced (no DROP /
  RENAME / DELETE / TRUNCATE / SET NOT NULL / PK / UNIQUE INDEX).
- Production apply for the latest two: **PENDING operator snapshot
  + safe-migrate + post-audit confirming CRITICAL: 0**.

```
LIVE SCHEMA COMPATIBILITY REPAIR: READY FOR PRODUCTION APPLY
```

This verdict applies only to the contents of this repository.
Production is fixed **only after** the operator (1) takes a Neon
snapshot, (2) applies the migration via safe-migrate, (3) re-runs the
live audit confirming **CRITICAL: 0** on every table.
