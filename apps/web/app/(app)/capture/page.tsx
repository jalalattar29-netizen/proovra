"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button, useToast } from "../../../components/ui";
import { CaptureBottomBar } from "../../../components/capture-v2/CaptureBottomBar";
import { CaptureCameraOverlay } from "../../../components/capture-v2/CaptureCameraOverlay";
import { CaptureDropzone } from "../../../components/capture-v2/CaptureDropzone";
import { CaptureRequirements } from "../../../components/capture-v2/CaptureRequirements";
import { CaptureSessionPanel } from "../../../components/capture-v2/CaptureSessionPanel";
import {
  Camera,
  ClipboardCheck,
  FileText,
  Folder,
  FolderOpen,
  ImageIcon,
  Mic,
  ShieldCheck,
  Video,
} from "lucide-react";

import type { ChecklistStep, SessionItem } from "./_lib/types";

import {
  COLLECTION_PLAN_TEMPLATES,
  GENERIC_EVIDENCE_UPLOAD_ACCEPT,
} from "./_lib/templates";
import { useIntakeTemplates } from "./_hooks/useIntakeTemplates";
import { useCaptureDraftPersistence } from "./_hooks/useCaptureDraftPersistence";
import { useCaptureDraftList } from "./_hooks/useCaptureDraftList";

import {
  deriveBatchEvidenceType,
  deriveSessionItemTypeLabel,
  formatEvidenceTypeLabel,
  formatFileSize,
  getChecklistStepById,
  getItemQualityStatus,
} from "./_lib/file-utils";

import { filesFromDataTransfer } from "./_lib/folder-utils";
import { logCaptureClientError } from "./_lib/capture-errors";
import { buildSessionReadiness } from "./_lib/session-readiness";
import { buildSessionWorkflowSnapshot } from "./_lib/session-workflow";
import { useCaptureSessionOrchestration } from "./_hooks/useCaptureSessionOrchestration";
import type { CaptureSessionAddFiles } from "./_hooks/useCaptureSessionOrchestration";
import { useCaptureCamera } from "./_hooks/useCaptureCamera";
import { useCaptureAudioRecorder } from "./_hooks/useCaptureAudioRecorder";

