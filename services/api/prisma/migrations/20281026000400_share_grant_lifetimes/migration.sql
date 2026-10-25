-- SHARE-GRANT LIFETIMES (members audit SEC-08, owner decision 2026-10-25).
--
-- Grants held in a person's name — owner share links (verification share
-- tokens with purpose OWNER_SHARE) and external-review grants — now live at
-- most 30 days per issue or renewal, and end when their creator leaves.
-- Existing rows predate both rules. This backfill applies them forward,
-- conditioned on exactly the rows that break them, and deletes nothing:
--
--   1. a live owner link with NO expiry, or one further away than 30 days,
--      gets an expiry 30 days from now (a notice period, not an instant cut);
--   2. a live external-review grant further away than 30 days is moved to 30
--      days from now;
--   3. a live owner link whose creator holds no ACTIVE membership of the
--      link's workspace is revoked (reason CREATOR_REMOVED);
--   4. a live external-review grant whose inviter holds no ACTIVE membership
--      of the grant's workspace is revoked.
--
-- NOT TOUCHED: the record's canonical pvr_ reference and the share tokens an
-- issued REPORT or PACKAGE carries (purpose REPORT / PACKAGE) — publication
-- state, which keeps an issued report's QR code verifying. Revoked and
-- expired rows are left as they are. Every statement is conditioned, so a
-- second application changes nothing.

UPDATE "verification_share_tokens"
   SET "expires_at_utc" = NOW() + INTERVAL '30 days'
 WHERE "purpose" = 'OWNER_SHARE'
   AND "revoked_at_utc" IS NULL
   AND ("expires_at_utc" IS NULL OR "expires_at_utc" > NOW() + INTERVAL '30 days');

UPDATE "external_review_grants"
   SET "expires_at_utc" = NOW() + INTERVAL '30 days',
       "updated_at_utc" = NOW()
 WHERE "state" IN ('INVITED', 'ACTIVE')
   AND "expires_at_utc" > NOW() + INTERVAL '30 days';

UPDATE "verification_share_tokens" t
   SET "revoked_at_utc" = NOW(),
       "revocation_reason" = 'CREATOR_REMOVED'
 WHERE t."purpose" = 'OWNER_SHARE'
   AND t."revoked_at_utc" IS NULL
   AND t."team_id" IS NOT NULL
   AND t."created_by_user_id" IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM "team_members" m
      WHERE m."team_id" = t."team_id"
        AND m."user_id" = t."created_by_user_id"
        AND m."status" = 'ACTIVE'
   );

UPDATE "external_review_grants" g
   SET "state" = 'REVOKED',
       "revoked_at_utc" = NOW(),
       "updated_at_utc" = NOW()
 WHERE g."state" IN ('INVITED', 'ACTIVE')
   AND NOT EXISTS (
     SELECT 1 FROM "team_members" m
      WHERE m."team_id" = g."team_id"
        AND m."user_id" = g."invited_by_user_id"
        AND m."status" = 'ACTIVE'
   );
