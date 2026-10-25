-- ONE DELEGATED-ADMINISTRATION AUTHORITY (members audit DOM-09, owner decision
-- 2026-10-25).
--
-- Two models were both written and both enforced: tiered grants
-- (delegated_admin_grants, checked by a route middleware of its own) and the
-- canonical permission engine (role + member capability grants + member
-- delegated scopes). The engine is the authority kept; every route that asked
-- for a tier now asks it for the permission of its domain.
--
-- WHY CAPABILITY GRANTS AND NOT SCOPES. A tier's reach was an arbitrary
-- OR-set of routes; the delegated scopes are coarser bundles. Mapping a tier
-- onto a scope would WIDEN it (a SECURITY_OFFICER would gain member
-- suspension through IDENTITY_ADMIN; a REVIEWER_LEAD the whole review
-- console). So each live tier grant is carried as member capability grants of
-- exactly the permissions its tier admitted, route by route, including the
-- ORG chain ladder (GLOBAL_ADMIN > ORG_ADMIN > DEPARTMENT_ADMIN >
-- WORKSPACE_ADMIN):
--
--   GLOBAL_ADMIN, ORG_ADMIN  billing.manage, governance.policy.manage,
--                            governance.exchange.manage,
--                            governance.department.manage,
--                            governance.retention.manage,
--                            governance.legal_hold.manage, audit.read,
--                            integration.webhook.manage,
--                            identity.org_policy.manage,
--                            identity.access_review.action
--   DEPARTMENT_ADMIN         governance.department.manage
--   WORKSPACE_ADMIN          (none — no route ever required it alone, so
--                            the grant admitted nothing)
--   REVIEWER_LEAD            governance.exchange.manage
--   SECURITY_OFFICER         governance.policy.manage, audit.read,
--                            identity.org_policy.manage,
--                            identity.access_review.action
--   COMPLIANCE_OFFICER       governance.policy.manage, audit.read,
--                            governance.retention.manage,
--                            governance.legal_hold.manage,
--                            identity.access_review.action
--
-- A grant belongs to a workspace MEMBERSHIP: a live tier grant carries
-- forward only when its grantee is an ACTIVE member of the grant's
-- workspace. Its grantor and expiry carry with it, and the reason names the
-- tier and the tier row it came from. A capability the member already holds
-- live is kept unless the tier grant outlives it, in which case its expiry is
-- extended to the tier's; a revoked or expired one is re-issued (the re-grant
-- path the capability writer itself uses).
--
-- Nothing is deleted: the tier table stays as history and no code reads it
-- after this release. Each live tier row ends as:
--
--   CONVERGED          carried into capability grants;
--   RETIRED_NO_EFFECT  WORKSPACE_ADMIN — it admitted nothing;
--   RETIRED_NO_MEMBER  its grantee is not an active member (nothing to carry).
--
-- Idempotent: the UPDATE matches only rows still ACTIVE, and the INSERT reads
-- only those rows, so a second run changes nothing.

