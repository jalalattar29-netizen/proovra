-- Trust Center version-history drift repair.
--
-- Runtime evidence:
--   * services/api/src/services/trust/trust-center.service.ts writes
--     TrustCenterArticleVersion rows through Prisma.
--   * The current Prisma model declares `publishedAt @map("published_at")`
--     and `publishedAtUtc @map("published_at_utc")`.
--   * In the audited runtime database, `trust_center_article_versions`
--     has `published_at_utc` and `effective_at`, but is missing
--     `published_at`, causing Prisma writes to fail and the auto-seed path
--     for AI Disclosure / Security articles to silently degrade.
--
-- Hard rules:
--   * Additive only.
--   * Idempotent.
--   * Nullable-first.

ALTER TABLE IF EXISTS "trust_center_article_versions"
  ADD COLUMN IF NOT EXISTS "published_at" TIMESTAMPTZ(6);
