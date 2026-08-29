import { CheckCircle2, CircleDot, LockKeyhole, ShieldCheck } from "lucide-react";

import { CaptureAiAssistant } from "../ai/CaptureAiAssistant";
import type { CollectionPlanTemplate, SessionItem } from "../../app/(app)/capture/_lib/types";
import type { CapturePlanMode, SessionReadiness } from "../../app/(app)/capture/_lib/session-readiness";
import { CaptureReadinessSignals } from "../../app/(app)/capture/_lib/CaptureReadinessSignals";

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
  sessionCountLabel: string;
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
};

const readinessCopy: Record<
  SessionReadiness["status"],
  { label: string; detail: string; tone: "empty" | "blocked" | "warning" | "ready" | "collecting" }
> = {
  empty: {
    label: "Awaiting material",
    detail: "Add at least one file, folder, photo, video, or audio recording to begin readiness review.",
    tone: "empty",
  },
  collecting: {
    label: "Collecting",
    detail: "Materials are staged locally. Continue mapping and reviewing before finalization.",
    tone: "collecting",
  },
  blocked: {
    label: "Blocked",
    detail: "Required evidence or metadata is missing. Resolve blockers before Review & Sign.",
    tone: "blocked",
  },
  warning: {
    label: "Ready with warnings",
    detail: "The session can proceed, but reviewers should inspect the warnings first.",
    tone: "warning",
  },
  ready: {
    label: "Ready for Review & Sign",
    detail: "Required evidence is mapped and no blockers are currently detected.",
    tone: "ready",
  },
};

