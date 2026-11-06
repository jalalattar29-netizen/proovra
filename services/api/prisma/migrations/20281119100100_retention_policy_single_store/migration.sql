-- =============================================================================
-- 2026-11-04 — GOV-005 / RETENTION-TWO-TABLES: one retention policy store.
--
-- BACKFILL + RETIRE, forward only. No row is deleted.
--
-- `evidence_retention_policies` is the store a record binds to (prospective,
-- extend-only: packages/shared-runtime/src/evidence-retention/policy-binding.ts).
-- The Phase 4B `retention_policy_configs` table, written by the Evidence
-- Lifecycle retention page and the organization setup wizard, bound nothing.
--
-- 1. COPY each config row into `evidence_retention_policies` under the SAME id
--    (references in audit rows keep resolving), with a version-1 row:
--      years          -> retention_days = round(years * 365.25)
--      WORKSPACE      -> WORKSPACE;  CASE -> CASE with case_id = scope_target_id
--      ACTIVE         -> ACTIVE;     anything else -> ARCHIVED
--      DEPARTMENT / EVIDENCE scope, or 0 years -> copied ARCHIVED (a record
--      carries no department, and 0 years would read as INDEFINITE retention
--      in the binding store), with the reason in the description
--    The template is kept in the description as `lifecycle-template:<T>`.
--    A name already ACTIVE in the workspace gets a ` [lifecycle <id8>]` suffix
--    (the ACTIVE-name unique key). Idempotent: ON CONFLICT (id) DO NOTHING.
--    Copied ACTIVE policies bind records created from now on, which is what
--    their creators were told; existing records are not rewritten.
-- 2. RETIRE `retention_policy_configs`: INSERT and UPDATE are refused, so the
--    historic rows stay as they were and nothing writes a second store. DELETE
--    is left to the workspace's own ON DELETE CASCADE (no code deletes a row);
--    refusing it would make a workspace undeletable.
--
-- Rollback: drop the trigger "retention_policy_configs_retired"; the copied
-- rows are ordinary policies an operator can archive.
-- =============================================================================

INSERT INTO "evidence_retention_policies" (
  "id", "team_id", "display_name", "description", "status", "scope", "case_id",
  "retention_days", "immutable", "auto_extension_enabled", "current_version",
  "created_by_user_id", "created_at", "updated_at", "archived_at_utc"
)
SELECT
  c."id",
  c."team_id",
  CASE
    WHEN c."state" = 'ACTIVE'
     AND c."scope_kind" IN ('WORKSPACE', 'CASE')
     AND c."years" > 0
     AND EXISTS (
       SELECT 1 FROM "evidence_retention_policies" p
        WHERE p."team_id" = c."team_id" AND p."display_name" = left(c."name", 180) AND p."status" = 'ACTIVE'
     )
    THEN left(c."name", 150) || ' [lifecycle ' || left(c."id"::text, 8) || ']'
    ELSE left(c."name", 180)
  END,
  'lifecycle-template:' || c."template"
    || CASE
         WHEN c."scope_kind" NOT IN ('WORKSPACE', 'CASE') THEN ' (archived on copy: ' || c."scope_kind" || ' scope cannot bind a record)'
         WHEN c."years" <= 0 THEN ' (archived on copy: 0 years would read as indefinite retention)'
         ELSE ''
       END,
  CASE
    WHEN c."state" = 'ACTIVE' AND c."scope_kind" IN ('WORKSPACE', 'CASE') AND c."years" > 0 THEN 'ACTIVE'
    ELSE 'ARCHIVED'
  END,
  CASE WHEN c."scope_kind" = 'CASE' THEN 'CASE' ELSE 'WORKSPACE' END,
  CASE WHEN c."scope_kind" = 'CASE' THEN c."scope_target_id" ELSE NULL END,
  CASE WHEN c."years" > 0 THEN round(c."years" * 365.25)::int ELSE NULL END,
  false,
  false,
  1,
  c."created_by_user_id",
  c."created_at",
  c."updated_at",
  CASE
    WHEN c."state" = 'ACTIVE' AND c."scope_kind" IN ('WORKSPACE', 'CASE') AND c."years" > 0 THEN NULL
    ELSE c."updated_at"
  END
FROM "retention_policy_configs" c
WHERE EXISTS (SELECT 1 FROM "users" u WHERE u."id" = c."created_by_user_id")
  AND EXISTS (SELECT 1 FROM "teams" t WHERE t."id" = c."team_id")
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "evidence_retention_policy_versions" (
  "retention_policy_id", "version", "retention_days", "immutable",
  "auto_extension_enabled", "diff_json", "authored_by_user_id", "change_note", "authored_at_utc"
)
SELECT p."id", 1, p."retention_days", false, false,
       jsonb_build_object('copiedFrom', 'retention_policy_configs'),
       p."created_by_user_id",
       'Copied from the retired lifecycle retention store (GOV-005)',
       p."created_at"
FROM "evidence_retention_policies" p
JOIN "retention_policy_configs" c ON c."id" = p."id"
WHERE NOT EXISTS (
  SELECT 1 FROM "evidence_retention_policy_versions" v
   WHERE v."retention_policy_id" = p."id" AND v."version" = 1
);

CREATE OR REPLACE FUNCTION "proovra_refuse_retired_table_write"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is retired: % is not permitted (its rows were copied to evidence_retention_policies)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS "retention_policy_configs_retired" ON "retention_policy_configs";
CREATE TRIGGER "retention_policy_configs_retired"
  BEFORE INSERT OR UPDATE ON "retention_policy_configs"
  FOR EACH ROW EXECUTE FUNCTION "proovra_refuse_retired_table_write"();