export default function CapturePage() {
  const { addToast } = useToast();
  const addFilesToSessionRef = useRef<CaptureSessionAddFiles | null>(null);
  const setPageErrorRef = useRef<(message: string | null) => void>(() => {});

  const [useLocation, setUseLocation] = useState(false);
  const [internalNotes, setInternalNotes] = useState("");

  const [collectionPlanId, setCollectionPlanId] = useState(
    "general-evidence-record"
  );
  const [planMode, setPlanMode] =
    useState<"FLEXIBLE" | "CHECKLIST_REQUIRED">("FLEXIBLE");
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [planDropdownOpen, setPlanDropdownOpen] = useState(false);
  const [openMaterialDropdownId, setOpenMaterialDropdownId] = useState<
    string | null
  >(null);
  const [expandedMaterialId, setExpandedMaterialId] = useState<string | null>(
  null
);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);

  const getSimpleRoleLabel = (role?: string | null) => {
    const normalized = role?.trim().toLowerCase() ?? "";
    if (normalized.startsWith("primary")) return "Primary";
    if (normalized.startsWith("supporting")) return "Supporting";
    if (normalized.includes("context") || normalized.includes("supplement"))
      return "Context";
    return "Context";
  };

  const getRoleFromChecklistStep = (step: ChecklistStep) => {
    const id = step.id.toLowerCase();

    const primaryStepIds = [
      "primary_evidence",
      "primary_media",
      "overview_media",
      "damage_close_up",
      "ownership_document",
      "scene_overview",
      "close_up_detail",
      "policy_document",
      "screenshot_export",
    ];

    const supportingStepIds = [
      "supporting_context",
      "optional_statement",
      "optional_audio",
      "supporting_exhibit",
      "source_context",
      "optional_timeline",
      "witness_statement",
      "supporting_file",
      "supporting_evidence",
      "reviewer_context",
      "source_safe_note",
      "supporting_document",
    ];

    if (primaryStepIds.includes(id)) return "Primary";
    if (supportingStepIds.includes(id)) return "Supporting";

    return step.required ? "Primary" : "Supporting";
  };

  const getRoleRequirementDisplayLabel = (
    item: SessionItem,
    mappedStep: ChecklistStep | null
  ) => {
    const roleLabel = mappedStep
      ? getRoleFromChecklistStep(mappedStep)
      : getSimpleRoleLabel(item.role);

    if (!mappedStep) return `${roleLabel} · Unmapped`;

    return `${roleLabel} · ${mappedStep.title}`;
  };

  function MapPinIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 21s-6-5.2-6-11a6 6 0 1 1 12 0c0 5.8-6 11-6 11Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="10" r="2.4" fill="currentColor" />
    </svg>
  );
}

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const folderInput = folderInputRef.current;
    if (!folderInput) return;

    folderInput.setAttribute("webkitdirectory", "");
    folderInput.setAttribute("directory", "");
  }, []);

  const { templates: serverTemplates } = useIntakeTemplates();

  const collectionPlans = serverTemplates.length
    ? serverTemplates
    : COLLECTION_PLAN_TEMPLATES;

  const selectedCollectionPlan = useMemo(
    () => collectionPlans.find((plan) => plan.id === collectionPlanId),
    [collectionPlanId, collectionPlans]
  );

  const draftList = useCaptureDraftList();
  const [resumeOpen, setResumeOpen] = useState(false);
  const [resumeDraftId, setResumeDraftId] = useState<string | null>(null);
  const [resumeDraftDetail, setResumeDraftDetail] = useState<
    Awaited<ReturnType<typeof draftList.fetchDetail>> | null
  >(null);
  const [resumeMetadataApplied, setResumeMetadataApplied] = useState(false);

  const draftPersistence = useCaptureDraftPersistence({ enabled: true });
  const draftIdRef = useRef<string | null>(null);
  draftIdRef.current = draftPersistence.draftId;

  const {
    cameraError,
    cameraMode,
    cameraOpen,
    cameraStarting,
    capturePhotoFromCamera,
    closeCamera,
    facingMode,
    flashEnabled,
    handleFlipCamera,
    handleToggleFlash,
    isRecording,
    openCamera: openCameraDevice,
    recordingSeconds,
    startVideoRecording,
    stopVideoRecording,
    videoPreviewRef,
  } = useCaptureCamera({
    addFilesToSessionRef,
    addToast,
  });

  const {
    addAudioRecordingToSession,
    audioPreviewUrl,
    audioRecorderError,
    audioRecorderOpen,
    audioRecorderState,
    discardAudioRecording,
    openAudioRecorder,
    resetAudioRecorderState,
    startAudioRecording,
    stopAudioRecording,
  } = useCaptureAudioRecorder({
    addFilesToSessionRef,
    addToast,
    closeCamera,
    onClearPageError: () => setPageErrorRef.current(null),
  });

  const {
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
  } = useCaptureSessionOrchestration({
    internalNotes,
    onCloseCaptureDevices: closeCamera,
    onResetAudioRecorder: resetAudioRecorderState,
    planMode,
    selectedCollectionPlan,
    useLocation,
    getCaptureSessionDraftId: () => draftIdRef.current,
    onSessionFinalized: () => {
      draftPersistence.acknowledgeFinalized();
    },
    onSessionDiscarded: () => draftPersistence.discardDraft(),
  });

  addFilesToSessionRef.current = addFilesToSession;
  setPageErrorRef.current = setError;

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

  const formatRecordingTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60).toString().padStart(2, "0");
    const secs = (seconds % 60).toString().padStart(2, "0");
    return `${mins}:${secs}`;
  };

  const openCamera = async (mode: "PHOTO" | "VIDEO") => {
    setError(null);
    resetAudioRecorderState();
    await openCameraDevice(mode);
  };

  useEffect(() => {
    return () => {
      revokeAllPreviews();
    };
  }, []);

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

  useEffect(() => {
    draftPersistence.scheduleSave({
      templateId: collectionPlanId,
      planMode,
      internalNotes,
      useLocation,
      items: sessionItems,
    });
  }, [
    collectionPlanId,
    planMode,
    internalNotes,
    useLocation,
    sessionItems,
    draftPersistence,
  ]);

  useEffect(() => {
    if (!resumeDraftDetail || resumeMetadataApplied) return;

    if (resumeDraftDetail.templateId) {
      setCollectionPlanId(resumeDraftDetail.templateId);
    }

    if (typeof resumeDraftDetail.internalNotes === "string") {
      setInternalNotes(resumeDraftDetail.internalNotes);
    }

    if (
      resumeDraftDetail.planMode === "FLEXIBLE" ||
      resumeDraftDetail.planMode === "CHECKLIST_REQUIRED"
    ) {
      setPlanMode(resumeDraftDetail.planMode);
    }

    setResumeMetadataApplied(true);
  }, [resumeDraftDetail, resumeMetadataApplied]);

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

  const sessionReadiness = useMemo(
    () =>
      buildSessionReadiness({
        items: sessionItems,
        selectedPlan: selectedCollectionPlan,
        planMode,
        useLocation,
      }),
    [sessionItems, selectedCollectionPlan, planMode, useLocation]
  );

  const {
    activeWorkflowStep,
    captureAiSummary,
    checklistStepItemMap,
    currentSessionId,
    finishDisabled,
    finishReason,
    missingStepTitles,
    requiredProgressPercent,
    sessionCountLabel,
    totalStagedBytes,
  } = useMemo(
    () =>
      buildSessionWorkflowSnapshot({
        busy,
        error,
        locationPermissionDenied,
        planMode,
        progress,
        selectedPlan: selectedCollectionPlan,
        sessionItems,
        sessionReadiness,
        sessionStartedAt,
        sessionStatus,
        sessionTimeline,
        useLocation,
      }),
    [
      busy,
      error,
      locationPermissionDenied,
      planMode,
      progress,
      selectedCollectionPlan,
      sessionItems,
      sessionReadiness,
      sessionStartedAt,
      sessionStatus,
      sessionTimeline,
      useLocation,
    ]
  );

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
      const clickedInsideMaterialDropdown = target.closest(
        ".capture-material-dropdown"
      );

      if (!clickedInsidePlanDropdown) {
        setPlanDropdownOpen(false);
      }

      if (!clickedInsideMaterialDropdown) {
        setOpenMaterialDropdownId(null);
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

      <div className="capture-enterprise-shell">
        {draftList.drafts.length > 0 && !sessionItems.length ? (
          <div
            className="capture-resume-banner"
            role="region"
            aria-label="Unfinished capture sessions"
          >
            <div className="capture-resume-banner-text">
              <strong>
                You have {draftList.drafts.length} unfinished capture session
                {draftList.drafts.length === 1 ? "" : "s"}.
              </strong>
              <p>
                Resume restores template, mappings, notes, and item metadata.
                For privacy and browser-security reasons, the original file
                binaries cannot be restored automatically — you must re-attach
                the actual files before finalization.
              </p>
            </div>

<div className="capture-resume-banner-actions">
  <button
    type="button"
    className="capture-drafts-trigger"
    onClick={() => setResumeOpen(true)}
  >
    Drafts ({draftList.drafts.length})
  </button>
</div>

{resumeOpen ? (
  <div
    className="capture-drafts-modal-backdrop"
    onClick={() => setResumeOpen(false)}
  >
    <div
      className="capture-drafts-modal"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="capture-drafts-modal-header">
        <div>
          <strong>Unfinished capture drafts</strong>
          <p>Resume draft metadata, then re-attach files before Review & Sign.</p>
        </div>

        <button type="button" onClick={() => setResumeOpen(false)}>
          Close
        </button>
      </div>

      <div className="capture-drafts-modal-list">
        {draftList.drafts.map((draft) => (
          <div key={draft.id} className="capture-drafts-modal-item">
            <div className="capture-drafts-modal-meta">
              <strong>{draft.templateName ?? "Untitled draft"}</strong>
              <span>
                {draft.itemCount} staged item{draft.itemCount === 1 ? "" : "s"}
                {draft.planMode ? ` • ${draft.planMode}` : ""}
                {draft.expiresAtUtc
                  ? ` • Expires ${new Date(draft.expiresAtUtc).toLocaleString()}`
                  : ""}
              </span>
            </div>

            <div className="capture-drafts-modal-actions">
              <button
                type="button"
                className="capture-bulk-button"
onClick={async () => {
  const detail = await draftList.fetchDetail(draft.id);

  if (!detail) {
    addToast("Draft could not be restored.", "error");
    return;
  }

  setResumeDraftId(draft.id);
  setResumeDraftDetail(detail);
  setResumeMetadataApplied(false);
  setResumeOpen(false);

  addToast(
    "Draft restored. Re-attach files before Review & Sign.",
    "success"
  );
}}
              >
                Resume
              </button>

              <button
                type="button"
                className="capture-bulk-button capture-draft-delete-button"
                onClick={async () => {
                  await draftList.discard(draft.id);
                }}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  </div>
) : null}

            <input type="hidden" name="resumed-draft" value={resumeDraftId ?? ""} />
          </div>
        ) : null}

        <section className="capture-enterprise-top">
          <div className="capture-enterprise-title-card">
            <div className="capture-enterprise-icon">
              <Camera size={28} strokeWidth={2.1} />
            </div>

            <div>
              <div className="capture-enterprise-eyebrow">
                Evidence intake workspace
              </div>
              <h1 className="capture-enterprise-title">Capture Evidence</h1>
              <p className="capture-enterprise-subtitle">
                Collect, map, fingerprint, and prepare evidence materials
                before Review & Sign. Drafts save metadata only. File contents
                are not stored until finalization, and draft metadata expires
                automatically.
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
                Cryptographic integrity, encrypted storage, and verifiable audit
                trail.
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
          <main className="capture-enterprise-card capture-main-panel">
<section className="capture-setup-strip">
  <div className="capture-setup-copy">
    <div className="capture-section-label">Collection setup</div>
    <div className="capture-card-title">Intake structure</div>
    <p className="capture-card-muted">
      Choose whether this session follows a required checklist or flexible intake.
    </p>
  </div>

  <div className="capture-setup-controls">
    <button
      type="button"
      className={`capture-setup-mode ${planMode === "CHECKLIST_REQUIRED" ? "active" : ""}`}
      onClick={() => setPlanMode("CHECKLIST_REQUIRED")}
      disabled={busy}
    >
      <ClipboardCheck size={18} strokeWidth={2.1} />
      <span>
        <strong>Guided</strong>
        <small>Checklist required</small>
      </span>
    </button>

    <button
      type="button"
      className={`capture-setup-mode ${planMode === "FLEXIBLE" ? "active" : ""}`}
      onClick={() => setPlanMode("FLEXIBLE")}
      disabled={busy}
    >
      <FolderOpen size={18} strokeWidth={2.1} />
      <span>
        <strong>Flexible</strong>
        <small>General intake</small>
      </span>
    </button>

    <label className={`capture-setup-location ${useLocation ? "active" : ""}`}>
      <MapPinIcon />
      <span>
        <strong>Location</strong>
        <small>{useLocation ? "Included" : "Not included"}</small>
      </span>
      <input
        type="checkbox"
        checked={useLocation}
        onChange={(event) => setUseLocation(event.target.checked)}
        disabled={busy}
      />
    </label>
  </div>
</section>
            <CaptureRequirements
              selectedCollectionPlan={selectedCollectionPlan}
              collectionPlans={collectionPlans}
              collectionPlanId={collectionPlanId}
              setCollectionPlanId={setCollectionPlanId}
              planDropdownOpen={planDropdownOpen}
              setPlanDropdownOpen={setPlanDropdownOpen}
              busy={busy}
              hasSessionItems={sessionItems.length > 0}
              checklistStepItemMap={checklistStepItemMap}
              sessionReadiness={sessionReadiness}
              formatEvidenceTypeLabel={formatEvidenceTypeLabel}
            />

            <CaptureDropzone
              busy={busy}
              sessionHasItems={sessionItems.length > 0}
              onOpenFilePicker={openFilePicker}
              onOpenFolderPicker={openFolderPicker}
              onOpenCamera={openCamera}
              onOpenAudioRecorder={openAudioRecorder}
              onDropFiles={async (event) => {
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
            />

            {sessionItems.length > 0 ? (
              <div className="capture-materials-board">
                <div className="capture-materials-header">
                  <div>
                    <div className="capture-section-label">
                      Evidence material management
                    </div>
                    <div className="capture-card-title">{sessionCountLabel}</div>
                    <p>
                      Compact review rows surface mapping, status, type, size,
                      and warnings for faster operational scanning.
                    </p>
                  </div>

                  <div className="capture-materials-meta-stack">
                    <span>{formatFileSize(totalStagedBytes)}</span>
                    <strong>
                      {sessionReadiness.summary.unmappedCount} unmapped
                    </strong>
                    <span
                      className="capture-draft-pill"
                      aria-live="polite"
                      title={
                        draftPersistence.savingState === "error"
                          ? "Failed to save the latest changes to the server draft."
                          : draftPersistence.lastSavedAt
                            ? `Last saved ${draftPersistence.lastSavedAt.toLocaleTimeString()}`
                            : "Draft is staged locally."
                      }
                    >
                      {draftPersistence.savingState === "saving"
                        ? "Saving draft…"
                        : draftPersistence.savingState === "error"
                          ? "Draft save failed"
                          : draftPersistence.draftId
                            ? "Draft saved"
                            : "Draft staging"}
                    </span>
                  </div>
                </div>

                {sessionItems.length > 0 && !busy ? (
                  <div
                    className="capture-bulk-actions"
                    role="toolbar"
                    aria-label="Bulk actions"
                  >
                    <button
                      type="button"
                      className="capture-bulk-button"
                      disabled={sessionItems.every((item) => !item.checklistStepId)}
                      onClick={() => {
                        setSessionItems((prev) =>
                          prev.map((item) => ({ ...item, checklistStepId: null }))
                        );
                      }}
                    >
                      Clear all mappings
                    </button>

                    <button
                      type="button"
                      className="capture-bulk-button"
                      disabled={sessionItems.every(
                        (item) => item.uploadProgress >= 100 || item.uploading
                      )}
                      onClick={() => {
                        sessionItems
                          .filter(
                            (item) => !item.uploading && item.uploadProgress < 100
                          )
                          .forEach((item) => removeSessionItem(item.id));
                      }}
                    >
                      Remove pending items
                    </button>
                  </div>
                ) : null}

                <div className="capture-materials-list">
<div className="capture-materials-list-header" role="rowheader">
  <span>#</span>
  <span>Preview</span>
  <span>File</span>
  <span>Type</span>
  <span>Size</span>
  <span>Role & requirement</span>
  <span>Status</span>
  <span>Actions</span>
</div>

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

  const mappingHelper = mappedStep
    ? `${mappedStep.title} • ${mappedStep.purposeLabel}`
    : planMode === "CHECKLIST_REQUIRED"
      ? "Choose a required collection step before Review & Sign."
      : "Optional context can be linked to a collection step.";

  return (
    <div
      key={item.id}
      className={`capture-material-row-shell ${
        isExpanded ? "is-expanded" : ""
      }`}
    >
      <div className="capture-material-row" role="row">
        <span className="capture-material-row-index">{index + 1}</span>

        <span className="capture-material-row-preview">
          <span className={`capture-material-row-type-icon ${previewTypeLabel.toLowerCase()}`}>
            <FileIcon size={13} strokeWidth={2.2} />
          </span>

          {item.previewUrl && item.mimeType.startsWith("image/") ? (
            <img src={item.previewUrl} alt={item.file.name} />
          ) : item.previewUrl && item.mimeType.startsWith("video/") ? (
            <video src={item.previewUrl} muted playsInline />
          ) : (
            <span className="capture-material-row-file-icon">
              <FileIcon size={24} strokeWidth={2} />
            </span>
          )}
        </span>

        <span className="capture-material-row-name" title={item.file.name}>
          {item.file.name}
        </span>

        <span className="capture-material-row-type">{typeLabel}</span>

        <span className="capture-material-row-size">
          {formatFileSize(item.file.size)}
        </span>

        <span className="capture-material-row-map-cell">
          <div
            className={`capture-material-dropdown compact ${
              openMaterialDropdownId === item.id ? "is-open" : ""
            }`}
          >
            <button
              type="button"
              className="capture-material-dropdown-trigger"
              disabled={busy}
              aria-haspopup="listbox"
              aria-expanded={openMaterialDropdownId === item.id}
              onClick={(event) => {
                event.stopPropagation();
                setOpenMaterialDropdownId((current) =>
                  current === item.id ? null : item.id
                );
              }}
            >
              <span>{getRoleRequirementDisplayLabel(item, mappedStep)}</span>
              <span className="capture-material-dropdown-chevron">⌄</span>
            </button>

            {openMaterialDropdownId === item.id ? (
              <div className="capture-material-dropdown-menu" role="listbox">
                <button
                  type="button"
                  className={!item.checklistStepId ? "active" : ""}
                  onClick={() => {
                    updateSessionItem(item.id, {
                      checklistStepId: null,
                      role: "Context / supplemental",
                    });
                    setOpenMaterialDropdownId(null);
                  }}
                >
                  <span>Context · Unmapped</span>
                  <small>Leave unmapped or supplemental</small>
                </button>

                {selectedCollectionPlan?.steps.map((step) => {
                  const active = item.checklistStepId === step.id;

                  return (
                    <button
                      key={step.id}
                      type="button"
                      className={active ? "active" : ""}
                      onClick={() => {
                        updateSessionItem(item.id, {
                          checklistStepId: step.id,
                          role: `${getRoleFromChecklistStep(step)} evidence`,
                        });
                        setOpenMaterialDropdownId(null);
                      }}
                    >
                      <span>
                        {getRoleFromChecklistStep(step)} · {step.title}
                      </span>
                      <small>
                        {step.required ? "Required" : "Optional"} ·{" "}
                        {step.acceptedKinds?.map(formatEvidenceTypeLabel).join(", ") ||
                          "Any supported material"}
                      </small>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        </span>

        <span
          className={`capture-material-row-status ${
            item.error ? "critical" : riskTone
          }`}
        >
          {item.error ? "Retry needed" : qualityStatus.label}
        </span>

        <span className="capture-material-row-actions">
          <button
            type="button"
            onClick={() =>
              setExpandedMaterialId((current) =>
                current === item.id ? null : item.id
              )
            }
          >
            {isExpanded ? "Close" : "Notes"}
          </button>

          {!busy ? (
            <button type="button" onClick={() => removeSessionItem(item.id)}>
              Remove
            </button>
          ) : null}
        </span>
      </div>

      {isExpanded ? (
        <div className="capture-material-detail-row">
          <div className="capture-material-detail-main">
            <strong>Reviewer note</strong>
            <p>{mappingHelper}</p>

            <textarea
              value={item.privateNote ?? ""}
              onChange={(event) =>
                updateSessionItem(item.id, {
                  privateNote: event.target.value,
                })
              }
              disabled={busy}
              placeholder="Add private reviewer comment for this material."
              maxLength={1000}
              className="capture-material-note"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
})}
                </div>
              </div>
            ) : null}

            {audioRecorderOpen ? (
              <div className="capture-audio-card">
                <div className="capture-panel-heading">
                  <strong>Audio Recorder</strong>

                  {audioRecorderState !== "recording" ? (
                    <button
                      type="button"
                      className="capture-audio-close-button"
                      onClick={resetAudioRecorderState}
                      aria-label="Close audio recorder"
                    >
                      ×
                    </button>
                  ) : null}
                </div>

                {audioPreviewUrl ? (
                  <audio controls preload="metadata" src={audioPreviewUrl}>
                    Your browser could not play this audio preview.
                  </audio>
                ) : null}

                {audioRecorderError ? (
                  <div className="capture-quality-danger">
                    {audioRecorderError}
                  </div>
                ) : null}

                <div className="capture-audio-actions">
                  <Button
                    onClick={startAudioRecording}
                    disabled={busy || audioRecorderState === "recording"}
                    className="capture-audio-start-button"
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
          </main>

          <CaptureSessionPanel
            busy={busy}
            error={error}
            locationPermissionDenied={locationPermissionDenied}
            sessionItems={sessionItems}
            sessionCountLabel={sessionCountLabel}
            currentSessionId={currentSessionId}
            selectedCollectionPlan={selectedCollectionPlan}
            totalStagedBytes={totalStagedBytes}
            internalNotes={internalNotes}
            setInternalNotes={setInternalNotes}
            aiPanelOpen={aiPanelOpen}
            setAiPanelOpen={setAiPanelOpen}
            captureAiSummary={captureAiSummary}
            sessionReadiness={sessionReadiness}
            useLocation={useLocation}
            planMode={planMode}
            requiredProgressPercent={requiredProgressPercent}
            formatFileSize={formatFileSize}
          />
        </section>

        <CaptureBottomBar
          busy={busy}
          progress={progress}
          sessionStatus={sessionStatus}
          finishDisabled={finishDisabled}
          finishReason={finishReason}
          missingSteps={missingStepTitles}
          canClearSession={sessionItems.length > 0}
          onReset={() => setClearConfirmOpen(true)}
          onFinalize={finalizeSession}
        />
      </div>

      {clearConfirmOpen ? (
        <div className="capture-confirm-backdrop">
          <div className="capture-confirm-modal">
            <div className="capture-confirm-icon">!</div>

            <div>
              <div className="capture-confirm-title">
                Clear this evidence session?
              </div>
              <p className="capture-confirm-text">
                This will remove all staged materials, mapping, private notes,
                and local review progress. No evidence record has been created
                yet.
              </p>
            </div>

            <div className="capture-confirm-actions">
              <button
                type="button"
                className="capture-confirm-cancel"
                onClick={() => setClearConfirmOpen(false)}
              >
                Keep Session
              </button>

              <button
                type="button"
                className="capture-confirm-danger"
                onClick={() => {
                  setClearConfirmOpen(false);
                  resetCaptureState();
                }}
              >
                Clear Session
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <CaptureCameraOverlay
        cameraOpen={cameraOpen}
        flashEnabled={flashEnabled}
        cameraMode={cameraMode}
        isRecording={isRecording}
        recordingSeconds={recordingSeconds}
        facingMode={facingMode}
        busy={busy}
        cameraStarting={cameraStarting}
        cameraError={cameraError}
        sessionItemsCount={sessionItems.length}
        videoPreviewRef={videoPreviewRef}
        closeCamera={closeCamera}
        handleToggleFlash={handleToggleFlash}
        handleFlipCamera={handleFlipCamera}
        capturePhotoFromCamera={capturePhotoFromCamera}
        startVideoRecording={startVideoRecording}
        stopVideoRecording={stopVideoRecording}
        formatRecordingTime={formatRecordingTime}
      />
    </div>
  );
}