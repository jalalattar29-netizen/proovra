-- THE DELEGATED-ADMINISTRATION FLOOR (members re-audit N-1, 2026-10-26).
--
-- Retiring the tier model swapped each tier gate for the broad permission of
-- its domain (governance.retention.manage, governance.policy.manage,
-- identity.access_review.action, …). The workspace ADMIN role already held
-- every one of those, so every ADMIN silently gained what only a named tier
-- holder could do: execute evidence destruction, author governance policies,
-- run access-review campaigns, publish trust incidents, decide evidence
-- exchange. The code now gates each former tier route on a PRECISE permission
-- that no workspace role holds except the OWNER, and that reaches anyone else
-- only through a member capability grant.
--
-- This grants those precise permissions to exactly the people the tiers
-- admitted: every member whose tier grant was carried into capability grants
-- (tier row CONVERGED, still unrevoked and unexpired), who still holds the
-- carried capability the route asked for until now (the ANCHOR — so a carried
-- grant an administrator has since revoked or let expire carries nothing
-- further), receives the precise permissions of their tier:
--
--   GLOBAL_ADMIN, ORG_ADMIN
--     governance.exchange.decide          (anchor governance.exchange.manage)
--     governance.department.define        (anchor governance.policy.manage)
--     integration.lifecycle_webhook.manage (anchor integration.webhook.manage)
--     governance.archive.transition       (anchor governance.retention.manage)
--     governance.policy.assign            (anchor governance.policy.manage)
--     governance.retention_policy.manage  (anchor governance.retention.manage)
--     governance.destruction.request      (anchor governance.retention.manage)
--     governance.destruction.approve      (anchor governance.retention.manage)
--     audit.lifecycle_package.preview     (anchor audit.read)
--     audit.verification_package.preview  (anchor audit.read)
--     trust.article.publish               (anchor governance.policy.manage)
--     trust.subprocessor.manage           (anchor governance.policy.manage)
--     trust.status.manage                 (anchor identity.org_policy.manage)
--     governance.access_review.decide     (anchor identity.access_review.action)
--   COMPLIANCE_OFFICER
--     governance.retention_policy.manage, governance.destruction.request,
--     governance.destruction.approve, governance.destruction.execute
--                                         (anchor governance.retention.manage)
--     audit.lifecycle_package.preview, audit.verification_package.preview
--                                         (anchor audit.read)
--     trust.article.publish, trust.article.ai_disclosure.publish,
--     trust.subprocessor.manage, governance.policy.author,
--     governance.trust_scan.run           (anchor governance.policy.manage)
--     governance.access_review.campaign.manage,
--     governance.access_review.decide     (anchor identity.access_review.action)
--   SECURITY_OFFICER
--     governance.destruction.approve, trust.article.security.publish,
--     trust.status.manage                 (anchor identity.org_policy.manage)
--     audit.verification_package.preview  (anchor audit.read)
--     trust.article.publish, trust.article.ai_disclosure.publish,
--     governance.policy.author, governance.trust_scan.run
--                                         (anchor governance.policy.manage)
--     governance.access_review.campaign.manage,
--     governance.access_review.decide     (anchor identity.access_review.action)
--   REVIEWER_LEAD, DEPARTMENT_ADMIN, WORKSPACE_ADMIN — nothing new: exchange
--     initiation and department membership keep the permission already
--     carried, and WORKSPACE_ADMIN admitted nothing.
--
-- A grant's expiry is the earlier of its tier's and its anchor's (no expiry
-- on either side means none); its grantor is the tier's. A member suspended
-- today receives the grant too (it is inert until they are reinstated).
--
-- These permissions are new: any capability row that already carries one was
-- written deliberately by the capability writer, so it is left exactly as it
-- is (ON CONFLICT DO NOTHING) — a re-run, or an administrator's later
-- revocation, is never overridden. Nothing is deleted. Idempotent.

