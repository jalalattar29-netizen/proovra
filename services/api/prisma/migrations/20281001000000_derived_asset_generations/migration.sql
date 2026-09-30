-- UC-DER-005 / UC-DER-006 / UC-DER-014 — derivative generations are preserved and self-describing.
--
-- 1. A regenerated derivative no longer overwrites its predecessor: the previous row is marked
--    SUPERSEDED and its object is kept. Widen the status catalog (strict superset; no existing
--    row can violate it). Constraint swap, not a destructive drop.
-- 2. The readable generation parameters (tool + version, producer parameters, the source read:
--    object version, bytes read, whole-or-prefix, digest of what was read). parameters_sha256
--    (existing column) is the SHA-256 of its canonical JSON.
--
-- EXPAND. Additive and idempotent. Apply BEFORE the API/worker images that write the column.
ALTER TABLE "evidence_part_derived_assets"
  DROP CONSTRAINT IF EXISTS "evidence_part_derived_assets_status_bounded";
ALTER TABLE "evidence_part_derived_assets"
  ADD CONSTRAINT "evidence_part_derived_assets_status_bounded"
  CHECK ("status" IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'UNSUPPORTED', 'SUPERSEDED'));

ALTER TABLE "evidence_part_derived_assets"
  ADD COLUMN IF NOT EXISTS "generation_parameters" JSONB;
