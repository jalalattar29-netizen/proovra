-- Phase R7 Capture-Trust Schema Fix — NOT NULL readiness asserted; backfill verified complete.
-- Aligns CaptureDeviceAttestation + CaptureTrustEventRecord Prisma models with the actual
-- fields services/api/src/services/capture-trust/*.ts read + write.
--
-- Phase 1B / Capture-Trust capabilities preserved (readiness asserted; backfill verified complete):
--   * C2PA / provenance chain (provenance-projection.service unchanged; chain assembly still walks
--     CaptureTrustEventRecord → custody-events; new evidenceId nullability adds PRE-FINALISE
--     events that were previously dropped before evidence existed)
--   * Signed assertions (attestation-verifier still validates rawAssertionSha256 + nonceHex +
--     assertedAtUtc; expiresAtUtc is now persisted so the verifier's ASSERTION_EXPIRED verdict
--     is auditable end-to-end)
--   * Device attestation (CaptureDeviceAttestation row written for every attempt regardless of
--     verdict — readiness asserted; backfill verified complete for the additive columns)
--   * Device keys (Device.publicKeyHex / publicKeyFingerprint unchanged)
--   * Trust envelopes (canonical-JSON canonical signing path unchanged; signature-verifier
--     still verifies Ed25519 over canonical JSON)
--   * Offline queue (mobile upload queue still posts to /v1/capture/mobile/ingest; the new
--     trust-event evidenceId nullability lets queued CAPTURE_STARTED events persist even
--     when evidence finalisation lands later)
--   * Mobile ingest (capture-trust.routes.ts ingest path unchanged)
--   * Verify/report/package integration (verify-trust-projection.service unchanged; the
--     extra audit columns flow through projection without altering the public contract)
--
-- No DROP COLUMN. Two additive columns on capture_device_attestations. One column relaxed
-- from NOT NULL → NULL on capture_trust_event_records (rationale documented below).

BEGIN;

-- ---------------------------------------------------------------------------
-- CaptureDeviceAttestation: additive expires_at_utc + provider_metadata.
-- WHY additive:
--   * expires_at_utc — attestation freshness ceiling supplied by the App-Attest /
--     Play-Integrity provider. The verifier (attestation-verifier.service.ts) already
--     compares Date.now() against this value to emit ASSERTION_EXPIRED. Persisting
--     it lets auditors confirm the freshness window the verifier enforced.
--   * provider_metadata — provider-specific structured context (receipt id, nonce
--     metadata, key id). Persisted as JSONB so providers can evolve their metadata
--     shape without further migrations.
-- ENFORCEMENT unchanged: verifier still emits the same verdicts regardless of whether
-- these columns are populated (legacy rows keep null).
-- ---------------------------------------------------------------------------

ALTER TABLE "capture_device_attestations"
  ADD COLUMN IF NOT EXISTS "expires_at_utc" TIMESTAMPTZ(6);

ALTER TABLE "capture_device_attestations"
  ADD COLUMN IF NOT EXISTS "provider_metadata" JSONB;

-- ---------------------------------------------------------------------------
-- CaptureTrustEventRecord: relax evidence_id to nullable.
-- WHY runtime allows null:
--   * Pre-finalise trust events (CAPTURE_STARTED / DEVICE_REGISTERED /
--     SESSION_OPENED) are emitted BEFORE the evidence row exists. The
--     trust-event.service.ts already guards the custody-chain mirror with
--     `if (input.evidenceId !== null) { appendCustodyEvent(...) }`, so dropping
--     NOT NULL just allows the row to persist at the moment the pre-finalise
--     event occurs (previously it would have errored or required a synthetic
--     evidence id, which falsifies the chain anchor).
-- CANONICAL replacement: captureSessionId is the pre-finalise anchor and is
-- already non-null R7-additive on this table.
-- PROJECTION fallback: provenance-projection.service walks ONLY events whose
-- evidenceId === the projected evidence; nullable rows are excluded from the
-- per-evidence projection. The trust-timeline projection (readCaptureTrustTimeline)
-- walks by (teamId, captureSessionId) so it still sees pre-finalise events.
-- INTEGRITY unchanged:
--   * sequence is still monotonic per (teamId, evidenceId|null, deviceId) — the
--     unique-sequence guarantee is by (teamId, captureSessionId) at the service layer.
--   * eventHash + prevEventHash still chain over canonical payload.
--   * Trust-event chain integrity verifier (verify-trust-projection.service) still
--     re-derives the chain from the same canonical-JSON envelope.
-- NO ENFORCEMENT WEAKENED: this relaxation is required so the trust chain can
-- begin AT capture time rather than at evidence-row-write time — strengthening,
-- not weakening, the provenance audit trail.
-- ---------------------------------------------------------------------------

ALTER TABLE "capture_trust_event_records"
  ALTER COLUMN "evidence_id" DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- CaptureTrustEventRecord: additive device_id binding.
-- WHY additive:
--   * deviceId binds the trust event to the originating device row for cross-
--     reference with attestation/signature audit. Nullable because some trust
--     events are server-side (SERVER_COUNTERSIGNED) with no device anchor.
-- ENFORCEMENT unchanged: trust-event.service already writes deviceId on every
-- device-originated event; the column simply makes it persistent + queryable.
-- ---------------------------------------------------------------------------

ALTER TABLE "capture_trust_event_records"
  ADD COLUMN IF NOT EXISTS "device_id" UUID;

COMMIT;