WITH "tier_permissions" ("tier", "permission") AS (
  VALUES
    ('GLOBAL_ADMIN', 'billing.manage'),
    ('GLOBAL_ADMIN', 'governance.policy.manage'),
    ('GLOBAL_ADMIN', 'governance.exchange.manage'),
    ('GLOBAL_ADMIN', 'governance.department.manage'),
    ('GLOBAL_ADMIN', 'governance.retention.manage'),
    ('GLOBAL_ADMIN', 'governance.legal_hold.manage'),
    ('GLOBAL_ADMIN', 'audit.read'),
    ('GLOBAL_ADMIN', 'integration.webhook.manage'),
    ('GLOBAL_ADMIN', 'identity.org_policy.manage'),
    ('GLOBAL_ADMIN', 'identity.access_review.action'),
    ('ORG_ADMIN', 'billing.manage'),
    ('ORG_ADMIN', 'governance.policy.manage'),
    ('ORG_ADMIN', 'governance.exchange.manage'),
    ('ORG_ADMIN', 'governance.department.manage'),
    ('ORG_ADMIN', 'governance.retention.manage'),
    ('ORG_ADMIN', 'governance.legal_hold.manage'),
    ('ORG_ADMIN', 'audit.read'),
    ('ORG_ADMIN', 'integration.webhook.manage'),
    ('ORG_ADMIN', 'identity.org_policy.manage'),
    ('ORG_ADMIN', 'identity.access_review.action'),
    ('DEPARTMENT_ADMIN', 'governance.department.manage'),
    ('REVIEWER_LEAD', 'governance.exchange.manage'),
    ('SECURITY_OFFICER', 'governance.policy.manage'),
    ('SECURITY_OFFICER', 'audit.read'),
    ('SECURITY_OFFICER', 'identity.org_policy.manage'),
    ('SECURITY_OFFICER', 'identity.access_review.action'),
    ('COMPLIANCE_OFFICER', 'governance.policy.manage'),
    ('COMPLIANCE_OFFICER', 'audit.read'),
    ('COMPLIANCE_OFFICER', 'governance.retention.manage'),
    ('COMPLIANCE_OFFICER', 'governance.legal_hold.manage'),
    ('COMPLIANCE_OFFICER', 'identity.access_review.action')
),
"carried" AS (
  -- One row per (member, permission): when a member held several tiers that
  -- carry the same permission, the latest-expiring grant wins (NULL = never).
  SELECT DISTINCT ON (m."id", tp."permission")
         m."id" AS "team_member_id",
         g."team_id",
         tp."permission",
         g."id" AS "tier_grant_id",
         g."tier",
         g."granted_by_user_id",
         g."expires_at_utc"
    FROM "delegated_admin_grants" g
    JOIN "tier_permissions" tp ON tp."tier" = g."tier"
    JOIN "team_members" m
      ON m."team_id" = g."team_id"
     AND m."user_id" = g."granted_to_user_id"
     AND m."status" = 'ACTIVE'
   WHERE g."state" = 'ACTIVE'
     AND g."revoked_at_utc" IS NULL
     AND (g."expires_at_utc" IS NULL OR g."expires_at_utc" > NOW())
   ORDER BY m."id", tp."permission", g."expires_at_utc" DESC NULLS FIRST, g."id"
)
INSERT INTO "member_capability_grants"
  ("id", "team_member_id", "team_id", "permission", "reason",
   "granted_at_utc", "granted_by_user_id", "expires_at_utc", "created_at", "updated_at")
SELECT gen_random_uuid(),
       c."team_member_id",
       c."team_id",
       c."permission",
       LEFT('Carried from delegated admin tier ' || c."tier" || ' (grant ' || c."tier_grant_id" || ')', 400),
       NOW(),
       c."granted_by_user_id",
       c."expires_at_utc",
       NOW(),
       NOW()
  FROM "carried" c
ON CONFLICT ("team_member_id", "permission") DO UPDATE
   SET "reason" = EXCLUDED."reason",
       "granted_at_utc" = EXCLUDED."granted_at_utc",
       "granted_by_user_id" = EXCLUDED."granted_by_user_id",
       "expires_at_utc" = EXCLUDED."expires_at_utc",
       "revoked_at_utc" = NULL,
       "revoked_by_user_id" = NULL,
       "revoked_reason" = NULL,
       "updated_at" = NOW()
 WHERE "member_capability_grants"."revoked_at_utc" IS NOT NULL
    OR ("member_capability_grants"."expires_at_utc" IS NOT NULL
        AND ("member_capability_grants"."expires_at_utc" <= NOW()
             OR EXCLUDED."expires_at_utc" IS NULL
             OR EXCLUDED."expires_at_utc" > "member_capability_grants"."expires_at_utc"));

UPDATE "delegated_admin_grants" g
   SET "state" = CASE
         WHEN g."tier" = 'WORKSPACE_ADMIN' THEN 'RETIRED_NO_EFFECT'
         WHEN EXISTS (
           SELECT 1 FROM "team_members" m
            WHERE m."team_id" = g."team_id"
              AND m."user_id" = g."granted_to_user_id"
              AND m."status" = 'ACTIVE'
         ) THEN 'CONVERGED'
         ELSE 'RETIRED_NO_MEMBER'
       END,
       "updated_at" = NOW()
 WHERE g."state" = 'ACTIVE'
   AND g."revoked_at_utc" IS NULL
   AND (g."expires_at_utc" IS NULL OR g."expires_at_utc" > NOW());
