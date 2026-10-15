/**
 * AUD-004 — recovering a continuous recording from the DURABLE native ledger.
 *
 * After a process death the JS side used to know only the segments it had
 * DECLARED (continuous-session-store). Recovery called the native stop, got an
 * empty outcome, could not build a manifest (no device block), and could only
 * discard: recorded-but-unuploaded segments were invisible and the lost tail
 * uncountable.
 *
 * The native ledger now holds every finalised segment, its upload state and
 * the session result (INTERRUPTED unless the recorder recorded a clean,
 * complete finish). Recovery here is the SAME lifecycle as a live finalize —
 * the same upload, the same manifest builder, the same staging — fed from the
 * ledger:
 *
 *   plan     — decide from the ledger + the JS record whether there is anything
 *              to recover, and refuse to merge a recording into any session
 *              other than the one it is bound to;
 *   execute  — upload the segments PROOVRA never confirmed, stage the manifest
 *              (device block and counts from the ledger), and return the staged
 *              session for the ordinary hand-off to Capture.
 *
 * IDEMPOTENT. Re-running it re-declares nothing new (the server answers the
 * same index + digest with the existing declaration and writes no custody
 * event), and a manifest is FIXED (persisted) before its first upload, so a
 * restart during finalization stages exactly the same bytes at the same part.
 * A concurrent second request joins the first (single flight).
 *
 * NEVER DESTRUCTIVE. Nothing here deletes a file: a segment's local copy is
 * released only by the native ledger after its upload is confirmed, or by the
 * commit/discard the screen performs explicitly. A session the server has
 * already closed (expired / reaped) is reported, and the recording is kept for
 * the user's explicit decision.
 */
import type { DeclaredSegment } from "../continuous-manifest";
import type { DirectCaptureSession } from "../direct-capture";
import { classifyCaptureError, isSessionGone } from "./capture-retry";

/** Structural copies of the native binding's types (kept free of React Native for node tests). */
export type RecoverySegment = {
  uri: string;
  sequence: number;
  startedAtOffsetMs: number;
  durationMs: number;
  widthPx: number;
  heightPx: number;
  orientation: "portrait" | "landscape";
};

export type RecoveryLedgerSegment = RecoverySegment & {
  sizeBytes: number;
  sha256Hex: string | null;
  uploadState: "RECORDED" | "UPLOADED";
};

export type RecoveryLedger = {
  recordingId: string;
  captureSessionId: string | null;
  evidenceId: string | null;
  ownerUserId: string | null;
  state: string;
  active: boolean;
  interruption: string | null;
  outcome: {
    osConsentGranted: boolean;
    captureStartedAtUtc: string;
    captureEndedAtUtc: string;
    device: unknown;
    totalDurationMs: number;
    segmentCount: number;
    sessionCompleteness: string;
    terminationReason: string;
    limitations: string[];
  };
  segments: RecoveryLedgerSegment[];
};

/** What the JS durable record (continuous-session-store) contributes. */
export type RecoveryLiveRecord = {
  captureSessionId: string;
  evidenceId: string;
  expiresAtUtc: string;
  declared: DeclaredSegment[];
  clientLimitations: string[];
  stagedManifest?: { manifestJson: string; manifestPartIndex: number } | null;
};

export type ContinuousRecoveryPlan =
  | { kind: "NONE" }
  /** The recorder is still running (a JS reload): reattach, do not recover. */
  | { kind: "ACTIVE" }
  /** Segments recorded before any session existed: only an explicit discard. */
  | { kind: "UNBOUND"; segmentCount: number }
  /** The ledger belongs to another session or another user: never merged. */
  | { kind: "MISMATCH" }
  | {
      kind: "RECOVER";
      session: DirectCaptureSession;
      evidenceId: string;
      declared: DeclaredSegment[];
      /** Recorded, never confirmed: uploaded from disk before the manifest. */
      pending: RecoverySegment[];
      result: RecoveryLedger["outcome"];
      clientLimitations: string[];
      stagedManifest: { manifestJson: string; manifestPartIndex: number } | null;
    };

/** PURE — a ledger segment PROOVRA confirmed, as the manifest declares it. */
export function declaredFromLedger(seg: RecoveryLedgerSegment): DeclaredSegment | null {
  if (seg.uploadState !== "UPLOADED" || !seg.sha256Hex) return null;
  return {
    partIndex: seg.sequence,
    sequence: seg.sequence,
    sha256Hex: seg.sha256Hex,
    sizeBytes: seg.sizeBytes,
    startedAtOffsetMs: seg.startedAtOffsetMs,
    durationMs: seg.durationMs,
    widthPx: seg.widthPx,
    heightPx: seg.heightPx,
    orientation: seg.orientation,
  };
}

