-- =============================================================================
-- UC-3 — ANDROID CONTINUOUS SCREEN CAPTURE acquisition mode.
--
-- Widens the two acquisition_mode CHECK constraints to admit
-- DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS, produced by the PROOVRA Android app
-- recording a continuous screen session (ordered segments) via MediaProjection
-- in a server-issued capture session. It joins the UC-1 web mode and the UC-2
-- deliberate-frame mode as the third `isDirectCapture` mode.
--
-- EXPAND / SAFE_TO_APPLY_NOW. A CHECK IN-list cannot be extended in place, so
-- each constraint is dropped and RE-ADDED with the same name and a strictly
-- WIDER value set (a constraint SWAP, not a removal): every existing row already
-- satisfies the narrower set, so it satisfies the wider one. Safe on either
-- image — the pre-UC-3 image writes only the five prior modes, which the widened
-- constraint still admits; the UC-3 image writes the new mode, which only the
-- widened constraint admits, so this must be applied before that image.
--
-- Idempotent: DROP CONSTRAINT IF EXISTS then ADD; a re-run swaps identically.
-- =============================================================================

ALTER TABLE "evidence" DROP CONSTRAINT IF EXISTS "evidence_acquisition_mode_check";
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_acquisition_mode_check"
  CHECK ("acquisition_mode" IS NULL OR "acquisition_mode" IN (
    'PROOVRA_WEB_UPLOAD',
    'SECURE_INTAKE_LINK',
    'PROOVRA_MOBILE_APP',
    'DIRECT_WEB_CAPTURE_EXTENSION',
    'DIRECT_SCREEN_CAPTURE_ANDROID',
    'DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS'
  ));

ALTER TABLE "capture_sessions" DROP CONSTRAINT IF EXISTS "capture_sessions_acquisition_mode_check";
ALTER TABLE "capture_sessions" ADD CONSTRAINT "capture_sessions_acquisition_mode_check"
  CHECK ("acquisition_mode" IS NULL OR "acquisition_mode" IN (
    'PROOVRA_WEB_UPLOAD',
    'SECURE_INTAKE_LINK',
    'PROOVRA_MOBILE_APP',
    'DIRECT_WEB_CAPTURE_EXTENSION',
    'DIRECT_SCREEN_CAPTURE_ANDROID',
    'DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS'
  ));
