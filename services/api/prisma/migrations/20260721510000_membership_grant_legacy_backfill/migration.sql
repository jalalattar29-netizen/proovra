-- =============================================================================
-- PHASE 3 (2026-07-22) — provenance backfill for PRE-EXISTING memberships.
--
-- Every membership row created BEFORE the membership_grants table existed
-- has no provenance. We do NOT guess its historical source. Each such row
-- receives exactly one LEGACY_UNKNOWN grant, which:
--
--   * makes the "zero grant rows" state impossible after backfill;
--   * can never be removed by source-scoped revocation (revoking a newly
--     known source such as SCIM/IDP_GROUP leaves the LEGACY_UNKNOWN grant
--     active, so the membership survives — access with unprovable history
--     is never accidentally deleted);
--   * is removed only by explicit manual revocation (revokeAllMembershipGrants).
--
-- Idempotent: the anti-join re-inserts nothing on re-run. Applies to BOTH
-- membership layers. Must run AFTER 20260721500000. NOT applied here.
-- =============================================================================

INSERT INTO "membership_grants"
  ("team_member_id", "source", "intent", "granted_role")
SELECT tm."id", 'LEGACY_UNKNOWN', 'PROVENANCE_BACKFILL', tm."role"::text
FROM "team_members" tm
WHERE NOT EXISTS (
  SELECT 1 FROM "membership_grants" g WHERE g."team_member_id" = tm."id"
);

INSERT INTO "membership_grants"
  ("organization_membership_id", "source", "intent", "granted_role")
SELECT om."id", 'LEGACY_UNKNOWN', 'PROVENANCE_BACKFILL', om."role"::text
FROM "organization_memberships" om
WHERE NOT EXISTS (
  SELECT 1 FROM "membership_grants" g
  WHERE g."organization_membership_id" = om."id"
);
