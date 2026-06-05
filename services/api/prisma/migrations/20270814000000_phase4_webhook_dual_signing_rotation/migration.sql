-- Phase 4 — Webhook endpoint dual-signing rotation.
--
-- Adds three nullable columns to `integration_webhook_endpoints` so a
-- rotated endpoint can keep signing with its PREVIOUS raw secret for a
-- short grace window after rotation. During the window every outbound
-- delivery carries BOTH signatures in the `X-Proovra-Signature` header
-- as `v1=<new>,v1=<old>` (Stripe-style multi-sig). Receivers can verify
-- against either, which lets them roll the new secret into production
-- without dropping events. After the cutoff the dispatcher signs with
-- only the new secret and the previous_* triple is lazily cleared on
-- the first emit that observes the expiry.
--
-- Columns:
--   previous_secret_ciphertext       VARCHAR(512)  — AES-256-GCM (same
--                                                    wrap key as
--                                                    secret_ciphertext)
--                                                    of the prior raw
--                                                    signing secret.
--   previous_secret_prefix           VARCHAR(32)   — operator-visible
--                                                    prefix of the prior
--                                                    raw secret. Audit
--                                                    / display only.
--   previous_secret_valid_until_utc  TIMESTAMPTZ   — inclusive cutoff
--                                                    after which the
--                                                    dispatcher stops
--                                                    appending the
--                                                    second signature.
--
-- Indexes:
--   ix_integration_webhook_endpoints_previous_secret_valid_until_utc
--     supports a future cron sweeper that lazily clears expired
--     previous_* triples; cheap because most rows are NULL.
--
-- Hard rules satisfied:
--   * ADDITIVE ONLY — three nullable columns + one new index; no
--     column drops, renames, or backfills. Endpoints that have never
--     been rotated read as "no previous secret in flight" (NULL).
--   * IDEMPOTENT — every DDL uses IF NOT EXISTS so re-runs on a
--     partially applied DB are clean no-ops.
--   * NO LOCK ESCALATION — columns are added without DEFAULT so the
--     statement does not rewrite the table on Postgres 11+.
--   * INDEX names mirror the drift-repair-friendly format used by the
--     Phase O repair migrations and the api_credentials dual-active
--     rotation migration (20270813...).
--   * The wrap key is the SAME wrap key as the live
--     `secret_ciphertext` column (deriveWebhookWrapKey, AES-256-GCM).
--     Storing two ciphertexts under the same wrap key does not weaken
--     the wrap-key derivation; both decrypt independently at dispatch
--     time.

SELECT 'Phase 4 webhook dual-signing rotation: additive nullable columns + 1 index on integration_webhook_endpoints.' AS phase4_rotation_readiness;

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------

ALTER TABLE "integration_webhook_endpoints"
  ADD COLUMN IF NOT EXISTS "previous_secret_ciphertext" VARCHAR(512);

ALTER TABLE "integration_webhook_endpoints"
  ADD COLUMN IF NOT EXISTS "previous_secret_prefix" VARCHAR(32);

ALTER TABLE "integration_webhook_endpoints"
  ADD COLUMN IF NOT EXISTS "previous_secret_valid_until_utc" TIMESTAMPTZ(6);

-- ---------------------------------------------------------------------------
-- 2. Index — sweep helper on the validity-window column. Most rows are
--    NULL (no rotation in flight) so the index is small.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "integration_webhook_endpoints_prev_secret_valid_until_utc_idx"
  ON "integration_webhook_endpoints" ("previous_secret_valid_until_utc");
