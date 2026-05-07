"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, useToast } from "../../../components/ui";
import { apiFetch } from "../../../lib/api";
import { CaptureAiAssistant } from "../../../components/ai/CaptureAiAssistant";
import {
  Camera,
  ClipboardCheck,
  FileText,
  Folder,
  FolderOpen,
  ImageIcon,
  Mic,
  ShieldCheck,
  Upload,
  Video,
} from "lucide-react";

import type {
  AudioRecorderState,
  CameraMode,
  EvidenceType,
  FacingMode,
  SessionItem,
  SessionTimelineEvent,
} from "./_lib/types";

import {
  COLLECTION_PLAN_TEMPLATES,
  GENERIC_EVIDENCE_UPLOAD_ACCEPT,
  ROLE_SUGGESTIONS,
} from "./_lib/templates";

import {
  buildAudioRecordingFileName,
  buildSessionItemSignals,
  deriveBatchEvidenceType,
  deriveSessionItemTypeLabel,
  formatEvidenceTypeLabel,
  formatFileSize,
  getChecklistStepById,
  getItemQualityStatus,
  getStepRequirementLabel,
  normalizeClientMimeType,
  pickSupportedAudioMimeType,
  roundGpsCoordinate,
  validateIncomingFiles,
} from "./_lib/file-utils";

import { computeIntegrityFromBlob } from "./_lib/hash-utils";
import { filesFromDataTransfer } from "./_lib/folder-utils";
import {
  buildStorageLimitMessage,
  describeMediaError,
  logCaptureClientError,
} from "./_lib/capture-errors";

