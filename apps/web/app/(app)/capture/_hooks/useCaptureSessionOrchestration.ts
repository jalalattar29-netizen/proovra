import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { useCallback, useEffect, useRef, useState } from "react";
import { tsaCompletionNotice } from "@proovra/shared";
import { useRouter } from "next/navigation";
import { getClientCaptureEnvironment } from "./captureEnvironmentClient";

import { useToast } from "../../../../components/ui";
import { apiFetch } from "../../../../lib/api";
import { buildResumeManifest, refusedUploadReleasedReservation, reservationUnusable, withReleasedNote } from "./capture-refusal";
// Phase HOME-DATA-OWNERSHIP — capture stamps the ACTIVE workspace id
// (personal Team id or team id) on every new evidence record.
import { useActiveSpace, useTenantGuard } from "../../../../lib/platform-context";
// Phase 30.12 — resumable upload adoption. Only the routing helper +
// chunk planner are imported eagerly; the orchestrator type is
// imported as a type-only reference so the bundle isn't pulled in
// when the env flag is off.
import { routeFile } from "../../../../lib/uploads/feature-flag";
import { declaredObject, planChunks } from "../../../../lib/uploads/retry";
import type { UseResumableUploadsApi } from "./useResumableUploads";
import type { CapturePlanMode } from "../_lib/session-readiness";
import type {
  CollectionPlanTemplate,
  EvidenceType,
  SessionItem,
  SessionItemClientSignals,
  SessionTimelineEvent,
} from "../_lib/types";
import {
  buildSessionItemSignals,
  deriveBatchEvidenceType,
  normalizeClientMimeType,
  validateIncomingFiles,
} from "../_lib/file-utils";
import { useCaptureLocation, type FinishLocation } from "./useCaptureLocation";
// F-P1-03 / F-P1-08 / C-05 — the legacy part upload (computeIntegrityFromBlob,
// presign, PUT under the shared storage-PUT retry rule, metadata restate).
import {
  capturedFileBasename,
  newPartMetadataFields,
  partClientSignals,
  partMetadataChanged,
  partMetadataOf,
  restatePartMetadata,
  uploadLegacyPart,
  type PartMetadata,
} from "./legacy-part-upload";
import { sha256Base64OfBlob } from "../../../../lib/uploads/streaming-sha256";
import {
  buildStorageLimitMessage,
  buildTeamPlanRequiredDetails,
  CaptureStagingLimitError,
  captureFailureToast,
  shouldReportCaptureFailure,
  logCaptureClientError,
} from "../_lib/capture-errors";
import {
  artifactOutcomeToast,
  classifyArtifactStatus,
  type CaptureArtifactOutcome,
} from "../_lib/artifact-readiness";

/**
 * UC-WEB-001 — the evidence record reserved for the CURRENT staged set.
 *
 * Finish & Sign used to be one-shot: POST /v1/evidence minted a record, a
 * mid-upload failure threw, and the next click minted a SECOND record. The
 * reservation keeps the record for exactly the staged set it was made for, so a retry resumes into the SAME record:
 * parts already uploaded are skipped, missing ones are re-presigned (the parts
 * route is RETURN_EXISTING idempotent per partIndex) and re-PUT, and a failed
 * /complete retries only /complete.
 *
 * It is abandoned the moment the staged set changes in a way that would
 * re-bind an already-issued part index to a different file (removal or
 * reorder); appending items keeps it, because new items take new indexes.
 *
 * ACROSS A RELOAD the server is the authority: POST /v1/evidence with the
 * same durable draft id (captureSessionId) answers with the draft's reserved,
 * still-unsealed record (`resumed: true`) instead of minting another, and the
 * draft only moves to FINALIZED at /complete (lane A, UC-WEB-001 server half).
 * No custom idempotency header is sent: it is not CORS-allow-listed, so a
 * browser would refuse the cross-origin create outright.
 */
export type CaptureRecordReservation = {
  evidenceId: string | null;
  evidenceTeamId: string | null;
  /** Item ids in part-index order at the time parts were issued. */
  itemIds: string[];
  uploadedItemIds: Set<string>;
  /** C-05 — the metadata last sent for each legacy-uploaded item. */
  sentMetadata?: Map<string, PartMetadata>;
};

export function reservationFitsItems(
  reservation: CaptureRecordReservation,
  itemIds: readonly string[],
): boolean {
  if (itemIds.length < reservation.itemIds.length) return false;
  return reservation.itemIds.every((id, index) => itemIds[index] === id);
}


export type CaptureSessionAddFiles = (
  files: File[],
  options?: {
    sessionEvidenceType?: EvidenceType;
    /** Stored on the part as its source label (server bound: 120 chars). */
    sourceLabel?: string;
    /** F-P1-09 — audio facts of a recording (a video without microphone). */
    audioSignals?: Pick<SessionItemClientSignals, "audioTracks" | "audioNotCapturedReason">;
  }
) => Promise<void>;

// =============================================================================
// Phase 30.12 — resumable item upload helper
// =============================================================================

