-- ONE LIVE ROW PER NAME, ANY NUMBER OF RETIRED ONES (members audit DOM-11,
-- 2026-10-26).
--
-- Three unique keys carried the row's status as a key column:
--
--   evidence_retention_policies (team_id, display_name, status)
--   scim_groups                 (team_id, display_name, status)
--   sso_connections             (team_id, provider, status)
--
-- That guarded the live row, but it also allowed only ONE retired row per
-- name: retiring a second "Default" retention policy, archiving a second SCIM
-- group of the same name, or disabling a second connection to the same
-- provider collided with the first and failed. History made the next
-- lifecycle step impossible.
--
-- Each key is replaced by a PARTIAL unique index over the live status only
-- (ACTIVE). Creating it cannot fail on existing data: the old key already
-- guaranteed at most one ACTIVE row per (team, name). Dropping the old key
-- only relaxes a constraint, so no image breaks: nothing in the product reads
-- these keys by name, and a duplicate ACTIVE row is still refused (P2002).
--
-- EXPAND-SAFE and idempotent: the new index is created before the old one is
-- dropped, both guarded.

CREATE UNIQUE INDEX IF NOT EXISTS "evidence_retention_policies_team_name_active_uk"
  ON "evidence_retention_policies" ("team_id", "display_name")
  WHERE "status" = 'ACTIVE';
DROP INDEX IF EXISTS "evidence_retention_policies_team_name_status_uk";

CREATE UNIQUE INDEX IF NOT EXISTS "scim_groups_team_display_active_uk"
  ON "scim_groups" ("team_id", "display_name")
  WHERE "status" = 'ACTIVE';
DROP INDEX IF EXISTS "scim_groups_team_display_status_uk";

CREATE UNIQUE INDEX IF NOT EXISTS "sso_connections_team_provider_active_uk"
  ON "sso_connections" ("team_id", "provider")
  WHERE "status" = 'ACTIVE';
DROP INDEX IF EXISTS "sso_connections_team_provider_status_uk";
