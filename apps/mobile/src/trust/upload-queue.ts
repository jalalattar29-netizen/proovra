/**
 * Phase 1B Closure — Trust-aware mobile upload queue.
 *
 * Persists TrustEnvelopes locally (SQLite) so an offline capture
 * keeps its provenance metadata for life. Syncs to
 * `POST /v1/capture/mobile/ingest` with bounded backoff. Surfaces
 * bounded server denial reasons.
 *
 * State machine:
 *
 *   signed_pending_sync ─► syncing ─► synced
 *                             │
 *                             ├─► sync_failed (retry-eligible)
 *                             └─► rejected_by_server (terminal +
 *                                  bounded reason)
 *
 *   queued_offline ─► signed_pending_sync (when online detected)
 *
 * Hard rules:
 *   * NEVER stores raw private key or attestation token outside
 *     expo-secure-store. The queue stores only the public-safe
 *     envelope (canonical payload + signature hex + base64 bytes +
 *     attestation rawAssertionBase64 + bounded metadata).
 *   * Retries with exponential backoff bounded at 5 attempts.
 *   * On server denial, the row is moved to `rejected_by_server`
 *     with the bounded `denialReason` and is NOT retried.
 */

import * as SQLite from "expo-sqlite";
import { Buffer } from "buffer";

import { apiFetch } from "../api";
import { captureException } from "../sentry";
import type {
  CaptureProvenanceClass,
  CaptureSignaturePayload,
  CaptureSignatureVerdict,
  CaptureIngestDenialReason,
  DeviceAttestationVerdict,
} from "@proovra/shared";

import type { AttestationResult } from "./attestation";

export type TrustQueueStatus =
  | "signed_pending_sync"
  | "queued_offline"
  | "syncing"
  | "synced"
  | "sync_failed"
  | "rejected_by_server";

export type TrustQueueRow = {
  id: string;
  captureSessionId: string;
  deviceId: string;
  provenanceClass: CaptureProvenanceClass;
  payloadJson: string;
  signatureHex: string;
  assetBase64: string;
  assetSha256: string;
  sizeBytes: number;
  attestationProvider: string | null;
  attestationRawBase64: string | null;
  attestationFailureReason: string | null;
  attestationFailureNote: string | null;
  status: TrustQueueStatus;
  attempts: number;
  lastError: string | null;
  denialReason: CaptureIngestDenialReason | null;
  serverEvidenceId: string | null;
  serverSignatureVerdict: CaptureSignatureVerdict | null;
  serverAttestationVerdict: DeviceAttestationVerdict | null;
  createdAt: string;
  updatedAt: string;
};

const db = SQLite.openDatabaseSync("proovra-trust.db");

function init() {
  db.execSync(`
    CREATE TABLE IF NOT EXISTS trust_queue (
      id TEXT PRIMARY KEY NOT NULL,
      capture_session_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      provenance_class TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      signature_hex TEXT NOT NULL,
      asset_base64 TEXT NOT NULL,
      asset_sha256 TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      attestation_provider TEXT,
      attestation_raw_base64 TEXT,
      attestation_failure_reason TEXT,
      attestation_failure_note TEXT,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      denial_reason TEXT,
      server_evidence_id TEXT,
      server_signature_verdict TEXT,
      server_attestation_verdict TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS trust_queue_status_idx ON trust_queue(status, created_at);
  `);
}

init();

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type EnqueueInput = {
  id: string;
  captureSessionId: string;
  deviceId: string;
  provenanceClass: CaptureProvenanceClass;
  payload: CaptureSignaturePayload;
  signatureHex: string;
  assetBase64: string;
  assetSha256: string;
  sizeBytes: number;
  attestation: (AttestationResult & { attempted: true }) | null;
  attestationFailure: { reason: string; note: string } | null;
  /** Whether the network is online at enqueue time. */
  online: boolean;
};