/**
 * Drive a single capture-item through the resumable upload pipeline:
 *
 *   1. POST /v1/uploads/sessions — create session bound to evidence
 *      with bridge metadata (targetPartIndex, originalFileName,
 *      expectedMimeType).
 *   2. POST .../multipart/initiate — bind to S3 native multipart.
 *   3. Drive MultipartUploader via the resumable hook (per-chunk
 *      presign → PUT → mark-uploaded).
 *   4. POST .../multipart/complete with verifyHash:true — server
 *      runs CompleteMultipartUpload + HEAD + SHA-256 stream + marks
 *      all parts VERIFIED + creates the bridging EvidencePart row.
 *   5. POST .../complete — session transitions to COMPLETED so the
 *      Phase 30.11 ALL-sessions finalize gate allows finalize.
 *
 * Hard custody rules baked in:
 *   * NEVER calls /v1/evidence/:id/complete (orchestrator does that
 *     once for the whole capture session after this returns).
 *   * NEVER creates custody events.
 *   * NEVER sets uploadedAt — server sets it during the canonical
 *     completeEvidence transaction.
 *   * Failure throws — caller surfaces to UI; no silent fallback
 *     to legacy.
 *
 * B4-F-300 — the resumable door carries the SAME per-file contract as the
 * ordinary one (legacy-part-upload.ts): the session is created with the
 * part's note / role / checklist step / source and its client signals (the
 * F-P1-09 silent-video marker included), and a basename-only file name. An
 * API whose session schema does not take those fields yet (strict: 400) is
 * sent the old body. Once the part is bridged into the record, its metadata is
 * restated through the ordinary door's idempotent re-presign (C-05), which
 * every API version accepts, so the seal's checklist gate sees the step.
 *
 * B4-F-301 — a failure (or a success) is reconciled with the upload hook: the
 * settled uploader is forgotten (a failed one is aborted server-side), so its
 * snapshot no longer blocks Review & Sign and the retry starts afresh.
 */
async function runResumableItemUpload(input: {
  evidenceId: string;
  evidenceTeamId: string;
  item: SessionItem;
  index: number;
  resumable: UseResumableUploadsApi;
  setSessionItems: (
    updater: (prev: SessionItem[]) => SessionItem[],
  ) => void;
  locationIncluded: boolean;
}): Promise<void> {
  const { evidenceId, evidenceTeamId, item, index, resumable, setSessionItems, locationIncluded } =
    input;
  const expectedPartCount = planChunks(item.file.size).length;
  // The server compares the stored object with this. A digest staging did not
  // get is computed now: without one, corruption in transit seals as the original.
  const sha256Base64 =
    item.clientSignals?.clientHintSha256Base64 ?? (await sha256Base64OfBlob(item.file));
  // 1. Create the upload session.
  const baseBody = {
    teamId: evidenceTeamId,
    evidenceId,
    expectedPartCount,
    ...declaredObject(item.file.size, sha256Base64),
    idempotencyKey: `capture:${evidenceId}:${index}`,
    targetPartIndex: index,
    originalFileName: capturedFileBasename(item),
    expectedMimeType: normalizeClientMimeType(item.mimeType),
  };
  const clientSignals = partClientSignals(item, locationIncluded);
  const contract = {
    ...newPartMetadataFields(item),
    ...(clientSignals ? { clientSignals } : {}),
  };
  const createSession = (body: object) =>
    apiFetch("/v1/uploads/sessions", { method: "POST", body: JSON.stringify(body) }) as Promise<{
      session: { id: string };
    }>;
  let sessionRes: { session: { id: string } };
  // B4-F-300 — the contract the bridge is told on multipart/complete: the
  // session cannot persist it (no column), so the bridge stores what complete
  // states. Not sent to an API that already refused it at create.
  let bridgeContract: object = contract;
  try {
    sessionRes = await createSession({ ...baseBody, ...contract });
  } catch (err) {
    // COMPAT — the session schema is strict on an API older than the
    // contract fields: it refuses them (400) and creates nothing. The old
    // body is sent; the metadata is restated after the bridge below.
    if (Object.keys(contract).length === 0 || !refusedAsUnknownFields(err)) throw err;
    sessionRes = await createSession(baseBody);
    bridgeContract = {};
  }
  const sessionId = sessionRes.session.id;
  try {
    await driveResumableSession({ sessionId, evidenceId, evidenceTeamId, item, resumable, setSessionItems, bridgeContract });
  } catch (err) {
    resumable.forget?.(sessionId, { abort: true });
    throw err;
  }
  resumable.forget?.(sessionId);
  // C-05 — the bridged part's note / role / step / label, through the
  // ordinary door's idempotent re-presign of the SAME file.
  if (Object.values(partMetadataOf(item)).some(Boolean)) {
    try {
      await restatePartMetadata({
        evidenceId,
        index,
        item,
        locationIncluded,
        previous: { privateRole: null, privateNote: null, checklistStepId: null, sourceLabel: null },
        checksumSha256Base64: sha256Base64,
      });
    } catch (err) {
      // The re-presign's ADVISORY storage check counts this file's declared
      // size again although its bytes are already stored; near the cap it can
      // refuse a restatement that changes no bytes. The seal measures the
      // actual bytes and decides; any other refusal stands.
      if ((err as { code?: unknown } | null)?.code !== "STORAGE_LIMIT_REACHED") throw err;
    }
  }
}

/** A 400 refusal of the request's shape (an older API's strict schema). */
function refusedAsUnknownFields(err: unknown): boolean {
  const e = err as { statusCode?: unknown; status?: unknown; code?: unknown } | null;
  const status = typeof e?.statusCode === "number" ? e.statusCode : e?.status;
  if (status !== 400) return false;
  return e?.code == null || ["VALIDATION_ERROR", "INVALID_INPUT", "INVALID_REQUEST", "BAD_REQUEST", "API_ERROR"].includes(String(e.code));
}

