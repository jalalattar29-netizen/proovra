import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { useToast } from "../../../../components/ui";
import { apiFetch } from "../../../../lib/api";
// Phase HOME-DATA-OWNERSHIP — capture stamps the ACTIVE workspace id
// (personal Team id or team id) on every new evidence record.
import { useActiveSpaceId } from "../../../../lib/platform-context";
// Phase 30.12 — resumable upload adoption. Only the routing helper +
// chunk planner are imported eagerly; the orchestrator type is
// imported as a type-only reference so the bundle isn't pulled in
// when the env flag is off.
import { routeFile } from "../../../../lib/uploads/feature-flag";
import { planChunks } from "../../../../lib/uploads/retry";
import type { UseResumableUploadsApi } from "./useResumableUploads";
import type { CapturePlanMode } from "../_lib/session-readiness";
import type {
  CollectionPlanTemplate,
  EvidenceType,
  SessionItem,
  SessionTimelineEvent,
} from "../_lib/types";
import {
  buildSessionItemSignals,
  deriveBatchEvidenceType,
  normalizeClientMimeType,
  roundGpsCoordinate,
  validateIncomingFiles,
} from "../_lib/file-utils";
import { computeIntegrityFromBlob } from "../_lib/hash-utils";
import {
  buildStorageLimitMessage,
  buildTeamPlanRequiredDetails,
  logCaptureClientError,
} from "../_lib/capture-errors";

