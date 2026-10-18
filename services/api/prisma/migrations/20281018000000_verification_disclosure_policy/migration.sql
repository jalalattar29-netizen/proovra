-- =============================================================================
-- VERIFICATION DISCLOSURE POLICY (2026-10-18). EXPAND + DETERMINISTIC BACKFILL.
--
-- PROOVRA has three access surfaces: the owner workspace, the record's
-- permanent canonical Public Verify reference (pvr_), and revocable reviewer
-- shares (pvs_). The pvr_ page always opens (subject only to the record's
-- verification ACCESS state and lifecycle) and always states the complete
-- verification truth. What it DISCLOSES about the record's content is the
-- record's disclosure policy, written here and nowhere else:
--
--   verification_disclosure_mode   VERIFICATION_ONLY (default) | CONTENT_PREVIEW
--   show_recorded_location         false (default); true only with CONTENT_PREVIEW
--
-- The legacy publication column (public_verify_state) is retired: after this
-- migration no code writes it and no code reads it. It is kept, read-only, so a
-- rollback to the previous image finds the column it expects. A later contract
-- migration drops it.
--
-- MAPPING (fail closed; deterministic):
--   PUBLISHED                         -> CONTENT_PREVIEW, location false
--   NOT_PUBLISHED / UNPUBLISHED /
--   SUSPENDED                         -> VERIFICATION_ONLY (the column default)
-- Nothing becomes more disclosed except a record its owner had already
-- published under the old model. Recorded location is never shown by this
-- migration: no prior owner decision about location existed.
--
-- SUSPENDED / UNPUBLISHED were publication states that hid the owner's
-- recipient links. Those links (purpose OWNER_SHARE) answer 404 today; under
-- the new model a reviewer share is gated only by its own state, so every
-- active OWNER_SHARE link of a record that is not PUBLISHED is revoked here
-- (reason DISCLOSURE_MODEL_MIGRATION). It answered "not found" before and
-- answers "link no longer active" after; it never starts disclosing.
-- Report/package links (purpose REPORT / PACKAGE) are canonical identifiers of
-- the record and are not touched.
--
-- verification_access_state (AVAILABLE | WITHDRAWN | SUSPENDED) is unchanged:
-- access is an independent axis and is preserved exactly.
--
-- NEVER TOUCHED: evidence bytes, hashes, signatures, custody events, retention,
-- Object Lock, reports, packages, artifacts or their storage.
--
-- IDEMPOTENT. Every statement is guarded: the columns by IF NOT EXISTS, the
-- backfill by "still at the pristine default" (version 0, never changed), the
-- revocation by "not yet revoked". Re-applying the file is a no-op, and a
-- record whose owner has since chosen a policy is never overwritten.
--
-- SAFE BEFORE THE NEW CODE. Columns are additive with constant defaults
-- (catalogue-only). The previous image neither reads nor writes them.
--
-- ROLLBACK (code-first): redeploy the previous image. It reads
-- public_verify_state, which this migration does not modify. Owner policy
-- changes made under the new image are not mirrored back (fail closed: the
-- previous image's publication state is what it was before the deploy). The
-- columns may stay; to remove them:
--   ALTER TABLE "evidence" DROP CONSTRAINT IF EXISTS "evidence_verification_disclosure_mode_check",
--     DROP CONSTRAINT IF EXISTS "evidence_recorded_location_requires_content_preview",
--     DROP COLUMN IF EXISTS "verification_disclosure_mode", DROP COLUMN IF EXISTS "show_recorded_location",
--     DROP COLUMN IF EXISTS "verification_disclosure_version",
--     DROP COLUMN IF EXISTS "verification_disclosure_changed_at_utc",
--     DROP COLUMN IF EXISTS "verification_disclosure_changed_by_user_id";
--   ALTER TABLE "verification_share_tokens" DROP COLUMN IF EXISTS "allow_original_download";
-- Revoked links are not reinstated automatically (they answered 404 before).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0. Pre-migration aggregates (counts only; no identifiers).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT "public_verify_state"::text AS state, "verification_access_state" AS access, count(*) AS n
      FROM "evidence" GROUP BY 1, 2 ORDER BY 1, 2
  LOOP
    RAISE NOTICE 'disclosure-migration pre: public_verify_state=% access=% count=%', r.state, r.access, r.n;
  END LOOP;
  SELECT count(*) AS n INTO r FROM "verification_share_tokens"
   WHERE "revoked_at_utc" IS NULL AND "purpose" = 'OWNER_SHARE';
  RAISE NOTICE 'disclosure-migration pre: active OWNER_SHARE links=%', r.n;
END $$;

-- ---------------------------------------------------------------------------
-- 1. The canonical disclosure policy.
-- ---------------------------------------------------------------------------
ALTER TABLE "evidence"
  ADD COLUMN IF NOT EXISTS "verification_disclosure_mode" VARCHAR(24) NOT NULL DEFAULT 'VERIFICATION_ONLY',
  ADD COLUMN IF NOT EXISTS "show_recorded_location" BOOLEAN NOT NULL DEFAULT false,
  -- Compare-and-swap token for owner policy changes; 0 = never changed.
  ADD COLUMN IF NOT EXISTS "verification_disclosure_version" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "verification_disclosure_changed_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "verification_disclosure_changed_by_user_id" UUID;

ALTER TABLE "evidence" DROP CONSTRAINT IF EXISTS "evidence_verification_disclosure_mode_check";
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_verification_disclosure_mode_check"
  CHECK ("verification_disclosure_mode" IN ('VERIFICATION_ONLY', 'CONTENT_PREVIEW'));

-- Location is only meaningful with content preview: the database refuses a
-- combination no reader could interpret.
ALTER TABLE "evidence" DROP CONSTRAINT IF EXISTS "evidence_recorded_location_requires_content_preview";
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_recorded_location_requires_content_preview"
  CHECK (NOT "show_recorded_location" OR "verification_disclosure_mode" = 'CONTENT_PREVIEW');

-- ---------------------------------------------------------------------------
-- 2. Reviewer shares: an original download is an explicit per-link grant.
-- ---------------------------------------------------------------------------
ALTER TABLE "verification_share_tokens"
  ADD COLUMN IF NOT EXISTS "allow_original_download" BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- 3. Audit trail value for owner policy changes (administrative, not forensic).
-- ---------------------------------------------------------------------------
ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'VERIFICATION_DISCLOSURE_CHANGED';

-- ---------------------------------------------------------------------------
-- 4. Deterministic backfill: an owner-published record keeps showing content.
-- ---------------------------------------------------------------------------
UPDATE "evidence"
   SET "verification_disclosure_mode" = 'CONTENT_PREVIEW'
 WHERE "public_verify_state" = 'PUBLISHED'
   AND "verification_disclosure_mode" = 'VERIFICATION_ONLY'
   AND "verification_disclosure_version" = 0
   AND "verification_disclosure_changed_at_utc" IS NULL;

-- ---------------------------------------------------------------------------
-- 5. Recipient links that were hidden by a non-published state stay closed.
-- ---------------------------------------------------------------------------
UPDATE "verification_share_tokens" t
   SET "revoked_at_utc" = CURRENT_TIMESTAMP,
       "revocation_reason" = 'DISCLOSURE_MODEL_MIGRATION'
  FROM "evidence" e
 WHERE t."evidence_id" = e."id"
   AND t."purpose" = 'OWNER_SHARE'
   AND t."revoked_at_utc" IS NULL
   AND e."public_verify_state" <> 'PUBLISHED';

-- ---------------------------------------------------------------------------
-- 6. Post-migration aggregates.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT "public_verify_state"::text AS state, "verification_disclosure_mode" AS mode,
           "show_recorded_location" AS loc, count(*) AS n
      FROM "evidence" GROUP BY 1, 2, 3 ORDER BY 1, 2, 3
  LOOP
    RAISE NOTICE 'disclosure-migration post: public_verify_state=% mode=% location=% count=%', r.state, r.mode, r.loc, r.n;
  END LOOP;
  SELECT count(*) AS n INTO r FROM "verification_share_tokens"
   WHERE "revocation_reason" = 'DISCLOSURE_MODEL_MIGRATION';
  RAISE NOTICE 'disclosure-migration post: OWNER_SHARE links closed by this migration=%', r.n;
END $$;
