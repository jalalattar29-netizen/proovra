"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Button, PageShell, useToast } from "../../../components/ui";
import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
// P3 domain remediation (2026-07-21) — tenant-boundary dirty-work guard.
// PHASE 7 §10.5 — canonical owning-context banner.
import { orderTemplatesByWorkflow } from "./_lib/workflowTemplateOrder";
import { CaptureReadinessPanel } from "./_lib/CaptureReadinessPanel";
import { CaptureSuggestionsPanel } from "./_lib/CaptureSuggestionsPanel";
import { CaptureTrustStrip } from "./_lib/CaptureTrustStrip";
import { CaptureHeader, CaptureSetupPanel } from "./_lib/CaptureHeader";
import { CaptureMaterialsList, materialRowDomId } from "./_lib/CaptureMaterialsList";
import { CaptureReviewDialog } from "./_lib/CaptureReviewDialog";
import { EMPTY_SESSION_ISSUE_CODE } from "./_lib/readiness-issue-codes";
import type { ReadinessIssue } from "./_lib/session-readiness";
import { useActiveSpace } from "../../../lib/platform-context/useTenantModel";
import { CaptureDirectWebCaptureCard, CaptureDirectWebCaptureNote } from "./_lib/CaptureDirectWebCaptureCard";
import { CaptureDraftReattachNotice } from "./_lib/CaptureDraftReattachNotice";
import { CaptureFinalReadiness } from "./_lib/CaptureFinalReadiness";
import { CaptureActivityDisclosure } from "./_lib/CaptureActivityDisclosure";
import { computeCaptureReadiness } from "./_lib/captureReadiness";
import { ContextualHelp } from "../../../components/contextual-help/ContextualHelp";
import { formatUserDateTime, formatUserTime } from "../../../lib/date";
import { CaptureBottomBar } from "../../../components/capture-v2/CaptureBottomBar";
import { CaptureCameraOverlay } from "../../../components/capture-v2/CaptureCameraOverlay";
import { CaptureDropzone } from "../../../components/capture-v2/CaptureDropzone";
import {
  CaptureRequirements,
  requirementRowDomId,
} from "../../../components/capture-v2/CaptureRequirements";
import { CaptureSessionPanel } from "../../../components/capture-v2/CaptureSessionPanel";
import { ChevronDown } from "lucide-react";

import type { SessionItem } from "./_lib/types";

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
  formatEvidenceTypeLabel,
  formatFileSize,
} from "./_lib/file-utils";

