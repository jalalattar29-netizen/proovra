-- ONE DELEGATED-ADMINISTRATION AUTHORITY (members audit DOM-09, owner decision
-- 2026-10-25).
--
-- Two models were both written and both enforced: tiered grants
-- (delegated_admin_grants, checked by a route middleware of its own) and
-- member delegated scopes (member_delegated_admin_scopes, folded into the
-- canonical permission engine). The scopes are the authority kept — they sit
-- inside the canonical authorization decision. This migration carries every
-- LIVE tier grant forward into the scope that delegates the same domain, then
-- marks every tier row with what became of it. Nothing is deleted: the tier
-- table stays as history, and no code reads it after this release.
--
--   GLOBAL_ADMIN / ORG_ADMIN / DEPARTMENT_ADMIN / WORKSPACE_ADMIN
--                       → GOVERNANCE_ADMIN   (the governance routes they gated)
--   REVIEWER_LEAD       → REVIEW_ADMIN
--   SECURITY_OFFICER    → IDENTITY_ADMIN
--   COMPLIANCE_OFFICER  → RETENTION_ADMIN    (retention, holds, destruction)
--
-- A scope belongs to a workspace MEMBERSHIP, so a live grant carries forward
-- only when its grantee is an ACTIVE member of the grant's workspace; the
-- expiry carries with it. An existing scope of the same kind is kept as it is
-- (ON CONFLICT DO NOTHING). Tier rows end as:
--
--   CONVERGED          a live grant whose grantee is an active member;
--   RETIRED_NO_MEMBER  a live grant whose grantee is not (nothing to carry to);
--   REVOKED / expired  unchanged (already ended).
--
-- Idempotent: the INSERT conflicts on its second run and the UPDATE matches
-- only rows still ACTIVE.

INSERT INTO "member_delegated_admin_scopes"
  ("id", "team_member_id", "team_id", "scope_kind", "reason",
   "granted_at_utc", "granted_by_user_id", "expires_at_utc", "created_at", "updated_at")
SELECT gen_random_uuid(),
       m."id",
       g."team_id",
       (CASE g."tier"
          WHEN 'REVIEWER_LEAD' THEN 'REVIEW_ADMIN'
          WHEN 'SECURITY_OFFICER' THEN 'IDENTITY_ADMIN'
          WHEN 'COMPLIANCE_OFFICER' THEN 'RETENTION_ADMIN'
          ELSE 'GOVERNANCE_ADMIN'
        END)::"DelegatedAdminScopeKind",
       LEFT('Converged from delegated admin tier ' || g."tier", 400),
       g."granted_at_utc",
       g."granted_by_user_id",
       g."expires_at_utc",
       NOW(),
       NOW()
  FROM "delegated_admin_grants" g
  JOIN "team_members" m
    ON m."team_id" = g."team_id"
   AND m."user_id" = g."granted_to_user_id"
   AND m."status" = 'ACTIVE'
 WHERE g."state" = 'ACTIVE'
   AND g."revoked_at_utc" IS NULL
   AND (g."expires_at_utc" IS NULL OR g."expires_at_utc" > NOW())
   AND g."tier" IN ('GLOBAL_ADMIN', 'ORG_ADMIN', 'DEPARTMENT_ADMIN', 'WORKSPACE_ADMIN',
                    'REVIEWER_LEAD', 'SECURITY_OFFICER', 'COMPLIANCE_OFFICER')
ON CONFLICT ("team_member_id", "scope_kind") DO NOTHING;

UPDATE "delegated_admin_grants" g
   SET "state" = CASE
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
