"use client";

/**
 * Phase 30.10 — Resumable upload adoption hook.
 *
 * Stand-alone hook the capture page mounts when the resumable flag
 * is on. Manages a Map of in-flight `MultipartUploader` instances,
 * runs the IndexedDB recovery scan once on mount, and exposes a
 * narrow operator API:
 *
 *   {
 *     uploads,        // Array<UploadProgressSnapshot> — live
 *     network,        // NetworkSnapshot — live online/offline
 *     recovery,       // RecoveryReport | null — boot scan result
 *     startResumable, // (input) => Promise<MultipartUploader>
 *     pause/resume/cancel/retry, // operator actions
 *     clearRecovery,  // remove cleanup-safe entries from IDB
 *     blockingReasons, // why Review & Sign is disabled, if any
 *   }
 *
 * Hard rules baked in:
 *   * NEVER calls /v1/evidence/:id/complete from this file. Finalize
 *     stays in useCaptureSessionOrchestration (unchanged).
 *   * NEVER creates custody events (no /custody-events POST).
 *   * NEVER sets uploadedAt. The snapshot's `lastServerContactMs`
 *     is the closest thing here, and that's advisory only.
 *   * NEVER persists raw bytes, signed URLs, storage_key, or
 *     multipartUploadId — those guarantees come from the underlying
 *     `MultipartUploader` + `UploadPersistence` modules.
 *   * Hook is a no-op when `isResumableEnabled()` is false — the
 *     capture page mounts it unconditionally; the runtime gate
 *     decides whether anything happens.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  isResumableEnabled,
  routeFile,
  type UploadRouting,
} from "../../../../lib/uploads/feature-flag";
import { MultipartUploader } from "../../../../lib/uploads/multipart-uploader";
import {
  createNetworkMonitor,
  type NetworkSnapshot,
} from "../../../../lib/uploads/network";
import {
  createUploadPersistence,
  type UploadPersistence,
} from "../../../../lib/uploads/persistence";
import {
  runUploadRecovery,
  type RecoveryReport,
} from "../../../../lib/uploads/recovery";
import {
  createUploadTelemetry,
  type UploadTelemetryEmitter,
} from "../../../../lib/uploads/telemetry";
import type {
  UploadProgressSnapshot,
} from "../../../../lib/uploads/types";

// =============================================================================
// Public surface
// =============================================================================

export type StartResumableInput = {
  /** Server-side upload session id. The caller (capture page) is
   *  responsible for creating the session via POST /v1/uploads/sessions
   *  before calling this — that keeps session creation co-located
   *  with the existing evidence-creation transaction. */
  sessionId: string;
  /** Team scope passed to every authorize check. */
  teamId: string;
  /** Server evidence id this session is bound to. */
  evidenceId: string;
  /** The File from the capture-page picker. */
  file: File;
  /** Optional content type override (falls back to file.type). */
  contentType?: string | null;
};

export type ReviewSignBlocker =
  | {
      kind: "upload_in_progress";
      sessionId: string;
    }
  | {
      kind: "server_verification_pending";
      sessionId: string;
    }
  | {
      kind: "hash_mismatch";
      sessionId: string;
    }
  | {
      kind: "session_expired";
      sessionId: string;
    }
  | {
      kind: "session_aborted";
      sessionId: string;
    }
  | {
      kind: "needs_recovery";
      sessionId: string;
    }
  | {
      kind: "failed_retryable";
      sessionId: string;
    };

export type UseResumableUploadsApi = {
  /** All currently-tracked in-memory uploads, freshest snapshot per. */
  uploads: ReadonlyArray<UploadProgressSnapshot>;
  /** Current network state. */
  network: NetworkSnapshot;
  /** Boot-time recovery scan. `null` until the scan finishes. */
  recovery: RecoveryReport | null;
  /** Underlying persistence, exposed for the capture page to project
   *  initial snapshots after session creation. */
  persistence: UploadPersistence;
  /** Convenience: true ↔ ops has flipped the env flag. UI surfaces
   *  the operations panel / recovery card only when this is true. */
  enabled: boolean;
  /** Convenience: applies `routeFile()` to a given size. Capture
   *  page uses this to decide per-file routing before creating a
   *  session. */
  routeForSize(sizeBytes: number): UploadRouting;
  /** Spin up a new `MultipartUploader`. The hook subscribes to it
   *  and persists snapshots automatically. Returns the uploader so
   *  the caller can keep a handle for fine-grained control. */
  startResumable(input: StartResumableInput): MultipartUploader;
  pause(sessionId: string): void;
  resume(sessionId: string): Promise<void>;
  cancel(sessionId: string): void;
  /** Remove a CLEANUP-SAFE recovery entry from IndexedDB. */
  clearRecovery(sessionId: string): Promise<void>;
  /** Whether Review & Sign should be blocked + why. Empty array →
   *  resumable side has no objection (legacy side may still gate). */
  blockingReasons: ReadonlyArray<ReviewSignBlocker>;
};