export function CaptureSessionPanel({
  busy,
  error,
  locationPermissionDenied,
  sessionItems,
  sessionCountLabel,
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
}: Props) {
  const readiness = readinessCopy[sessionReadiness.status];

  // Four facts, each already decided by the readiness authority. Nothing here
  // is a rule — `done` is a read, not a judgement.
  const statusChecks = [
    {
      label: `${sessionReadiness.summary.requiredCompleted}/${sessionReadiness.summary.requiredTotal} required mapped`,
      done:
        sessionReadiness.summary.requiredTotal > 0 &&
        sessionReadiness.summary.requiredCompleted === sessionReadiness.summary.requiredTotal,
    },
    {
      label: `${sessionItems.length} material${sessionItems.length === 1 ? "" : "s"} added`,
      done: sessionItems.length > 0,
    },
    {
      label: sessionReadiness.summary.blockerCount === 0 ? "No blockers" : "Blockers to clear",
      done: sessionReadiness.summary.blockerCount === 0,
    },
    {
      label: sessionReadiness.canFinalize ? "Ready for Review & Sign" : "Review & Sign not available",
      done: sessionReadiness.canFinalize,
    },
  ];

  const aiReviewLabel = sessionReadiness.aiRecommendedReview
    ? "Recommended before finalization"
    : "Optional metadata review";

  return (
    <aside className="capture-session-column">
      {/* SESSION STATUS — the rail's answer to "where is this session?", read
          before anything else in it. State, save line, how far the required
          mapping has got, and the four facts that decide it. Every value comes
          from `sessionReadiness` or from state the page already holds; the
          card computes nothing.

          It absorbed the tone card that used to open Operations command
          center. That card carried the same label and the same detail string,
          one box below — the rail opened by saying the same thing twice. */}
      <section
        className={`capture-enterprise-card capture-status-card ${readiness.tone}`}
        data-capture-session-status={busy ? "finalizing" : readiness.tone}
      >
        <header className="capture-status-card__head">
          <div>
            <p className="capture-section-label">Session status</p>
            <strong>{busy ? "Finalizing" : readiness.label}</strong>
          </div>
          <span className={`capture-readiness-chip ${readiness.tone}`}>
            {busy ? "In progress" : "Draft"}
          </span>
        </header>

        <p className="capture-status-card__detail">
          {busy
            ? "Uploads and verification preparation are running. Keep this tab open."
            : readiness.detail}
        </p>

        <div className="capture-status-card__progress">
          <div
            className="capture-status-ring"
            style={{ ["--capture-ring" as string]: `${requiredProgressPercent}%` }}
            role="img"
            aria-label={`${requiredProgressPercent}% of required items mapped`}
          >
            <span>{requiredProgressPercent}%</span>
          </div>
          <ul className="capture-status-checks">
            {statusChecks.map((check) => (
              <li key={check.label} data-capture-check={check.done ? "done" : "open"}>
                {check.done ? (
                  <CheckCircle2 size={15} strokeWidth={2.2} aria-hidden="true" />
                ) : (
                  <CircleDot size={15} strokeWidth={2.2} aria-hidden="true" />
                )}
                <span>{check.label}</span>
              </li>
            ))}
          </ul>
        </div>

        {sessionStatus ? (
          <p className="capture-status-card__saved">{sessionStatus}</p>
        ) : null}
      </section>

      <div className="capture-enterprise-card capture-right-panel capture-command-center">
        <div className="capture-command-header">
          <div>
            <div className="capture-section-label">Operations command center</div>
            <div className="capture-card-title">{sessionCountLabel}</div>
          </div>
        </div>

        <div className="capture-command-metrics">
          <div>
            <span>Required</span>
            <strong>
              {sessionReadiness.summary.requiredCompleted}/{sessionReadiness.summary.requiredTotal}
            </strong>
          </div>
          <div>
            <span>Mapped</span>
            <strong>{sessionReadiness.mappedItems.length}</strong>
          </div>
          <div className={sessionReadiness.summary.blockerCount > 0 ? "is-blocked" : ""}>
            <span>Blockers</span>
            <strong>{sessionReadiness.summary.blockerCount}</strong>
          </div>
          <div className={sessionReadiness.summary.warningCount > 0 ? "is-warning" : ""}>
            <span>Warnings</span>
            <strong>{sessionReadiness.summary.warningCount}</strong>
          </div>
        </div>

        <div className="capture-progress-track capture-command-progress">
          <div style={{ width: `${requiredProgressPercent}%` }} />
        </div>

        {/* Blockers and warnings — one component, one place on the page.
            It renders the same `sessionReadiness` arrays these two sections
            used to render by hand, keeps the four-item cap and the "+N more"
            overflow, and collapses the far more common zero state to a single
            row instead of two cards that each announce an absence. */}
        <CaptureReadinessSignals readiness={sessionReadiness} />

        <section className="capture-command-section capture-session-metadata-card">
          <div className="capture-command-section-title">
            <span>Session metadata</span>
          </div>
          {/* Rows, not four bordered boxes. In the two-up grid these used to
              form, a 320px rail gave each value ~120px and `CAP-2026-08-29`
              wrapped a character at a time. A label-left/value-right row gives
              the value the full width and needs no border of its own — the
              section already has one. */}
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
              <dd>{planMode === "CHECKLIST_REQUIRED" ? "Checklist required" : "Flexible"}</dd>
            </div>
            <div>
              <dt>Total size</dt>
              <dd>{formatFileSize(totalStagedBytes)}</dd>
            </div>
          </dl>
        </section>

<section className="capture-command-section capture-integrity-block">
  <div className="capture-command-section-title">
    <span>Integrity preparation</span>
    <ShieldCheck size={16} strokeWidth={2.1} />
  </div>

  <div className="capture-integrity-list">
    <div>
      <span>Fingerprint</span>
      <strong>{sessionItems.length > 0 ? "Queued" : "Waiting"}</strong>
    </div>
    <div>
      <span>Custody</span>
      <strong>{sessionItems.length > 0 ? "Ready after sign" : "Not started"}</strong>
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
</section>
        <section className="capture-command-section capture-ai-advisory-shell">
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

        <section className="capture-notes-card">
          <div className="capture-card-title capture-inline-heading">
            <span className="capture-inline-heading-icon">
              <LockKeyhole size={15} strokeWidth={2.1} />
            </span>
            Private note
          </div>
          <p>
            Visible only inside the authenticated app. Excluded from public verification, reports, and verification packages.
          </p>
          <textarea
            value={internalNotes}
            onChange={(event) => setInternalNotes(event.target.value)}
            maxLength={4000}
            disabled={busy}
            placeholder="Add investigator, legal, insurance, or internal review context."
          />
        </section>

        {error ? <div className="capture-quality-danger capture-inline-alert">{error}</div> : null}

        {locationPermissionDenied ? (
          <div className="capture-quality-warning capture-inline-alert">
            Location was not granted. The current session will continue without GPS metadata unless the selected plan requires it.
          </div>
        ) : null}
      </div>
    </aside>
  );
}