export default function CapturePage() {
  const router = useRouter();
  const { addToast } = useToast();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [useLocation, setUseLocation] = useState(false);
  const [progress, setProgress] = useState(0);
  const [sessionStatus, setSessionStatus] = useState<string | null>(null);
  const [sessionStartedAt, setSessionStartedAt] = useState(() => new Date());
  const [internalNotes, setInternalNotes] = useState("");

  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraMode, setCameraMode] = useState<CameraMode>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [facingMode, setFacingMode] = useState<FacingMode>("environment");
  const [cameraStarting, setCameraStarting] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [flashEnabled, setFlashEnabled] = useState(false);

  const [audioRecorderOpen, setAudioRecorderOpen] = useState(false);
  const [audioRecorderState, setAudioRecorderState] =
    useState<AudioRecorderState>("idle");
  const [audioRecorderError, setAudioRecorderError] = useState<string | null>(null);
  const [audioRecordingSeconds, setAudioRecordingSeconds] = useState(0);
  const [audioPreviewUrl, setAudioPreviewUrl] = useState<string | null>(null);
  const [audioPreviewFile, setAudioPreviewFile] = useState<File | null>(null);

  const [sessionItems, setSessionItems] = useState<SessionItem[]>([]);
  const [, setSessionTimeline] = useState<SessionTimelineEvent[]>([]);
  const [collectionPlanId, setCollectionPlanId] = useState("general-evidence-record");
  const [planMode, setPlanMode] =
    useState<"FLEXIBLE" | "CHECKLIST_REQUIRED">("FLEXIBLE");
  const [, setLocationAccuracyMeters] = useState<number | null>(null);
  const [locationPermissionDenied, setLocationPermissionDenied] = useState(false);
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [planDropdownOpen, setPlanDropdownOpen] = useState(false);
  const [materialDropdownOpenId, setMaterialDropdownOpenId] =
  useState<string | null>(null);
  const [expandedMaterialId, setExpandedMaterialId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const videoPreviewRef = useRef<HTMLVideoElement | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const audioRecorderRef = useRef<MediaRecorder | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioPreviewUrlRef = useRef<string | null>(null);
  const sessionItemsRef = useRef<SessionItem[]>([]);

  useEffect(() => {
    sessionItemsRef.current = sessionItems;
  }, [sessionItems]);

  useEffect(() => {
    audioPreviewUrlRef.current = audioPreviewUrl;
  }, [audioPreviewUrl]);

  useEffect(() => {
    const folderInput = folderInputRef.current;
    if (!folderInput) return;

    folderInput.setAttribute("webkitdirectory", "");
    folderInput.setAttribute("directory", "");
  }, []);

  const selectedCollectionPlan = useMemo(
    () => COLLECTION_PLAN_TEMPLATES.find((plan) => plan.id === collectionPlanId),
    [collectionPlanId]
  );

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

  const updateSessionItem = (
    itemId: string,
    updates: Partial<
      Pick<SessionItem, "role" | "privateNote" | "checklistStepId" | "sourceLabel">
    >
  ) => {
    setSessionItems((prev) =>
      prev.map((item) => (item.id === itemId ? { ...item, ...updates } : item))
    );
  };

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const pollReport = async (evidenceId: string): Promise<boolean> => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await apiFetch(`/v1/evidence/${evidenceId}/report/latest`, {
          method: "GET",
        });
        return true;
      } catch {
        await sleep(2000);
      }
    }

    return false;
  };

  const formatRecordingTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60).toString().padStart(2, "0");
    const secs = (seconds % 60).toString().padStart(2, "0");
    return `${mins}:${secs}`;
  };

  const stopMediaStream = () => {
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
  };

  const stopAudioStream = () => {
    audioStreamRef.current?.getTracks().forEach((track) => track.stop());
    audioStreamRef.current = null;
  };

  const attachStreamToPreview = async (stream: MediaStream) => {
    const video = videoPreviewRef.current;
    if (!video) return;

    video.srcObject = stream;

    await new Promise<void>((resolve) => {
      const onLoaded = () => {
        video.removeEventListener("loadedmetadata", onLoaded);
        resolve();
      };

      video.addEventListener("loadedmetadata", onLoaded);

      if (video.readyState >= 1) {
        video.removeEventListener("loadedmetadata", onLoaded);
        resolve();
      }
    });

    try {
      await video.play();
    } catch {
      // ignore autoplay issues
    }
  };

  const revokeItemPreview = (item: SessionItem) => {
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  };

  const revokeAllPreviews = () => {
    sessionItemsRef.current.forEach(revokeItemPreview);
  };

  const clearAudioPreview = () => {
    if (audioPreviewUrl) URL.revokeObjectURL(audioPreviewUrl);
    setAudioPreviewUrl(null);
    setAudioPreviewFile(null);
  };

  const resetAudioRecorderState = () => {
    if (audioRecorderRef.current && audioRecorderRef.current.state !== "inactive") {
      audioRecorderRef.current.stop();
    }

    stopAudioStream();
    audioRecorderRef.current = null;
    audioChunksRef.current = [];
    clearAudioPreview();
    setAudioRecorderOpen(false);
    setAudioRecorderState("idle");
    setAudioRecorderError(null);
    setAudioRecordingSeconds(0);
  };

  const closeCamera = () => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }

    setIsRecording(false);
    setRecordingSeconds(0);
    stopMediaStream();
    mediaRecorderRef.current = null;

    const video = videoPreviewRef.current;
    if (video) {
      try {
        video.pause();
      } catch {
        // ignore
      }

      video.srcObject = null;
      video.load();
    }

    setCameraOpen(false);
    setCameraMode(null);
    setCameraError(null);
    setCameraStarting(false);
    setFlashEnabled(false);
  };

  useEffect(() => {
    return () => {
      stopMediaStream();
      stopAudioStream();
      revokeAllPreviews();

      if (audioPreviewUrlRef.current) {
        URL.revokeObjectURL(audioPreviewUrlRef.current);
      }

      document.body.classList.remove("camera-open");
    };
  }, []);

  useEffect(() => {
    if (cameraOpen) {
      document.body.classList.add("camera-open");
    } else {
      document.body.classList.remove("camera-open");
    }

    return () => {
      document.body.classList.remove("camera-open");
    };
  }, [cameraOpen]);

  useEffect(() => {
    if (!isRecording) {
      setRecordingSeconds(0);
      return;
    }

    const timer = window.setInterval(() => {
      setRecordingSeconds((prev) => prev + 1);
    }, 1000);

    return () => window.clearInterval(timer);
  }, [isRecording]);

  useEffect(() => {
    if (audioRecorderState !== "recording") {
      setAudioRecordingSeconds(0);
      return;
    }

    const timer = window.setInterval(() => {
      setAudioRecordingSeconds((prev) => prev + 1);
    }, 1000);

    return () => window.clearInterval(timer);
  }, [audioRecorderState]);

  useEffect(() => {
    const validStepIds = new Set(
      selectedCollectionPlan?.steps.map((step) => step.id) ?? []
    );

    setSessionItems((prev) =>
      prev.map((item) =>
        item.checklistStepId && !validStepIds.has(item.checklistStepId)
          ? { ...item, checklistStepId: null }
          : item
      )
    );
  }, [selectedCollectionPlan?.id]);

  const addFilesToSession = async (
    files: File[],
    options?: { sessionEvidenceType?: EvidenceType }
  ) => {
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

        const fileKind = normalizeClientMimeType(mimeType).startsWith("image/")
          ? "PHOTO"
          : normalizeClientMimeType(mimeType).startsWith("video/")
            ? "VIDEO"
            : normalizeClientMimeType(mimeType).startsWith("audio/")
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

          const signals = buildSessionItemSignals(
            nextFile,
            relativePath,
            existingItems
          );

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
    setSessionItems((prev) => {
      const found = prev.find((item) => item.id === itemId);
      if (found) revokeItemPreview(found);
      return prev.filter((item) => item.id !== itemId);
    });

    addToast("Item removed from session", "info");
  };

  const resetCaptureState = () => {
    revokeAllPreviews();
    setSessionItems([]);
    setSessionStatus(null);
    setProgress(0);
    setError(null);
    setBusy(false);
    setInternalNotes("");
    setLocationPermissionDenied(false);
    setSessionStartedAt(new Date());
    closeCamera();
    resetAudioRecorderState();
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

      const selectedPlan = COLLECTION_PLAN_TEMPLATES.find(
        (plan) => plan.id === collectionPlanId
      );

      let gps:
        | {
            lat: number;
            lng: number;
            accuracyMeters?: number;
          }
        | undefined;

      const locationRequired = selectedPlan?.locationRequirement === "required";
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

      const intakePlanJson = selectedPlan
        ? {
            templateId: selectedPlan.id,
            templateName: selectedPlan.name,
            mode: planMode,
            locationRequirement: selectedPlan.locationRequirement,
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
            requiredSteps: selectedPlan.steps
              .filter((step) => step.required)
              .map((step) => ({
                id: step.id,
                title: step.title,
                description: step.description,
                purposeLabel: step.purposeLabel,
                acceptedKinds: step.acceptedKinds,
              })),
            optionalSteps: selectedPlan.steps
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

          xhr.onerror = () => reject(new Error("Upload failed"));
          xhr.onload = () => {
            if (xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300)) {
              resolve();
            } else {
              reject(new Error(`Upload failed (${xhr.status})`));
            }
          };

          xhr.open("PUT", part.upload.putUrl);
          xhr.setRequestHeader("content-type", normalizeClientMimeType(item.mimeType));
          xhr.setRequestHeader(
            "x-amz-checksum-sha256",
            integrity.checksumSha256Base64
          );
          xhr.setRequestHeader("Content-MD5", integrity.contentMd5Base64);
          xhr.send(item.file);
        });

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
      const reportReady = await pollReport(evidenceId);

      setProgress(100);

      if (reportReady) {
        addToast("Evidence record created successfully!", "success");
      } else {
        addToast(
          "Evidence record created. Verification artifacts are still generating.",
          "warning"
        );
      }

      resetCaptureState();
      router.push(`/evidence/${evidenceId}`);
    } catch (err) {
      logCaptureClientError("web_capture_finalize_session", err, {
        itemCount: items.length,
      });

      const storageMessage = buildStorageLimitMessage(err);
      const baseMsg =
        storageMessage ||
        (err instanceof Error ? err.message : "Evidence intake failed");

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
        current === "Storage limit reached" ? current : null
      );
    }
  };

  const openFilePicker = () => {
    if (busy) return;
    setError(null);

    if (!fileInputRef.current) {
      const pickerError = new Error("Evidence file input is unavailable");
      logCaptureClientError("web_capture_open_file_picker", pickerError, {});
      setError("File picker is unavailable in this browser session.");
      return;
    }

    fileInputRef.current.value = "";
    fileInputRef.current.click();
  };

  const openFolderPicker = () => {
    if (busy) return;
    setError(null);

    if (!folderInputRef.current) {
      const pickerError = new Error("Evidence folder input is unavailable");
      logCaptureClientError("web_capture_open_folder_picker", pickerError, {});
      setError("Folder picker is unavailable in this browser session.");
      return;
    }

    folderInputRef.current.click();
  };

  const startCameraStream = async (
    mode: "PHOTO" | "VIDEO",
    nextFacingMode: FacingMode
  ) => {
    setCameraError(null);
    setCameraStarting(true);

    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError("Camera is not supported in this browser.");
      setCameraStarting(false);
      return;
    }

    try {
      stopMediaStream();

      setCameraMode(mode);
      setCameraOpen(true);
      setFacingMode(nextFacingMode);

      const videoConstraints = {
        facingMode: { ideal: nextFacingMode },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      } as const;

      let stream: MediaStream;
      let usedVideoOnlyFallback = false;

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: videoConstraints,
          audio: mode === "VIDEO",
        });
      } catch (primaryError) {
        if (mode !== "VIDEO") throw primaryError;

        stream = await navigator.mediaDevices.getUserMedia({
          video: videoConstraints,
          audio: false,
        });

        usedVideoOnlyFallback = true;
      }

      mediaStreamRef.current = stream;
      await attachStreamToPreview(stream);

      if (usedVideoOnlyFallback) {
        setCameraError(
          "Video recorder opened without microphone audio. Check microphone permissions if audio capture is required."
        );
      }
    } catch (err) {
      logCaptureClientError("web_capture_open_camera", err, {
        mode,
        facingMode: nextFacingMode,
      });

      setCameraError(
        describeMediaError(err, {
          permissionDenied:
            mode === "VIDEO"
              ? "Camera or microphone permission was denied. Allow device access to record video evidence."
              : "Camera permission was denied. Allow camera access to capture photo evidence.",
          notFound:
            mode === "VIDEO"
              ? "No camera device is available for video recording on this device."
              : "No camera device is available for photo capture on this device.",
          busy:
            mode === "VIDEO"
              ? "The camera or microphone is currently unavailable. Close other apps using them and try again."
              : "The camera is currently unavailable. Close other apps using it and try again.",
          constrained:
            mode === "VIDEO"
              ? "This browser could not satisfy the requested video recording settings. Try a different browser or device."
              : "This browser could not satisfy the requested camera settings. Try a different browser or device.",
          security:
            mode === "VIDEO"
              ? "Browser security settings blocked camera or microphone access."
              : "Browser security settings blocked camera access.",
          fallback:
            mode === "VIDEO"
              ? "Unable to open the video recorder."
              : "Unable to open the camera.",
        })
      );

      setCameraOpen(false);
    } finally {
      setCameraStarting(false);
    }
  };

  const openCamera = async (mode: "PHOTO" | "VIDEO") => {
    setError(null);
    setCameraError(null);
    setIsRecording(false);
    setRecordingSeconds(0);
    resetAudioRecorderState();
    await startCameraStream(mode, facingMode);
  };

  const handleFlipCamera = async () => {
    if (!cameraMode || cameraStarting || isRecording) return;

    const nextFacingMode: FacingMode =
      facingMode === "environment" ? "user" : "environment";

    await startCameraStream(cameraMode, nextFacingMode);
  };

  const handleToggleFlash = () => {
    const next = !flashEnabled;
    setFlashEnabled(next);

    addToast(
      next
        ? "Flash overlay enabled (visual preview only on web)"
        : "Flash overlay disabled",
      "info"
    );
  };

  const capturePhotoFromCamera = async () => {
    const video = videoPreviewRef.current;

    if (!video || !video.videoWidth || !video.videoHeight) {
      setCameraError("Camera preview is not ready yet.");
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setCameraError("Unable to capture image.");
      return;
    }

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", 0.92);
    });

    if (!blob) {
      setCameraError("Failed to capture photo.");
      return;
    }

    const capturedFile = new File(
      [blob],
      `PROOVRA-CAPTURE-${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`,
      {
        type: "image/jpeg",
        lastModified: Date.now(),
      }
    );

    try {
      await addFilesToSession([capturedFile], { sessionEvidenceType: "PHOTO" });
    } catch {
      setCameraError("Failed to add the captured photo to this evidence session.");
    }
  };

  const startVideoRecording = () => {
    const stream = mediaStreamRef.current;

    if (!stream) {
      setCameraError("Camera stream is not available.");
      return;
    }

    if (typeof MediaRecorder === "undefined") {
      setCameraError("Video recording is not supported in this browser.");
      return;
    }

    try {
      recordedChunksRef.current = [];
      setRecordingSeconds(0);

      const preferredMimeTypes = [
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp8,opus",
        "video/webm",
        "video/mp4",
      ];

      const mimeType =
        typeof MediaRecorder.isTypeSupported === "function"
          ? preferredMimeTypes.find((candidate) =>
              MediaRecorder.isTypeSupported(candidate)
            ) || ""
          : preferredMimeTypes[2] ?? "";

      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined
      );

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          recordedChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        const finalMimeType = normalizeClientMimeType(
          recorder.mimeType || "video/webm",
          "video/webm"
        );

        const blob = new Blob(recordedChunksRef.current, {
          type: finalMimeType,
        });

        if (blob.size === 0) {
          setCameraError("Recorded video is empty.");
          return;
        }

        const extension = finalMimeType.includes("mp4") ? "mp4" : "webm";

        const recordedFile = new File(
          [blob],
          `PROOVRA-VIDEO-CAPTURE-${new Date()
            .toISOString()
            .replace(/[:.]/g, "-")}.${extension}`,
          {
            type: finalMimeType,
            lastModified: Date.now(),
          }
        );

        try {
          await addFilesToSession([recordedFile], {
            sessionEvidenceType: "VIDEO",
          });
        } catch {
          setCameraError("Failed to add the recorded video to this evidence session.");
        }

        setIsRecording(false);
      };

      mediaRecorderRef.current = recorder;
      recorder.start(250);
      setIsRecording(true);
      addToast("Recording started", "info");
    } catch (err) {
      logCaptureClientError("web_capture_start_recording", err, {
        cameraMode,
      });

      setCameraError(
        describeMediaError(err, {
          permissionDenied:
            "Camera or microphone permission was denied. Allow access to record video evidence.",
          notFound: "A camera device is not available for video recording.",
          busy:
            "The camera or microphone is currently unavailable. Close other apps using them and try again.",
          constrained:
            "This browser could not start the requested recording settings. Try a different browser or device.",
          security: "Browser security settings blocked video recording.",
          fallback: "Unable to start video recording.",
        })
      );
    }
  };

  const stopVideoRecording = () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return;

    recorder.stop();
    addToast("Finishing video recording...", "info");
  };

  const openAudioRecorder = () => {
    closeCamera();
    setError(null);
    setAudioRecorderOpen(true);
    setAudioRecorderError(null);

    if (audioRecorderState === "failed") {
      setAudioRecorderState("idle");
    }
  };

  const startAudioRecording = async () => {
    setAudioRecorderOpen(true);
    setAudioRecorderError(null);
    clearAudioPreview();

    if (!navigator.mediaDevices?.getUserMedia) {
      setAudioRecorderState("failed");
      setAudioRecorderError(
        "Audio recording is not supported in this browser. Upload an audio file instead."
      );
      return;
    }

    if (typeof MediaRecorder === "undefined") {
      setAudioRecorderState("failed");
      setAudioRecorderError(
        "Audio recording is not supported in this browser. Upload an audio file instead."
      );
      return;
    }

    try {
      const preferredMimeType = pickSupportedAudioMimeType();
      let stream: MediaStream;

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }

      stopAudioStream();
      audioStreamRef.current = stream;
      audioChunksRef.current = [];

      const recorder =
        preferredMimeType !== null && preferredMimeType !== ""
          ? new MediaRecorder(stream, { mimeType: preferredMimeType })
          : new MediaRecorder(stream);

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onerror = (event) => {
        logCaptureClientError("web_capture_audio_recorder_error", event, {
          state: recorder.state,
        });

        stopAudioStream();
        setAudioRecorderState("failed");
        setAudioRecorderError(
          "Audio recording could not be completed. No evidence record was created."
        );
      };

      recorder.onstop = () => {
        stopAudioStream();

        const finalMimeType = normalizeClientMimeType(
          recorder.mimeType || preferredMimeType || "audio/webm",
          "audio/webm"
        );

        const blob = new Blob(audioChunksRef.current, {
          type: finalMimeType,
        });

        if (!blob.size) {
          setAudioRecorderState("failed");
          setAudioRecorderError(
            "Audio recording could not be completed. No evidence record was created."
          );
          return;
        }

        const extension = finalMimeType.includes("ogg")
          ? "ogg"
          : finalMimeType.includes("mp4")
            ? "m4a"
            : "webm";

        const previewUrl = URL.createObjectURL(blob);
        const recordedFile = new File(
          [blob],
          buildAudioRecordingFileName(extension),
          {
            type: finalMimeType,
            lastModified: Date.now(),
          }
        );

        setAudioPreviewUrl(previewUrl);
        setAudioPreviewFile(recordedFile);
        setAudioRecorderState("preview_ready");
        addToast("Audio recording ready for review", "success");
      };

      audioRecorderRef.current = recorder;
      recorder.start(250);
      setAudioRecorderState("recording");
      addToast("Audio recording started", "info");
    } catch (err) {
      logCaptureClientError("web_capture_start_audio_recording", err, {});

      setAudioRecorderState("failed");
      setAudioRecorderError(
        describeMediaError(err, {
          permissionDenied:
            "Microphone permission was denied. Enable microphone access or upload an existing audio file.",
          notFound:
            "No microphone device is available in this browser. Upload an audio file instead.",
          busy:
            "The microphone is currently unavailable. Close other apps using it and try again.",
          constrained:
            "This browser could not satisfy the requested audio recording settings. Upload an audio file instead.",
          security:
            "Browser security settings blocked microphone access. Upload an audio file instead.",
          fallback:
            "Audio recording could not be started. Upload an audio file instead.",
        })
      );
    }
  };

  const stopAudioRecording = () => {
    const recorder = audioRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return;

    recorder.stop();
    setAudioRecorderState("stopped");
    addToast("Finishing audio recording...", "info");
  };

  const discardAudioRecording = () => {
    resetAudioRecorderState();
    setAudioRecorderOpen(true);
    addToast("Audio recording discarded", "info");
  };

  const addAudioRecordingToSession = async () => {
    if (!audioPreviewFile) return;

    setAudioRecorderState("uploading");

    try {
      await addFilesToSession([audioPreviewFile], {
        sessionEvidenceType: "AUDIO",
      });

      resetAudioRecorderState();
    } catch (err) {
      logCaptureClientError("web_capture_add_audio_to_session", err, {});
      setAudioRecorderState("failed");
      setAudioRecorderError(
        err instanceof Error
          ? err.message
          : "Audio recording could not be added to the evidence session."
      );
    }
  };

  const handleDroppedFiles = async (fileList: FileList | File[] | null) => {
    const files = Array.from(fileList ?? []);
    if (!files.length) return;

    const batchType = deriveBatchEvidenceType(files);

    try {
      await addFilesToSession(files, { sessionEvidenceType: batchType });
    } catch (err) {
      logCaptureClientError("web_capture_handle_dropped_files", err, {
        fileCount: files.length,
      });

      throw err;
    }
  };

  const sessionCountLabel = useMemo(() => {
    const count = sessionItems.length;
    return `${count} item${count === 1 ? "" : "s"} added`;
  }, [sessionItems.length]);

  const checklistStepItemMap = useMemo(() => {
    const map = new Map<string, SessionItem[]>();

    sessionItems.forEach((item) => {
      if (!item.checklistStepId) return;

      const existing = map.get(item.checklistStepId) ?? [];
      map.set(item.checklistStepId, [...existing, item]);
    });

    return map;
  }, [sessionItems]);

  const checklistValidation = useMemo(() => {
    const requiredSteps =
      selectedCollectionPlan?.steps.filter((step) => step.required) ?? [];

    const mappedRequiredStepIds = new Set(
      sessionItems.map((item) => item.checklistStepId).filter(Boolean) as string[]
    );

    const missingRequiredSteps = requiredSteps.filter(
      (step) => !mappedRequiredStepIds.has(step.id)
    );

    return {
      requiredSteps,
      missingRequiredSteps,
      isComplete: requiredSteps.length === 0 || missingRequiredSteps.length === 0,
      mappedRequiredStepIds,
    };
  }, [selectedCollectionPlan, sessionItems]);

  const finishValidation = useMemo(() => {
    if (sessionItems.length === 0) {
      return {
        reason: "Add at least one material to finish.",
        missingStepTitles: [] as string[],
      };
    }

    if (
      planMode === "CHECKLIST_REQUIRED" &&
      checklistValidation.missingRequiredSteps.length > 0
    ) {
      return {
        reason: "Cannot finish yet",
        missingStepTitles: checklistValidation.missingRequiredSteps.map(
          (step) => step.title
        ),
      };
    }

    if (selectedCollectionPlan?.locationRequirement === "required" && !useLocation) {
      return {
        reason: "Location metadata is required by the selected plan.",
        missingStepTitles: [] as string[],
      };
    }

    return {
      reason: undefined,
      missingStepTitles: [] as string[],
    };
  }, [
    sessionItems.length,
    planMode,
    checklistValidation.missingRequiredSteps,
    selectedCollectionPlan,
    useLocation,
  ]);

  const finishDisabled = busy || Boolean(finishValidation.reason);

  const totalStagedBytes = useMemo(
    () => sessionItems.reduce((sum, item) => sum + item.file.size, 0),
    [sessionItems]
  );

  const activeWorkflowStep = busy ? 4 : sessionItems.length > 0 ? 3 : 1;

  const completedRequiredCount =
    checklistValidation.requiredSteps.length -
    checklistValidation.missingRequiredSteps.length;

  const requiredProgressPercent =
    checklistValidation.requiredSteps.length > 0
      ? Math.round(
          (completedRequiredCount / checklistValidation.requiredSteps.length) * 100
        )
      : 100;

  const captureAiSummary = useMemo(
    () => ({
      totalItems: sessionItems.length,
      totalSizeBytes: totalStagedBytes,
      requiredStepsCompleted: completedRequiredCount,
      requiredStepsTotal: checklistValidation.requiredSteps.length,
      planMode,
      useLocation,
      locationRequirement:
        selectedCollectionPlan?.locationRequirement ?? "optional",
    }),
    [
      sessionItems.length,
      totalStagedBytes,
      completedRequiredCount,
      checklistValidation.requiredSteps.length,
      planMode,
      useLocation,
      selectedCollectionPlan?.locationRequirement,
    ]
  );

  const currentSessionId = useMemo(() => {
    const date = sessionStartedAt;
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");

    return `CAP-${y}-${m}-${d}`;
  }, [sessionStartedAt]);

  const closeMaterialDropdown = () => {
  setMaterialDropdownOpenId(null);
};

