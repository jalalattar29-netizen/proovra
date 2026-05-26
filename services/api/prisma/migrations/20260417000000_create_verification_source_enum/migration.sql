-- =============================================================================
-- Phase 0 corrective migration — platform reproducibility recovery
-- =============================================================================
--
-- Context
-- -------
-- The runtime audit revealed that `prisma migrate deploy` against a clean
-- database failed at migration `20260418_report_snapshot_fields` with:
--
--   ERROR: type "VerificationSource" does not exist
--   ERROR: column "reviewer_summary_version" does not exist
--
-- Subsequent migrations failed on additional missing enums
-- (`CaptureMethod`, `IdentityLevel`, etc.). The `schema.prisma` file
-- declares these objects, but no Prisma migration ever created them.
-- Production environments worked because the objects were created
-- out-of-band by hand-written SQL "drift-patches" under
-- `services/api/sql/drift-patches/` and `services/api/prisma/sql/`.
--
-- This migration restores reproducibility from source by declaring all
-- enums and snapshot columns the later migration chain depends on.
-- It is timestamped BEFORE `20260418_report_snapshot_fields` and every
-- subsequent migration so that on a fresh database the required enums
-- exist when their first user runs.
--
-- Safety
-- ------
-- * Every CREATE TYPE is guarded by `pg_type` existence check.
-- * Every ALTER TABLE ADD COLUMN uses `IF NOT EXISTS`.
-- * Production environments already have these objects (created by
--   drift-patches); this migration is a no-op for them.
-- * Idempotent — running multiple times produces the same result.
-- * No row data is touched. No DROP. No RENAME of existing objects.
--
-- Production deployment notes
-- ---------------------------
-- If `20260418_report_snapshot_fields` is already marked applied in the
-- target database's `_prisma_migrations` table (Phase 0 didn't exist
-- when production was first brought up), Prisma will still try to apply
-- this earlier-timestamped migration on next `migrate deploy`. The
-- idempotent guards make this safe; the migration becomes a no-op and
-- is recorded in `_prisma_migrations`. Future deploys are then clean.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Create enums declared in schema.prisma but never emitted by a
--    Prisma migration (created out-of-band by drift-patches in prod).
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'VerificationSource') THEN
    CREATE TYPE "VerificationSource" AS ENUM (
      'REPORT_GENERATED',
      'PUBLIC_VERIFY_VIEWED',
      'TECHNICAL_VERIFICATION_CHECKED'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CaptureMethod') THEN
    CREATE TYPE "CaptureMethod" AS ENUM (
      'SECURE_CAMERA',
      'UPLOADED_FILE',
      'IMPORTED_DOCUMENT',
      'MULTIPART_PACKAGE',
      'EXTERNAL_INTAKE_UPLOAD'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CertificationStatus') THEN
    CREATE TYPE "CertificationStatus" AS ENUM ('DRAFT', 'REQUESTED', 'ATTESTED', 'REVOKED');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CertificationType') THEN
    CREATE TYPE "CertificationType" AS ENUM ('CUSTODIAN', 'QUALIFIED_PERSON');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DemoFollowUpStatus') THEN
    CREATE TYPE "DemoFollowUpStatus" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED', 'REPLIED', 'STOPPED');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DemoLeadQuality') THEN
    CREATE TYPE "DemoLeadQuality" AS ENUM ('LOW', 'MEDIUM', 'HIGH');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DemoLeadTrack') THEN
    CREATE TYPE "DemoLeadTrack" AS ENUM ('DISCOVERY', 'SALES', 'ENTERPRISE');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DemoRecommendedAction') THEN
    CREATE TYPE "DemoRecommendedAction" AS ENUM ('reply_with_resources', 'offer_demo', 'route_enterprise');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DemoRequestPriority') THEN
    CREATE TYPE "DemoRequestPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DemoRequestStatus') THEN
    CREATE TYPE "DemoRequestStatus" AS ENUM ('NEW', 'REVIEWED', 'CONTACTED', 'QUALIFIED', 'REJECTED', 'ARCHIVED');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DemoRoutingTarget') THEN
    CREATE TYPE "DemoRoutingTarget" AS ENUM ('AUTO_RESOURCES', 'AUTO_BOOKING', 'MANUAL_SALES', 'ENTERPRISE_DESK');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'IdentityLevel') THEN
    CREATE TYPE "IdentityLevel" AS ENUM (
      'BASIC_ACCOUNT',
      'VERIFIED_EMAIL',
      'OAUTH_BACKED_IDENTITY',
      'ORGANIZATION_ACCOUNT',
      'VERIFIED_ORGANIZATION'
    );
  END IF;

  -- Note: `mfa_challenge_purpose` and `mfa_recovery_request_status` are
  -- intentionally NOT created here — migration `20260724000000_r8_1_3_mfa_pending_challenges`
  -- and `20260725000000_r8_1_5_mfa_recovery_admin_ui` create them with
  -- `CREATE TYPE` (non-idempotent). Clean-DB deploys work because those
  -- run after this corrective; production environments have them via
  -- the same later migrations resolved by hand. If a later corrective
  -- pass needs to idempotent-guard those CREATE TYPE statements too,
  -- modify the respective migrations.

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OrganizationVerificationState') THEN
    CREATE TYPE "OrganizationVerificationState" AS ENUM ('UNVERIFIED', 'PENDING', 'VERIFIED');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'StorageAddonBillingCycle') THEN
    CREATE TYPE "StorageAddonBillingCycle" AS ENUM ('ONE_TIME', 'MONTHLY');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'StorageAddonKey') THEN
    CREATE TYPE "StorageAddonKey" AS ENUM (
      'PERSONAL_10_GB',
      'PERSONAL_50_GB',
      'PERSONAL_200_GB',
      'TEAM_100_GB',
      'TEAM_500_GB',
      'TEAM_1_TB'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'VerificationStatus') THEN
    CREATE TYPE "VerificationStatus" AS ENUM (
      'MATERIALS_AVAILABLE',
      'RECORDED_INTEGRITY_VERIFIED',
      'REVIEW_REQUIRED',
      'FAILED'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'VerificationViewerType') THEN
    CREATE TYPE "VerificationViewerType" AS ENUM ('PUBLIC', 'AUTHENTICATED', 'INTERNAL_REVIEWER');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WorkspaceStorageAddonStatus') THEN
    CREATE TYPE "WorkspaceStorageAddonStatus" AS ENUM (
      'PENDING',
      'ACTIVE',
      'PAST_DUE',
      'CANCELED',
      'EXPIRED',
      'FAILED'
    );
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- 2. Add the snapshot version columns that `20260418_report_snapshot_fields`
--    indexes but never explicitly adds. Production has them via out-of-band
--    SQL; fresh environments need them here before the index migration runs.
-- -----------------------------------------------------------------------------

ALTER TABLE "reports"
  ADD COLUMN IF NOT EXISTS "reviewer_summary_version"     INTEGER,
  ADD COLUMN IF NOT EXISTS "verification_package_version" INTEGER;