async function driveResumableSession(input: {
  sessionId: string;
  evidenceId: string;
  evidenceTeamId: string;
  item: SessionItem;
  resumable: UseResumableUploadsApi;
  setSessionItems: (updater: (prev: SessionItem[]) => SessionItem[]) => void;
  /** B4-F-300 — the per-file contract stated on multipart/complete. */
  bridgeContract: object;
}): Promise<void> {
  const { sessionId, evidenceId, evidenceTeamId, item, resumable, setSessionItems, bridgeContract } = input;
  // 2. Initiate the S3 native multipart upload.
  await apiFetch(`/v1/uploads/sessions/${sessionId}/multipart/initiate`, {
    method: "POST",
    body: JSON.stringify({
      teamId: evidenceTeamId,
      contentType: normalizeClientMimeType(item.mimeType),
    }),
  });
  // 3. Drive chunk upload via MultipartUploader.
  //
  // PHASE 13 (NEW-036): the initiate at step 2 is OURS, not the uploader's, and
  // the uploader only aborts the S3 multipart when it believes one exists. Left
  // unsaid, a cancel between step 2 and the first part upload skipped the
  // multipart abort entirely and left a live upload whose parts stay stored and
  // billed until an expiry sweep that never looks at aborted sessions.
  const uploader = resumable.startResumable({
    sessionId,
    teamId: evidenceTeamId,
    evidenceId,
    file: item.file,
    contentType: normalizeClientMimeType(item.mimeType),
    multipartAlreadyInitiated: true,
  });
  await new Promise<void>((resolve, reject) => {
    const unsub = uploader.subscribe((snap) => {
      // Translate the uploader's coarse state into the capture-page
      // item progress field so the legacy UI still shows "uploading".
      // Fine-grained per-chunk progress is rendered by the
      // UploadOperationsPanel mounted on the capture page.
      const pct = snap.totalBytes
        ? Math.min(99, Math.floor((snap.uploadedBytes / snap.totalBytes) * 100))
        : 1;
      setSessionItems((prev) =>
        prev.map((current) =>
          current.id === item.id
            ? {
                ...current,
                uploading: true,
                uploadProgress: Math.max(1, pct),
                error: null,
              }
            : current,
        ),
      );
      // VERIFYING / READY_FOR_FINALIZATION = all parts uploaded;
      // proceed to storage-complete.
      if (
        snap.state === "VERIFYING" ||
        snap.state === "READY_FOR_FINALIZATION"
      ) {
        unsub();
        resolve();
      } else if (
        snap.state === "FAILED_TERMINAL" ||
        snap.state === "FAILED_RETRYABLE" ||
        snap.state === "CANCELLED" ||
        snap.state === "CONFLICT"
      ) {
        unsub();
        reject(
          new Error(
            snap.failureReason
              ? `resumable_upload_failed:${snap.failureReason}`
              : `resumable_upload_failed:${snap.state.toLowerCase()}`,
          ),
        );
      }
    });
  });
  // 4. Server-side complete + bridge creation. B4-F-300: the bridged part
  // stores the per-file contract stated here. An older API's strict schema
  // refuses it (400) before acting; the old body is then sent and the
  // metadata is restated after the bridge (C-05).
  const completeMultipart = (contract: object) =>
    apiFetch(`/v1/uploads/sessions/${sessionId}/multipart/complete`, {
      method: "POST",
      body: JSON.stringify({ teamId: evidenceTeamId, verifyHash: true, ...contract }),
    });
  try {
    await completeMultipart(bridgeContract);
  } catch (err) {
    if (Object.keys(bridgeContract).length === 0 || !refusedAsUnknownFields(err)) throw err;
    await completeMultipart({});
  }
  // 5. Flip session to COMPLETED so the Phase 30.11 gate allows
  // the downstream evidence finalize.
  await apiFetch(`/v1/uploads/sessions/${sessionId}/complete`, {
    method: "POST",
    body: JSON.stringify({ teamId: evidenceTeamId }),
  });
  // Mark the capture-page item complete. The server-side
  // EvidencePart bridge row already exists; downstream
  // completeEvidence will validate it alongside the legacy parts.
  setSessionItems((prev) =>
    prev.map((current) =>
      current.id === item.id
        ? {
            ...current,
            uploading: false,
            uploadProgress: 100,
            error: null,
          }
        : current,
    ),
  );
}

type AddFilesOptions = NonNullable<Parameters<CaptureSessionAddFiles>[1]>;

type ResetCaptureStateOptions = {
  preserveTimeline?: boolean;
  /**
   * C-04 — after a successful Finish, only the items that Finish sealed are
   * cleared. Material added while it ran (a drop, a recorded clip) was never
   * uploaded; clearing everything silently lost it.
   */
  onlyItemIds?: ReadonlySet<string>;
};

type UseCaptureSessionOrchestrationParams = {
  internalNotes: string;
  onCloseCaptureDevices: () => void;
  onResetAudioRecorder: () => void;
  planMode: CapturePlanMode;
  selectedCollectionPlan: CollectionPlanTemplate | undefined;
  useLocation: boolean;
  // Optional durable Capture draft binding. When present, the draft id is
  // sent on POST /v1/evidence so the server can move the draft to FINALIZED.
  // The hook calls onSessionFinalized() after a successful finalize so the
  // draft owner can drop its local state.
  getCaptureSessionDraftId?: () => string | null;
  /**
   * C-10 — saves the draft NOW when none exists yet (debounce pending or a
   * failed save), so the record Finish reserves is bound to a draft and every
   * later release (a changed selection, a discard) reaches it.
   */
  ensureCaptureSessionDraftId?: () => Promise<string | null>;
  onSessionFinalized?: () => void;
  onSessionDiscarded?: () => void | Promise<void>;
  // Phase 30.12 — optional resumable upload adoption. When supplied
  // AND the feature flag is enabled AND a file is large, this hook
  // forks that file's upload through the resumable orchestrator
  // instead of the legacy XHR PUT path. ALL other files (small,
  // camera, audio, recorded video, folder) continue through the
  // legacy path verbatim. Omitted ⇒ orchestrator behaves exactly
  // as before this phase.
  resumable?: UseResumableUploadsApi | null;
};