export type CaptureSessionAddFiles = (
  files: File[],
  options?: { sessionEvidenceType?: EvidenceType }
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
}): Promise<void> {
  const { evidenceId, evidenceTeamId, item, index, resumable, setSessionItems } =
    input;
  const expectedPartCount = planChunks(item.file.size).length;
  // 1. Create the upload session.
  const sessionRes = (await apiFetch("/v1/uploads/sessions", {
    method: "POST",
    body: JSON.stringify({
      teamId: evidenceTeamId,
      evidenceId,
      expectedPartCount,
      idempotencyKey: `capture:${evidenceId}:${index}`,
      targetPartIndex: index,
      originalFileName: item.relativePath || item.file.name,
      expectedMimeType: normalizeClientMimeType(item.mimeType),
    }),
  })) as { session: { id: string } };
  const sessionId = sessionRes.session.id;
  // 2. Initiate the S3 native multipart upload.
  await apiFetch(`/v1/uploads/sessions/${sessionId}/multipart/initiate`, {
    method: "POST",
    body: JSON.stringify({
      teamId: evidenceTeamId,
      contentType: normalizeClientMimeType(item.mimeType),
    }),
  });
  // 3. Drive chunk upload via MultipartUploader.
  const uploader = resumable.startResumable({
    sessionId,
    teamId: evidenceTeamId,
    evidenceId,
    file: item.file,
    contentType: normalizeClientMimeType(item.mimeType),
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
  // 4. Server-side complete + bridge creation.
  await apiFetch(`/v1/uploads/sessions/${sessionId}/multipart/complete`, {
    method: "POST",
    body: JSON.stringify({ teamId: evidenceTeamId, verifyHash: true }),
  });
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

type AddFilesOptions = {
  sessionEvidenceType?: EvidenceType;
};

type ResetCaptureStateOptions = {
  preserveTimeline?: boolean;
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
  onSessionFinalized,
  onSessionDiscarded,
  resumable,
}: UseCaptureSessionOrchestrationParams) {
  const router = useRouter();
  const { addToast } = useToast();
  const activeSpaceId = useActiveSpaceId();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [sessionStatus, setSessionStatus] = useState<string | null>(null);
  const [sessionStartedAt, setSessionStartedAt] = useState(() => new Date());
  const [sessionItems, setSessionItems] = useState<SessionItem[]>([]);
  const [sessionTimeline, setSessionTimeline] = useState<SessionTimelineEvent[]>([]);
  const [, setLocationAccuracyMeters] = useState<number | null>(null);
  const [locationPermissionDenied, setLocationPermissionDenied] = useState(false);

  const sessionItemsRef = useRef<SessionItem[]>([]);

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

  const revokeAllPreviews = () => {
    sessionItemsRef.current.forEach(revokeItemPreview);
  };

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  // Side-effect-free polling: the server endpoint never creates custody, audit,
  // view, or download events. This was previously /report/latest, which logged
  // REPORT_DOWNLOADED + evidence.report_viewed on every poll and falsified the
  // custody chain. See backend evidence.routes.ts /artifacts/status.
  const pollArtifacts = async (evidenceId: string): Promise<boolean> => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const status = await apiFetch(
          `/v1/evidence/${evidenceId}/artifacts/status`,
          { method: "GET" }
        );

        if (status?.report?.available) {
          return true;
        }
      } catch {
        // Treat transient failures as "not yet ready" and retry.
      }

      await sleep(2000);
    }

    return false;
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
        return;
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

          const signals = buildSessionItemSignals(nextFile, relativePath, existingItems);

          try {
            const integrity = await computeIntegrityFromBlob(nextFile);
            signals.clientHintSha256Base64 = integrity.checksumSha256Base64;

            const hashDuplicate = existingItems.some(
              (existing) =>
                existing.clientSignals?.clientHintSha256Base64 ===
                integrity.checksumSha256Base64
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
      logCaptureClientError("web_capture_add_to_session", err, {
        sessionEvidenceType: options?.sessionEvidenceType ?? null,
        fileCount: files.length,
      });

      const storageMessage = buildStorageLimitMessage(err);
      const message =
        storageMessage ||
        (err instanceof Error ? err.message : "Failed to add items to session");

      setError(message);
      addToast(message, "error");
      throw err;
    }
  };

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

    revokeAllPreviews();
    setSessionItems([]);
    setSessionStatus(null);
    setProgress(0);
    setError(null);
    setBusy(false);
    setLocationPermissionDenied(false);
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

  const finalizeSession = async () => {
    const items = sessionItemsRef.current;

    if (items.length === 0) {
      addToast("No items in session", "error");
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

      let gps:
        | {
            lat: number;
            lng: number;
            accuracyMeters?: number;
          }
        | undefined;

      const locationRequired = selectedCollectionPlan?.locationRequirement === "required";
      const shouldUsePreciseGps = locationRequired;

      if (useLocation && navigator.geolocation) {
        try {
          gps = await new Promise<typeof gps>((resolve, reject) => {
            navigator.geolocation.getCurrentPosition(
              (pos) =>
                resolve({
                  lat: shouldUsePreciseGps
                    ? pos.coords.latitude
                    : roundGpsCoordinate(pos.coords.latitude, 3),
                  lng: shouldUsePreciseGps
                    ? pos.coords.longitude
                    : roundGpsCoordinate(pos.coords.longitude, 3),
                  accuracyMeters: pos.coords.accuracy,
                }),
              (geoErr) => reject(geoErr),
              { enableHighAccuracy: true, timeout: 8000 }
            );
          });

          setLocationAccuracyMeters(gps?.accuracyMeters ?? null);
          setLocationPermissionDenied(false);

          recordTimelineEvent({
            title: "Location recorded",
            detail: shouldUsePreciseGps
              ? "Precise device location metadata was attached with user consent because the selected intake plan requires location context."
              : "Reduced-precision device location metadata was attached with user consent.",
            tone: "info",
          });
        } catch {
          setLocationAccuracyMeters(null);
          setLocationPermissionDenied(true);

          recordTimelineEvent({
            title: "Location unavailable",
            detail: "The browser denied or failed to provide device location metadata.",
            tone: "warning",
          });

          if (locationRequired) {
            throw new Error(
              "Location metadata is required by the selected plan, but browser location was not granted."
            );
          }

          addToast("Location unavailable. Continuing without GPS.", "warning");
        }
      }

      if (locationRequired && !gps) {
        throw new Error(
          "Location metadata is required by the selected plan. Enable location and grant browser permission before finishing."
        );
      }

      const primaryMimeType = normalizeClientMimeType(primaryFile.type);
      const primaryIntegrity = await computeIntegrityFromBlob(primaryFile);

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

      const captureSessionId = getCaptureSessionDraftId?.() ?? null;

      const created = await apiFetch("/v1/evidence", {
        method: "POST",
        body: JSON.stringify({
          type: rootType,
          // Active workspace stamp; backend resolves the personal Team
          // itself when omitted (envelope still loading).
          teamId: activeSpaceId ?? undefined,
          mimeType: primaryMimeType,
          internalNotes: internalNotes.trim() || undefined,
          originalFileName: items[0]?.relativePath || primaryFile.name,
          captureFileName: primaryFile.name,
          deviceTimeIso: new Date().toISOString(),
          gps,
          checksumSha256Base64: primaryIntegrity.checksumSha256Base64,
          contentMd5Base64: primaryIntegrity.contentMd5Base64,
          intakePlanJson,
          captureSessionId: captureSessionId ?? undefined,
        }),
      });

      const evidenceId = created.id as string;
      // Phase 30.12/HOME-DATA-OWNERSHIP — the server echoes the stamped
      // team id (never null now). Resumable fork: teamId + hook + env
      // flag + large file; all other paths use the legacy XHR PUT flow.
      const evidenceTeamId =
        (created as { teamId?: string | null }).teamId ?? null;
      setSessionStatus("Uploading preserved evidence items...");

      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];

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
            });
            // Item is now staged + uploaded + server-bridged via the
            // EvidencePart row created at completeStorageMultipart
            // time. The downstream completeEvidence transaction
            // sees this item alongside any legacy parts and
            // finalizes them atomically.
            continue;
          } catch (err) {
            // Resumable failures are surfaced to the user via the
            // operations panel; the orchestrator continues to the
            // next item rather than falling back to legacy for THIS
            // file (forbidden by the non-negotiables). The capture
            // page must surface the failure and let the user retry.
            const msg = err instanceof Error ? err.message : "upload_failed";
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

        const integrity = await computeIntegrityFromBlob(item.file);

        const part = await apiFetch(`/v1/evidence/${evidenceId}/parts`, {
          method: "POST",
          body: JSON.stringify({
            partIndex: index,
            mimeType: normalizeClientMimeType(item.mimeType),
            originalFileName: item.relativePath || item.file.name,
            checksumSha256Base64: integrity.checksumSha256Base64,
            contentMd5Base64: integrity.contentMd5Base64,
            privateRole: item.role?.trim() || undefined,
            privateNote: item.privateNote?.trim() || undefined,
            checklistStepId: item.checklistStepId || undefined,
            sourceLabel: item.sourceLabel?.trim() || undefined,
            clientSignals: item.clientSignals
              ? {
                  captureTimeUtc: item.clientSignals.captureTimeUtc,
                  browserMediaCaptureAvailable:
                    item.clientSignals.browserMediaCaptureAvailable,
                  folderPathPresent: item.clientSignals.folderPathPresent,
                  locationIncluded: Boolean(gps),
                  duplicateStatus: item.clientSignals.duplicateStatus,
                  screenshotLike: item.clientSignals.screenshotLike,
                  genericMime: item.clientSignals.genericMime,
                  oldLastModified: item.clientSignals.oldLastModified,
                  clientHintSha256Base64:
                    item.clientSignals.clientHintSha256Base64,
                }
              : undefined,
          }),
        });

        // Phase 12 — bounded retry around the PUT. Network errors and
        // 5xx responses are transient and worth retrying with backoff;
        // 4xx responses are NOT retried (presigned URL is expired or
        // the request shape is wrong — re-presign would be needed).
        // This is additive: success path is unchanged and any user-
        // visible state update flows through the same callbacks.
        const MAX_PUT_ATTEMPTS = 3;
        let attempt = 0;
        let lastError: Error | null = null;
        while (attempt < MAX_PUT_ATTEMPTS) {
          attempt += 1;
          try {
            await new Promise<void>((resolve, reject) => {
              const xhr = new XMLHttpRequest();

              xhr.upload.onprogress = (event) => {
                if (!event.lengthComputable) return;

                const itemPct = Math.max(
                  1,
                  Math.min(100, Math.round((event.loaded / event.total) * 100))
                );

                setSessionItems((prev) =>
                  prev.map((current) =>
                    current.id === item.id
                      ? {
                          ...current,
                          uploading: true,
                          uploadProgress: itemPct,
                          error: null,
                        }
                      : current
                  )
                );

                const overall = Math.round(
                  ((index + event.loaded / event.total) / items.length) * 90
                );

                setProgress(Math.max(1, Math.min(90, overall)));
              };

              xhr.onerror = () =>
                reject(
                  Object.assign(new Error("Upload failed"), {
                    transient: true,
                  })
                );
              xhr.onload = () => {
                if (xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300)) {
                  resolve();
                } else if (xhr.status >= 500) {
                  reject(
                    Object.assign(new Error(`Upload failed (${xhr.status})`), {
                      transient: true,
                    })
                  );
                } else {
                  // 4xx — presigned URL likely expired or rejected.
                  // NOT retryable from here.
                  reject(new Error(`Upload failed (${xhr.status})`));
                }
              };

              xhr.open("PUT", part.upload.putUrl);
              xhr.setRequestHeader(
                "content-type",
                normalizeClientMimeType(item.mimeType)
              );
              xhr.setRequestHeader(
                "x-amz-checksum-sha256",
                integrity.checksumSha256Base64
              );
              xhr.setRequestHeader("Content-MD5", integrity.contentMd5Base64);
              xhr.send(item.file);
            });
            lastError = null;
            break;
          } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            const isTransient =
              !!(lastError as Error & { transient?: boolean }).transient;
            if (!isTransient || attempt >= MAX_PUT_ATTEMPTS) {
              throw lastError;
            }
            // Backoff: 500ms → 1500ms → ...
            await new Promise((r) => setTimeout(r, attempt * 500));
          }
        }
        if (lastError) throw lastError;

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

      await apiFetch(`/v1/evidence/${evidenceId}/complete`, {
        method: "POST",
        body: JSON.stringify({}),
      });

      setSessionStatus("Generating verification artifacts...");
      const reportReady = await pollArtifacts(evidenceId);

      setProgress(100);

      if (reportReady) {
        addToast("Evidence record created successfully!", "success");
      } else {
        addToast(
          "Evidence record created. Verification artifacts are still generating.",
          "warning"
        );
      }

      // Drop the local draft handle — the server has moved it to FINALIZED
      // (linked to the new evidence record) inside the create handler.
      onSessionFinalized?.();

      resetCaptureState({ preserveTimeline: true });
      router.push(`/evidence/${evidenceId}`);
    } catch (err) {
      // Expected billing gate — TEAM workspace evidence requires a TEAM
      // plan. This is user-recoverable: switch to personal workspace OR
      // upgrade. Staged materials must NOT be discarded (we don't call
      // resetCaptureState below for billing gates). Skip the Sentry
      // capture too — this is not a server fault.
      const teamPlanGate = buildTeamPlanRequiredDetails(err);
      if (teamPlanGate) {
        setError(teamPlanGate.message);
        addToast(teamPlanGate.message, "warning");
        setSessionStatus("Team plan required");
        setBusy(false);
        return;
      }

      logCaptureClientError("web_capture_finalize_session", err, {
        itemCount: items.length,
      });

      const storageMessage = buildStorageLimitMessage(err);
      const baseMsg =
        storageMessage || (err instanceof Error ? err.message : "Evidence intake failed");

      const reqId = (err as { requestId?: string }).requestId;
      const msg =
        reqId && typeof baseMsg === "string" && !baseMsg.includes("requestId:")
          ? `${baseMsg} (requestId: ${reqId})`
          : baseMsg;

      setError(msg);
      addToast(msg, "error");

      if (storageMessage) {
        setSessionStatus("Storage limit reached");
      }
    } finally {
      setBusy(false);
      setSessionStatus((current) =>
        current === "Storage limit reached" || current === "Team plan required"
          ? current
          : null
      );
    }
  };

  return {
    addFilesToSession,
    busy,
    error,
    finalizeSession,
    locationPermissionDenied,
    progress,
    removeSessionItem,
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