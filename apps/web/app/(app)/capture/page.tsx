"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button, PageShell, PageHeader, useToast } from "../../../components/ui";
import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
// P3 domain remediation (2026-07-21) — tenant-boundary dirty-work guard.
import { useDirtyWork } from "../../../lib/platform-context/dirtyWorkRegistry";
// PHASE 7 §10.5 — canonical owning-context banner.
import { orderTemplatesByWorkflow } from "./_lib/workflowTemplateOrder";
import { CaptureReadinessPanel } from "./_lib/CaptureReadinessPanel";
import { CaptureSuggestionsPanel } from "./_lib/CaptureSuggestionsPanel";
import { CaptureIntakeRail } from "./_lib/CaptureIntakeRail";
import { CaptureOperationalSummary } from "./_lib/CaptureOperationalSummary";
import { CaptureTrustStrip } from "./_lib/CaptureTrustStrip";
import { CaptureFinalReadiness } from "./_lib/CaptureFinalReadiness";
import { CaptureActivityDisclosure } from "./_lib/CaptureActivityDisclosure";
import {
  computeCaptureReadiness,
  getRoleFromChecklistStep,
} from "./_lib/captureReadiness";
import { ContextualHelp } from "../../../components/contextual-help/ContextualHelp";
import { formatUserDateTime, formatUserTime } from "../../../lib/date";
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
  Video,
} from "lucide-react";

import type { ChecklistStep, SessionItem } from "./_lib/types";

import {
  COLLECTION_PLAN_TEMPLATES,
  GENERIC_EVIDENCE_UPLOAD_ACCEPT,
} from "./_lib/templates";
// Phase 3 Workflow Engine: prefer the workflow-aware loader. When the
// NEXT_PUBLIC_FEATURE_WORKFLOW_ENGINE_CAPTURE flag is unset/false, this hook
// is a transparent pass-through to useIntakeTemplates and behavior is
// bit-for-bit identical to today. When the flag is true, the hook attempts
// /v1/workflow/templates and falls back to useIntakeTemplates on any error.
import { useWorkflowTemplates } from "./_hooks/useWorkflowTemplates";
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
// Phase 30.10 — resumable upload adoption surface. The hook is
// active only when NEXT_PUBLIC_RESUMABLE_UPLOADS_ENABLED=true; with
// the flag off it returns empty arrays and no UI/network activity.
// The panel mount is therefore a true no-op for production today.
import { useResumableUploads } from "./_hooks/useResumableUploads";
import { UploadOperationsPanel } from "../../../components/uploads/UploadOperationsPanel";
import type { CaptureSessionAddFiles } from "./_hooks/useCaptureSessionOrchestration";
import { useCaptureCamera } from "./_hooks/useCaptureCamera";
import { useCaptureAudioRecorder } from "./_hooks/useCaptureAudioRecorder";

// Phase 38.9 — wrap in canonical PageRouteGate.
export default function CapturePage() {
  return (
    <PageRouteGate routeId="workspace.capture">
      <CapturePageInner />
    </PageRouteGate>
  );
}

