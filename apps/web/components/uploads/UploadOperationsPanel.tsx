"use client";

/**
 * Phase 30.9 — Upload Operations Panel.
 *
 * Operational view of in-flight resumable uploads. Renders snapshots
 * emitted by `MultipartUploader.subscribe()` plus the network
 * monitor's online/offline state.
 *
 * Tone:
 *   * Enterprise, calm-under-stress, legally careful.
 *   * NOT a consumer cloud-storage UI.
 *   * Distinguishes "uploaded" (bytes hit S3) from "server-verified"
 *     (custody-grade verification done) using explicit labels.
 *   * Shows a "safe to close" indicator only when the orchestrator
 *     reports `safeToClose: true`.
 *
 * Hard rules:
 *   * NEVER renders storage keys, signed URLs, multipartUploadId.
 *     The snapshot prop's contract already strips those — this
 *     component just renders what it's given.
 *   * NEVER claims local "finalized" — only renders `state` strings
 *     from the bounded `CLIENT_UPLOAD_SESSION_STATES` catalog.
 *   * NEVER autoresolves conflict — surfaces an explicit action.
 */

import type { ReactElement } from "react";

import type { NetworkSnapshot } from "../../lib/uploads/network";
import type {
  RecoveryEntry,
  RecoveryReport,
} from "../../lib/uploads/recovery";
import type {
  ClientFailureReason,
  ClientUploadSessionState,
  UploadProgressSnapshot,
} from "../../lib/uploads/types";

// =============================================================================
// Public surface
// =============================================================================

export type UploadOperationsPanelProps = {
  /** Live snapshots from one or more MultipartUploader instances. */
  uploads: ReadonlyArray<UploadProgressSnapshot>;
  /** Live network state. */
  network: NetworkSnapshot;
  /** Optional recovery report (from runUploadRecovery on boot). */
  recovery?: RecoveryReport | null;
  /** Operator actions. The panel renders buttons; the host wires
   *  the actual orchestrator calls. */
  onResume?: (sessionId: string) => void;
  onPause?: (sessionId: string) => void;
  onCancel?: (sessionId: string) => void;
  /** Called when the operator dismisses a CLEANUP-SAFE recovery
   *  entry (FINALIZED / ABORTED / EXPIRED / NOT_FOUND). */
  onClearRecovery?: (sessionId: string) => void;
  /** Called when the operator wants to retry a recovery entry that
   *  is classified `failed`. */
  onRetryRecovery?: (sessionId: string) => void;
};

// =============================================================================
// Component
// =============================================================================

export function UploadOperationsPanel(
  props: UploadOperationsPanelProps,
): ReactElement {
  const { uploads, network, recovery } = props;
  const activeCount = uploads.filter((u) => isActiveState(u.state)).length;
  const safeToClose = uploads.every((u) => u.safeToClose);
  return (
    <section
      aria-label="Upload operations"
      className="proovra-upload-operations"
      data-online={network.isOnline ? "true" : "false"}
      data-safe-to-close={safeToClose ? "true" : "false"}
    >
      <NetworkBanner network={network} activeCount={activeCount} />
      <SafeToCloseIndicator
        safeToClose={safeToClose}
        activeCount={activeCount}
      />
      {recovery && recovery.entries.length > 0 && (
        <RecoverySection
          report={recovery}
          onResume={props.onResume}
          onClear={props.onClearRecovery}
          onRetry={props.onRetryRecovery}
        />
      )}
      <ul className="proovra-upload-operations__list">
        {uploads.map((u) => (
          <UploadRow
            key={u.sessionId}
            upload={u}
            onResume={props.onResume}
            onPause={props.onPause}
            onCancel={props.onCancel}
          />
        ))}
      </ul>
    </section>
  );
}

// =============================================================================
// Sub-components
// =============================================================================

