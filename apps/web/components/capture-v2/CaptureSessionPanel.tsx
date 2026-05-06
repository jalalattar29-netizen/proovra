import { CaptureAiAssistant } from "../ai/CaptureAiAssistant";

type EvidenceType = "PHOTO" | "VIDEO" | "AUDIO" | "DOCUMENT";

type ChecklistStep = {
  id: string;
  title: string;
  description: string;
  purposeLabel: string;
  required: boolean;
  acceptedKinds?: EvidenceType[];
};

type CollectionPlanTemplate = {
  id: string;
  name: string;
  description: string;
  locationRequirement: "optional" | "recommended" | "required";
  steps: ChecklistStep[];
};

type SessionItemClientSignals = {
  clientHintSha256Base64?: string;
  captureTimeUtc: string;
  browserMediaCaptureAvailable: boolean;
  folderPathPresent: boolean;
  locationIncluded: boolean;
  duplicateStatus?: "none" | "warning" | "duplicate";
  screenshotLike?: boolean;
  genericMime?: boolean;
  oldLastModified?: boolean;
};

type SessionItem = {
  id: string;
  file: File;
  previewUrl: string | null;
  mimeType: string;
  relativePath: string | null;
  uploadProgress: number;
  uploading: boolean;
  error?: string | null;
  role?: string;
  checklistStepId?: string | null;
  privateNote?: string;
  sourceLabel?: string;
  clientSignals?: SessionItemClientSignals;
};

type CaptureAiSummary = {
  totalItems: number;
  totalSizeBytes: number;
  requiredStepsCompleted: number;
  requiredStepsTotal: number;
  planMode: "FLEXIBLE" | "CHECKLIST_REQUIRED";
  useLocation: boolean;
  locationRequirement: "optional" | "recommended" | "required";
};

type QualityStatus = {
  tone: "success" | "warning" | "danger";
  label: string;
  detail: string;
};

type RequirementStatus = {
  label: string;
  tone: "success" | "warning";
  title: string;
  description: string;
};

type Props = {
  busy: boolean;
  error: string | null;
  locationPermissionDenied: boolean;
  sessionItems: SessionItem[];
  sessionCountLabel: string;
  currentSessionId: string;
  selectedCollectionPlan: CollectionPlanTemplate | undefined;
  completedRequiredCount: number;
  requiredStepsTotal: number;
  totalStagedBytes: number;
  requiredProgressPercent: number;
  internalNotes: string;
  setInternalNotes: (value: string) => void;
  aiPanelOpen: boolean;
  setAiPanelOpen: (open: boolean) => void;
  captureAiSummary: CaptureAiSummary;
  planMode: "FLEXIBLE" | "CHECKLIST_REQUIRED";
  resetCaptureState: () => void;
  removeSessionItem: (itemId: string) => void;
  updateSessionItem: (
    itemId: string,
    updates: Partial<
      Pick<SessionItem, "role" | "privateNote" | "checklistStepId" | "sourceLabel">
    >
  ) => void;
  getChecklistStepById: (
    plan: CollectionPlanTemplate | undefined,
    stepId: string | null | undefined
  ) => ChecklistStep | null;
  getChecklistStepStatus: (params: {
    item: SessionItem;
    plan: CollectionPlanTemplate | undefined;
  }) => RequirementStatus;
  getItemQualityStatus: (params: {
    item: SessionItem;
    step: ChecklistStep | null;
  }) => QualityStatus;
  deriveSessionItemTypeLabel: (mimeType: string) => string;
  formatFileSize: (bytes: number) => string;
  getStepRequirementLabel: (step: ChecklistStep) => string;
};

