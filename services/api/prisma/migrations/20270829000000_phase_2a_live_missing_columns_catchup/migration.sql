-- Phase 2A — Live missing-columns catch-up
--
-- Scope:
--   * ONLY the 47 CRITICAL missing columns from the live production audit
--   * additive-only
--   * no DROP / no FK changes / no destructive enum work / no direct RENAME
--   * guarded null-only backfills where a clear legacy source exists
--
-- Notes:
--   * Required created_at / updated_at fields use NOW()-based defaults so
--     existing rows remain writable and future Prisma inserts are safe.
--   * Approval / campaign-window timestamps that carry historical governance
--     meaning stay nullable unless a real legacy source exists. Phase 2A
--     clears the missing-column CRITICALs without inventing dates.
--   * A few Prisma-required fields are added nullable on purpose when the
--     live table may already contain rows and there is no safe same-statement
--     NOT NULL promotion path for this phase. Those nullability mismatches
--     become Phase 2B HIGH drift, not Phase 2A CRITICAL missing-column drift.

-- 1. entitlement_grants
ALTER TABLE IF EXISTS "entitlement_grants"
  ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

-- 2. evidence_exchange_package_deliveries
ALTER TABLE IF EXISTS "evidence_exchange_package_deliveries"
  ADD COLUMN IF NOT EXISTS "delivered_at" TIMESTAMPTZ(6);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'evidence_exchange_package_deliveries'
       AND column_name = 'delivered_at'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'evidence_exchange_package_deliveries'
       AND column_name = 'delivered_at_utc'
  ) THEN
    EXECUTE $sql$
      UPDATE "evidence_exchange_package_deliveries"
         SET "delivered_at" = "delivered_at_utc"
       WHERE "delivered_at" IS NULL
         AND "delivered_at_utc" IS NOT NULL
    $sql$;
  END IF;
END $$;

ALTER TABLE IF EXISTS "evidence_exchange_package_deliveries"
  ALTER COLUMN "delivered_at" SET DEFAULT NOW();

-- 3. destruction_certificates
ALTER TABLE IF EXISTS "destruction_certificates"
  ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

-- 4. external_review_invitation_deliveries
ALTER TABLE IF EXISTS "external_review_invitation_deliveries"
  ADD COLUMN IF NOT EXISTS "provider_msg_id" VARCHAR(200);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'external_review_invitation_deliveries'
       AND column_name = 'provider_msg_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'external_review_invitation_deliveries'
       AND column_name = 'provider_message_id'
  ) THEN
    EXECUTE $sql$
      UPDATE "external_review_invitation_deliveries"
         SET "provider_msg_id" = "provider_message_id"
       WHERE "provider_msg_id" IS NULL
         AND "provider_message_id" IS NOT NULL
    $sql$;
  END IF;
END $$;

-- 5. redaction_versions
ALTER TABLE IF EXISTS "redaction_versions"
  ADD COLUMN IF NOT EXISTS "artifact_kind" VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "created_by_user_id" UUID,
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'redaction_versions'
       AND column_name = 'created_by_user_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'redaction_versions'
       AND column_name = 'authored_by_user_id'
  ) THEN
    EXECUTE $sql$
      UPDATE "redaction_versions"
         SET "created_by_user_id" = "authored_by_user_id"
       WHERE "created_by_user_id" IS NULL
         AND "authored_by_user_id" IS NOT NULL
    $sql$;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'redaction_versions'
       AND column_name = 'artifact_kind'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'redaction_versions'
       AND column_name = 'project_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'redaction_projects'
       AND column_name = 'artifact_kind'
  ) THEN
    EXECUTE $sql$
      UPDATE "redaction_versions" AS rv
         SET "artifact_kind" = rp."artifact_kind"
        FROM "redaction_projects" AS rp
       WHERE rv."artifact_kind" IS NULL
         AND rp."artifact_kind" IS NOT NULL
         AND rp."id" = rv."project_id"
    $sql$;
  END IF;