useEffect(() => {
  const hasStagedMaterials = sessionItems.length > 0 && !busy;

  const handleBeforeUnload = (event: BeforeUnloadEvent) => {
    if (!hasStagedMaterials) return;

    event.preventDefault();
    event.returnValue = "";
  };

  window.addEventListener("beforeunload", handleBeforeUnload);

  return () => {
    window.removeEventListener("beforeunload", handleBeforeUnload);
  };
}, [sessionItems.length, busy]);

useEffect(() => {
  const handleOutsideClick = (event: PointerEvent) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    const clickedInsidePlanDropdown = target.closest(".capture-plan-dropdown");
    const clickedInsideMaterialDropdown = target.closest(".capture-material-dropdown");

    if (!clickedInsidePlanDropdown) {
      setPlanDropdownOpen(false);
    }

    if (!clickedInsideMaterialDropdown) {
      setMaterialDropdownOpenId(null);
    }
  };

  document.addEventListener("pointerdown", handleOutsideClick);

  return () => {
    document.removeEventListener("pointerdown", handleOutsideClick);
  };
}, []);

  return (
    <div className="section app-section capture-page-shell capture-enterprise-page">
      <input
        ref={fileInputRef}
        type="file"
        aria-label="Upload evidence files"
        multiple
        accept={GENERIC_EVIDENCE_UPLOAD_ACCEPT}
        onChange={async (event) => {
          const input = event.currentTarget;

          try {
            await handleDroppedFiles(input.files);
          } catch (err) {
            logCaptureClientError("web_capture_file_input_change", err, {});
          } finally {
            input.value = "";
          }
        }}
        style={{ display: "none" }}
      />

      <input
        ref={folderInputRef}
        type="file"
        aria-label="Upload evidence folder"
        multiple
        onChange={async (event) => {
          const input = event.currentTarget;

          try {
            await handleDroppedFiles(input.files);
          } catch (err) {
            logCaptureClientError("web_capture_folder_input_change", err, {});
          } finally {
            input.value = "";
          }
        }}
        style={{ display: "none" }}
      />

      <datalist id="role-suggestions">
        {ROLE_SUGGESTIONS.map((role) => (
          <option key={role} value={role} />
        ))}
      </datalist>

      <div className="capture-enterprise-shell">
        <section className="capture-enterprise-top">
          <div className="capture-enterprise-title-card">
<div className="capture-enterprise-icon">
  <Camera size={28} strokeWidth={2.1} />
</div>
            <div>
              <div className="capture-enterprise-eyebrow">Evidence intake workspace</div>
              <h1 className="capture-enterprise-title">Capture Evidence</h1>
              <p className="capture-enterprise-subtitle">
                Collect, map, fingerprint, and prepare evidence materials before Review
                & Sign.
              </p>
            </div>
          </div>

          <div className="capture-enterprise-security-card">
<div className="capture-security-shield">
  <ShieldCheck size={28} strokeWidth={2.1} />
</div>
            <div>
              <strong>End-to-end protected</strong>
              <p>
                Cryptographic integrity, encrypted storage, and verifiable audit trail.
              </p>
            </div>
          </div>
        </section>

        <section className="capture-enterprise-steps">
          {[
            ["1", "Intake method", "Choose how to collect"],
            ["2", "Requirements", "Configure collection and mapping"],
            ["3", "Evidence capture", "Upload or record source material"],
            ["4", "Review & Sign", "Finalize the evidence session"],
          ].map(([step, title, detail], index) => {
            const stepNumber = index + 1;
            const stepState =
              activeWorkflowStep > stepNumber
                ? "completed"
                : activeWorkflowStep === stepNumber
                  ? "active"
                  : "future";

            return (
              <div
                key={step}
                className={`capture-enterprise-step ${stepState}`}
              >
                <div className="capture-enterprise-step-number">{step}</div>
                <div>
                  <strong>{title}</strong>
                  <span>{detail}</span>
                </div>
              </div>
            );
          })}
        </section>

        <section className="capture-enterprise-grid">
          <aside className="capture-enterprise-card capture-left-panel">
            <div>
              <div className="capture-section-label">Collection method</div>
              <div className="capture-card-title">Choose intake structure</div>
              <p className="capture-card-muted">
                Select a guided checklist for structured review or use flexible intake
                for general evidence preservation.
              </p>
            </div>

            <button
              type="button"
              className={`capture-method-button ${
                planMode === "CHECKLIST_REQUIRED" ? "active" : ""
              }`}
              onClick={() => setPlanMode("CHECKLIST_REQUIRED")}
              disabled={busy || sessionItems.length > 0}
            >
<span className="capture-method-icon">
  <ClipboardCheck size={22} strokeWidth={2.1} />
</span>
              <span>
                <strong>Guided checklist</strong>
                <small>
                  Structured requirements for claims, investigations, legal, and compliance.
                </small>
              </span>
            </button>

            <button
              type="button"
              className={`capture-method-button ${
                planMode === "FLEXIBLE" ? "active" : ""
              }`}
              onClick={() => setPlanMode("FLEXIBLE")}
              disabled={busy || sessionItems.length > 0}
            >
<span className="capture-method-icon bronze">
  <FolderOpen size={22} strokeWidth={2.1} />
</span>
              <span>
                <strong>Flexible intake</strong>
                <small>Upload any materials without blocking completion.</small>
              </span>
            </button>

            {sessionItems.length > 0 ? (
              <div className="capture-soft-note">
                Intake mode and template are locked after adding materials to preserve
                review context.
              </div>
            ) : null}

            <div className="capture-benefits-card">
              <div className="capture-card-title">Why guided checklist?</div>
              {[
                "Reduces missing evidence",
                "Maps each item to reviewer purpose",
                "Improves claim and legal readiness",
                "Creates clearer audit context",
              ].map((text) => (
                <div key={text}>✓ {text}</div>
              ))}
            </div>

            <label className="capture-location-card">
              <span>
                <strong>Include location</strong>
                <small>
                  Investigation plans preserve precise GPS metadata, while other intake
                  workflows reduce location precision by default.
                </small>
              </span>
              <input
                type="checkbox"
                checked={useLocation}
                onChange={(event) => setUseLocation(event.target.checked)}
                disabled={busy}
              />
            </label>
          </aside>

          <main className="capture-enterprise-card capture-main-panel">
            <div className="capture-panel-heading">
              <div>
                <div className="capture-section-label">Requirements</div>
                <div className="capture-card-title">
                  {selectedCollectionPlan?.name ?? "Evidence intake"}
                </div>
                <p className="capture-card-muted">
                  {selectedCollectionPlan?.description}
                </p>
              </div>

              <div className="capture-plan-dropdown">
                <button
                  type="button"
                  className="capture-plan-dropdown-trigger"
                  disabled={busy || sessionItems.length > 0}
                  onClick={() => setPlanDropdownOpen((prev) => !prev)}
                >
                  <span>{selectedCollectionPlan?.name ?? "Select plan"}</span>
                  <span>⌄</span>
                </button>

                {planDropdownOpen && !(busy || sessionItems.length > 0) ? (
                  <div className="capture-plan-dropdown-menu">
                    {COLLECTION_PLAN_TEMPLATES.map((plan) => (
                      <button
                        key={plan.id}
                        type="button"
                        className={`capture-plan-dropdown-item ${
                          collectionPlanId === plan.id ? "active" : ""
                        }`}
                        onClick={() => {
                          setCollectionPlanId(plan.id);
                          setPlanDropdownOpen(false);
                        }}
                      >
                        {plan.name}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>

            {selectedCollectionPlan ? (
              <div className="capture-requirements-list">
                {selectedCollectionPlan.steps.map((step, index) => {
                  const mapped = checklistStepItemMap.has(step.id);

                  return (
                    <div key={step.id} className="capture-requirement-row">
                      <div className="capture-requirement-index">{index + 1}</div>
<div className="capture-requirement-icon">
  {step.acceptedKinds?.includes("DOCUMENT") ? (
    <FileText size={18} strokeWidth={2.1} />
  ) : step.acceptedKinds?.includes("AUDIO") ? (
    <Mic size={18} strokeWidth={2.1} />
  ) : step.acceptedKinds?.includes("VIDEO") ? (
    <Video size={18} strokeWidth={2.1} />
  ) : (
    <Camera size={18} strokeWidth={2.1} />
  )}
</div>

                      <div className="capture-requirement-copy">
                        <div>
                          <strong>{step.title}</strong>
                          <span className={step.required ? "required" : "optional"}>
                            {step.required ? "Required" : "Optional"}
                          </span>
                        </div>
                        <p>{step.description}</p>
                        <small>
                          Accepted:{" "}
                          {step.acceptedKinds?.map(formatEvidenceTypeLabel).join(", ")}
                        </small>
                      </div>

                      <div
                        className={`capture-requirement-status ${
                          mapped
                            ? "capture-status-met"
                            : step.required
                              ? "capture-status-missing"
                              : ""
                        }`}
                      >
                        {mapped ? "Mapped" : step.required ? "Not mapped" : "Optional"}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}

            <div
              className="capture-drop-zone-enterprise"
              onDragOver={(event) => event.preventDefault()}
              onDrop={async (event) => {
                event.preventDefault();

                try {
                  const files = await filesFromDataTransfer(event.dataTransfer);
                  await handleDroppedFiles(files);
                } catch (err) {
                  logCaptureClientError("web_capture_drop_files_or_folder", err, {});
                  setError(
                    err instanceof Error
                      ? err.message
                      : "Dropped files or folder could not be added."
                  );
                }
              }}
            >
              <div className="capture-upload-actions">
<Button variant="secondary" onClick={openFilePicker} disabled={busy}>
  <Upload size={17} strokeWidth={2.1} />
  Upload Files
</Button>
<Button variant="secondary" onClick={openFolderPicker} disabled={busy}>
  <FolderOpen size={17} strokeWidth={2.1} />
  Upload Folder
</Button>
<Button variant="secondary" onClick={() => openCamera("PHOTO")} disabled={busy}>
  <Camera size={17} strokeWidth={2.1} />
  Capture Photo
</Button>
<Button variant="secondary" onClick={() => openCamera("VIDEO")} disabled={busy}>
  <Video size={17} strokeWidth={2.1} />
  Record Video
</Button>
<Button variant="secondary" onClick={openAudioRecorder} disabled={busy}>
  <Mic size={17} strokeWidth={2.1} />
  Record Audio
</Button>
              </div>
{sessionItems.length > 0 ? (
  <div className="capture-materials-board">
    <div className="capture-materials-header">
      <div>
        <div className="capture-section-label">Added materials</div>
        <div className="capture-card-title">{sessionCountLabel}</div>
      </div>

      <div className="capture-materials-meta">
        {formatFileSize(totalStagedBytes)}
      </div>
    </div>

    <div className="capture-materials-grid">
      {sessionItems.map((item, index) => {
        const mappedStep = getChecklistStepById(
          selectedCollectionPlan,
          item.checklistStepId
        );

        const qualityStatus = getItemQualityStatus({
          item,
          step: mappedStep,
        });

        const isExpanded = expandedMaterialId === item.id;

        const riskTone =
          qualityStatus.tone === "danger"
            ? "critical"
            : qualityStatus.tone === "success"
              ? "success"
              : "warning";

        const mappedLabel = mappedStep
          ? getStepRequirementLabel(mappedStep)
          : planMode === "CHECKLIST_REQUIRED"
            ? "Unmapped"
            : "Optional mapping";

        const typeLabel = deriveSessionItemTypeLabel(item.mimeType);

        const previewTypeLabel = item.relativePath
          ? "FOLDER"
          : item.mimeType.startsWith("audio/")
            ? "AUDIO"
            : item.mimeType.startsWith("video/")
              ? "VIDEO"
              : item.mimeType.startsWith("image/")
                ? "IMAGE"
                : item.mimeType === "application/pdf"
                  ? "PDF"
                  : "FILE";

        const FileIcon = item.relativePath
          ? Folder
          : item.mimeType.startsWith("audio/")
            ? Mic
            : item.mimeType.startsWith("video/")
              ? Video
              : item.mimeType.startsWith("image/")
                ? ImageIcon
                : FileText;

        return (
          <div
            key={item.id}
            className={`capture-material-card ${
              materialDropdownOpenId === item.id ? "is-open" : ""
            }`}
          >
            <div className="capture-material-preview">
              <div className="capture-material-badge">{previewTypeLabel}</div>

              {item.previewUrl && item.mimeType.startsWith("image/") ? (
                <img src={item.previewUrl} alt={item.file.name} />
              ) : item.previewUrl && item.mimeType.startsWith("video/") ? (
                <video src={item.previewUrl} muted playsInline controls={false} />
              ) : (
                <div className="capture-material-file-icon">
                  <FileIcon size={34} strokeWidth={1.9} />
                </div>
              )}
            </div>

            <div className="capture-material-body">
              <div className="capture-material-compact">
                <div className="capture-material-top">
                  <div>
                    <small>Item {index + 1}</small>
                    <strong title={item.file.name}>{item.file.name}</strong>
                    <span>
                      {typeLabel} • {formatFileSize(item.file.size)}
                    </span>
                  </div>

                  {!busy ? (
                    <button type="button" onClick={() => removeSessionItem(item.id)}>
                      Remove
                    </button>
                  ) : null}
                </div>

                <div className="capture-material-pill-row">
                  <span
                    className={`capture-material-status-pill ${
                      mappedStep ? "mapped" : "unmapped"
                    }`}
                  >
                    {mappedLabel}
                  </span>

                  <span className={`capture-material-risk-pill ${riskTone}`}>
                    {qualityStatus.label}
                  </span>
                </div>

                <button
                  type="button"
                  className="capture-material-expand-button"
                  onClick={() =>
                    setExpandedMaterialId((current) =>
                      current === item.id ? null : item.id
                    )
                  }
                >
                  {isExpanded ? "Hide review details" : "Expand review"}
                  <span>{isExpanded ? "⌃" : "⌄"}</span>
                </button>
              </div>

              {isExpanded ? (
                <div className="capture-material-review-panel">
                  <div
                    className={`capture-material-dropdown ${
                      materialDropdownOpenId === item.id ? "is-open" : ""
                    }`}
                  >
                    <button
                      type="button"
                      className="capture-material-dropdown-trigger"
                      disabled={busy}
                      onClick={() =>
                        setMaterialDropdownOpenId((current) =>
                          current === item.id ? null : item.id
                        )
                      }
                    >
                      <span>
                        {mappedStep
                          ? `Mapped: ${getStepRequirementLabel(mappedStep)}`
                          : planMode === "CHECKLIST_REQUIRED"
                            ? "Map to requirement"
                            : "Map to collection step"}
                      </span>
                      <span className="capture-material-dropdown-chevron">⌄</span>
                    </button>

                    {materialDropdownOpenId === item.id ? (
                      <div className="capture-material-dropdown-menu">
                        <button
                          type="button"
                          className={!item.checklistStepId ? "active" : ""}
                          onClick={() => {
                            updateSessionItem(item.id, { checklistStepId: null });
                            closeMaterialDropdown();
                          }}
                        >
                          Map to collection step
                        </button>

                        {selectedCollectionPlan?.steps.map((step) => (
                          <button
                            key={step.id}
                            type="button"
                            className={
                              item.checklistStepId === step.id ? "active" : ""
                            }
                            onClick={() => {
                              updateSessionItem(item.id, {
                                checklistStepId: step.id,
                              });
                              closeMaterialDropdown();
                            }}
                          >
                            <span>
                              {getStepRequirementLabel(step)}: {step.title}
                            </span>
                            <small>{step.purposeLabel}</small>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>

                  <div
                    className={
                      qualityStatus.tone === "success"
                        ? "capture-quality-success"
                        : qualityStatus.tone === "danger"
                          ? "capture-quality-danger"
                          : "capture-quality-warning"
                    }
                  >
                    <strong>{qualityStatus.label}</strong>
{qualityStatus.detail ? <div>{qualityStatus.detail}</div> : null}
                  </div>

                  <textarea
                    value={item.privateNote ?? ""}
                    onChange={(event) =>
                      updateSessionItem(item.id, {
                        privateNote: event.target.value,
                      })
                    }
                    disabled={busy}
                    placeholder="Private item note"
                    maxLength={1000}
                    className="capture-material-note"
                  />
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  </div>
) : null}

              {sessionItems.length === 0 ? (
                <>
                  <strong>Drag & drop files here or choose a capture method</strong>
                  <p>
                    Files staged locally before Review & Sign. Nothing is signed or
                    submitted until the evidence record is finalized.
                  </p>
                  <p className="capture-drop-zone-note">
                    Integrity metadata is prepared during intake. Verification artifacts
                    are generated after finalization.
                  </p>
                </>
              ) : null}
            {audioRecorderOpen ? (
              <div className="capture-audio-card">
                <div className="capture-panel-heading">
                  <strong>Audio Recorder</strong>
                  <span>
                    {audioRecorderState === "recording"
                      ? `Recording · ${formatRecordingTime(audioRecordingSeconds)}`
                      : audioRecorderState === "preview_ready"
                        ? "Preview ready"
                        : "Ready"}
                  </span>
                </div>

                {audioPreviewUrl ? (
                  <audio controls preload="metadata" src={audioPreviewUrl}>
                    Your browser could not play this audio preview.
                  </audio>
                ) : null}

                {audioRecorderError ? (
                  <div className="capture-quality-danger">{audioRecorderError}</div>
                ) : null}

                <div className="capture-upload-actions">
                  <Button
                    variant="secondary"
                    onClick={startAudioRecording}
                    disabled={busy || audioRecorderState === "recording"}
                  >
                    Start Recording
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={stopAudioRecording}
                    disabled={audioRecorderState !== "recording"}
                  >
                    Stop
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={discardAudioRecording}
                    disabled={
                      audioRecorderState === "recording" ||
                      audioRecorderState === "uploading"
                    }
                  >
                    Discard
                  </Button>
                  <Button
                    onClick={addAudioRecordingToSession}
                    disabled={audioRecorderState !== "preview_ready"}
                  >
                    Add to Session
                  </Button>
                </div>
              </div>
            ) : null}
            </div>
          </main>

          <aside className="capture-session-column">
            <div className="capture-enterprise-card capture-right-panel">
              <div className="capture-panel-heading">
                <div>
                  <div className="capture-section-label">Session overview</div>
                  <div className="capture-card-title">{sessionCountLabel}</div>
                </div>

                <button
                  type="button"
                  onClick={resetCaptureState}
                  disabled={busy || sessionItems.length === 0}
                  className="capture-small-button"
                >
                  New Session
                </button>
              </div>

              <div className="capture-session-meta">
                {[
                  ["Session ID", currentSessionId],
                  ["Template", selectedCollectionPlan?.name ?? "General"],
                  [
                    "Status",
                    busy ? "Finalizing" : sessionItems.length ? "In Progress" : "Draft",
                  ],
                  [
                    "Required Steps",
                    `${completedRequiredCount} of ${checklistValidation.requiredSteps.length} completed`,
                  ],
                  ["Total Items", String(sessionItems.length)],
                  ["Total Size", formatFileSize(totalStagedBytes)],
                ].map(([label, value]) => (
                  <div key={label}>
                    <span>{label}</span>
                    <strong>{value}</strong>
                  </div>
                ))}

                <div className="capture-progress-track">
                  <div style={{ width: `${requiredProgressPercent}%` }} />
                </div>
              </div>

              <div className="capture-integrity-block">
                <div className="capture-card-title">Integrity preparation</div>
                <div className="capture-integrity-grid">
                  <div>
                    <span>Local fingerprint</span>
                    <strong>Queued with staged material</strong>
                  </div>
                  <div>
                    <span>Chain of custody</span>
                    <strong>Initialized</strong>
                  </div>
                  <div>
                    <span>Verification package</span>
                    <strong>Generated after Review & Sign</strong>
                  </div>
                  <div>
                    <span>Timestamping</span>
                    <strong>Queued after finalization</strong>
                  </div>
                  <div>
                    <span>Location metadata</span>
                    <strong>{useLocation ? "Included" : "Not included"}</strong>
                  </div>
                </div>
              </div>

              <CaptureAiAssistant
                isOpen={aiPanelOpen}
                setOpen={setAiPanelOpen}
                collectionPlan={selectedCollectionPlan ?? null}
                summary={captureAiSummary}
                sessionItems={sessionItems.map((item) => ({
                  id: item.id,
                  fileName: item.file.name,
                  mimeType: item.mimeType,
                  sizeBytes: item.file.size,
                  checklistStepId: item.checklistStepId ?? null,
                  role: item.role ?? undefined,
                  sourceLabel: item.sourceLabel ?? undefined,
                  clientSignals: {
                    duplicateStatus: item.clientSignals?.duplicateStatus,
                    screenshotLike: item.clientSignals?.screenshotLike,
                    genericMime: item.clientSignals?.genericMime,
                    oldLastModified: item.clientSignals?.oldLastModified,
                    folderPathPresent: item.clientSignals?.folderPathPresent,
                    locationIncluded: item.clientSignals?.locationIncluded,
                  },
                }))}
              />

<div className="capture-empty-state">
  Added materials appear below the upload workspace for mapping, notes, and quality review.
</div>
              <div className="capture-notes-card">
                <div className="capture-card-title">Private Internal Notes</div>
                <p>
                  Visible only inside the authenticated app. Excluded from public
                  verification, reports, and verification packages.
                </p>
                <textarea
                  value={internalNotes}
                  onChange={(event) => setInternalNotes(event.target.value)}
                  maxLength={4000}
                  disabled={busy}
                  placeholder="Add investigator, legal, insurance, or internal review context."
                />
              </div>

              {error ? <div className="capture-quality-danger">{error}</div> : null}

              {locationPermissionDenied ? (
                <div className="capture-quality-warning">
                  Location was not granted. The current session will continue without GPS
                  metadata.
                </div>
              ) : null}
            </div>
          </aside>
        </section>

        <section className="capture-bottom-bar">
          <div className="capture-bottom-bar-inner">
            <div>
              <strong>{finishValidation.reason ?? "Ready to finish and sign"}</strong>
              <p>
                {busy
                  ? `Finishing evidence session… ${progress}%`
                  : sessionStatus ??
                    "Complete the intake when all required materials are mapped. Review & Sign locks the session, records integrity metadata, and starts verification artifact generation."}
              </p>

              {finishValidation.missingStepTitles.length > 0 ? (
                <small>Missing: {finishValidation.missingStepTitles.join(", ")}</small>
              ) : null}
            </div>

            <Button
              variant="secondary"
              onClick={resetCaptureState}
              disabled={busy || sessionItems.length === 0}
              className="capture-clear-button"
            >
              Clear Session
            </Button>

            <Button
              onClick={finalizeSession}
              disabled={finishDisabled}
              className="capture-finish-button"
            >
              {busy ? "Finishing…" : "Review & Sign"}
            </Button>
          </div>
        </section>
      </div>

      {cameraOpen ? (
        <div className={`camera-overlay ${flashEnabled ? "camera-overlay-flash" : ""}`}>
          <video
            ref={videoPreviewRef}
            autoPlay
            muted={cameraMode !== "VIDEO" || !isRecording}
            playsInline
            className="camera-preview"
          />

          <div className="camera-topbar">
            <button
              type="button"
              className="camera-icon-btn"
              onClick={closeCamera}
              disabled={busy || cameraStarting}
            >
              Close
            </button>

            <div className="camera-topbar-title-group">
              <div className="camera-title">
                {cameraMode === "PHOTO" ? "Capture Photo" : "Record Video"}
              </div>

              {cameraMode === "VIDEO" && isRecording ? (
                <div className="camera-recording-indicator">
                  <span className="camera-recording-dot" />
                  REC {formatRecordingTime(recordingSeconds)}
                </div>
              ) : (
                <div className="camera-subtitle">
                  {facingMode === "environment" ? "Rear camera" : "Front camera"}
                </div>
              )}
            </div>

            <div className="camera-topbar-group camera-topbar-group-right">
              {cameraMode === "PHOTO" ? (
                <button
                  type="button"
                  className={`camera-icon-btn ${flashEnabled ? "active" : ""}`}
                  onClick={handleToggleFlash}
                  disabled={busy || cameraStarting}
                >
                  Flash
                </button>
              ) : null}

              <button
                type="button"
                className="camera-icon-btn"
                onClick={handleFlipCamera}
                disabled={busy || cameraStarting || isRecording}
              >
                Flip
              </button>
            </div>
          </div>

          <div className="camera-added-pill">{sessionItems.length} added</div>

          <div className="camera-bottombar">
            <div className="camera-bottombar-meta">
              {cameraError ? (
                <div className="camera-inline-error">{cameraError}</div>
              ) : cameraMode === "PHOTO" ? (
                <div className="camera-helper-text">
                  Capture repeatedly to add multiple photos into one evidence record.
                </div>
              ) : !isRecording ? (
                <div className="camera-helper-text">
                  Record a clip, it will be auto-added to the same evidence session.
                </div>
              ) : (
                <div className="camera-helper-text">
                  Recording… {formatRecordingTime(recordingSeconds)}
                </div>
              )}
            </div>

            <div className="camera-bottombar-actions">
              {cameraMode === "PHOTO" ? (
                <button
                  type="button"
                  className="camera-capture-btn"
                  onClick={capturePhotoFromCamera}
                  disabled={busy || cameraStarting}
                >
                  Add to Evidence Session
                </button>
              ) : !isRecording ? (
                <button
                  type="button"
                  className="camera-capture-btn"
                  onClick={startVideoRecording}
                  disabled={busy || cameraStarting}
                >
                  Record
                </button>
              ) : (
                <button
                  type="button"
                  className="camera-capture-btn danger"
                  onClick={stopVideoRecording}
                  disabled={busy}
                >
                  Stop & Add
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}