function NetworkBanner(props: {
  network: NetworkSnapshot;
  activeCount: number;
}): ReactElement | null {
  if (props.network.isOnline) return null;
  return (
    <div
      role="status"
      className="proovra-upload-operations__banner proovra-upload-operations__banner--offline"
    >
      You're offline. {props.activeCount > 0
        ? "Uploads are paused and will resume when the connection returns."
        : "Drafts are saved locally; uploads will start when you're back online."}
    </div>
  );
}

function SafeToCloseIndicator(props: {
  safeToClose: boolean;
  activeCount: number;
}): ReactElement | null {
  if (props.activeCount === 0) return null;
  return (
    <div
      role="status"
      className={
        props.safeToClose
          ? "proovra-upload-operations__close proovra-upload-operations__close--safe"
          : "proovra-upload-operations__close proovra-upload-operations__close--unsafe"
      }
    >
      {props.safeToClose
        ? "Safe to close this tab — no uploads in flight."
        : "Do not close this tab — uploads are still in flight."}
    </div>
  );
}

function UploadRow(props: {
  upload: UploadProgressSnapshot;
  onResume?: (sessionId: string) => void;
  onPause?: (sessionId: string) => void;
  onCancel?: (sessionId: string) => void;
}): ReactElement {
  const { upload } = props;
  const verifiedPct = upload.totalBytes
    ? Math.floor((upload.verifiedBytes / upload.totalBytes) * 100)
    : 0;
  const uploadedPct = upload.totalBytes
    ? Math.floor((upload.uploadedBytes / upload.totalBytes) * 100)
    : 0;
  return (
    <li className="proovra-upload-operations__row" data-state={upload.state}>
      <header className="proovra-upload-operations__row-header">
        <span className="proovra-upload-operations__state-pill">
          {renderState(upload.state)}
        </span>
        {upload.failureReason && (
          <span
            className="proovra-upload-operations__reason"
            aria-label="failure reason"
          >
            {renderFailureReason(upload.failureReason)}
          </span>
        )}
      </header>
      <div className="proovra-upload-operations__progress">
        <span aria-label="uploaded bytes">
          Uploaded {uploadedPct}%
        </span>
        <span aria-label="server-verified bytes">
          Server-verified {verifiedPct}%
        </span>
      </div>
      <footer className="proovra-upload-operations__row-actions">
        {canResume(upload.state) && props.onResume && (
          <button
            type="button"
            onClick={() => props.onResume?.(upload.sessionId)}
            aria-label="Resume upload"
          >
            Resume
          </button>
        )}
        {canPause(upload.state) && props.onPause && (
          <button
            type="button"
            onClick={() => props.onPause?.(upload.sessionId)}
            aria-label="Pause upload"
          >
            Pause
          </button>
        )}
        {canCancel(upload.state) && props.onCancel && (
          <button
            type="button"
            onClick={() => props.onCancel?.(upload.sessionId)}
            aria-label="Cancel upload"
          >
            Cancel
          </button>
        )}
      </footer>
    </li>
  );
}

function RecoverySection(props: {
  report: RecoveryReport;
  onResume?: (sessionId: string) => void;
  onClear?: (sessionId: string) => void;
  onRetry?: (sessionId: string) => void;
}): ReactElement {
  return (
    <section
      aria-label="Upload recovery"
      className="proovra-upload-operations__recovery"
    >
      <h3>Recover earlier uploads</h3>
      <ul>
        {props.report.entries.map((entry) => (
          <RecoveryRow
            key={entry.sessionId}
            entry={entry}
            onResume={props.onResume}
            onClear={props.onClear}
            onRetry={props.onRetry}
          />
        ))}
      </ul>
    </section>
  );
}