END $$;

-- 6. redaction_regions
ALTER TABLE IF EXISTS "redaction_regions"
  ADD COLUMN IF NOT EXISTS "label" VARCHAR(200),
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

-- 7. redaction_detections
ALTER TABLE IF EXISTS "redaction_detections"
  ADD COLUMN IF NOT EXISTS "detection_kind" VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "confidence" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "geometry" JSONB,
  ADD COLUMN IF NOT EXISTS "payload" JSONB,
  ADD COLUMN IF NOT EXISTS "state" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'redaction_detections'
       AND column_name = 'detection_kind'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'redaction_detections'
       AND column_name = 'kind'
  ) THEN
    EXECUTE $sql$
      UPDATE "redaction_detections"
         SET "detection_kind" = "kind"
       WHERE "detection_kind" IS NULL
         AND "kind" IS NOT NULL
    $sql$;
  END IF;
END $$;

-- 8. redaction_decisions
ALTER TABLE IF EXISTS "redaction_decisions"
  ADD COLUMN IF NOT EXISTS "region_id" UUID,
  ADD COLUMN IF NOT EXISTS "state" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

-- 9. redaction_approvals
ALTER TABLE IF EXISTS "redaction_approvals"
  ADD COLUMN IF NOT EXISTS "approved_by_user_id" UUID,
  ADD COLUMN IF NOT EXISTS "approved_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'redaction_approvals'
       AND column_name = 'approved_by_user_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'redaction_approvals'
       AND column_name = 'approver_user_id'
  ) THEN
    EXECUTE $sql$
      UPDATE "redaction_approvals"
         SET "approved_by_user_id" = "approver_user_id"
       WHERE "approved_by_user_id" IS NULL
         AND "approver_user_id" IS NOT NULL
    $sql$;
  END IF;
END $$;

-- 10. redaction_derivatives
ALTER TABLE IF EXISTS "redaction_derivatives"
  ADD COLUMN IF NOT EXISTS "generated_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

-- 11. departments
ALTER TABLE IF EXISTS "departments"
  ADD COLUMN IF NOT EXISTS "parent_id" UUID;

-- 12. governance_policies
ALTER TABLE IF EXISTS "governance_policies"
  ADD COLUMN IF NOT EXISTS "config" JSONB NOT NULL DEFAULT '{}'::jsonb;

-- 13. governance_policy_assignments
ALTER TABLE IF EXISTS "governance_policy_assignments"
  ADD COLUMN IF NOT EXISTS "scope_kind" VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMPTZ(6);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'governance_policy_assignments'
       AND column_name = 'scope_kind'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'governance_policy_assignments'
       AND column_name = 'scope'
  ) THEN
    EXECUTE $sql$
      UPDATE "governance_policy_assignments"
         SET "scope_kind" = "scope"
       WHERE "scope_kind" IS NULL
         AND "scope" IS NOT NULL
    $sql$;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'governance_policy_assignments'
       AND column_name = 'created_at'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'governance_policy_assignments'
       AND column_name = 'assigned_at_utc'
  ) THEN
    EXECUTE $sql$
      UPDATE "governance_policy_assignments"
         SET "created_at" = "assigned_at_utc"
       WHERE "created_at" IS NULL
         AND "assigned_at_utc" IS NOT NULL
    $sql$;
  END IF;
END $$;

ALTER TABLE IF EXISTS "governance_policy_assignments"
  ALTER COLUMN "created_at" SET DEFAULT NOW();

