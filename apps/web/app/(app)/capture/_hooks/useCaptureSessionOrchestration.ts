import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { useToast } from "../../../../components/ui";
import { apiFetch } from "../../../../lib/api";
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
}: UseCaptureSessionOrchestrationParams) {
  const router = useRouter();
  const { addToast } = useToast();

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
