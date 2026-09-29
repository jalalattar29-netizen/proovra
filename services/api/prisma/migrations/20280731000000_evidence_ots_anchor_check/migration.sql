-- EVIDENCE OTS ANCHOR CHECK (2026-09-29). Additive only: one nullable column.
--
-- How an OpenTimestamps anchor was established:
--   BITCOIN_VERIFIED  `ots verify` checked the proof's Bitcoin attestation
--                     against the Bitcoin chain;
--   PROOF_STRUCTURE   `ots info` showed, offline, that the proof commits to
--                     this record's hash and carries a Bitcoin block-header
--                     attestation (the chain was not checked).
-- Only BITCOIN_VERIFIED may be claimed as publicly verified
-- (package manifest `publicAnchoringVerified`, public Verify, labels).
--
-- Historical rows keep NULL: "not recorded", which every reader presents as
-- anchored-not-checked. Nothing is inferred or backfilled.

ALTER TABLE "evidence"
  ADD COLUMN IF NOT EXISTS "ots_anchor_check" VARCHAR(24);