-- 14. access_review_campaigns
ALTER TABLE IF EXISTS "access_review_campaigns"
  ADD COLUMN IF NOT EXISTS "title" VARCHAR(300),
  ADD COLUMN IF NOT EXISTS "starts_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "ends_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "completed_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'access_review_campaigns'
       AND column_name = 'title'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'access_review_campaigns'
       AND column_name = 'name'
  ) THEN
    EXECUTE $sql$
      UPDATE "access_review_campaigns"
         SET "title" = "name"
       WHERE "title" IS NULL
         AND "name" IS NOT NULL
    $sql$;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'access_review_campaigns'
       AND column_name = 'starts_at_utc'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'access_review_campaigns'
       AND column_name = 'scheduled_start_utc'
  ) THEN
    EXECUTE $sql$
      UPDATE "access_review_campaigns"
         SET "starts_at_utc" = "scheduled_start_utc"
       WHERE "starts_at_utc" IS NULL
         AND "scheduled_start_utc" IS NOT NULL
    $sql$;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'access_review_campaigns'
       AND column_name = 'ends_at_utc'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'access_review_campaigns'
       AND column_name = 'scheduled_end_utc'
  ) THEN
    EXECUTE $sql$
      UPDATE "access_review_campaigns"
         SET "ends_at_utc" = "scheduled_end_utc"
       WHERE "ends_at_utc" IS NULL
         AND "scheduled_end_utc" IS NOT NULL
    $sql$;
  END IF;
END $$;

-- 15. access_review_items
ALTER TABLE IF EXISTS "access_review_items"
  ADD COLUMN IF NOT EXISTS "rationale" VARCHAR(800),
  ADD COLUMN IF NOT EXISTS "decided_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

-- 16. cross_org_review_grants
ALTER TABLE IF EXISTS "cross_org_review_grants"
  ADD COLUMN IF NOT EXISTS "target_org_id" UUID,
  ADD COLUMN IF NOT EXISTS "granted_by_user_id" UUID,
  ADD COLUMN IF NOT EXISTS "revoked_at_utc" TIMESTAMPTZ(6);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'cross_org_review_grants'
       AND column_name = 'target_org_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'cross_org_review_grants'
       AND column_name = 'invited_organization_id'
  ) THEN
    EXECUTE $sql$
      UPDATE "cross_org_review_grants"
         SET "target_org_id" = "invited_organization_id"
       WHERE "target_org_id" IS NULL
         AND "invited_organization_id" IS NOT NULL
    $sql$;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'cross_org_review_grants'
       AND column_name = 'granted_by_user_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'cross_org_review_grants'
       AND column_name = 'created_by_user_id'
  ) THEN
    EXECUTE $sql$
      UPDATE "cross_org_review_grants"
         SET "granted_by_user_id" = "created_by_user_id"
       WHERE "granted_by_user_id" IS NULL
         AND "created_by_user_id" IS NOT NULL
    $sql$;
  END IF;
END $$;

-- 17. media_intelligence_records
ALTER TABLE IF EXISTS "media_intelligence_records"
  ADD COLUMN IF NOT EXISTS "reviewed_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'media_intelligence_records'
       AND column_name = 'reviewed_at'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'media_intelligence_records'
       AND column_name = 'reviewed_at_utc'
  ) THEN
    EXECUTE $sql$
      UPDATE "media_intelligence_records"
         SET "reviewed_at" = "reviewed_at_utc"
       WHERE "reviewed_at" IS NULL
         AND "reviewed_at_utc" IS NOT NULL
    $sql$;
  END IF;
END $$;

-- 18. redaction_policy_versions
ALTER TABLE IF EXISTS "redaction_policy_versions"
  ADD COLUMN IF NOT EXISTS "published_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'redaction_policy_versions'
       AND column_name = 'published_at'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'redaction_policy_versions'
       AND column_name = 'published_at_utc'
  ) THEN
    EXECUTE $sql$
      UPDATE "redaction_policy_versions"
         SET "published_at" = "published_at_utc"
       WHERE "published_at" IS NULL
         AND "published_at_utc" IS NOT NULL
    $sql$;
  END IF;
END $$;

-- 19. department_memberships
ALTER TABLE IF EXISTS "department_memberships"
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

-- 20. video_tracks
ALTER TABLE IF EXISTS "video_tracks"
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();