WITH "tier_floor" ("tier", "permission", "anchor") AS (
  VALUES
    ('GLOBAL_ADMIN', 'governance.exchange.decide', 'governance.exchange.manage'),
    ('GLOBAL_ADMIN', 'governance.department.define', 'governance.policy.manage'),
    ('GLOBAL_ADMIN', 'integration.lifecycle_webhook.manage', 'integration.webhook.manage'),
    ('GLOBAL_ADMIN', 'governance.archive.transition', 'governance.retention.manage'),
    ('GLOBAL_ADMIN', 'governance.policy.assign', 'governance.policy.manage'),
    ('GLOBAL_ADMIN', 'governance.retention_policy.manage', 'governance.retention.manage'),
    ('GLOBAL_ADMIN', 'governance.destruction.request', 'governance.retention.manage'),
    ('GLOBAL_ADMIN', 'governance.destruction.approve', 'governance.retention.manage'),
    ('GLOBAL_ADMIN', 'audit.lifecycle_package.preview', 'audit.read'),
    ('GLOBAL_ADMIN', 'audit.verification_package.preview', 'audit.read'),
    ('GLOBAL_ADMIN', 'trust.article.publish', 'governance.policy.manage'),
    ('GLOBAL_ADMIN', 'trust.subprocessor.manage', 'governance.policy.manage'),
    ('GLOBAL_ADMIN', 'trust.status.manage', 'identity.org_policy.manage'),
    ('GLOBAL_ADMIN', 'governance.access_review.decide', 'identity.access_review.action'),
    ('ORG_ADMIN', 'governance.exchange.decide', 'governance.exchange.manage'),
    ('ORG_ADMIN', 'governance.department.define', 'governance.policy.manage'),
    ('ORG_ADMIN', 'integration.lifecycle_webhook.manage', 'integration.webhook.manage'),
    ('ORG_ADMIN', 'governance.archive.transition', 'governance.retention.manage'),
    ('ORG_ADMIN', 'governance.policy.assign', 'governance.policy.manage'),
    ('ORG_ADMIN', 'governance.retention_policy.manage', 'governance.retention.manage'),
    ('ORG_ADMIN', 'governance.destruction.request', 'governance.retention.manage'),
    ('ORG_ADMIN', 'governance.destruction.approve', 'governance.retention.manage'),
    ('ORG_ADMIN', 'audit.lifecycle_package.preview', 'audit.read'),
    ('ORG_ADMIN', 'audit.verification_package.preview', 'audit.read'),
    ('ORG_ADMIN', 'trust.article.publish', 'governance.policy.manage'),
    ('ORG_ADMIN', 'trust.subprocessor.manage', 'governance.policy.manage'),
    ('ORG_ADMIN', 'trust.status.manage', 'identity.org_policy.manage'),
    ('ORG_ADMIN', 'governance.access_review.decide', 'identity.access_review.action'),
    ('COMPLIANCE_OFFICER', 'governance.retention_policy.manage', 'governance.retention.manage'),
    ('COMPLIANCE_OFFICER', 'governance.destruction.request', 'governance.retention.manage'),
    ('COMPLIANCE_OFFICER', 'governance.destruction.approve', 'governance.retention.manage'),
    ('COMPLIANCE_OFFICER', 'governance.destruction.execute', 'governance.retention.manage'),
    ('COMPLIANCE_OFFICER', 'audit.lifecycle_package.preview', 'audit.read'),
    ('COMPLIANCE_OFFICER', 'audit.verification_package.preview', 'audit.read'),
    ('COMPLIANCE_OFFICER', 'trust.article.publish', 'governance.policy.manage'),
    ('COMPLIANCE_OFFICER', 'trust.article.ai_disclosure.publish', 'governance.policy.manage'),
    ('COMPLIANCE_OFFICER', 'trust.subprocessor.manage', 'governance.policy.manage'),
    ('COMPLIANCE_OFFICER', 'governance.policy.author', 'governance.policy.manage'),
    ('COMPLIANCE_OFFICER', 'governance.trust_scan.run', 'governance.policy.manage'),
    ('COMPLIANCE_OFFICER', 'governance.access_review.campaign.manage', 'identity.access_review.action'),
    ('COMPLIANCE_OFFICER', 'governance.access_review.decide', 'identity.access_review.action'),
    ('SECURITY_OFFICER', 'governance.destruction.approve', 'identity.org_policy.manage'),
    ('SECURITY_OFFICER', 'trust.article.security.publish', 'identity.org_policy.manage'),
    ('SECURITY_OFFICER', 'trust.status.manage', 'identity.org_policy.manage'),
    ('SECURITY_OFFICER', 'audit.verification_package.preview', 'audit.read'),
    ('SECURITY_OFFICER', 'trust.article.publish', 'governance.policy.manage'),
    ('SECURITY_OFFICER', 'trust.article.ai_disclosure.publish', 'governance.policy.manage'),
    ('SECURITY_OFFICER', 'governance.policy.author', 'governance.policy.manage'),
    ('SECURITY_OFFICER', 'governance.trust_scan.run', 'governance.policy.manage'),
    ('SECURITY_OFFICER', 'governance.access_review.campaign.manage', 'identity.access_review.action'),
    ('SECURITY_OFFICER', 'governance.access_review.decide', 'identity.access_review.action')
),
"floor" AS (
  SELECT DISTINCT ON (m."id", tf."permission")
         m."id" AS "team_member_id",
         g."team_id",
         tf."permission",
         g."id" AS "tier_grant_id",
         g."tier",
         g."granted_by_user_id",
         CASE
           WHEN g."expires_at_utc" IS NULL THEN a."expires_at_utc"
           WHEN a."expires_at_utc" IS NULL THEN g."expires_at_utc"
           ELSE LEAST(g."expires_at_utc", a."expires_at_utc")
         END AS "expires_at_utc"
    FROM "delegated_admin_grants" g
    JOIN "tier_floor" tf ON tf."tier" = g."tier"
    JOIN "team_members" m
      ON m."team_id" = g."team_id"
     AND m."user_id" = g."granted_to_user_id"
     AND m."status" IN ('ACTIVE', 'SUSPENDED')
    JOIN "member_capability_grants" a
      ON a."team_member_id" = m."id"
     AND a."permission" = tf."anchor"
     AND a."revoked_at_utc" IS NULL
     AND (a."expires_at_utc" IS NULL OR a."expires_at_utc" > NOW())
   WHERE g."state" = 'CONVERGED'
     AND g."revoked_at_utc" IS NULL
     AND (g."expires_at_utc" IS NULL OR g."expires_at_utc" > NOW())
   ORDER BY m."id", tf."permission",
            (CASE
               WHEN g."expires_at_utc" IS NULL THEN a."expires_at_utc"
               WHEN a."expires_at_utc" IS NULL THEN g."expires_at_utc"
               ELSE LEAST(g."expires_at_utc", a."expires_at_utc")
             END) DESC NULLS FIRST,
            g."id"
)
INSERT INTO "member_capability_grants"
  ("id", "team_member_id", "team_id", "permission", "reason",
   "granted_at_utc", "granted_by_user_id", "expires_at_utc", "created_at", "updated_at")
SELECT gen_random_uuid(),
       f."team_member_id",
       f."team_id",
       f."permission",
       LEFT('Delegated-administration floor: carried from tier ' || f."tier" || ' (grant ' || f."tier_grant_id" || ')', 400),
       NOW(),
       f."granted_by_user_id",
       f."expires_at_utc",
       NOW(),
       NOW()
  FROM "floor" f
ON CONFLICT ("team_member_id", "permission") DO NOTHING;