export function useCaptureSessionOrchestration({
  internalNotes,
  onCloseCaptureDevices,
  onResetAudioRecorder,
  planMode,
  selectedCollectionPlan,
  useLocation,
  getCaptureSessionDraftId,
  ensureCaptureSessionDraftId,
  onSessionFinalized,
  onSessionDiscarded,
  resumable,
}: UseCaptureSessionOrchestrationParams) {
  const router = useRouter();
  const { addToast } = useToast();
  // Null while the envelope is loading or failed. That is "unknown", never Personal.
  const activeSpace = useActiveSpace();
  // PHASE 7 §10.3/§10.E — capture the tenant generation when finalize
  // begins; if the operator switches workspace mid-finalize the Evidence
  // is still safely bound server-side to the ORIGINAL workspace
  // (evidenceTeamId), but we must NOT auto-navigate into it under the new
  // active context nor claim success for the wrong Workspace.
  const { stamp: ctxStamp, isStale: ctxIsStale } = useTenantGuard();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [sessionStatus, setSessionStatus] = useState<string | null>(null);
  const [sessionStartedAt, setSessionStartedAt] = useState(() => new Date());
  const [sessionItems, setSessionItems] = useState<SessionItem[]>([]);
  const [sessionTimeline, setSessionTimeline] = useState<SessionTimelineEvent[]>([]);
  const location = useCaptureLocation({
    useLocation,
    required: selectedCollectionPlan?.locationRequirement === "required",
  });

  const sessionItemsRef = useRef<SessionItem[]>([]);
  const reservationRef = useRef<CaptureRecordReservation | null>(null);
  // B4-F-301 / B4-F-207 — the record the current reservation holds, as state:
  // Review & Sign counts only that record's upload recovery entries, and the
  // Clear dialog says whether a reserved record will be released.
  const [reservedEvidenceId, setReservedEvidenceId] = useState<string | null>(null);
  const syncReservation = () => setReservedEvidenceId(reservationRef.current?.evidenceId ?? null);
  // C-04 — the record a successful Finish opens, once the sealed items have
  // been cleared. Decided after that render, from the items actually left:
  // material added while Finish ran keeps the operator on this page.
  const [openAfterFinish, setOpenAfterFinish] = useState<string | null>(null);

  sessionItemsRef.current = sessionItems;

  const recordTimelineEvent = (
    event: Omit<SessionTimelineEvent, "id" | "atUtc">
  ) => {
    setSessionTimeline((prev) => [
      {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        atUtc: new Date().toISOString(),
        ...event,
      },
      ...prev,
    ]);
  };

  const revokeItemPreview = (item: SessionItem) => {
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  };

  // Stable identity: it reads the session items through a ref, so it never
  // needs re-creating. The capture page lists it in its unmount cleanup,
  // which would otherwise re-register on every render.
  const revokeAllPreviews = useCallback(() => {
    sessionItemsRef.current.forEach(revokeItemPreview);
  }, []);

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  // Side-effect-free polling: the server endpoint never creates custody, audit,
  // view, or download events. This was previously /report/latest, which logged
  // REPORT_DOWNLOADED + evidence.report_viewed on every poll and falsified the
  // custody chain. See backend evidence.routes.ts /artifacts/status.
  //
  // UC-WEB-005 — reads the canonical output state, stops on a terminal one,
  // and returns WHICH state it saw, so a failed or blocked report is never
  // announced as "still generating".
  const pollArtifacts = async (
    evidenceId: string
  ): Promise<CaptureArtifactOutcome> => {
    let last: CaptureArtifactOutcome = "UNKNOWN";
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const status = await apiFetch(
          `/v1/evidence/${evidenceId}/artifacts/status`,
          { method: "GET" }
        );
        const read = classifyArtifactStatus(status);
        last = read.outcome;
        if (read.terminal) return read.outcome;
        // The projection says polling is pointless (no live work).
        if (status?.outputs && status.outputs.pollIntervalMs === null) {
          return read.outcome;
        }
      } catch {
        // Transient read failure: keep the last state seen and retry.
      }

      await sleep(2000);
    }

    return last;
  };

  const addFilesToSession = async (files: File[], options?: AddFilesOptions) => {
    if (!files.length) return;

    setError(null);
    setSessionStatus(null);

    try {
      const existingItems = sessionItemsRef.current;
      const limitError = validateIncomingFiles(files, existingItems);

      if (limitError) {
        setError(limitError);
        addToast(limitError, "error");
        throw new CaptureStagingLimitError(limitError); // F-24
      }

      const existingRequiredChecklistIds = new Set(
        existingItems
          .map((item) => item.checklistStepId)
          .filter(Boolean) as string[]
      );

      const unmappedRequiredSteps =
        planMode === "CHECKLIST_REQUIRED" && selectedCollectionPlan
          ? selectedCollectionPlan.steps.filter(
              (step) => step.required && !existingRequiredChecklistIds.has(step.id)
            )
          : [];

      let availableRequiredSteps = [...unmappedRequiredSteps];

      const assignChecklistStepId = (mimeType: string): string | null => {
        if (availableRequiredSteps.length === 0) return null;

        const normalized = normalizeClientMimeType(mimeType);
        const fileKind = normalized.startsWith("image/")
          ? "PHOTO"
          : normalized.startsWith("video/")
            ? "VIDEO"
            : normalized.startsWith("audio/")
              ? "AUDIO"
              : "DOCUMENT";

        const compatibleSteps = availableRequiredSteps.filter(
          (step) => !step.acceptedKinds || step.acceptedKinds.includes(fileKind)
        );

        const chosenStep =
          compatibleSteps.length === 1
            ? compatibleSteps[0]
            : availableRequiredSteps.length === 1
              ? availableRequiredSteps[0]
              : null;

        if (!chosenStep) return null;

        availableRequiredSteps = availableRequiredSteps.filter(
          (step) => step.id !== chosenStep.id
        );

        return chosenStep.id;
      };

      const nextItems: SessionItem[] = await Promise.all(
        files.map(async (nextFile) => {
          const normalizedMimeType = normalizeClientMimeType(nextFile.type);
          const canPreview =
            normalizedMimeType.startsWith("image/") ||
            normalizedMimeType.startsWith("video/") ||
            normalizedMimeType.startsWith("audio/");

          const relativePath =
            typeof (nextFile as File & { webkitRelativePath?: string })
              .webkitRelativePath === "string" &&
            (nextFile as File & { webkitRelativePath?: string }).webkitRelativePath
              ? (nextFile as File & { webkitRelativePath?: string })
                  .webkitRelativePath ?? null
              : null;

          const signals = { ...buildSessionItemSignals(nextFile, relativePath, existingItems), ...options?.audioSignals };

          try {
            const staged = await sha256Base64OfBlob(nextFile);
            signals.clientHintSha256Base64 = staged;

            const hashDuplicate = existingItems.some(
              (existing) => existing.clientSignals?.clientHintSha256Base64 === staged,
            );

            if (hashDuplicate) signals.duplicateStatus = "duplicate";
          } catch {
            // Final server-side integrity is computed during evidence finalization.
          }

          return {
            id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            file: nextFile,
            previewUrl: canPreview ? URL.createObjectURL(nextFile) : null,
            mimeType: normalizedMimeType,
            relativePath,
            uploadProgress: 0,
            uploading: false,
            error: null,
            checklistStepId: assignChecklistStepId(normalizedMimeType),
            ...(options?.sourceLabel ? { sourceLabel: options.sourceLabel } : {}),
            clientSignals: signals,
          };
        })
      );

      if (sessionItemsRef.current.length === 0) {
        setSessionStartedAt(new Date());
      }

      setSessionItems((prev) => [...prev, ...nextItems]);

      recordTimelineEvent({
        title: options?.sessionEvidenceType
          ? `${options.sessionEvidenceType} captured`
          : "Materials staged",
        detail: options?.sessionEvidenceType
          ? `A ${options.sessionEvidenceType.toLowerCase()} item was added to the session.`
          : `${files.length} item${files.length > 1 ? "s" : ""} added to this session.`,
        tone: "info",
      });

      addToast(
        `${files.length} item${files.length > 1 ? "s" : ""} added to session`,
        "success"
      );
    } catch (err) {
      if (err instanceof CaptureStagingLimitError) throw err; // on screen already
      logCaptureClientError("web_capture_add_to_session", err, {
        sessionEvidenceType: options?.sessionEvidenceType ?? null,
        fileCount: files.length,
      });

      const storageMessage = buildStorageLimitMessage(err);
      const message =
        storageMessage ||
        (toSafeUserError(err, { message: "Failed to add items to session" }).message);

      setError(message);
      addToast(message, "error");
      throw err;
    }
  };

  useEffect(() => {
    if (!openAfterFinish) return;
    setOpenAfterFinish(null);
    const left = sessionItems.length;
    if (left > 0) {
      addToast(
        `Evidence finalized. ${left} item${left === 1 ? " was" : "s were"} added while finishing and ${left === 1 ? "is" : "are"} still staged. Finish again to seal ${left === 1 ? "it" : "them"} as a new record.`,
        "info"
      );
      return;
    }
    router.push(`/evidence/${openAfterFinish}`);
  }, [openAfterFinish, sessionItems, addToast, router]);

  const removeSessionItem = (itemId: string) => {
    let removedName: string | null = null;

    setSessionItems((prev) => {
      const found = prev.find((item) => item.id === itemId);
      if (found) {
        revokeItemPreview(found);
        removedName = found.file.name;
      }
      return prev.filter((item) => item.id !== itemId);
    });

    recordTimelineEvent({
      title: "Material removed",
      detail: removedName
        ? `${removedName} was removed from the local staging session.`
        : "A staged material was removed from the local session.",
      tone: "info",
    });

    addToast("Item removed from session", "info");
  };

  const resetCaptureState = (options?: ResetCaptureStateOptions) => {
    const hadMaterials = sessionItemsRef.current.length > 0;

    reservationRef.current = null;
    syncReservation();
    const only = options?.onlyItemIds;
    if (only) {
      // The removeSessionItem pattern: revoke and filter the sealed items only.
      setSessionItems((prev) => {
        prev.forEach((item) => {
          if (only.has(item.id)) revokeItemPreview(item);
        });
        return prev.filter((item) => !only.has(item.id));
      });
    } else {
      revokeAllPreviews();
      setSessionItems([]);
    }
    setSessionStatus(null);
    setProgress(0);
    setError(null);
    setBusy(false);
    setSessionStartedAt(new Date());

    if (!options?.preserveTimeline) {
      setSessionTimeline(
        hadMaterials
          ? [
              {
                id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
                atUtc: new Date().toISOString(),
                title: "Session cleared",
                detail:
                  "Local staging, mappings, private notes, and sidebar messages were reset before evidence finalization.",
                tone: "warning",
              },
            ]
          : []
      );

      // A non-finalized clear is a discard. Tell the durable draft owner so
      // it can move the server-side draft to DISCARDED (audit-trailed).
      void onSessionDiscarded?.();
    }

    onCloseCaptureDevices();
    onResetAudioRecorder();
  };

  const finalizeWithoutLocation = () => finalizeSession({ acceptLocationFailure: true });

  const finalizeSession = async (options?: { acceptLocationFailure?: boolean }) => {
    const acceptLocationFailure = options?.acceptLocationFailure === true;
    const items = sessionItemsRef.current;
    // C-04 — the items THIS Finish seals (its snapshot).
    const sealedItemIds: ReadonlySet<string> = new Set(items.map((item) => item.id));

    // A STANDING condition (workspace full; plan excludes this) survives the
    // reset in `finally`; a progress status does not. That reset compared
    // against two hard-coded sentences and dropped any third.
    let standingStatus: string | null = null;

    if (items.length === 0) {
      addToast("No items in session", "error");
      return;
    }

    // Offline: nothing can reach the API, so do not start (and do not mint a
    // record). Staged items stay; the retry resumes normally once online.
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      const offlineMessage =
        "You are offline. Finish & Sign needs a connection; your staged materials are kept.";
      setError(offlineMessage);
      addToast(offlineMessage, "warning");
      return;
    }

    const captured = ctxStamp();

    // UC-WEB-001 — resume into the reserved record when the staged set still
    // fits it; otherwise start a new reservation.
    const itemIds = items.map((item) => item.id);
    let reservation = reservationRef.current;
    if (reservation && !reservationFitsItems(reservation, itemIds)) {
      reservation = null;
    }
    if (!reservation) {
      reservation = {
        evidenceId: null,
        evidenceTeamId: null,
        itemIds,
        uploadedItemIds: new Set(),
      };
    } else {
      reservation.itemIds = itemIds;
    }
    reservationRef.current = reservation;
    syncReservation();
    const resuming = reservation.evidenceId !== null;
    let currentItemId: string | null = null;

    // INGEST-009 — an omitted teamId is filed in Personal by the server, so a new
    // record is refused until the workspace is known. Staged items stay.
    if (!resuming && !activeSpace) {
      const unknownMessage =
        "PROOVRA could not confirm which workspace this belongs to, so nothing has been filed. Your staged materials are kept. Check your connection and try again.";
      setError(unknownMessage);
      addToast(unknownMessage, "warning");
      return;
    }

    setBusy(true);
    setError(null);
    setSessionStatus("Creating evidence record...");
    setProgress(0);

    recordTimelineEvent({
      title: "Finalization started",
      detail: "Finish & Sign process started for the current session.",
      tone: "info",
    });

    try {
      const files = items.map((item) => item.file);
      const rootType = deriveBatchEvidenceType(files);
      const primaryFile = files[0];

      if (!primaryFile) {
        throw new Error("No evidence items are available to finalize.");
      }

      const locationRequired = location.required;
      const shouldUsePreciseGps = locationRequired;
      // A resumed finalize reuses the reserved record: its location was fixed
      // when it was created and is not re-measured (see useCaptureLocation).
      const measured: FinishLocation = resuming ? {} : await location.measureForFinish(acceptLocationFailure);
      if (measured.stopMessage) {
        setError(measured.stopMessage);
        addToast(measured.stopMessage, "warning");
        standingStatus = locationRequired ? "Location required" : "Location not obtained";
        return;
      }
      const gps = measured.gps;
      const locationRequestOutcome = measured.outcome;
      if (gps || locationRequestOutcome !== "NOT_REQUESTED") {
        recordTimelineEvent(
          gps
            ? {
                title: "Location recorded",
                detail: shouldUsePreciseGps
                  ? "Precise device location metadata was attached with user consent because the selected intake plan requires location context."
                  : "Reduced-precision device location metadata was attached with user consent.",
                tone: "info",
              }
            : { title: "Location not obtained", detail: "Finishing without location; the record states the failed request.", tone: "warning" },
        );
      }

      const primaryMimeType = normalizeClientMimeType(primaryFile.type);

      const intakePlanJson = selectedCollectionPlan
        ? {
            templateId: selectedCollectionPlan.id,
            templateName: selectedCollectionPlan.name,
            mode: planMode,
            locationRequirement: selectedCollectionPlan.locationRequirement,
            gpsConsent: Boolean(gps),
            gpsPurpose: gps
              ? locationRequired
                ? "evidence_context_required"
                : "evidence_context_optional"
              : undefined,
            gpsPrecision: gps
              ? shouldUsePreciseGps
                ? "precise"
                : "reduced_3_decimal_places"
              : undefined,
            requiredSteps: selectedCollectionPlan.steps
              .filter((step) => step.required)
              .map((step) => ({
                id: step.id,
                title: step.title,
                description: step.description,
                purposeLabel: step.purposeLabel,
                acceptedKinds: step.acceptedKinds,
              })),
            optionalSteps: selectedCollectionPlan.steps
              .filter((step) => !step.required)
              .map((step) => ({
                id: step.id,
                title: step.title,
                description: step.description,
                purposeLabel: step.purposeLabel,
                acceptedKinds: step.acceptedKinds,
              })),
            createdAt: new Date().toISOString(),
            deviceTimeIso: new Date().toISOString(),
          }
        : undefined;

      const captureSessionId =
        getCaptureSessionDraftId?.() ?? (resuming ? null : await ensureCaptureSessionDraftId?.().catch(() => null)) ?? null;

      if (resuming) {
        recordTimelineEvent({
          title: "Resuming finalization",
          detail:
            "Retrying into the same evidence record; items already uploaded are not sent again.",
          tone: "info",
        });
      }

      const created = resuming
        ? { id: reservation.evidenceId, teamId: reservation.evidenceTeamId }
        : await apiFetch("/v1/evidence", {
        method: "POST",
        body: JSON.stringify({
          type: rootType,
          // Active workspace stamp. Omitted only for a confirmed Personal Space
          // whose id the server has not resolved; the guard above covers unknown.
          teamId: activeSpace?.id || undefined,
          mimeType: primaryMimeType,
          internalNotes: internalNotes.trim() || undefined,
          originalFileName: items[0]?.relativePath || primaryFile.name,
          captureFileName: primaryFile.name,
          // AUD-21 (2026-10-20): no deviceTimeIso. The browser clock at the
          // Finish click is not a device capture time, yet it was shown as
          // "Device-declared capture time" and signed into the fingerprint.
          // PROOVRA records when it received the bytes itself.
          gps,
          locationRequestOutcome: gps ? undefined : locationRequestOutcome,
          // AUD-52 (2026-10-20): no checksum at creation — the record holds no
          // bytes yet; each part carries its own checksum (see the part upload).
          intakePlanJson,
          captureSessionId: captureSessionId ?? undefined,
          // F-03 — resumed only while the reserved parts are these files.
          parts: captureSessionId ? buildResumeManifest(items) : undefined,
          // Enterprise Capture Environment — silent client tz/locale hints
          // (extracted to ./captureEnvironmentClient for size + reuse).
          ...getClientCaptureEnvironment(),
        }),
      });

      const evidenceId = created.id as string;
      // Phase 30.12/HOME-DATA-OWNERSHIP — the server echoes the stamped
      // team id (never null now). Resumable fork: teamId + hook + env
      // flag + large file; all other paths use the legacy XHR PUT flow.
      const evidenceTeamId =
        (created as { teamId?: string | null }).teamId ?? null;
      reservation.evidenceId = evidenceId;
      reservation.evidenceTeamId = evidenceTeamId;
      syncReservation();
      setSessionStatus(
        resuming
          ? "Resuming upload into the same evidence record..."
          : "Uploading preserved evidence items..."
      );

      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];

        // UC-WEB-001 — already uploaded into this record: never re-sent. C-05 —
        // a note/role/step/label edited since is restated before the seal.
        if (reservation.uploadedItemIds.has(item.id)) {
          const sent = reservation.sentMetadata?.get(item.id);
          if (sent && partMetadataChanged(item, sent)) {
            await restatePartMetadata({ evidenceId, index, item, locationIncluded: Boolean(gps), previous: sent });
            reservation.sentMetadata?.set(item.id, partMetadataOf(item));
          }
          continue;
        }
        currentItemId = item.id;

        setSessionItems((prev) =>
          prev.map((current) =>
            current.id === item.id
              ? { ...current, uploading: true, uploadProgress: 1, error: null }
              : current
          )
        );

        // Phase 30.12 — large-file resumable fork. The fork engages
        // BEFORE the integrity hash + presign call so the legacy XHR
        // path is never reached for files routed to resumable. This
        // guarantees a file either goes one way or the other — never
        // a half-legacy / half-resumable state (per non-negotiable 14
        // "NEVER silently convert a failed large upload to legacy
        // simple upload after resumable has started").
        if (
          resumable &&
          resumable.enabled &&
          evidenceTeamId &&
          routeFile({ sizeBytes: item.file.size }) === "resumable"
        ) {
          try {
            await runResumableItemUpload({
              evidenceId,
              evidenceTeamId,
              item,
              index,
              resumable,
              setSessionItems,
              locationIncluded: Boolean(gps),
            });
            // B4-F-300 — C-05 restates later edits for this item too.
            (reservation.sentMetadata ??= new Map()).set(item.id, partMetadataOf(item));
            // Item is now staged + uploaded + server-bridged via the
            // EvidencePart row created at completeStorageMultipart
            // time. The downstream completeEvidence transaction
            // sees this item alongside any legacy parts and
            // finalizes them atomically.
            reservation.uploadedItemIds.add(item.id);
            continue;
          } catch (err) {
            // Resumable failures are surfaced to the user via the
            // operations panel; the orchestrator continues to the
            // next item rather than falling back to legacy for THIS
            // file (forbidden by the non-negotiables). The capture
            // page must surface the failure and let the user retry.
            const msg = toSafeUserError(err, {
              message: "We couldn't upload this file. Please retry.",
            }).message;
            setSessionItems((prev) =>
              prev.map((current) =>
                current.id === item.id
                  ? {
                      ...current,
                      uploading: false,
                      uploadProgress: 0,
                      error: msg,
                    }
                  : current,
              ),
            );
            throw err;
          }
        }

        // F-P1-08 — presign + PUT under THE shared storage-PUT retry rule
        // (legacy-part-upload.ts): transient answers retried with jitter and a
        // bounded Retry-After, an expired URL presigned again, status 0 never
        // success, every other refusal final.
        await uploadLegacyPart({
          evidenceId,
          index,
          item,
          locationIncluded: Boolean(gps),
          onProgress: (fraction) => {
            const itemPct = Math.max(1, Math.min(100, Math.round(fraction * 100)));
            setSessionItems((prev) =>
              prev.map((current) =>
                current.id === item.id ? { ...current, uploading: true, uploadProgress: itemPct, error: null } : current
              )
            );
            setProgress(Math.max(1, Math.min(90, Math.round(((index + fraction) / items.length) * 90))));
          },
        });
        (reservation.sentMetadata ??= new Map()).set(item.id, partMetadataOf(item));

        reservation.uploadedItemIds.add(item.id);
        setSessionItems((prev) =>
          prev.map((current) =>
            current.id === item.id
              ? { ...current, uploading: false, uploadProgress: 100, error: null }
              : current
          )
        );
      }

      setSessionStatus("Finalizing signed record...");
      setProgress(95);

      currentItemId = null;
      const completed = (await apiFetch(`/v1/evidence/${evidenceId}/complete`, {
        method: "POST",
        body: JSON.stringify({}),
      })) as { tsaOutcome?: Parameters<typeof tsaCompletionNotice>[0] } | null;
      // The record is sealed and signed either way; a trusted timestamp the
      // provider did not issue is stated now, not discovered later.
      const tsaNotice = tsaCompletionNotice(completed?.tsaOutcome ?? null);
      // Sealed: nothing left to resume.
      reservationRef.current = null;
      syncReservation();

      setSessionStatus("Generating verification artifacts...");
      const artifactOutcome = await pollArtifacts(evidenceId);

      setProgress(100);

      // PHASE 7 §10.3/§10.E — the operator switched workspace during
      // finalize. The Evidence row is safely bound to its original
      // workspace (server-verified), but auto-navigating into it under
      // the NEW active context would either fail-closed at the detail
      // gate or surface cross-context. Complete quietly: keep the staged
      // material cleared (the server already finalized it), tell the
      // operator where it landed, and do NOT redirect.
      if (ctxIsStale(captured)) {
        addToast(
          "Evidence finalized in the workspace it was started in. Switch back to open it.",
          "info"
        );
        onSessionFinalized?.();
        resetCaptureState({ preserveTimeline: true, onlyItemIds: sealedItemIds });
        return;
      }

      {
        const outcomeToast = artifactOutcomeToast(artifactOutcome);
        addToast(outcomeToast.message, outcomeToast.tone);
      }
      if (tsaNotice) addToast(`${tsaNotice.title}. ${tsaNotice.message}`, "warning");

      // Drop the local draft handle — the server has moved it to FINALIZED
      // (linked to the new evidence record) inside the create handler.
      onSessionFinalized?.();

      resetCaptureState({ preserveTimeline: true, onlyItemIds: sealedItemIds });
      // C-04 — opened once the clear has rendered (effect below), unless
      // material added while Finish ran is still staged.
      setOpenAfterFinish(evidenceId);
    } catch (err) {
      const released = refusedUploadReleasedReservation(err); // PRO-078
      // F-03 / F-09 — see reservationUnusable.
      if (released || reservationUnusable(err)) reservationRef.current = null;
      syncReservation();
      // UC-WEB-001 — a failed item gets a safe error; uploaded ones keep 100%.
      {
        const failedItemId = currentItemId;
        const uploaded = reservationRef.current?.uploadedItemIds ?? new Set<string>();
        const itemError = withReleasedNote(toSafeUserError(err, {
          message: "This item could not be uploaded. Retry to resume.",
        }).message, released);
        setSessionItems((prev) =>
          prev.map((current) => {
            if (uploaded.has(current.id)) {
              return { ...current, uploading: false, uploadProgress: 100, error: null };
            }
            if (current.id === failedItemId) {
              return { ...current, uploading: false, uploadProgress: 0, error: itemError };
            }
            return current.uploading || current.uploadProgress > 0
              ? { ...current, uploading: false, uploadProgress: 0 }
              : current;
          })
        );
      }

      // Expected billing gate (TEAM evidence needs a TEAM plan): recoverable,
      // staged materials are kept, and it is not reported as a server fault.
      const teamPlanGate = buildTeamPlanRequiredDetails(err);
      if (teamPlanGate) {
        setError(teamPlanGate.message);
        addToast(teamPlanGate.message, "warning");
        standingStatus = "Team plan required";
        setBusy(false);
        return;
      }

      // What happened, and whether it is ours — one resolution, because the
      // sentence and the report decision both turn on it. See capture-errors.
      const safe = toSafeUserError(err, { message: "Evidence intake failed" });
      const explained = !shouldReportCaptureFailure(err);

      if (!explained) {
        logCaptureClientError("web_capture_finalize_session", err, {
          itemCount: items.length,
        });
      }

      const storageMessage = buildStorageLimitMessage(err);
      const baseMsg = storageMessage || withReleasedNote(safe.message, released);

      const toast = captureFailureToast(safe, {
        explained,
        requestId: (err as { requestId?: string }).requestId,
      });
      setError(baseMsg);
      addToast(baseMsg, toast.severity, undefined, toast.options);

      standingStatus = storageMessage
        ? "Storage limit reached"
        : explained
          ? safe.title
          : null;
    } finally {
      setBusy(false);
      setSessionStatus(standingStatus);
    }
  };

  return {
    addFilesToSession,
    busy,
    error,
    finalizeSession,
    finalizeWithoutLocation,
    location,
    locationPermissionDenied: location.permissionDenied,
    progress,
    removeSessionItem,
    reservedEvidenceId,
    resetCaptureState,
    revokeAllPreviews,
    sessionItems,
    sessionStartedAt,
    sessionStatus,
    sessionTimeline,
    setError,
    setSessionItems,
    setSessionStatus,
  };
}