function RecoveryRow(props: {
  entry: RecoveryEntry;
  onResume?: (sessionId: string) => void;
  onClear?: (sessionId: string) => void;
  onRetry?: (sessionId: string) => void;
}): ReactElement {
  const { entry } = props;
  return (
    <li data-classification={entry.classification}>
      <span className="proovra-upload-operations__file-name">
        {entry.fileFingerprint.name}
      </span>
      <span className="proovra-upload-operations__classification">
        {renderClassification(entry.classification)}
      </span>
      <div>
        {entry.resumable && props.onResume && (
          <button
            type="button"
            onClick={() => props.onResume?.(entry.sessionId)}
          >
            Resume
          </button>
        )}
        {entry.classification === "failed" && props.onRetry && (
          <button
            type="button"
            onClick={() => props.onRetry?.(entry.sessionId)}
          >
            Retry
          </button>
        )}
        {entry.cleanupSafe && props.onClear && (
          <button
            type="button"
            onClick={() => props.onClear?.(entry.sessionId)}
          >
            Clear
          </button>
        )}
      </div>
    </li>
  );
}

// =============================================================================
// Display helpers — bounded labels, never raw enum strings
// =============================================================================

function renderState(state: ClientUploadSessionState): string {
  switch (state) {
    case "STAGED":
      return "Staged";
    case "CREATING_SESSION":
      return "Preparing session";
    case "INITIATING_MULTIPART":
      return "Preparing storage";
    case "UPLOADING":
      return "Uploading";
    case "PAUSED":
      return "Paused";
    case "VERIFYING":
      return "Server verifying";
    case "READY_FOR_FINALIZATION":
      return "Ready to finalize";
    case "FINALIZING":
      return "Finalizing";
    case "FINALIZED":
      return "Finalized";
    case "FAILED_RETRYABLE":
      return "Needs retry";
    case "FAILED_TERMINAL":
      return "Failed — operator review";
    case "CANCELLED":
      return "Cancelled";
    case "CONFLICT":
      return "Conflict";
  }
}

function renderFailureReason(reason: ClientFailureReason): string {
  switch (reason) {
    case "network_error":
      return "Network error";
    case "offline":
      return "Offline";
    case "presign_failed":
      return "Could not get upload URL";
    case "put_5xx":
      return "Storage 5xx";
    case "put_4xx":
      return "Storage rejected upload";
    case "put_timeout":
      return "Upload timed out";
    case "etag_missing":
      return "Storage response missing metadata";
    case "mark_uploaded_failed":
      return "Server refused upload acknowledgement";
    case "mark_verified_failed":
      return "Server refused verification";
    case "multipart_complete_failed":
      return "Storage could not assemble file";
    case "session_expired":
      return "Session expired";
    case "session_aborted":
      return "Session aborted";
    case "session_failed":
      return "Session failed";
    case "hash_mismatch":
      return "Hash mismatch — file integrity violated";
    case "conflict":
      return "Session conflict — operator review required";
    case "cancelled_by_user":
      return "Cancelled";
    case "rate_limited":
      return "Rate limited — backing off";
    case "service_unavailable":
      return "Server temporarily unavailable";
    case "unknown":
      return "Unknown error";
  }
}

function renderClassification(
  c: RecoveryEntry["classification"],
): string {
  switch (c) {
    case "resumable":
      return "Can resume";
    case "verifying":
      return "Server verifying";
    case "ready_for_finalization":
      return "Ready to finalize";
    case "finalized":
      return "Already finalized";
    case "expired":
      return "Expired";
    case "aborted":
      return "Aborted";
    case "failed":
      return "Failed — needs review";
    case "not_found":
      return "Not on server";
    case "unknown":
      return "Status unknown";
  }
}

// =============================================================================
// State predicates
// =============================================================================

function isActiveState(s: ClientUploadSessionState): boolean {
  return (
    s === "CREATING_SESSION" ||
    s === "INITIATING_MULTIPART" ||
    s === "UPLOADING" ||
    s === "VERIFYING" ||
    s === "FINALIZING"
  );
}

function canResume(s: ClientUploadSessionState): boolean {
  return (
    s === "PAUSED" ||
    s === "FAILED_RETRYABLE" ||
    s === "STAGED"
  );
}

function canPause(s: ClientUploadSessionState): boolean {
  return s === "UPLOADING";
}

function canCancel(s: ClientUploadSessionState): boolean {
  return (
    s === "UPLOADING" ||
    s === "PAUSED" ||
    s === "FAILED_RETRYABLE" ||
    s === "STAGED"
  );
}