import { filesFromDataTransfer } from "./_lib/folder-utils";
import { describeDropFailure, logCaptureClientError } from "./_lib/capture-errors";
import { buildSessionReadiness } from "./_lib/session-readiness";
import { buildSessionWorkflowSnapshot } from "./_lib/session-workflow";
import { useCaptureSessionOrchestration } from "./_hooks/useCaptureSessionOrchestration";
import { useCaptureLeaveGuard } from "./_hooks/useCaptureLeaveGuard";
import { useCaptureScreenRecorder } from "./_hooks/useCaptureScreenRecorder";
import {
  CaptureScreenRecorderCard,
  shouldShowScreenRecorderCard,
} from "./_lib/CaptureScreenRecorderCard";
import { captureLocationCheckLabel } from "./_lib/browser-location";
import { CaptureLocationStatus } from "./_lib/CaptureLocationStatus";
import { useOnlineStatus } from "../../../lib/pwa/useOnlineStatus";
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
  // Setup (template, mode, location) opens in place from the header.
  const [setupOpen, setSetupOpen] = useState(false);
  const setupPanelId = useId();
  // Review & Sign opens the review dialog; its confirm calls finalizeSession.
  const [reviewOpen, setReviewOpen] = useState(false);
  const activeSpace = useActiveSpace();
  const workspaceName = activeSpace?.displayName ?? null;
  const [openMaterialDropdownId, setOpenMaterialDropdownId] = useState<
    string | null
  >(null);
  const [expandedMaterialId, setExpandedMaterialId] = useState<string | null>(
  null
);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);

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
  const [reattachDismissed, setReattachDismissed] = useState(false);

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
    finalizeWithoutLocation,
    location,
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

  // Browser screen recording — stages ONE video item through the same
  // addFilesToSession path; sealed by the same Finish & Sign.
  // Screen is DIRECT: the Screen action calls `screenRecorder.start()` in its
  // own click, which opens the browser's chooser. The card below appears only
  // once there is a live, stopped, cancelled or failed recording to show.
  const online = useOnlineStatus();
  const screenRecorder = useCaptureScreenRecorder({ addFilesToSession });
  const screenCardVisible = shouldShowScreenRecorderCard(screenRecorder.state, screenRecorder.error);

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

  // The draft's save state, said once and shown in the header and the list.
  const draftLabel =
    draftPersistence.savingState === "saving"
      ? "Saving draft…"
      : draftPersistence.savingState === "locked"
        ? "Session finalized — start a new capture"
        : draftPersistence.savingState === "error"
          ? "Draft save failed"
          : draftPersistence.draftId
            ? "Draft saved"
            : sessionItems.length > 0
              ? "Not saved yet"
              : "New draft";
  const draftTitle =
    draftPersistence.savingState === "locked"
      ? "This capture session is already finalized or locked. Start a new capture session to continue."
      : draftPersistence.savingState === "error"
        ? "Failed to save the latest changes to the server draft."
        : draftPersistence.lastSavedAt
          ? `Last saved ${formatUserTime(draftPersistence.lastSavedAt)}. Drafts save setup, notes and file details, not file contents.`
          : "Drafts save setup, notes and file details, not file contents.";

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

  // RESUME — apply everything the draft actually persists.
  //
  // This effect used to apply three of the five restorable fields and drop the
  // rest on the floor. `GET /v1/capture/sessions/:id` returns `useLocation`
  // and the full `itemsSnapshot`, `fetchDetail` maps both into
  // `CaptureDraftDetail`, and neither was ever read. In the common case — a
  // draft on the default template in the default mode with no notes — all
  // three applied fields already held the values being written, so clicking
  // Resume changed nothing observable at all while a toast said it had.
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

    // Persisted by `useCaptureDraftPersistence`, returned by the read route,
    // and until now discarded. It changes the Location control AND the
    // location-related readiness warning, so dropping it meant a resumed
    // session could warn about metadata the operator had already enabled.
    setUseLocation(Boolean(resumeDraftDetail.useLocation));

    setResumeMetadataApplied(true);

    // ANNOUNCE AFTER THE FACT, NOT BEFORE IT. The toast used to fire in the
    // click handler, before this effect had applied anything — a success
    // message for work that had not happened yet. It now states what was
    // restored and, separately, what the operator still has to do.
    const pending = resumeDraftDetail.items?.length ?? 0;
    addToast(
      pending > 0
        ? `Draft restored. Re-attach ${pending} file${pending === 1 ? "" : "s"} before Review & Sign.`
        : "Draft restored.",
      "success",
    );
  }, [resumeDraftDetail, resumeMetadataApplied, addToast]);

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

  // ROUTES TO THE FIX. A blocker, a warning or an open requirement leads to the
  // row or control that resolves it; nothing here changes readiness.
  const focusById = useCallback((id: string, focusSelector?: string) => {
    window.requestAnimationFrame(() => {
      const el = document.getElementById(id);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      const target = focusSelector ? el.querySelector<HTMLElement>(focusSelector) : el;
      (target ?? el).focus({ preventScroll: true });
    });
  }, []);

  const openAssignmentFor = useCallback(
    (itemId: string) => {
      setExpandedMaterialId(null);
      setOpenMaterialDropdownId(itemId);
      focusById(materialRowDomId(itemId), "[data-capture-assign-trigger]");
    },
    [focusById],
  );

  const openLocationSetup = useCallback(() => {
    setSetupOpen(true);
    window.requestAnimationFrame(() => {
      const toggle = document.querySelector<HTMLInputElement>("[data-capture-location-toggle]");
      toggle?.scrollIntoView({ behavior: "smooth", block: "center" });
      toggle?.focus({ preventScroll: true });
    });
  }, []);

  const selectIssue = (issue: ReadinessIssue) => {
    if (issue.code === EMPTY_SESSION_ISSUE_CODE) return openFilePicker();
    if (issue.itemId) return openAssignmentFor(issue.itemId);
    if (issue.checklistStepId) return focusById(requirementRowDomId(issue.checklistStepId));
    if (issue.code.includes("location")) return openLocationSetup();
    focusById("capture-staged-anchor");
  };

  const assignForStep = (stepId: string) => {
    const first = sessionReadiness.unmappedItems[0];
    if (first) return openAssignmentFor(first.id);
    focusById(requirementRowDomId(stepId));
  };

  // UC-WEB-002 — one guard for leave-page AND workspace-switch, ON while
  // material is staged OR a finalize/upload is in flight (busy). See
  // _hooks/useCaptureLeaveGuard.ts for why `busy` must not switch it off.
  useCaptureLeaveGuard(sessionItems.length, busy);

  useEffect(() => {
    const handleOutsideClick = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;

      const clickedInsideMaterialDropdown = target.closest(
        ".capture-material-dropdown"
      );

      if (!clickedInsideMaterialDropdown) {
        setOpenMaterialDropdownId(null);
      }
    };

    document.addEventListener("pointerdown", handleOutsideClick);

    return () => {
      document.removeEventListener("pointerdown", handleOutsideClick);
    };
  }, []);

  const locationLabel = captureLocationCheckLabel(useLocation, location.check);

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
        className="capture-enterprise-shell capture-flow"
        data-capture-template-order={collectionPlans
          .map((p) => p.id)
          .join(",")}
      >
        {/* ONE COMPACT HEADER (2026-11-13). The hero, the five-stage intake
            rail and the always-open setup strip used to stand between the
            operator and the add controls. The rail's "current step" was often
            below the fold and its later stages were not a real sequence, so
            it is gone; the header states the setup that governs the session
            and opens Setup in place. */}
        <CaptureHeader
          workspaceName={workspaceName}
          plan={selectedCollectionPlan}
          planMode={planMode}
          useLocation={useLocation}
          locationLabel={locationLabel}
          draftLabel={draftLabel}
          setupOpen={setupOpen}
          onToggleSetup={() => setSetupOpen((open) => !open)}
          setupPanelId={setupPanelId}
        />

        {setupOpen ? (
          <CaptureSetupPanel
            id={setupPanelId}
            plans={collectionPlans}
            planId={collectionPlanId}
            onPlanChange={setCollectionPlanId}
            plan={selectedCollectionPlan}
            planMode={planMode}
            onPlanModeChange={setPlanMode}
            useLocation={useLocation}
            onUseLocationChange={setUseLocation}
            locationLabel={locationLabel}
            locationCheckStatus={location.check.status}
            locked={sessionItems.length > 0}
            busy={busy}
            locationStatus={
              <CaptureLocationStatus
                useLocation={useLocation}
                location={location}
                busy={busy}
                onFinishWithoutLocation={() => void finalizeWithoutLocation()}
              />
            }
          />
        ) : null}

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
                Resume restores the template, assignments, notes and file details.
                Browsers cannot restore file contents, so you re-attach the files
                before Review &amp; Sign.
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
                  role="dialog"
                  aria-modal="true"
                  aria-label="Unfinished capture drafts"
                  onClick={(event) => event.stopPropagation()}
                >
                  <div className="capture-drafts-modal-header">
                    <div>
                      <strong>Unfinished capture drafts</strong>
                      <p>Resume draft metadata, then re-attach files before Review &amp; Sign.</p>
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
                              setReattachDismissed(false);
                              // No success toast here: nothing has been applied yet. The effect that
                              // applies the draft announces it once it actually has.
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

        <section className="capture-enterprise-grid">
          <div className="capture-enterprise-card capture-main-panel">
            {/* What the resumed draft restored, and what it could not.
                It sits directly above the one ingestion surface, because
                re-attaching is the action it asks for. Hidden once material
                is staged. */}
            {resumeDraftDetail &&
            !reattachDismissed &&
            sessionItems.length === 0 ? (
              <CaptureDraftReattachNotice
                detail={resumeDraftDetail}
                plan={selectedCollectionPlan}
                onDismiss={() => setReattachDismissed(true)}
              />
            ) : null}

            {/* ADD EVIDENCE — the first panel in the working column, and the
                one place material enters the session. */}
            <CaptureDropzone
              busy={busy}
              itemCount={sessionItems.length}
              onOpenFilePicker={openFilePicker}
              onOpenFolderPicker={openFolderPicker}
              onOpenCamera={openCamera}
              onOpenAudioRecorder={openAudioRecorder}
              onStartScreenRecording={
                screenRecorder.state === "unsupported"
                  ? undefined
                  : () => {
                      // Directly from the click: the browser's chooser needs
                      // this user gesture. No intermediate card.
                      setError(null);
                      void screenRecorder.start();
                    }
              }
              screenRecordingActive={screenCardVisible && !(screenRecorder.state === "idle")}
              onDropFiles={async (event) => {
                event.preventDefault();

                try {
                  const files = await filesFromDataTransfer(event.dataTransfer);
                  await handleDroppedFiles(files);
                } catch (err) {
                  logCaptureClientError("web_capture_drop_files_or_folder", err, {});
                  setError(describeDropFailure(err));
                }
              }}
            />
            {!online ? (
              <p className="capture-offline-notice" role="alert" data-capture-offline>
                You are offline. Staged materials stay on this page; adding a recording and
                Review &amp; Sign need a connection and will not start until it returns.
              </p>
            ) : null}
            {screenCardVisible ? (
              <CaptureScreenRecorderCard
                state={screenRecorder.state}
                error={screenRecorder.error}
                facts={screenRecorder.facts}
                hasRecording={screenRecorder.recording !== null}
                elapsedMs={screenRecorder.elapsedMs}
                disabled={busy}
                offline={!online}
                onStart={() => void screenRecorder.start()}
                onPause={screenRecorder.pause}
                onResume={screenRecorder.resume}
                onStop={screenRecorder.stop}
                onDiscard={screenRecorder.discard}
                onAdd={() => void screenRecorder.addToSession()}
                onClose={() => {
                  if (screenRecorder.state === "idle") screenRecorder.dismissError();
                  else screenRecorder.discard();
                }}
              />
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

            <span id="capture-staged-anchor" tabIndex={-1} className="capture-visually-hidden">
              Staged evidence
            </span>
            <CaptureMaterialsList
              items={sessionItems}
              plan={selectedCollectionPlan}
              planMode={planMode}
              busy={busy}
              totalBytes={totalStagedBytes}
              draftLabel={draftLabel}
              draftTitle={draftTitle}
              openAssignmentId={openMaterialDropdownId}
              setOpenAssignmentId={setOpenMaterialDropdownId}
              expandedId={expandedMaterialId}
              setExpandedId={setExpandedMaterialId}
              onUpdateItem={updateSessionItem}
              onRemoveItem={removeSessionItem}
              onClearAssignments={() => {
                setSessionItems((prev) =>
                  prev.map((item) => ({ ...item, checklistStepId: null }))
                );
              }}
              onRemovePending={() => {
                sessionItems
                  .filter((item) => !item.uploading && item.uploadProgress < 100)
                  .forEach((item) => removeSessionItem(item.id));
              }}
            />

            <CaptureRequirements
              selectedCollectionPlan={selectedCollectionPlan}
              planMode={planMode}
              busy={busy}
              checklistStepItemMap={checklistStepItemMap}
              sessionReadiness={sessionReadiness}
              formatEvidenceTypeLabel={formatEvidenceTypeLabel}
              onAddForStep={() => openFilePicker()}
              onAssignForStep={assignForStep}
            />

            {/* THE END OF THE FLOW. "Can I proceed?" sits immediately above the
                control that answers it, and on small screens the pair stays
                in reach at the bottom of the viewport. Same `canFinalize` and
                `busy` the button reads. */}
            <div
              className="capture-finish"
              data-capture-finish={sessionItems.length > 0 ? "active" : "empty"}
            >
              <CaptureFinalReadiness
                readiness={sessionReadiness}
                busy={busy}
                onAddFirst={openFilePicker}
                onResolve={() => {
                  const first = sessionReadiness.blockers[0];
                  if (first) selectIssue(first);
                }}
              />

              <CaptureBottomBar
                busy={busy}
                progress={progress}
                sessionStatus={sessionStatus}
                finishDisabled={finishDisabled}
                canClearSession={sessionItems.length > 0}
                onReset={() => setClearConfirmOpen(true)}
                onFinalize={() => setReviewOpen(true)}
              />
            </div>

            {/* SECONDARY DETAIL, ON DEMAND. Session activity, the capture help,
                the trust statements, the quality guidance and the browser
                extension explanation all inform; none is the next action. */}
            <section className="capture-more" aria-label="More about this session">
              {/* Session activity, collapsed. `sessionTimeline` is already in
                  state, so opening this fetches nothing. */}
              <CaptureActivityDisclosure events={sessionTimeline} />

              <details className="capture-more__guide" data-capture-guidance>
                <summary>
                  <span>Help and guidance</span>
                  <ChevronDown size={15} aria-hidden="true" />
                </summary>
                <ContextualHelp
                  surface="capture"
                  stateNotes={
                    sessionItems.length === 0
                      ? [
                          "No materials staged yet — start with Add files, a recording, or a folder.",
                        ]
                      : undefined
                  }
                />
                <CaptureTrustStrip />
                <CaptureReadinessPanel items={sessionItems} />
                {sessionItems.length > 0 ? (
                  <CaptureSuggestionsPanel
                    readiness={computeCaptureReadiness({
                      items: sessionItems,
                    })}
                  />
                ) : null}
                <CaptureDirectWebCaptureCard />
                {/* The extension channel while it is not installable: kept
                    distinct from screen recording, never above the sources. */}
                <CaptureDirectWebCaptureNote />
              </details>
            </section>
          </div>

          <CaptureSessionPanel
            busy={busy}
            error={error}
            locationPermissionDenied={locationPermissionDenied}
            sessionItems={sessionItems}
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
            onSelectIssue={selectIssue}
          />
        </section>

      </div>

      <CaptureReviewDialog
        open={reviewOpen && !busy}
        busy={busy}
        items={sessionItems}
        plan={selectedCollectionPlan}
        planMode={planMode}
        workspaceName={workspaceName}
        locationLabel={locationLabel}
        hasPrivateNote={internalNotes.trim().length > 0}
        warnings={sessionReadiness.warnings}
        totalBytes={totalStagedBytes}
        onCancel={() => setReviewOpen(false)}
        onConfirm={() => {
          setReviewOpen(false);
          void finalizeSession();
        }}
      />

      {clearConfirmOpen ? (
        <div className="capture-confirm-backdrop">
          <div className="capture-confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="capture-clear-title">
            <div className="capture-confirm-icon">!</div>

            <div>
              <div className="capture-confirm-title" id="capture-clear-title">
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
