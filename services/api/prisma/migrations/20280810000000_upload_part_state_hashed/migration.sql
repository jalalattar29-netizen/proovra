-- =============================================================================
-- UPLOAD PART STATE HASHED (2026-09-30, ET-UPL-05).
--
-- Multipart completion marked every part VERIFIED whenever the server hashed
-- the completed object, even when the client declared no reference hash — so
-- nothing had been verified against anything. A part settled that way is now
-- HASHED (server digest recorded, no verified_at); VERIFIED means the digest
-- matched a declared reference.
--
-- EXPAND / SAFE_TO_APPLY_NOW. A CHECK IN-list cannot be extended in place, so
-- the constraint is dropped and RE-ADDED with the same name and a strictly
-- WIDER value set (a constraint SWAP, not a removal): every existing row
-- already satisfies the narrower set. The pre-ET-UPL-05 image never writes
-- HASHED; the new image does, so apply this BEFORE that image.
--
-- Idempotent: DROP CONSTRAINT IF EXISTS then ADD; a re-run swaps identically.
-- =============================================================================

ALTER TABLE "evidence_upload_session_parts" DROP CONSTRAINT IF EXISTS "evidence_upload_session_parts_state_bounded";
ALTER TABLE "evidence_upload_session_parts" ADD CONSTRAINT "evidence_upload_session_parts_state_bounded"
  CHECK ("state" IN (
    'PENDING', 'UPLOADED_UNVERIFIED', 'VERIFIED', 'HASHED', 'FAILED'
  ));