export function CaptureSessionPanel({
  busy,
  error,
  locationPermissionDenied,
  sessionItems,
  sessionCountLabel,
  currentSessionId,
  selectedCollectionPlan,
  completedRequiredCount,
  requiredStepsTotal,
  totalStagedBytes,
  requiredProgressPercent,
  internalNotes,
  setInternalNotes,
  aiPanelOpen,
  setAiPanelOpen,
  captureAiSummary,
  planMode,
  resetCaptureState,
  removeSessionItem,
  updateSessionItem,
  getChecklistStepById,
  getChecklistStepStatus,
  getItemQualityStatus,
  deriveSessionItemTypeLabel,
  formatFileSize,
  getStepRequirementLabel,
}: Props) {
  return (
    <aside className="capture-session-column">
      <div className="capture-enterprise-card capture-session-panel">
        <div className="capture-session-header">
          <div>
            <div className="capture-section-label">Session overview</div>
            <div className="capture-card-title">{sessionCountLabel}</div>
          </div>

          <button
            type="button"
            onClick={resetCaptureState}
            disabled={busy || sessionItems.length === 0}
            className="capture-session-reset"
          >
            New Session
          </button>
        </div>

        <div className="capture-session-metrics">
          {[
            ["Session ID", currentSessionId],
            ["Template", selectedCollectionPlan?.name ?? "General"],
            ["Status", busy ? "Finalizing" : sessionItems.length ? "In Progress" : "Draft"],
            ["Required Steps", `${completedRequiredCount} of ${requiredStepsTotal} completed`],
            ["Total Items", String(sessionItems.length)],
            ["Total Size", formatFileSize(totalStagedBytes)],
          ].map(([label, value]) => (
            <div key={label} className="capture-session-metric-row">
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}

          <div className="capture-session-progress">
            <div style={{ width: `${requiredProgressPercent}%` }} />
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

        {sessionItems.length > 0 ? (
          <div className="capture-session-list">
            {sessionItems.map((item, index) => {
              const mappedStep = getChecklistStepById(
                selectedCollectionPlan,
                item.checklistStepId
              );

              const requirementStatus = getChecklistStepStatus({
                item,
                plan: selectedCollectionPlan,
              });

              const qualityStatus = getItemQualityStatus({
                item,
                step: mappedStep,
              });

              const statusLabel = item.error
                ? "Failed"
                : item.uploading
                  ? `Uploading ${item.uploadProgress}%`
                  : item.uploadProgress === 100
                    ? "Uploaded"
                    : "Ready";

              return (
                <div key={item.id} className="capture-session-item">
                  <div className="capture-session-item-grid">
                    <div className="capture-session-thumb">
                      {item.previewUrl && item.mimeType.startsWith("image/") ? (
                        <img src={item.previewUrl} alt={item.file.name} />
                      ) : item.previewUrl && item.mimeType.startsWith("video/") ? (
                        <video
                          src={item.previewUrl}
                          muted
                          playsInline
                          controls={false}
                        />
                      ) : item.mimeType.startsWith("audio/") ? (
                        "Audio"
                      ) : (
                        deriveSessionItemTypeLabel(item.mimeType)
                      )}
                    </div>

                    <div className="capture-session-item-body">
                      <div className="capture-session-item-title-row">
                        <div style={{ minWidth: 0 }}>
                          <div className="capture-session-item-index">
                            Item {index + 1}
                          </div>

                          <div title={item.file.name} className="capture-session-file-name">
                            {item.file.name}
                          </div>
                        </div>

                        {!busy ? (
                          <button
                            type="button"
                            onClick={() => removeSessionItem(item.id)}
                            className="capture-session-remove"
                          >
                            Remove
                          </button>
                        ) : null}
                      </div>

                      <div className="capture-card-muted">
                        {deriveSessionItemTypeLabel(item.mimeType)} •{" "}
                        {formatFileSize(item.file.size)}
                      </div>

                      <select
                        value={item.checklistStepId ?? ""}
                        onChange={(event) =>
                          updateSessionItem(item.id, {
                            checklistStepId: event.target.value || null,
                          })
                        }
                        disabled={busy}
                        className="capture-session-select"
                      >
                        <option value="">
                          {planMode === "CHECKLIST_REQUIRED"
                            ? "Map to required collection step"
                            : "Map to collection step"}
                        </option>

                        {selectedCollectionPlan?.steps.map((step) => (
                          <option key={step.id} value={step.id}>
                            {getStepRequirementLabel(step)}: {step.title} —{" "}
                            {step.purposeLabel}
                          </option>
                        ))}
                      </select>

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
                        <div>{qualityStatus.detail}</div>
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
                        className="capture-session-textarea"
                      />

                      <div className="capture-session-status-row">
                        <span className={item.error ? "danger" : "ok"}>
                          {statusLabel}
                        </span>

                        <span className="capture-card-muted">
                          {requirementStatus.label}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="capture-card-muted">
            Added materials will appear here for mapping, notes, and quality review.
          </div>
        )}

        <div className="capture-internal-notes">
          <div className="capture-card-title">Private Internal Notes</div>

          <div className="capture-card-muted">
            Visible only inside the authenticated app. Excluded from public
            verification, reports, and verification packages.
          </div>

          <textarea
            value={internalNotes}
            onChange={(event) => setInternalNotes(event.target.value)}
            maxLength={4000}
            disabled={busy}
            placeholder="Add investigator, legal, insurance, or internal review context."
            className="capture-session-textarea capture-internal-notes-textarea"
          />
        </div>

        {error ? (
          <div className="capture-quality-danger capture-inline-alert">
            {error}
          </div>
        ) : null}

        {locationPermissionDenied ? (
          <div className="capture-quality-warning capture-inline-alert">
            Location was not granted. The current session will continue without GPS
            metadata.
          </div>
        ) : null}
      </div>
    </aside>
  );
}