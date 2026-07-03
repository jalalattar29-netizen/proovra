-- Remove the unsupported external publication / public receipt layer from
-- evidence_anchors. PROOVRA relies solely on OpenTimestamps -> Bitcoin
-- anchoring (transaction_id, anchored_at_utc), the verification page,
-- the verification package, chain of custody, RFC3161 timestamps and the
-- signature package. There is no separate public publication / receipt
-- object, so the receipt_id and public_url columns are dropped.
ALTER TABLE "evidence_anchors" DROP COLUMN IF EXISTS "receipt_id";
ALTER TABLE "evidence_anchors" DROP COLUMN IF EXISTS "public_url";
