/**
 * Phase 12 — Reliability / upload session canonical types.
 *
 * Browser-safe (no Prisma, no Node imports). Holds:
 *   - Upload session status catalog
 *   - Allowed-transition matrix
 *   - Default env-tunable thresholds (stalled / abandoned)
 *   - Default size / multipart constants
 *
 * The existing `EvidenceStatus` (CREATED / UPLOADING / UPLOADED / SIGNED
 * / REPORTED) remains the source of truth for forensic / chain
 * decisions. This module governs the OPERATIONS-facing upload
 * lifecycle on the `UploadSession` row.
 */

// -----------------------------------------------------------------------------
// State catalog
// -----------------------------------------------------------------------------

export const UPLOAD_SESSION_STATUSES = [
  "CREATED",
  "PRESIGNED",
  "UPLOADING",
  "PARTIAL",
  "VERIFYING",
  "COMPLETED",
  "FAILED",
  "STALLED",
  "ABANDONED",
  "REVIEW_REQUIRED",
] as const;
export type UploadSessionStatus = (typeof UPLOAD_SESSION_STATUSES)[number];

export const UPLOAD_SESSION_TERMINAL_STATUSES: ReadonlySet<UploadSessionStatus> =
  new Set(["COMPLETED", "FAILED", "ABANDONED"]);

export function isTerminalUploadSessionStatus(
  status: UploadSessionStatus,
): boolean {
  return UPLOAD_SESSION_TERMINAL_STATUSES.has(status);
}

// -----------------------------------------------------------------------------
// Allowed transitions
//
// Every transition is explicit. Anything not listed is denied. Helpers
// `assertValidUploadSessionTransition` + `tryUploadSessionTransition`
// can be used in routes / services to enforce this.
//
// Key design notes:
//   - CREATED is the only "fresh" state.
//   - PRESIGNED → UPLOADING happens implicitly: the client may begin
//     uploading immediately after we issue the presigned URL, so the
//     server moves the session to UPLOADING as soon as any part-state
//     write occurs (or at the first heartbeat).
//   - VERIFYING is the in-flight `completeEvidence` window. From there
//     we go to COMPLETED on success or FAILED on error.
//   - STALLED is a sweeper-driven label; it can return to UPLOADING
//     when the client resumes activity, or roll forward to ABANDONED
//     past the abandoned threshold.
//   - REVIEW_REQUIRED is the SAFE fallback when reconciliation cannot
//     unambiguously repair a session. Operators decide the next step
//     by hand. From REVIEW_REQUIRED we may transition to ABANDONED,
//     UPLOADING, or VERIFYING.
//   - Terminal states are COMPLETED, FAILED, ABANDONED. STALLED and
//     REVIEW_REQUIRED are NOT terminal — they exist precisely so
//     recovery is possible.
// -----------------------------------------------------------------------------

const TRANSITIONS: Readonly<
  Record<UploadSessionStatus, ReadonlyArray<UploadSessionStatus>>
> = {
  CREATED: ["PRESIGNED", "FAILED", "ABANDONED", "REVIEW_REQUIRED"],
  PRESIGNED: [
    "UPLOADING",
    "PARTIAL",
    "VERIFYING",
    "FAILED",
    "STALLED",
    "ABANDONED",
    "REVIEW_REQUIRED",
  ],
  UPLOADING: [
    "PARTIAL",
    "VERIFYING",
    "FAILED",
    "STALLED",
    "ABANDONED",
    "REVIEW_REQUIRED",
  ],
  PARTIAL: [
    "UPLOADING",
    "VERIFYING",
    "FAILED",
    "STALLED",
    "ABANDONED",
    "REVIEW_REQUIRED",
  ],
  VERIFYING: ["COMPLETED", "FAILED", "REVIEW_REQUIRED"],
  COMPLETED: [],
  FAILED: [
    // Operators may explicitly re-queue a failed session for review.
    "REVIEW_REQUIRED",
  ],
  STALLED: ["UPLOADING", "ABANDONED", "REVIEW_REQUIRED"],
  ABANDONED: [],
  REVIEW_REQUIRED: ["UPLOADING", "VERIFYING", "ABANDONED", "FAILED"],
};

export function isAllowedUploadSessionTransition(
  from: UploadSessionStatus,
  to: UploadSessionStatus,
): boolean {
  if (from === to) return true; // self-noop is harmless / used by heartbeats
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function listAllowedUploadSessionTransitions(
  from: UploadSessionStatus,
): ReadonlyArray<UploadSessionStatus> {
  return TRANSITIONS[from] ?? [];
}

// -----------------------------------------------------------------------------
// Default thresholds — env overrides clamp to these floors / ceilings.
// -----------------------------------------------------------------------------

export const DEFAULT_UPLOAD_STALLED_MINUTES = 60;
export const DEFAULT_UPLOAD_ABANDONED_HOURS = 72;

// Clamp ranges. Operators can tune within these bounds; values outside
// are coerced to the nearest extreme so a misconfiguration doesn't
// produce nonsense behavior (e.g. instant-abandon).
export const UPLOAD_STALLED_MINUTES_MIN = 5;
export const UPLOAD_STALLED_MINUTES_MAX = 24 * 60; // one day

export const UPLOAD_ABANDONED_HOURS_MIN = 1;
export const UPLOAD_ABANDONED_HOURS_MAX = 24 * 30; // one month

// -----------------------------------------------------------------------------
// Large-file defaults
// -----------------------------------------------------------------------------

/** Default cap on a single original upload size (10 GiB). */
export const DEFAULT_MAX_UPLOAD_FILE_SIZE_BYTES = 10 * 1024 * 1024 * 1024;

/** Above this size, prefer multipart uploads (~100 MiB). */
export const DEFAULT_MULTIPART_THRESHOLD_BYTES = 100 * 1024 * 1024;

/** Default S3 multipart part size (~16 MiB). */
export const DEFAULT_MULTIPART_PART_SIZE_BYTES = 16 * 1024 * 1024;

/** Hard floor for multipart part size (5 MiB — S3 minimum). */
export const MULTIPART_PART_SIZE_MIN_BYTES = 5 * 1024 * 1024;

/** Hard ceiling for multipart part size (5 GiB — S3 maximum). */
export const MULTIPART_PART_SIZE_MAX_BYTES = 5 * 1024 * 1024 * 1024;
