-- =============================================================================
-- PHASE 2 (2026-07-21) — ambiguous-organization report (READ-ONLY).
--
-- Context: the retired generic `POST /v1/orgs` route created Organization
-- rows with the schema-default kind = SYSTEM and an ORG_OWNER membership.
-- After the Phase 2 CUSTOMER filter, SYSTEM organizations no longer surface
-- on any customer Organization page. Per the program rule (§5.4), rows whose
-- classification is ambiguous must be REPORTED for manual remediation — not
-- silently guessed and not silently hidden.
--
-- This report lists every SYSTEM organization that carries CUSTOMER-LIKE
-- usage — i.e. artifacts only a customer Enterprise Organization should
-- have. For each such row an operator must decide:
--   (a) promote to kind = CUSTOMER (it was a real customer created through
--       the legacy route) — via the enterprise provisioning repair path; or
--   (b) leave SYSTEM (it was an experiment/abandoned container) and notify
--       the owner that self-service organizations are retired.
--
-- Run manually against a replica. This script performs NO writes.
-- =============================================================================

SELECT
  o."id",
  o."name",
  o."status",
  o."kind",
  o."created_at",
  o."billing_owner_user_id",
  (SELECT COUNT(*) FROM "organization_memberships" m
     WHERE m."organization_id" = o."id")                    AS membership_count,
  (SELECT COUNT(*) FROM "teams" t
     WHERE t."organization_id" = o."id")                    AS workspace_count,
  (SELECT COUNT(*) FROM "organization_domains" d
     WHERE d."organization_id" = o."id")                    AS domain_count,
  (SELECT COUNT(*) FROM "organization_invites" i
     WHERE i."organization_id" = o."id")                    AS invite_count
FROM "organizations" o
WHERE o."kind" = 'SYSTEM'
  AND (
    -- customer-like usage signals: any governance membership beyond the
    -- implicit container, any domain claim, or any org invite.
    EXISTS (SELECT 1 FROM "organization_memberships" m
              WHERE m."organization_id" = o."id")
    OR EXISTS (SELECT 1 FROM "organization_domains" d
                 WHERE d."organization_id" = o."id")
    OR EXISTS (SELECT 1 FROM "organization_invites" i
                 WHERE i."organization_id" = o."id")
  )
ORDER BY o."created_at" ASC;