export function enqueueTrustEnvelope(input: EnqueueInput): void {
  const stmt = db.prepareSync(
    `INSERT OR REPLACE INTO trust_queue (
       id, capture_session_id, device_id, provenance_class,
       payload_json, signature_hex, asset_base64, asset_sha256, size_bytes,
       attestation_provider, attestation_raw_base64,
       attestation_failure_reason, attestation_failure_note,
       status, attempts, last_error, denial_reason,
       server_evidence_id, server_signature_verdict, server_attestation_verdict,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const ts = nowIso();
  stmt.executeSync(
    input.id,
    input.captureSessionId,
    input.deviceId,
    input.provenanceClass,
    JSON.stringify(input.payload),
    input.signatureHex,
    input.assetBase64,
    input.assetSha256,
    input.sizeBytes,
    input.attestation?.provider ?? null,
    input.attestation?.rawAssertionBase64 ?? null,
    input.attestationFailure?.reason ?? null,
    input.attestationFailure?.note ?? null,
    input.online ? "signed_pending_sync" : "queued_offline",
    0,
    null,
    null,
    null,
    null,
    null,
    ts,
    ts,
  );
  stmt.finalizeSync();
}

export function listTrustQueue(): TrustQueueRow[] {
  return db.getAllSync<TrustQueueRow>(
    `SELECT id, capture_session_id as captureSessionId, device_id as deviceId,
            provenance_class as provenanceClass, payload_json as payloadJson,
            signature_hex as signatureHex, asset_base64 as assetBase64,
            asset_sha256 as assetSha256, size_bytes as sizeBytes,
            attestation_provider as attestationProvider,
            attestation_raw_base64 as attestationRawBase64,
            attestation_failure_reason as attestationFailureReason,
            attestation_failure_note as attestationFailureNote,
            status, attempts, last_error as lastError, denial_reason as denialReason,
            server_evidence_id as serverEvidenceId,
            server_signature_verdict as serverSignatureVerdict,
            server_attestation_verdict as serverAttestationVerdict,
            created_at as createdAt, updated_at as updatedAt
       FROM trust_queue
      ORDER BY created_at ASC`,
  );
}

export function listTrustQueueSummary(): {
  total: number;
  pendingSync: number;
  offline: number;
  syncing: number;
  synced: number;
  failed: number;
  rejected: number;
} {
  const rows = listTrustQueue();
  return {
    total: rows.length,
    pendingSync: rows.filter((r) => r.status === "signed_pending_sync").length,
    offline: rows.filter((r) => r.status === "queued_offline").length,
    syncing: rows.filter((r) => r.status === "syncing").length,
    synced: rows.filter((r) => r.status === "synced").length,
    failed: rows.filter((r) => r.status === "sync_failed").length,
    rejected: rows.filter((r) => r.status === "rejected_by_server").length,
  };
}

export function markOnline() {
  db.runSync(
    `UPDATE trust_queue SET status = 'signed_pending_sync', updated_at = ?
      WHERE status = 'queued_offline'`,
    nowIso(),
  );
}

// ---------------------------------------------------------------------------
// Sync worker
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [500, 2_000, 8_000, 30_000, 120_000];

function setStatus(
  id: string,
  status: TrustQueueStatus,
  fields: Partial<{
    attempts: number;
    lastError: string | null;
    denialReason: CaptureIngestDenialReason | null;
    serverEvidenceId: string | null;
    serverSignatureVerdict: CaptureSignatureVerdict | null;
    serverAttestationVerdict: DeviceAttestationVerdict | null;
  }> = {},
) {
  const stmt = db.prepareSync(
    `UPDATE trust_queue SET
        status = ?,
        attempts = COALESCE(?, attempts),
        last_error = ?,
        denial_reason = COALESCE(?, denial_reason),
        server_evidence_id = COALESCE(?, server_evidence_id),
        server_signature_verdict = COALESCE(?, server_signature_verdict),
        server_attestation_verdict = COALESCE(?, server_attestation_verdict),
        updated_at = ?
      WHERE id = ?`,
  );
  stmt.executeSync(
    status,
    fields.attempts ?? null,
    fields.lastError ?? null,
    fields.denialReason ?? null,
    fields.serverEvidenceId ?? null,
    fields.serverSignatureVerdict ?? null,
    fields.serverAttestationVerdict ?? null,
    nowIso(),
    id,
  );
  stmt.finalizeSync();
}

const TERMINAL_DENIALS: ReadonlySet<CaptureIngestDenialReason> = new Set([
  "DEVICE_REVOKED",
  "DEVICE_NOT_REGISTERED",
  "SIGNATURE_INVALID",
  "BYTES_HASH_MISMATCH",
  "REPLAY_NONCE_REUSED",
  "PROVENANCE_CLASS_DECLINED",
  "POLICY_REJECTED",
]);

export async function syncTrustQueue(): Promise<{
  attempted: number;
  synced: number;
  rejected: number;
  failed: number;
}> {
  const candidates = db.getAllSync<TrustQueueRow>(
    `SELECT id, capture_session_id as captureSessionId, device_id as deviceId,
            provenance_class as provenanceClass, payload_json as payloadJson,
            signature_hex as signatureHex, asset_base64 as assetBase64,
            asset_sha256 as assetSha256, size_bytes as sizeBytes,
            attestation_provider as attestationProvider,
            attestation_raw_base64 as attestationRawBase64,
            attestation_failure_reason as attestationFailureReason,
            attestation_failure_note as attestationFailureNote,
            status, attempts, last_error as lastError, denial_reason as denialReason,
            server_evidence_id as serverEvidenceId,
            server_signature_verdict as serverSignatureVerdict,
            server_attestation_verdict as serverAttestationVerdict,
            created_at as createdAt, updated_at as updatedAt
       FROM trust_queue
      WHERE status IN ('signed_pending_sync','sync_failed')
      ORDER BY created_at ASC
      LIMIT 20`,
  );

  let synced = 0;
  let rejected = 0;
  let failed = 0;

  for (const row of candidates) {
    if (row.attempts >= MAX_ATTEMPTS) {
      setStatus(row.id, "sync_failed", {
        lastError: "MAX_ATTEMPTS_EXCEEDED",
      });
      failed += 1;
      continue;
    }
    setStatus(row.id, "syncing", { attempts: row.attempts + 1 });
    const wait = BACKOFF_MS[Math.min(row.attempts, BACKOFF_MS.length - 1)];
    if (row.attempts > 0) {
      await sleep(wait);
    }

    try {
      const payload = JSON.parse(row.payloadJson) as CaptureSignaturePayload;
      const attestation =
        row.attestationProvider && row.attestationRawBase64
          ? {
              provider: row.attestationProvider,
              rawAssertionBase64: row.attestationRawBase64,
              assertedAtUtc: payload.signedAtUtc,
              nonceHex: payload.nonceHex,
              expiresAtUtc: null,
              providerMetadata: {},
            }
          : null;

      const res = await apiFetch("/v1/capture/mobile/ingest", {
        method: "POST",
        body: JSON.stringify({
          payload,
          signatureHex: row.signatureHex,
          assetBase64: row.assetBase64,
          attestation,
        }),
      });

      // Bounded shape: { receipt: { evidenceId, provenanceClass,
      // signatureVerdict, attestationVerdict, denialReason, ... } }
      const receipt = res?.receipt ?? null;
      if (receipt?.denialReason) {
        const denial = receipt.denialReason as CaptureIngestDenialReason;
        setStatus(row.id, "rejected_by_server", {
          denialReason: denial,
          lastError: `Server denial: ${denial}`,
        });
        rejected += 1;
        continue;
      }
      setStatus(row.id, "synced", {
        serverEvidenceId: receipt?.evidenceId ?? null,
        serverSignatureVerdict: receipt?.signatureVerdict ?? null,
        serverAttestationVerdict: receipt?.attestationVerdict ?? null,
        lastError: null,
      });
      synced += 1;
    } catch (err) {
      const denial = extractDenial(err);
      if (denial && TERMINAL_DENIALS.has(denial)) {
        setStatus(row.id, "rejected_by_server", {
          denialReason: denial,
          lastError: `Server denial: ${denial}`,
        });
        rejected += 1;
        continue;
      }
      captureException(err, {
        feature: "trust_queue_sync",
        rowId: row.id,
        attempt: row.attempts + 1,
      });
      setStatus(row.id, "sync_failed", {
        lastError: err instanceof Error ? err.message : "Sync failed",
      });
      failed += 1;
    }
  }

  return { attempted: candidates.length, synced, rejected, failed };
}

function extractDenial(err: unknown): CaptureIngestDenialReason | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = err as any;
  if (e && typeof e.body === "object" && e.body) {
    const d = e.body.receipt?.denialReason ?? e.body.denialReason;
    if (typeof d === "string") return d as CaptureIngestDenialReason;
  }
  if (e && typeof e.denial === "string") {
    return e.denial as CaptureIngestDenialReason;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function clearSyncedTrustRows(): number {
  const res = db.runSync(
    `DELETE FROM trust_queue WHERE status = 'synced' AND updated_at < ?`,
    new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString(),
  );
  return res.changes;
}

// Bounded helper: convert a raw base64 row back to bytes (for the
// rare local-side audit / re-sign path).
export function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}
