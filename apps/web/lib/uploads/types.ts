/**
 * Phase 30.9 — Resumable upload orchestrator: shared types.
 *
 * Pure types only — no runtime values that depend on browser APIs.
 * Lives outside the orchestrator class so persistence / UI / tests
 * can import the vocabulary without pulling in the file/fetch
 * machinery.
 *
 * Hard custody / privacy invariants reflected here:
 *   * Client state vocabulary is BOUNDED — anything the orchestrator
 *     surfaces is one of these enums.
 *   * Client NEVER claims "FINALIZED" as authoritative; that belongs
 *     to the backend Evidence row. The local-side `FINALIZED` state
 *     means "server confirmed; we can clean up local state".
 *   * No timestamps stored here are interpreted as custody truth.
 *     `clientObservedAtMs` is advisory only.
 *   * ETag is recorded as opaque storage metadata — never compared
 *     against any SHA-256.
 */

// =============================================================================
// Bounded vocabularies
// =============================================================================

/** Lifecycle of an upload session as the BROWSER tracks it. The
 *  server-side state machine is the authority; this is the local
 *  shadow the orchestrator drives the UI from. */
export const CLIENT_UPLOAD_SESSION_STATES = [
  "STAGED",                    // file picked, no server session yet
  "CREATING_SESSION",          // POST /v1/uploads/sessions in flight
  "INITIATING_MULTIPART",      // POST .../multipart/initiate in flight
  "UPLOADING",                 // at least one part in flight or queued
  "PAUSED",                    // user paused; resumable
  "VERIFYING",                 // server-side verification pending
  "READY_FOR_FINALIZATION",    // all parts VERIFIED; awaiting finalize
  "FINALIZING",                // POST /v1/evidence/:id/complete in flight
  "FINALIZED",                 // server confirmed; safe to clean local
  "FAILED_RETRYABLE",          // transient failure; UI offers retry
  "FAILED_TERMINAL",           // unrecoverable; UI offers cancel/recovery
  "CANCELLED",                 // user cancelled
  "CONFLICT",                  // server says session diverged from local
] as const;

export type ClientUploadSessionState =
  (typeof CLIENT_UPLOAD_SESSION_STATES)[number];

/** Per-chunk state. Mirrors the server-side `evidence_upload_session_parts`
 *  vocabulary, plus client-only `QUEUED` / `IN_FLIGHT` for the
 *  scheduler's bookkeeping. */
export const CLIENT_PART_STATES = [
  "PENDING",              // not yet attempted
  "QUEUED",               // in the upload pool's wait queue
  "PRESIGNING",           // awaiting presign response
  "IN_FLIGHT",            // PUT in progress
  "UPLOADED_UNVERIFIED",  // PUT returned 2xx; ETag captured
  "VERIFIED",             // server confirmed via mark-verified
  "FAILED",               // terminal failure for this part
  "PAUSED",               // pool yielded the slot voluntarily
] as const;

export type ClientPartState = (typeof CLIENT_PART_STATES)[number];

/** Offline draft state machine — matches the brief's catalog
 *  one-for-one. `LOCAL_ONLY` is the only state that can exist purely
 *  in the browser with no server counterpart. */
export const OFFLINE_DRAFT_STATES = [
  "LOCAL_ONLY",
  "SERVER_DRAFT",
  "SYNC_PENDING",
  "SYNCING",
  "PARTIALLY_UPLOADED",
  "READY_FOR_FINALIZATION",
  "FINALIZING",
  "FINALIZED",
  "CONFLICT",
  "FAILED_RETRYABLE",
  "FAILED_TERMINAL",
  "CANCELLED",
] as const;

export type OfflineDraftState = (typeof OFFLINE_DRAFT_STATES)[number];

/** Bounded reason vocabulary for retries / failures. Operator + UI
 *  use these to make actionable decisions; we never surface a raw
 *  fetch error message. */