function CapturePageInner() {
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

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const folderInput = folderInputRef.current;
    if (!folderInput) return;

    folderInput.setAttribute("webkitdirectory", "");
    folderInput.setAttribute("directory", "");
  }, []);

  const { templates: serverTemplates } = useWorkflowTemplates();

  // Canonical template ordering. NEVER hides templates; only reorders
  // so the canonical priority templates appear first. The operator can
  // always pick any template.
  // Memoised: a new array each render re-fired the step-seeding effect.
  const collectionPlans = useMemo(
    () => [...orderTemplatesByWorkflow({
      templates: serverTemplates.length ? serverTemplates : COLLECTION_PLAN_TEMPLATES,
    })],
    [serverTemplates],
  );

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

  // Phase 30.10 / 30.12 — resumable upload adoption. With the env flag OFF
  // (production default), `resumable.enabled` is false and the hook
  // does no work — no IndexedDB open, no recovery scan, no network
  // monitor subscription. The panel below short-circuits to null
  // when there's nothing to show, so this mount is a true no-op
  // for the existing capture flow.
  // Phase 30.12: this declaration must come BEFORE the orchestrator
  // call so the orchestrator can receive `resumable` as a parameter.
  const resumable = useResumableUploads();

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
    // Phase 30.12 — pass the resumable adoption hook so the
    // orchestrator can fork large files through the multipart path.
    // With NEXT_PUBLIC_RESUMABLE_UPLOADS_ENABLED unset (default),
    // `resumable.enabled` is false and the fork never engages.
    resumable,
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

  // Release this session's object URLs on unmount. `revokeAllPreviews` is
  // memoised by the orchestration hook, so listing it as the dependency it
  // actually is does not re-register the cleanup on every render.
  useEffect(() => {
    return () => {
      revokeAllPreviews();
    };
  }, [revokeAllPreviews]);

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
    // `steps` is the value actually read and is stable per plan (the plan
    // list is memoised); `setSessionItems` is a useState setter.
  }, [selectedCollectionPlan?.id, selectedCollectionPlan?.steps, setSessionItems]);

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
        // Phase 30.12 — fold resumable upload blockers into the
        // readiness verdict so Review & Sign is disabled with a
        // precise reason when a large-file upload isn't yet
        // server-verified. Empty array (the default when the env
        // flag is off) makes this a no-op.
        resumableBlockers: resumable.blockingReasons,
      }),
    [
      sessionItems,
      selectedCollectionPlan,
      planMode,
      useLocation,
      resumable.blockingReasons,
    ]
  );

  const {
    captureAiSummary,
    checklistStepItemMap,
    currentSessionId,
    finishDisabled,
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

  // P3 domain remediation (2026-07-21) — `beforeunload` only fires on real
  // browser navigation; an in-app WORKSPACE SWITCH is an envelope swap that
  // never triggers it. Register staged capture material in the dirty-work
  // registry so the context switcher demands explicit confirmation before
  // crossing the tenant boundary (staged evidence must never silently
  // finalize into a different workspace).
  useDirtyWork(
    sessionItems.length > 0 && !busy,
    "Staged evidence in Capture",
  );

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
    <PageShell
      width="full"
      className="capture-page-shell capture-enterprise-page"
      data-capture-page-shell>
      {/* Phase 30.10 — resumable upload operations panel. Renders
       *  only when the env flag is on AND there's something to show
       *  (active uploads, network is offline, or recovery has at
       *  least one entry). The legacy single-shot capture flow
       *  below stays unchanged. */}
      {resumable.enabled &&
        (resumable.uploads.length > 0 ||
          !resumable.network.isOnline ||
          (resumable.recovery && resumable.recovery.entries.length > 0)) ? (
        <UploadOperationsPanel
          uploads={resumable.uploads}
          network={resumable.network}
          recovery={resumable.recovery}
          onPause={resumable.pause}
          onResume={(id) => {
            void resumable.resume(id);
          }}
          onCancel={resumable.cancel}
          onClearRecovery={(id) => {
            void resumable.clearRecovery(id);
          }}
        />
      ) : null}

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

      <div
        className="capture-enterprise-shell"
        data-capture-template-order={collectionPlans
          .map((p) => p.id)
          .join(",")}
      >
        {/* Intake progress rail. Five-stage progression derived from
            the actual session state. Informational + non-blocking; the
            operator can finalize via the existing controls regardless
            of rail state. */}
        <CaptureIntakeRail
          items={sessionItems}
          collectionPlanSelected={Boolean(selectedCollectionPlan)}
          readiness={computeCaptureReadiness({
            items: sessionItems,
          })}
        />





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
                  ? ` • Expires ${formatUserDateTime(draft.expiresAtUtc)}`
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


        {/* ONE STEPPER, NOT TWO (2026-08-27).
            A page-local four-step list — Intake method / Requirements /
            Evidence capture / Review & Sign — rendered here, directly above
            the canonical five-stage `CaptureIntakeRail` further up. Two
            trackers with different models gave one page two answers to "where
            am I", and only the rail derives its state from the session.
            The rail is the orientation; this list is gone. */}
        <section className="capture-enterprise-grid">
          <main className="capture-enterprise-card capture-main-panel">
        <section className="capture-hero">
          {/* The page's identity mark. `Camera` is the icon the sidebar
              already uses for this route and the eyebrow already carried at
              15px — same glyph, given the size a page heading needs so the
              reader knows which page they are on before reading a word. It is
              part of the heading block, not an illustration. */}
          <span className="capture-hero__mark" aria-hidden="true">
            <Camera size={22} strokeWidth={2} />
          </span>

          {/* Phase IA-self-serve-completion — "Evidence intake
              workspace" replaced with "Capture & upload" so the
              eyebrow matches how lawyers / journalists describe
              this step (capturing, not "intake-ing"). Copy preserved
              verbatim under the shared PageHeader. */}
          <PageHeader
            className="capture-enterprise-title-card"
            eyebrow={
              <span
                className="capture-enterprise-eyebrow"
                style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
              >
                <Camera size={15} strokeWidth={2.1} />
                Capture &amp; upload
              </span>
            }
            title="Capture Evidence"
            subtitle="Collect, map, fingerprint, and prepare evidence materials before Review & Sign. Drafts save metadata only — file contents are not stored until finalization."
            /* NO UPLOAD ACTION HERE (2026-08-27).
               The hero carried a primary "Upload evidence" button that opened
               the same picker as the Evidence Materials section below, which
               already owns Files / Folder / Photo / Video / Audio and the drop
               zone. Two entry points for one operation meant the page's most
               prominent control bypassed the surface that shows what was
               added, what it mapped to and what is still required. The hero
               introduces the page; Evidence Materials ingests. */
          />

          {/* THE TRUST STRIP replaces a single "End-to-end protected" card.
              Three compact statements, explanatory copy only — no verdict, no
              session state, no admissibility claim. */}
          <CaptureTrustStrip />
        </section>

        {/* ORDER: identity first, then the guidance that supports it.
            Help, Capture readiness and Suggested next steps used to render
            in the band above the grid, which put instructional and readiness
            content above the page's own title — a reader met "what to do
            next" before "where am I". Same components, same state, same
            canonical readiness; they simply follow the hero now. */}
        {/* Contextual help, collapsed by default so the rail + capture
            controls stay primary. State-aware notes surface when the
            operator has no items staged. */}
        <ContextualHelp
          surface="capture"
          collapsedByDefault
          stateNotes={
            sessionItems.length === 0
              ? [
                  "No materials staged yet — start with the camera, the upload dropzone, or import from a folder.",
                ]
              : undefined
          }
        />
        {/* Operational readiness layer: completeness criteria evaluated
            against the current session. Read-only; never blocks
            finalization. Hidden when the operator hasn't started intake
            yet. */}
        <CaptureReadinessPanel items={sessionItems} />
        {/* Actionable suggestions derived from the same readiness
            criteria. Where the readiness panel reports the state, this
            panel proposes the next concrete operator action.
            Informational + non-blocking. */}
        {sessionItems.length > 0 ? (
          <CaptureSuggestionsPanel
            readiness={computeCaptureReadiness({
              items: sessionItems,
            })}
          />
        ) : null}
<section className="capture-setup-strip">
<div className="capture-setup-copy">
  <div className="capture-section-label">Collection setup</div>
  <div className="capture-card-title">Intake structure</div>
</div>

<p className="capture-setup-description">
  Choose whether this session follows a required checklist, flexible intake,
  or location-enabled collection.
</p>

<div className="capture-setup-controls">
  <button
  type="button"
  className={`capture-setup-mode ${planMode === "CHECKLIST_REQUIRED" ? "active" : ""}`}
  onClick={() => setPlanMode("CHECKLIST_REQUIRED")}
  disabled={busy || sessionItems.length > 0}
>
  <span className="capture-setup-icon">
    <ClipboardCheck size={18} strokeWidth={2.1} />
  </span>
  <span>
    <strong>Guided</strong>
    <small>Checklist required</small>
  </span>
</button>

<button
  type="button"
  className={`capture-setup-mode ${planMode === "FLEXIBLE" ? "active" : ""}`}
  onClick={() => setPlanMode("FLEXIBLE")}
  disabled={busy || sessionItems.length > 0}
>
  <span className="capture-setup-icon">
    <FolderOpen size={18} strokeWidth={2.1} />
  </span>
  <span>
    <strong>Flexible</strong>
    <small>General intake</small>
  </span>
</button>

<label className={`capture-setup-location ${useLocation ? "active" : ""}`}>
  <span className="capture-setup-icon">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path
        d="M12 21s-6-5.2-6-11a6 6 0 1 1 12 0c0 5.8-6 11-6 11Z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="10" r="2.4" fill="currentColor" stroke="none" />
    </svg>
  </span>

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
                        draftPersistence.savingState === "locked"
                          ? "This capture session is already finalized or locked. Start a new capture session to continue."
                          : draftPersistence.savingState === "error"
                            ? "Failed to save the latest changes to the server draft."
                            : draftPersistence.lastSavedAt
                              ? `Last saved ${formatUserTime(draftPersistence.lastSavedAt)}`
                              : "Draft is staged locally."
                      }
                    >
                      {draftPersistence.savingState === "saving"
                        ? "Saving draft…"
                        : draftPersistence.savingState === "locked"
                          ? "Session finalized — start a new capture"
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
            {/* Phase IA-self-serve-completion — "Reviewer note" was
                misleading for self-serve users: they ARE the reviewer
                and they're adding their own notes for themselves or
                counsel. Renamed to "Your notes" and the placeholder
                to plain-language guidance. The underlying field
                (`privateNote`) and API contract are unchanged. */}
            <strong>Your notes</strong>
            <p>{mappingHelper}</p>

            <textarea
              value={item.privateNote ?? ""}
              onChange={(event) =>
                updateSessionItem(item.id, {
                  privateNote: event.target.value,
                })
              }
              disabled={busy}
              placeholder="Add a note about this material (private to you)."
              maxLength={1000}
              className="capture-material-note"
            />

            {/* Phase CAPTURE-CLOSURE Part E — item-level source label.
                The backend column `EvidencePart.sourceLabel` was
                already persisted (the orchestration hook sent it,
                the review-workspace contentItems projection exposed
                it, and the Evidence Detail item card renders it) —
                but Capture had no input. Adding a short field here
                so users can name the source per item (e.g. "Phone
                camera, on-site" / "Witness recording", etc.).
                Distinct from the per-item private note and from the
                evidence-level capture note. Limited to 120 chars
                (matches `EvidencePart.sourceLabel @db.VarChar(120)`
                in prisma/schema.prisma). */}
            <label
              style={{
                display: "block",
                marginTop: 10,
                fontSize: 12.5,
                fontWeight: 600,
                color: "#475569",
              }}
            >
              Source (optional)
            </label>
            <input
              type="text"
              data-capture-item-source-label
              value={item.sourceLabel ?? ""}
              onChange={(event) =>
                updateSessionItem(item.id, {
                  sourceLabel: event.target.value,
                })
              }
              disabled={busy}
              placeholder="e.g. Phone camera, on-site"
              maxLength={120}
              style={{
                marginTop: 4,
                width: "100%",
                padding: "6px 8px",
                fontSize: 13,
                border: "1px solid #cbd5e1",
                borderRadius: 6,
                background: busy ? "#f8fafc" : "white",
              }}
            />
            <p
              className="evidence-detail-muted"
              style={{ margin: "4px 0 0 0", fontSize: 11.5 }}
            >
              Shown on the evidence record as the item's source context.
              Not included in the public verification page or report.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
})}
                </div>
              </div>
            ) : null}
        {/* Phase 38.18 — integrated operational summary band. Sits
            directly above the finalize bar so the operator sees
            "where am I + what's the next concrete action" without
            scrolling back to the top-of-page panels. */}
        <CaptureOperationalSummary items={sessionItems} />

        {/* Session activity, collapsed. `sessionTimeline` is already in
            state, so opening this fetches nothing. */}
        <CaptureActivityDisclosure events={sessionTimeline} />

        {/* "Can I proceed?", immediately above the control that answers it.
            Same `canFinalize` and `busy` the bottom bar reads. */}
        <CaptureFinalReadiness readiness={sessionReadiness} busy={busy} />

        <CaptureBottomBar
          busy={busy}
          progress={progress}
          sessionStatus={sessionStatus}
          finishDisabled={finishDisabled}
          canClearSession={sessionItems.length > 0}
          onReset={() => setClearConfirmOpen(true)}
          onFinalize={finalizeSession}
        />
          </main>

          <CaptureSessionPanel
            busy={busy}
            error={error}
            locationPermissionDenied={locationPermissionDenied}
            sessionItems={sessionItems}
            sessionCountLabel={sessionCountLabel}
            sessionStatus={sessionStatus}
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
    </PageShell>
  );
}