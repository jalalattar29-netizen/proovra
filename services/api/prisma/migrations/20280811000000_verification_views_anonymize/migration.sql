-- =============================================================================
-- VERIFICATION VIEW ANONYMIZATION (2026-09-30, ET-PKG-09). BACKFILL.
--
-- Every anonymous public Verify view stored the viewer's full IP address and
-- user agent in verification_views, with no retention and no reader (the only
-- readers select evidence_id / viewer_type / created_at, or count rows). The
-- write path now stores only a masked network prefix (IPv4 a.b.x.x, IPv6 the
-- first two groups) and no user agent. This rewrites the rows written before.
--
-- Idempotent: each UPDATE is conditioned so an already-anonymized row is never
-- touched again; re-running is a no-op. No column, table or index changes.
-- =============================================================================

UPDATE "verification_views"
   SET "user_agent" = NULL
 WHERE "user_agent" IS NOT NULL;

UPDATE "verification_views"
   SET "ip_address" = CASE
     WHEN regexp_replace("ip_address", '^::ffff:', '', 'i') ~ '^\d{1,3}(\.\d{1,3}){3}$'
       THEN split_part(regexp_replace("ip_address", '^::ffff:', '', 'i'), '.', 1) || '.'
         || split_part(regexp_replace("ip_address", '^::ffff:', '', 'i'), '.', 2) || '.x.x'
     WHEN "ip_address" LIKE '%:%' AND split_part("ip_address", ':', 1) <> '' AND split_part("ip_address", ':', 2) <> ''
       THEN split_part("ip_address", ':', 1) || ':' || split_part("ip_address", ':', 2) || ':…'
     ELSE NULL
   END
 WHERE "ip_address" IS NOT NULL
   AND "ip_address" !~ '\.x\.x$'
   AND "ip_address" !~ ':…$';
