-- =============================================================================
-- UC-1 — DIRECT WEB CAPTURE acquisition mode.
--
-- Widens the two acquisition_mode CHECK constraints to admit the first
-- direct-capture mode, DIRECT_WEB_CAPTURE_EXTENSION, produced by the PROOVRA
-- browser extension through a server-issued capture session.
--
-- EXPAND / SAFE_TO_APPLY_NOW. A CHECK IN-list cannot be extended in place, so
-- each constraint is dropped and RE-ADDED with the same name and a strictly
-- WIDER value set (a constraint SWAP, not a removal): every existing row
-- already satisfies the narrower set, so it satisfies the wider one. Safe on
-- either image — the pre-UC-1 image writes only the three UC-0 modes, which the
-- widened constraint still admits; the UC-1 image writes the new mode, which
-- only the widened constraint admits, so this must be applied before that image.
--
-- Idempotent: DROP CONSTRAINT IF EXISTS then ADD; a re-run swaps identically.
-- =============================================================================

ALTER TABLE "evidence" DROP CONSTRAINT IF EXISTS "evidence_acquisition_mode_check";
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_acquisition_mode_check"
  CHECK ("acquisition_mode" IS NULL OR "acquisition_mode" IN (
    'PROOVRA_WEB_UPLOAD',
    'SECURE_INTAKE_LINK',
    'PROOVRA_MOBILE_APP',
    'DIRECT_WEB_CAPTURE_EXTENSION'
  ));

ALTER TABLE "capture_sessions" DROP CONSTRAINT IF EXISTS "capture_sessions_acquisition_mode_check";
ALTER TABLE "capture_sessions" ADD CONSTRAINT "capture_sessions_acquisition_mode_check"
  CHECK ("acquisition_mode" IS NULL OR "acquisition_mode" IN (
    'PROOVRA_WEB_UPLOAD',
    'SECURE_INTAKE_LINK',
    'PROOVRA_MOBILE_APP',
    'DIRECT_WEB_CAPTURE_EXTENSION'
  ));
