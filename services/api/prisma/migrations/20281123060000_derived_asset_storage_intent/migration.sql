-- =============================================================================
-- 2026-11-21 — FINAL-VERIFY-2 closure (M676 follow-up): a derived write that
-- may have stored bytes is held by a DURABLE INTENT until it is reconciled.
--
-- M676 reserved a derived job's bytes on its derived row
-- (`storage_reserved_bytes` / `storage_reserved_at_utc`, 20281122000000) and
-- the reservation stopped counting at its TTL. Three failures freed that
-- capacity while the bytes could still exist, uncounted:
--   (a) the settling write AND the fallback (retained) row both failed;
--   (b) the upload's answer was lost (version unknown) under a legal hold /
--       Object Lock, so the object could be neither deleted nor recorded;
--   (c) the settling write stalled past the reservation's window.
--
-- `derived_asset_storage_intents` is one row per ATTEMPT that declared a write
-- target (bucket + key) under the workspace capacity lock, written in the same
-- statement as the reservation and BEFORE any byte is sent. While OPEN it
-- counts its reserved bytes in both usage meters, whatever the age of the
-- reservation: expiry, replacement or release of the reservation never frees
-- it. It leaves OPEN only by proof:
--   SETTLED   the canonical row was recorded in the same transaction;
--   RELEASED  the holder never started a write;
--   DELETED   the holder's own version was removed and a listing proves it;
--   ADOPTED   the stored version(s) are now counted on their own row(s);
--   ABSENT    the reconciler listed the key (and aborted any incomplete
--             multipart upload) after every holder's write window had closed,
--             and found nothing unreferenced.
-- `holder_stamp_utc` is the holder's last reservation stamp (database clock),
-- renewed with the reservation; the reconciler acts only after it is older
-- than the reservation TTL plus a grace. `reconcile_token` /
-- `reconcile_lease_until` fence concurrent reconcilers.
--
-- `evidence_part_derived_assets.storage_reservation_token` names the intent a
-- reservation belongs to: a reservation WITH a token is counted through its
-- intent (never twice); one WITHOUT (an older image, or a reservation with no
-- declared write target) is counted by the row while live, as before.
--
-- EXPAND / SAFE_TO_APPLY_NOW. One new table (no rows), one nullable column
-- (no default, no backfill, metadata-only lock), plain b-tree indexes. Older
-- images neither read nor write either. Rollback: leave both (an empty table
-- and a NULL column are the old behaviour).
-- =============================================================================

ALTER TABLE "evidence_part_derived_assets"
  ADD COLUMN "storage_reservation_token" UUID;

CREATE TABLE "derived_asset_storage_intents" (
  "id"                    UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"               UUID         NOT NULL,
  "evidence_id"           UUID         NOT NULL,
  "evidence_part_id"      UUID         NOT NULL,
  "asset_kind"            VARCHAR(48)  NOT NULL,
  "variant_key"           VARCHAR(64)  NOT NULL,
  "reserved_bytes"        BIGINT       NOT NULL,
  "storage_bucket"        VARCHAR(255) NOT NULL,
  "storage_key"           VARCHAR(512) NOT NULL,
  "derived_sha256"        VARCHAR(64),
  "content_type"          VARCHAR(80),
  "holder_stamp_utc"      TIMESTAMPTZ(6) NOT NULL,
  "state"                 VARCHAR(16)  NOT NULL DEFAULT 'OPEN',
  "resolution"            VARCHAR(200),
  "resolved_bytes"        BIGINT,
  "resolved_asset_id"     UUID,
  "resolved_at_utc"       TIMESTAMPTZ(6),
  "reconcile_token"       UUID,
  "reconcile_lease_until" TIMESTAMPTZ(6),
  "reconcile_attempts"    INTEGER      NOT NULL DEFAULT 0,
  "last_reconcile_error"  VARCHAR(200),
  "created_at_utc"        TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "derived_asset_storage_intents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "derived_asset_storage_intents_bytes_ck" CHECK ("reserved_bytes" >= 0),
  CONSTRAINT "derived_asset_storage_intents_state_ck"
    CHECK ("state" IN ('OPEN', 'SETTLED', 'RELEASED', 'DELETED', 'ADOPTED', 'ABSENT')),
  CONSTRAINT "derived_asset_storage_intents_resolved_ck"
    CHECK (("state" = 'OPEN') = ("resolved_at_utc" IS NULL))
);

CREATE INDEX "derived_asset_storage_intents_team_state_idx"
  ON "derived_asset_storage_intents" ("team_id", "state");
CREATE INDEX "derived_asset_storage_intents_state_stamp_idx"
  ON "derived_asset_storage_intents" ("state", "holder_stamp_utc");
CREATE INDEX "derived_asset_storage_intents_object_idx"
  ON "derived_asset_storage_intents" ("storage_bucket", "storage_key");
