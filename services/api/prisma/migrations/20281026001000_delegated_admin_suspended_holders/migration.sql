-- A SUSPENDED HOLDER'S DELEGATED AUTHORITY RESUMES ON REINSTATEMENT
-- (members re-audit N-2, 2026-10-26).
--
-- The delegated-admin convergence carried each live tier grant into member
-- capability grants only when its grantee was an ACTIVE member, and retired
-- every other live row as RETIRED_NO_MEMBER. That swept up grantees who were
-- merely SUSPENDED. Under the tier model their grant lay dormant and resumed
-- when they were reinstated; under the permission engine a capability grant
-- does the same (a SUSPENDED member is refused everything — the engine checks
-- membership status before it looks at any grant — and the grant applies
-- again once the member is ACTIVE). Retiring the row instead meant a member
-- reinstated after the release silently lost the authority, which "valid tier
-- grants migrated forward-only" never allowed.
--
-- This carries exactly those rows forward, with the convergence's own
-- tier-to-permission map, grantor and expiry: a row retired RETIRED_NO_MEMBER
-- that is still unrevoked and unexpired, whose grantee is still a member of
-- the grant's workspace, SUSPENDED (or ACTIVE again — reinstated since). A
-- grantee whose membership was REVOKED, or who has none, keeps nothing: there
-- is no membership to reinstate. Each carried row then reads CONVERGED, like
-- every other carried tier row; the capability grants are inert until the
-- member is reinstated.
--
-- A capability the member already holds live is kept unless the tier outlives
-- it (its expiry is then extended); a revoked or expired one is re-issued —
-- the convergence's rule. Nothing is deleted. Idempotent: only rows still
-- RETIRED_NO_MEMBER are read, and each one carried is flipped, so a second
-- run changes nothing.

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
     AND m."status" IN ('SUSPENDED', 'ACTIVE')
   WHERE g."state" = 'RETIRED_NO_MEMBER'
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
       LEFT('Carried from delegated admin tier ' || c."tier" || ' (grant ' || c."tier_grant_id" || ', holder suspended at convergence)', 400),
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
   SET "state" = 'CONVERGED',
       "updated_at" = NOW()
 WHERE g."state" = 'RETIRED_NO_MEMBER'
   AND g."revoked_at_utc" IS NULL
   AND (g."expires_at_utc" IS NULL OR g."expires_at_utc" > NOW())
   AND g."tier" <> 'WORKSPACE_ADMIN'
   AND EXISTS (
     SELECT 1 FROM "team_members" m
      WHERE m."team_id" = g."team_id"
        AND m."user_id" = g."granted_to_user_id"
        AND m."status" IN ('SUSPENDED', 'ACTIVE')
   );