/** PURE — the recovery decision. */
export function planContinuousRecovery(
  ledger: RecoveryLedger | null,
  live: RecoveryLiveRecord | null,
  ownerUserId: string | null,
): ContinuousRecoveryPlan {
  if (!ledger) return { kind: "NONE" };
  if (ledger.active) return { kind: "ACTIVE" };
  if (!ledger.captureSessionId || !ledger.evidenceId) {
    return ledger.segments.length > 0 ? { kind: "UNBOUND", segmentCount: ledger.segments.length } : { kind: "NONE" };
  }
  if (live) {
    // The JS record and the ledger must name the SAME session and record.
    if (live.captureSessionId !== ledger.captureSessionId || live.evidenceId !== ledger.evidenceId) return { kind: "MISMATCH" };
  } else if (!ownerUserId || ledger.ownerUserId !== ownerUserId) {
    // Without the JS record only the user who bound the recording may recover it.
    return { kind: "MISMATCH" };
  }

  const bySequence = new Map<number, DeclaredSegment>();
  for (const d of live?.declared ?? []) bySequence.set(d.sequence, d);
  for (const seg of ledger.segments) {
    const d = declaredFromLedger(seg);
    if (d && !bySequence.has(d.sequence)) bySequence.set(d.sequence, d);
  }
  const declared = [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
  const pending = ledger.segments
    .filter((s) => !bySequence.has(s.sequence))
    .sort((a, b) => a.sequence - b.sequence);

  return {
    kind: "RECOVER",
    session: { captureSessionId: ledger.captureSessionId, expiresAtUtc: live?.expiresAtUtc ?? "" },
    evidenceId: ledger.evidenceId,
    declared,
    pending,
    result: ledger.outcome,
    clientLimitations: live?.clientLimitations ?? [],
    stagedManifest: live?.stagedManifest ?? null,
  };
}

export type StagedRecovery = {
  manifestJson: string;
  manifestPartIndex: number;
  segmentCount: number;
  recordedSegmentCount: number;
  sessionCompleteness: string;
};

export type ContinuousRecoveryDeps = {
  upload: (session: DirectCaptureSession, evidenceId: string, seg: RecoverySegment) => Promise<DeclaredSegment>;
  /** Record the confirmation durably (native ledger), releasing the local copy. */
  confirm: (session: DirectCaptureSession, seg: RecoverySegment, declared: DeclaredSegment) => Promise<void>;
  /** Persist the JS record (declared segments, the fixed manifest). */
  persist: (state: {
    declared: DeclaredSegment[];
    stagedManifest: { manifestJson: string; manifestPartIndex: number } | null;
  }) => Promise<void>;
  stage: (
    session: DirectCaptureSession,
    evidenceId: string,
    result: RecoveryLedger["outcome"],
    declared: DeclaredSegment[],
    extraLimitations: ReadonlyArray<string>,
    options: {
      existing: { manifestJson: string; manifestPartIndex: number } | null;
      onManifestFixed: (fixed: { manifestJson: string; manifestPartIndex: number }) => Promise<void>;
    },
  ) => Promise<StagedRecovery>;
};

export type ContinuousRecoveryResult =
  | {
      kind: "STAGED";
      session: DirectCaptureSession;
      evidenceId: string;
      staged: StagedRecovery;
      declared: DeclaredSegment[];
      /** Recorded segments that could not be uploaded (stated SEGMENT_UPLOAD_LOST). */
      lostSequences: number[];
    }
  /** The server closed the session; nothing was deleted. */
  | { kind: "SESSION_GONE"; code: string };

/**
 * Upload what PROOVRA never confirmed, then stage the manifest from the
 * ledger. A RETRYABLE failure (network, timeout, 5xx) is thrown — nothing is
 * marked lost, and a retry resumes idempotently. A segment refused for good
 * (terminal 4xx other than a closed session) is stated as lost by the manifest.
 */
export async function executeContinuousRecovery(
  plan: Extract<ContinuousRecoveryPlan, { kind: "RECOVER" }>,
  deps: ContinuousRecoveryDeps,
): Promise<ContinuousRecoveryResult> {
  const { session, evidenceId } = plan;
  let declared = [...plan.declared];
  let stagedManifest = plan.stagedManifest;
  const lost: number[] = [];

  // A fixed manifest already states which segments it covers: nothing more joins.
  if (!stagedManifest) {
    for (const seg of plan.pending) {
      try {
        const d = await deps.upload(session, evidenceId, seg);
        declared = [...declared.filter((x) => x.sequence !== d.sequence), d].sort((a, b) => a.sequence - b.sequence);
        await deps.confirm(session, seg, d);
        await deps.persist({ declared, stagedManifest });
      } catch (err) {
        if (isSessionGone(err)) return { kind: "SESSION_GONE", code: String((err as { code: string }).code) };
        if (classifyCaptureError(err) === "RETRYABLE") throw err;
        lost.push(seg.sequence);
      }
    }
  }

  try {
    const staged = await deps.stage(session, evidenceId, plan.result, declared, plan.clientLimitations, {
      existing: stagedManifest,
      onManifestFixed: async (fixed) => {
        stagedManifest = fixed;
        await deps.persist({ declared, stagedManifest });
      },
    });
    return { kind: "STAGED", session, evidenceId, staged, declared, lostSequences: lost };
  } catch (err) {
    if (isSessionGone(err)) return { kind: "SESSION_GONE", code: String((err as { code: string }).code) };
    throw err;
  }
}

const inFlight = new Map<string, Promise<ContinuousRecoveryResult>>();

/**
 * Single flight per recording: a second recovery request (a double tap, a
 * focus effect racing a button) joins the one already running instead of
 * uploading and staging a second time.
 */
export function recoverOnce(
  key: string,
  run: () => Promise<ContinuousRecoveryResult>,
): Promise<ContinuousRecoveryResult> {
  const existing = inFlight.get(key);
  if (existing) return existing;
  const p = run().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, p);
  return p;
}
