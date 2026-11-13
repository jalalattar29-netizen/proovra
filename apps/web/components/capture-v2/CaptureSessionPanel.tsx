import { useId } from "react";
import { ChevronDown, LockKeyhole, ShieldCheck } from "lucide-react";

import { CaptureAiAssistant } from "../ai/CaptureAiAssistant";
import type { CollectionPlanTemplate, SessionItem } from "../../app/(app)/capture/_lib/types";
import type {
  CapturePlanMode,
  ReadinessIssue,
  SessionReadiness,
} from "../../app/(app)/capture/_lib/session-readiness";
import { CaptureReadinessSignals } from "../../app/(app)/capture/_lib/CaptureReadinessSignals";

/**
 * THE RAIL — one summary, then the supporting context.
 *
 * It used to open with three surfaces that answered the same question: a
 * Session status card (label, ring, four checks), an Operations command center
 * (Required / Mapped / Blockers / Warnings tiles and a progress bar), and the
 * Requirements panel's own "Finish gate". This is now ONE summary card, read
 * from `sessionReadiness` (the authority), whose blockers and warnings are
 * buttons that lead to the row or setting that resolves them.
 *
 * Below it, the session's supporting context, each compact: AI advisory review
 * (unchanged component, advisory copy unchanged), the private note (unchanged
 * visibility statement), and the session details — ID, template, mode, size and
 * integrity preparation — in a disclosure, because they inform but are not the
 * next action.
 */

type CaptureAiSummary = {
  totalItems: number;
  totalSizeBytes: number;
  requiredStepsCompleted: number;
  requiredStepsTotal: number;
  planMode: CapturePlanMode;
  useLocation: boolean;
  locationRequirement: "optional" | "recommended" | "required";
};

type Props = {
  busy: boolean;
  error: string | null;
  locationPermissionDenied: boolean;
  sessionItems: SessionItem[];
  /** The draft/save line, already computed by the orchestration hook. */
  sessionStatus: string | null;
  currentSessionId: string;
  selectedCollectionPlan: CollectionPlanTemplate | undefined;
  totalStagedBytes: number;
  internalNotes: string;
  setInternalNotes: (value: string) => void;
  aiPanelOpen: boolean;
  setAiPanelOpen: (open: boolean) => void;
  captureAiSummary: CaptureAiSummary;
  sessionReadiness: SessionReadiness;
  useLocation: boolean;
  planMode: CapturePlanMode;
  requiredProgressPercent: number;
  formatFileSize: (bytes: number) => string;
  onSelectIssue?: (issue: ReadinessIssue) => void;
};

const readinessCopy: Record<
  SessionReadiness["status"],
  { label: string; detail: string; tone: "empty" | "blocked" | "warning" | "ready" | "collecting" }
> = {
  empty: {
    label: "Not started",
    detail: "Add your first file to get started.",
    tone: "empty",
  },
  collecting: {
    label: "Collecting",
    detail: "Evidence is staged in this browser. Assign it and review before signing.",
    tone: "collecting",
  },
  blocked: {
    label: "Blocked",
    detail: "Resolve the items below before Review & Sign.",
    tone: "blocked",
  },
  warning: {
    label: "Ready, with warnings",
    detail: "You can Review & Sign. Check the warnings first.",
    tone: "warning",
  },
  ready: {
    label: "Ready for Review & Sign",
    detail: "Everything required is assigned and nothing is blocking.",
    tone: "ready",
  },
};

