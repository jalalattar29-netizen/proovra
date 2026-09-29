-- EVIDENCE TSA VALIDATION (2026-09-29, ET-TSA-01 / ET-TSA-06). Additive only:
-- four nullable columns.
--
-- A timestamp reply is STAMPED only after its RFC 3161 token is validated
-- (CMS signature, chain to the environment's configured trust anchor, signer
-- validity at genTime, imprint, nonce, accepted policy). These columns record
-- that validation and, on failure, which bounded failure it was, so an
-- imprint mismatch is no longer indistinguishable from a provider outage.
--
-- Historical STAMPED rows keep NULL tsa_validated_at_utc and read as
-- "recorded, not validated" until the validation CLI validates their kept
-- token. Nothing is inferred or backfilled here.

ALTER TABLE "evidence"
  ADD COLUMN IF NOT EXISTS "tsa_validated_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "tsa_signer_cert_sha256" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "tsa_policy_oid" VARCHAR(80),
  ADD COLUMN IF NOT EXISTS "tsa_failure_code" VARCHAR(64);
