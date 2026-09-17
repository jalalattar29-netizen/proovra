-- =============================================================================
-- UC-0 (A3) — RETIRE the narrow per-kind derived-asset unique key.
--
-- `EvidencePartDerivedAsset` has carried two unique keys since UC-0:
--
--   * evidence_part_derived_assets_team_part_kind_variant_uk
--       (team_id, evidence_part_id, asset_kind, variant_key)  -- the canonical
--   * evidence_part_derived_assets_team_part_kind_uk
--       (team_id, evidence_part_id, asset_kind)               -- the narrow one
--
-- The narrow key forbids a second variant of one kind on the same part, which
-- blocks multiple deterministic variants (e.g. UC-4 keyframes). It was retained
-- through UC-0 (expand/contract) because the pre-UC-0 image upserts
-- `ON CONFLICT (team_id, evidence_part_id, asset_kind)` against it; dropping it
-- under that image would fail every derived-asset write.
--
-- This is the CONTRACT half. The composite key keeps identical variants
-- idempotent (same 4-tuple = one row) while letting distinct variants coexist.
--
-- ORDER: apply ONLY after the UC-0 image is live everywhere. The UC-0 image
-- upserts against the composite key, so it does not need the narrow one; an
-- image that predates UC-0 does, which is the ordering hazard this note names.
-- =============================================================================

-- READINESS GUARD + CONTRACT, in ONE block so the guard authorises the drop:
-- the RAISE runs first and the DROP runs only after it, and only while the
-- composite key still enforces per-variant uniqueness. If the composite key is
-- absent, dropping the narrow key would leave derived assets with NO uniqueness
-- at all — refuse rather than silently allow duplicate identical variants.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname = 'evidence_part_derived_assets_team_part_kind_variant_uk'
  ) THEN
    RAISE EXCEPTION
      'derived-asset variant contract refused: the composite variant unique key is missing, so removing the narrow key would leave no uniqueness';
  END IF;
  EXECUTE 'DROP INDEX IF EXISTS "evidence_part_derived_assets_team_part_kind_uk"';
END $$;
