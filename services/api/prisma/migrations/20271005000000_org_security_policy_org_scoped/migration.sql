-- PHASE 10 §policy-convergence (2026-07-23) — OrganizationSecurityPolicy is a
-- CUSTOMER ORGANIZATION policy. It was keyed per-Workspace (team_id); this makes
-- `organization_id` the AUTHORITATIVE key: exactly ONE policy per Customer
-- Organization, inherited by all its ORGANIZATION workspaces. NOT APPLIED.
--
-- Backfill + collapse (deterministic, idempotent, fail-safe):
--   * Only CUSTOMER organizations + ORGANIZATION (non-personal) workspaces.
--   * SYSTEM organizations and Personal/OWNED workspaces get NO org policy
--     (their rows keep organization_id NULL — classified residue, Phase-12).
--   * When one Organization has MULTIPLE workspace policy rows, the
--     DETERMINISTIC WINNER (highest policy_version, then latest updated_at) is
--     bound to the Organization; the losing rows keep organization_id NULL and
--     are no longer authoritative (the org resolver reads the winner only).
--   * CONFLICT (losing rows with divergent security-material values) is NOT
--     silently resolved — the winner is chosen deterministically but the
--     `org_security_policy_conflicts` view below lists every Organization whose
--     collapsed rows disagreed, so the readiness gate can FAIL CLOSED until an
--     operator reconciles. Nothing is deleted.

ALTER TABLE "organization_security_policies"
  ADD COLUMN IF NOT EXISTS "organization_id" UUID;

-- §item-2 EXECUTABLE PREFLIGHT — a divergent-conflict Organization (multiple
-- workspace policy rows with DIFFERENT security-material values) must NOT be
-- collapsed by choosing an arbitrary winner. RAISE before any collapsing write
-- so the migration fails closed until an operator reconciles. Internal
-- organization ids only (no public tenant data).
DO $$
DECLARE
  conflict_ids TEXT;
BEGIN
  SELECT string_agg(x.organization_id::text, ', ')
    INTO conflict_ids
  FROM (
    SELECT t."organization_id" AS organization_id
    FROM "organization_security_policies" p
    JOIN "teams" t ON t."id" = p."team_id" AND t."is_personal" = false AND t."organization_id" IS NOT NULL
    JOIN "organizations" o ON o."id" = t."organization_id" AND o."kind" = 'CUSTOMER'
    GROUP BY t."organization_id"
    HAVING COUNT(*) > 1
       AND COUNT(DISTINCT (p."sso_required", p."managed_identity_required", p."no_personal_space",
                           p."security_mode", p."concurrent_session_limit", p."max_session_age_seconds")) > 1
  ) x;
  IF conflict_ids IS NOT NULL THEN
    RAISE EXCEPTION 'org_security_policy_convergence_conflict: divergent policies for organizations [%]. Reconcile before migrating.', conflict_ids;
  END IF;
END
$$;

-- Bind the deterministic winner per CUSTOMER organization. Multiple NULLs are
-- permitted by the unique index (Postgres), so losing/excluded rows are fine.
WITH ranked AS (
  SELECT
    p."team_id" AS team_id,
    t."organization_id" AS org_id,
    ROW_NUMBER() OVER (
      PARTITION BY t."organization_id"
      ORDER BY p."policy_version" DESC NULLS LAST, p."updated_at" DESC NULLS LAST
    ) AS rn
  FROM "organization_security_policies" p
  JOIN "teams" t
    ON t."id" = p."team_id"
   AND t."organization_id" IS NOT NULL
   AND t."is_personal" = false
  JOIN "organizations" o
    ON o."id" = t."organization_id"
   AND o."kind" = 'CUSTOMER'
)
UPDATE "organization_security_policies" p
SET "organization_id" = r.org_id
FROM ranked r
WHERE p."team_id" = r.team_id
  AND r.rn = 1
  AND p."organization_id" IS NULL;  -- idempotent

-- Authoritative uniqueness (multiple NULLs allowed → excluded/residue rows OK).
CREATE UNIQUE INDEX IF NOT EXISTS "organization_security_policies_organization_id_key"
  ON "organization_security_policies"("organization_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organization_security_policies_organization_id_fkey'
  ) THEN
    ALTER TABLE "organization_security_policies"
      ADD CONSTRAINT "organization_security_policies_organization_id_fkey"
      FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
      -- §1.2 — RESTRICT (not cascade): preserve the policy + audit through
      -- Organization archive/suspend/cancellation; no physical purge in Phase 10.
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$$;

-- Readiness aid: Organizations whose collapsed workspace policy rows disagreed
-- on security-material values. The deployment readiness gate MUST fail closed
-- while this returns rows (operator reconciliation required).
CREATE OR REPLACE VIEW "org_security_policy_conflicts" AS
  SELECT t."organization_id" AS organization_id,
         COUNT(DISTINCT (p."sso_required", p."managed_identity_required", p."no_personal_space",
                         p."security_mode", p."concurrent_session_limit", p."max_session_age_seconds")) AS distinct_postures,
         COUNT(*) AS policy_rows
  FROM "organization_security_policies" p
  JOIN "teams" t ON t."id" = p."team_id" AND t."is_personal" = false AND t."organization_id" IS NOT NULL
  JOIN "organizations" o ON o."id" = t."organization_id" AND o."kind" = 'CUSTOMER'
  GROUP BY t."organization_id"
  HAVING COUNT(*) > 1 AND COUNT(DISTINCT (p."sso_required", p."managed_identity_required", p."no_personal_space",
                         p."security_mode", p."concurrent_session_limit", p."max_session_age_seconds")) > 1;