// =============================================================================
// Hook
// =============================================================================

export function useResumableUploads(): UseResumableUploadsApi {
  const enabled = useMemo(() => isResumableEnabled(), []);
  const persistence = useMemo(() => createUploadPersistence(), []);
  const networkRef = useRef(createNetworkMonitor());
  const [network, setNetwork] = useState<NetworkSnapshot>(() =>
    networkRef.current.snapshot(),
  );
  const [uploadsMap, setUploadsMap] = useState<
    Map<string, UploadProgressSnapshot>
  >(() => new Map());
  const [recovery, setRecovery] = useState<RecoveryReport | null>(null);
  const uploadersRef = useRef(new Map<string, MultipartUploader>());
  // Telemetry emitters are keyed by teamId because a user may be a
  // member of multiple teams. Created lazily on first use.
  const telemetryRef = useRef(new Map<string, UploadTelemetryEmitter>());
  // Remember which session belongs to which team so pause / cancel
  // / clear can route telemetry without re-walking the uploads map.
  const sessionTeamRef = useRef(new Map<string, string>());

  const getTelemetry = useCallback(
    (teamId: string): UploadTelemetryEmitter => {
      const cached = telemetryRef.current.get(teamId);
      if (cached) return cached;
      const emitter = createUploadTelemetry({ teamId });
      telemetryRef.current.set(teamId, emitter);
      return emitter;
    },
    [],
  );

  // Network subscription
  useEffect(() => {
    return networkRef.current.subscribe(setNetwork);
  }, []);

  // Boot-time recovery scan — only when the flag is enabled.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    (async () => {
      try {
        const report = await runUploadRecovery({ persistence });
        if (!cancelled) {
          setRecovery(report);
          // Telemetry: one `upload_recovery_total` bump per
          // CLASS of recovery entry seen on this boot. We route
          // through the FIRST team we see; cross-team batching
          // isn't worth the complexity.
          const firstTeamId = report.entries[0]?.teamId;
          if (firstTeamId && report.entries.length > 0) {
            getTelemetry(firstTeamId).emit(
              "upload_recovery_total",
              report.entries.length,
            );
          }
        }
      } catch {
        if (!cancelled) setRecovery({ ranAtMs: Date.now(), entries: [], counts: emptyCounts() });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, persistence, getTelemetry]);

  const startResumable = useCallback(
    (input: StartResumableInput): MultipartUploader => {
      const uploader = new MultipartUploader({
        sessionId: input.sessionId,
        teamId: input.teamId,
        file: input.file,
        contentType: input.contentType ?? input.file.type ?? null,
        isOnline: () => networkRef.current.isOnline(),
        onPersist: async (snapshot) => {
          const projected = persistence.project(snapshot, {
            evidenceId: input.evidenceId,
            teamId: input.teamId,
            fileFingerprint: {
              name: input.file.name,
              sizeBytes: input.file.size,
              lastModifiedMs: input.file.lastModified,
            },
            createdAtMsClient: Date.now(),
          });
          await persistence.put(projected);
        },
      });
      uploader.subscribe((snap) => {
        setUploadsMap((prev) => {
          const next = new Map(prev);
          next.set(snap.sessionId, snap);
          return next;
        });
      });
      uploadersRef.current.set(input.sessionId, uploader);
      sessionTeamRef.current.set(input.sessionId, input.teamId);
      // Fire-and-forget start — the caller observes via snapshots.
      void uploader.start();
      return uploader;
    },
    [persistence],
  );

  const pause = useCallback(
    (sessionId: string) => {
      uploadersRef.current.get(sessionId)?.pause();
      const teamId = sessionTeamRef.current.get(sessionId);
      if (teamId) getTelemetry(teamId).emit("upload_pause_total");
    },
    [getTelemetry],
  );

  const resume = useCallback(
    async (sessionId: string) => {
      const up = uploadersRef.current.get(sessionId);
      if (!up) return;
      const teamId = sessionTeamRef.current.get(sessionId);
      if (teamId) getTelemetry(teamId).emit("upload_resume_total");
      await up.resume();
    },
    [getTelemetry],
  );

  const cancel = useCallback(
    (sessionId: string) => {
      uploadersRef.current.get(sessionId)?.cancel();
      const teamId = sessionTeamRef.current.get(sessionId);
      if (teamId) getTelemetry(teamId).emit("upload_cancel_total");
    },
    [getTelemetry],
  );

  const clearRecovery = useCallback(
    async (sessionId: string) => {
      await persistence.remove(sessionId);
      setRecovery((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          entries: prev.entries.filter((e) => e.sessionId !== sessionId),
        };
      });
    },
    [persistence],
  );

  const uploads = useMemo(
    () => Array.from(uploadsMap.values()),
    [uploadsMap],
  );

  const routeForSize = useCallback(
    (sizeBytes: number): UploadRouting =>
      routeFile({ sizeBytes, flagEnabled: enabled }),
    [enabled],
  );

  const blockingReasons = useMemo<ReadonlyArray<ReviewSignBlocker>>(
    () => computeBlockingReasons(uploads, recovery),
    [uploads, recovery],
  );

  return {
    uploads,
    network,
    recovery,
    persistence,
    enabled,
    routeForSize,
    startResumable,
    pause,
    resume,
    cancel,
    clearRecovery,
    blockingReasons,
  };
}

