-- =============================================================================
-- 2026-11-20 — M676 / WS-SCHED (DEC-04): a derived-artifact job RESERVES the
-- bytes it is about to write, before any byte goes under Object Lock.
--
-- The derived-asset storage gate (thumbnails, frames, waveforms, proxies, the
-- combined screen recording) was check-then-write: concurrent derived jobs of
-- one workspace each read the same committed usage, each passed, and together
-- overshot the allowance by one derived object per concurrent job.
--
-- `storage_reserved_bytes` is the size the worker admitted under the workspace
-- capacity lock (the advisory lock the API's admission and completion take),
-- written in a short transaction that ends before the upload starts;
-- `storage_reserved_at_utc` is when. A reservation counts in both usage
-- meters (API workspace-usage, worker getWorkspaceUsage, through the one
-- shared sum) only while it is younger than the media-intelligence run lease
-- (20 minutes), so a worker that died stops counting by itself. The row's
-- settling write (`recordDerivedAsset`, COMPLETED / FAILED / UNSUPPORTED)
-- clears both columns in the same statement; an aborted job clears them.
--
-- EXPAND / SAFE_TO_APPLY_NOW. Two nullable columns, no default, no backfill,
-- no NOT NULL, no index, no table rewrite. NULL means "nothing reserved":
-- every existing row and every row an older image writes. An older image never
-- reads or writes them. Rollback: leave the columns (NULL is the old
-- behaviour).
-- =============================================================================

ALTER TABLE "evidence_part_derived_assets"
  ADD COLUMN "storage_reserved_bytes" BIGINT,
  ADD COLUMN "storage_reserved_at_utc" TIMESTAMPTZ(6);