export function CaptureSessionPanel({
  busy,
  error,
  locationPermissionDenied,
  sessionItems,
  sessionStatus,
  currentSessionId,
  selectedCollectionPlan,
  totalStagedBytes,
  internalNotes,
  setInternalNotes,
  aiPanelOpen,
  setAiPanelOpen,
  captureAiSummary,
  sessionReadiness,
  useLocation,
  planMode,
  requiredProgressPercent,
  formatFileSize,
  onSelectIssue,
}: Props) {
  const readiness = readinessCopy[sessionReadiness.status];
  const noteId = useId();
  const { requiredTotal, requiredCompleted } = sessionReadiness.summary;
  const guided = planMode === "CHECKLIST_REQUIRED";

  // Nothing staged means nothing to review; a template warning on an empty
  // draft is not a reason to suggest it yet.
  const aiReviewLabel =
    sessionReadiness.status !== "empty" && sessionReadiness.aiRecommendedReview
      ? "Suggested: warnings are open"
      : "Optional";
  const itemLabel = (itemId: string) => sessionItems.find((item) => item.id === itemId)?.file.name;

  return (
    <aside className="capture-session-column capture-rail" aria-label="Session summary and context">
      <section
        className={`capture-rail__card capture-summary ${readiness.tone}`}
        data-capture-session-status={busy ? "finalizing" : readiness.tone}
        aria-labelledby={`${noteId}-summary`}
      >
        <p className="capture-section-label">Session summary</p>
        <h2 id={`${noteId}-summary`} className="capture-summary__label">
          {busy ? "Finalizing" : readiness.label}
        </h2>
        <p className="capture-summary__detail">
          {busy ? "Uploads and sealing are running. Keep this tab open." : readiness.detail}
        </p>

        {requiredTotal > 0 && sessionItems.length > 0 ? (
          <div className="capture-summary__progress">
            <span>
              {requiredCompleted} of {requiredTotal} {guided ? "required" : "recommended"} assigned
            </span>
            <div
              className="capture-summary__bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={requiredProgressPercent}
              aria-label={`${requiredProgressPercent}% of ${guided ? "required" : "recommended"} items assigned`}
            >
              <span style={{ width: `${requiredProgressPercent}%` }} />
            </div>
          </div>
        ) : null}

        {/* Blockers and warnings — one component, one place on the page. */}
        <CaptureReadinessSignals
          readiness={sessionReadiness}
          onSelectIssue={onSelectIssue}
          itemLabel={itemLabel}
        />

        {sessionStatus ? <p className="capture-status-card__saved">{sessionStatus}</p> : null}
      </section>

      {error ? (
        <div className="capture-quality-danger capture-inline-alert" role="alert">
          {error}
        </div>
      ) : null}

      {locationPermissionDenied ? (
        <div className="capture-quality-warning capture-inline-alert" role="status">
          Location was not granted. The session continues without location unless the template requires it.
        </div>
      ) : null}

      <section className="capture-rail__card capture-command-section capture-ai-advisory-shell">
        <div className="capture-command-section-title">
          <span>AI advisory review</span>
          <strong>{aiReviewLabel}</strong>
        </div>
        <p>
          Metadata-only quality control. It may surface missing mappings or client-side risk signals, but it does not determine authenticity, truth, authorship, legal admissibility, or final outcome.
        </p>
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
      </section>

      <section className="capture-rail__card capture-notes-card" data-capture-private-note>
        <div className="capture-card-title capture-inline-heading" id="capture-private-note-title">
          <span className="capture-inline-heading-icon">
            <LockKeyhole size={15} strokeWidth={2.1} />
          </span>
          Private note
        </div>
        <p id="capture-private-note-help">
          Visible only inside the authenticated app. Excluded from public verification, reports, and verification packages.
        </p>
        {/* PRO-076: named by its heading, not only by its placeholder. */}
        <textarea
          aria-labelledby="capture-private-note-title"
          aria-describedby="capture-private-note-help"
          value={internalNotes}
          onChange={(event) => setInternalNotes(event.target.value)}
          maxLength={4000}
          disabled={busy}
          placeholder="Add investigator, legal, insurance, or internal review context."
        />
      </section>

      <details className="capture-rail__card capture-details" data-capture-session-details>
        <summary>
          <span>Session details</span>
          <ChevronDown size={15} aria-hidden="true" />
        </summary>
        <dl className="capture-meta-rows">
          <div>
            <dt>Session ID</dt>
            <dd>{currentSessionId}</dd>
          </div>
          <div>
            <dt>Template</dt>
            <dd>{selectedCollectionPlan?.name ?? "General"}</dd>
          </div>
          <div>
            <dt>Mode</dt>
            <dd>{guided ? "Guided (checklist required)" : "Flexible"}</dd>
          </div>
          <div>
            <dt>Total size</dt>
            <dd>{formatFileSize(totalStagedBytes)}</dd>
          </div>
        </dl>
        <div className="capture-command-section-title capture-details__sub">
          <span>Integrity preparation</span>
          <ShieldCheck size={16} strokeWidth={2.1} aria-hidden="true" />
        </div>
        <div className="capture-integrity-list">
          <div>
            <span>Fingerprint</span>
            <strong>{sessionItems.length > 0 ? "Recomputed by the server at signing" : "Waiting"}</strong>
          </div>
          <div>
            <span>Custody</span>
            <strong>{sessionItems.length > 0 ? "Starts when you sign" : "Not started"}</strong>
          </div>
          <div>
            <span>Package</span>
            <strong>After finalization</strong>
          </div>
          <div>
            <span>Location</span>
            <strong>{useLocation ? "Included" : "Not included"}</strong>
          </div>
        </div>
      </details>
    </aside>
  );
}