export const CLIENT_FAILURE_REASONS = [
  "network_error",            // fetch threw / aborted
  "offline",                  // navigator.onLine === false
  "presign_failed",           // 4xx/5xx from presign route
  "put_5xx",                  // S3 returned 5xx
  "put_4xx",                  // S3 returned 4xx (terminal for retries)
  "put_timeout",              // request timed out
  "etag_missing",             // S3 PUT 200 but no ETag header
  "mark_uploaded_failed",     // POST .../uploaded denied
  "mark_verified_failed",     // POST .../verified denied
  "multipart_complete_failed",
  "session_expired",          // server reports session expired
  "session_aborted",          // server reports session aborted
  "session_failed",           // server reports session FAILED
  "hash_mismatch",            // server-side hash mismatch reported
  "conflict",                 // server state diverged from local
  "cancelled_by_user",
  "rate_limited",             // server returned 429
  "service_unavailable",      // server returned 503
  "unknown",
] as const;

export type ClientFailureReason = (typeof CLIENT_FAILURE_REASONS)[number];

// =============================================================================
// Configuration bounds
// =============================================================================

/**
 * Bounded chunk size. Lower bound is 5 MB (S3 requires it for all
 * parts except the LAST one). Upper bound is 64 MB so the orchestrator
 * never holds more than 64 MB × concurrency in memory.
 */
export const MIN_CHUNK_SIZE_BYTES = 5 * 1024 * 1024;
export const MAX_CHUNK_SIZE_BYTES = 64 * 1024 * 1024;
export const DEFAULT_CHUNK_SIZE_BYTES = 8 * 1024 * 1024;

/**
 * Bounded concurrency. The pool runs `concurrency` parallel part
 * uploads. 1–6 is the safe range — anything higher saturates uplink
 * on consumer connections.
 */
export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 6;
export const DEFAULT_CONCURRENCY = 4;

/** Hard upper bound on retry attempts per part. After this the part
 *  goes FAILED and the UI surfaces the operator action. */
export const MAX_PART_RETRIES = 5;

/** Bounded retry backoff. The classifier returns a wait_ms within
 *  this range. Server-supplied Retry-After (in seconds) is honored
 *  but still clamped to MAX_RETRY_BACKOFF_MS. */
export const MIN_RETRY_BACKOFF_MS = 500;
export const MAX_RETRY_BACKOFF_MS = 30_000;

// =============================================================================
// Public projection shapes
// =============================================================================

/**
 * Snapshot the orchestrator emits to subscribers. Intentionally
 * narrow — NO storage keys, NO multipartUploadId, NO signed URLs.
 * Operator UI consumes this; nothing in it identifies the S3 layout.
 */
export type UploadProgressSnapshot = {
  sessionId: string;
  state: ClientUploadSessionState;
  /** Bytes uploaded across all VERIFIED parts only — never inflated
   *  by in-flight or unverified bytes (so the bar can't reach 100%
   *  before server verification). */
  verifiedBytes: number;
  /** Bytes the orchestrator believes have been PUT to S3 successfully
   *  (UPLOADED_UNVERIFIED + VERIFIED). For "uploaded vs server-
   *  verified" UI distinction. */
  uploadedBytes: number;
  totalBytes: number;
  parts: ReadonlyArray<ClientPartProgress>;
  failureReason: ClientFailureReason | null;
  isOnline: boolean;
  /** Operator hint: "safe to close" only if we have zero in-flight
   *  parts AND the session is either PAUSED, FAILED_*, CANCELLED,
   *  or FINALIZED. The orchestrator computes this; UI shouldn't. */
  safeToClose: boolean;
  /** When did we last successfully talk to the server? Advisory only;
   *  never used as custody truth. */
  lastServerContactMs: number | null;
};

export type ClientPartProgress = {
  partIndex: number;          // 0-indexed, matches server schema
  state: ClientPartState;
  bytes: number;              // total bytes of this part
  retryCount: number;
  /** S3 ETag captured from the PUT response. Storage metadata only —
   *  the UI must NOT render this as an integrity claim. */
  etag: string | null;
  failureReason: ClientFailureReason | null;
};

// =============================================================================
// Custody-safety guarantees
//
// The orchestrator NEVER surfaces:
//   - storage_bucket / storage_key / multipart_upload_id
//   - presigned URL strings (they are consumed inside the PUT call
//     and then discarded — the snapshot never holds the URL)
//   - server SHA-256 (it appears only inside a successful
//     `multipart/complete` response, which the orchestrator records
//     internally but does not expose in the UI snapshot)
//   - uploadedAt / completedAt — those are server-side timestamps;
//     the snapshot only carries `lastServerContactMs` for UX feedback.
//
// These guarantees are enforced by the source-contract tests in
// services/api/test/phase-30-9-*.test.ts.
// =============================================================================
