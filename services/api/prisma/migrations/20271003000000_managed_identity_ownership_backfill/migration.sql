-- PHASE 10 §correction-3 (2026-07-23) — MANAGED IDENTITY OWNERSHIP BACKFILL.
--
-- 20271002000000 added the ownership columns. Pre-existing rows with
-- identity_mode = 'MANAGED_ENTERPRISE' but managing_organization_id = NULL are
-- an inconsistent (UNRESOLVED) state. This backfill binds an EXACT owner ONLY
-- where one can be DETERMINISTICALLY proven from existing verified evidence
-- (active external identity mappings → their team's Organization).
--
-- Resolution policy (deterministic, idempotent, auditable):
--   A. EXACTLY ONE distinct owning Organization proven → bind it (source SCIM;
--      the evidence is a directory/external-identity mapping).
--   B. ZERO owning Organizations proven → leave NULL → the row stays
--      MANAGED_UNRESOLVED (fail closed). NOT converted to STANDARD.
--   C. MULTIPLE candidate Organizations → CONFLICT → leave NULL → UNRESOLVED,
--      requires explicit human remediation. Never choose arbitrarily.
--
-- Touches ONLY `users` ownership columns. NO Evidence mutation, NO membership
-- mutation, NO Personal transfer, NO Organization merge. Idempotent: once an
-- owner is set the row no longer matches `managing_organization_id IS NULL`, so
-- re-running is a no-op. NOT APPLIED (authored for deployment).

WITH candidate AS (
  SELECT
    u.id                                   AS user_id,
    COUNT(DISTINCT t.organization_id)      AS org_count,
    -- min(uuid) does not exist in PostgreSQL (≤17); rows are only bound when
    -- org_count = 1, so MIN over the text form selects that single value
    -- deterministically.
    MIN(t.organization_id::text)::uuid     AS the_org
  FROM "users" u
  JOIN "external_identity_mappings" m
    ON m."user_id" = u."id"
   AND m."unlinked_at_utc" IS NULL            -- ACTIVE mappings only
  JOIN "teams" t
    ON t."id" = m."team_id"
   AND t."organization_id" IS NOT NULL
  WHERE u."identity_mode" = 'MANAGED_ENTERPRISE'
    AND u."managing_organization_id" IS NULL   -- only UNRESOLVED rows (idempotent)
  GROUP BY u."id"
)
UPDATE "users" u
SET
  "managing_organization_id" = c.the_org,
  "managed_identity_source"  = 'SCIM'
FROM candidate c
WHERE u."id" = c.user_id
  AND c.org_count = 1;                          -- EXACTLY ONE owner (A). Zero/multi (B/C) left NULL.