// =============================================================================
// Pure helpers
// =============================================================================

function computeBlockingReasons(
  uploads: ReadonlyArray<UploadProgressSnapshot>,
  recovery: RecoveryReport | null,
): ReadonlyArray<ReviewSignBlocker> {
  const blockers: ReviewSignBlocker[] = [];
  for (const u of uploads) {
    switch (u.state) {
      case "STAGED":
      case "CREATING_SESSION":
      case "INITIATING_MULTIPART":
      case "UPLOADING":
      case "FINALIZING":
        blockers.push({ kind: "upload_in_progress", sessionId: u.sessionId });
        break;
      case "VERIFYING":
      case "READY_FOR_FINALIZATION":
        blockers.push({
          kind: "server_verification_pending",
          sessionId: u.sessionId,
        });
        break;
      case "FAILED_RETRYABLE":
        if (u.failureReason === "hash_mismatch") {
          blockers.push({ kind: "hash_mismatch", sessionId: u.sessionId });
        } else if (u.failureReason === "session_expired") {
          blockers.push({ kind: "session_expired", sessionId: u.sessionId });
        } else {
          blockers.push({ kind: "failed_retryable", sessionId: u.sessionId });
        }
        break;
      case "FAILED_TERMINAL":
        if (u.failureReason === "session_aborted") {
          blockers.push({ kind: "session_aborted", sessionId: u.sessionId });
        } else if (u.failureReason === "hash_mismatch") {
          blockers.push({ kind: "hash_mismatch", sessionId: u.sessionId });
        } else {
          blockers.push({ kind: "failed_retryable", sessionId: u.sessionId });
        }
        break;
      // PAUSED / FINALIZED / CANCELLED / CONFLICT — do not block.
      // CONFLICT is surfaced via recovery instead.
    }
  }
  if (recovery) {
    for (const e of recovery.entries) {
      if (e.needsAttention) {
        if (e.classification === "expired") {
          blockers.push({ kind: "session_expired", sessionId: e.sessionId });
        } else if (e.classification === "aborted") {
          blockers.push({ kind: "session_aborted", sessionId: e.sessionId });
        } else if (e.classification === "failed") {
          blockers.push({ kind: "needs_recovery", sessionId: e.sessionId });
        }
      }
    }
  }
  return blockers;
}

function emptyCounts(): RecoveryReport["counts"] {
  return {
    resumable: 0,
    verifying: 0,
    ready_for_finalization: 0,
    finalized: 0,
    expired: 0,
    aborted: 0,
    failed: 0,
    not_found: 0,
    unknown: 0,
  };
}
