"use client";

import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Card } from "../ui";
import { apiFetch, ApiError } from "../../lib/api";

type EvidenceType = "PHOTO" | "VIDEO" | "AUDIO" | "DOCUMENT";

type SessionItemSignalPayload = {
  duplicateStatus?: "none" | "warning" | "duplicate";
  screenshotLike?: boolean;
  genericMime?: boolean;
  oldLastModified?: boolean;
  folderPathPresent?: boolean;
  locationIncluded?: boolean;
};

type SessionItemPayload = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  checklistStepId?: string | null;
  role?: string;
  sourceLabel?: string;
  clientSignals?: SessionItemSignalPayload;
};

type CollectionPlanStep = {
  id: string;
  title: string;
  description: string;
  purposeLabel: string;
  required: boolean;
  acceptedKinds?: EvidenceType[];
};

type CollectionPlanPayload = {
  id: string;
  name: string;
  description: string;
  locationRequirement: "optional" | "recommended" | "required";
  steps: CollectionPlanStep[];
};

type CaptureSessionSummary = {
  totalItems: number;
  totalSizeBytes: number;
  requiredStepsCompleted: number;
  requiredStepsTotal: number;
  planMode: "FLEXIBLE" | "CHECKLIST_REQUIRED";
  useLocation: boolean;
  locationRequirement: "optional" | "recommended" | "required";
};

type CaptureAiAssistantProps = {
  isOpen: boolean;
  setOpen: (open: boolean) => void;
  collectionPlan: CollectionPlanPayload | null;
  summary: CaptureSessionSummary;
  sessionItems: SessionItemPayload[];
};

type AiFlag = {
  severity: "info" | "warning" | "danger";
  title: string;
  detail: string;
  affectedItemId?: string;
  affectedStepId?: string;
};

type AiResult = {
  status: "ok" | "blocked" | "disabled" | "error";
  summary: string;
  warnings: string[];
  suggestions: string[];
  flags: AiFlag[];
  legalDisclaimer: string;
};

export function CaptureAiAssistant({
  isOpen,
  setOpen,
  collectionPlan,
  summary,
  sessionItems,
}: CaptureAiAssistantProps) {
  const [analysis, setAnalysis] = useState<AiResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [isReviewModalOpen, setIsReviewModalOpen] = useState(false);

  const canAnalyze = summary.totalItems > 0 && Boolean(collectionPlan);

  const handleAnalyze = async () => {
    if (!collectionPlan) return;

    setLoading(true);
    setError(null);
    setUnavailable(false);

    try {
      const safeItems = sessionItems.map((item) => ({
        id: item.id,
        fileName: item.fileName,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
        checklistStepId: item.checklistStepId ?? null,
        role: item.role,
        sourceLabel: item.sourceLabel,
        clientSignals: item.clientSignals,
      }));

      const response = (await apiFetch(
        "/v1/ai/capture/analyze-session",
        {
          method: "POST",
          body: JSON.stringify({
            collectionPlan,
            planMode: summary.planMode,
            useLocation: summary.useLocation,
            items: safeItems,
          }),
        },
        { auth: true }
      )) as { data?: AiResult };

      const result: AiResult = response?.data ?? {
        status: "disabled",
        summary: "AI assistance is currently unavailable.",
        warnings: [],
        suggestions: [],
        flags: [],
        legalDisclaimer: "AI assistance is currently unavailable.",
      };

      setAnalysis(result);
    } catch (err: unknown) {
      const apiError = err as ApiError;
      const unavailableReason =
        apiError?.code === "AI_DISABLED" ||
        apiError?.statusCode === 404 ||
        apiError?.statusCode === 503 ||
        apiError?.statusCode === 502 ||
        apiError?.statusCode === 504;

      if (unavailableReason) {
        setUnavailable(true);
        setError("AI assistant unavailable.");
      } else {
        setError("AI assistance could not be loaded. Continue capture normally.");
      }
    } finally {
      setLoading(false);
    }
  };

  const sortedAiFlags = useMemo(() => {
    const priority = { danger: 0, warning: 1, info: 2 };
    return (analysis?.flags ?? [])
      .slice()
      .sort(
        (a, b) =>
          priority[a.severity] - priority[b.severity] ||
          a.title.localeCompare(b.title)
      );
  }, [analysis?.flags]);

  const signalSummary = useMemo(() => {
    return sessionItems.reduce(
      (acc, item) => {
        const signals = item.clientSignals;
        if (!signals) return acc;

        if (signals.duplicateStatus === "duplicate") acc.duplicateItems += 1;
        if (signals.duplicateStatus === "warning") acc.duplicateWarnings += 1;
        if (signals.genericMime) acc.genericMimeItems += 1;
        if (signals.oldLastModified) acc.oldTimestampItems += 1;
        if (signals.screenshotLike) acc.screenshotLikeItems += 1;
        if (signals.folderPathPresent) acc.folderPathItems += 1;
        if (signals.locationIncluded) acc.locationIncludedItems += 1;

        return acc;
      },
      {
        duplicateItems: 0,
        duplicateWarnings: 0,
        genericMimeItems: 0,
        oldTimestampItems: 0,
        screenshotLikeItems: 0,
        folderPathItems: 0,
        locationIncludedItems: 0,
      }
    );
  }, [sessionItems]);

  const requiredMissingCount = Math.max(
    0,
    summary.requiredStepsTotal - summary.requiredStepsCompleted
  );

  const requiredCoveragePercent =
    summary.requiredStepsTotal > 0
      ? Math.round((summary.requiredStepsCompleted / summary.requiredStepsTotal) * 100)
      : 100;

  const clientSignalIssueCount =
    signalSummary.duplicateItems +
    signalSummary.duplicateWarnings +
    signalSummary.genericMimeItems +
    signalSummary.oldTimestampItems +
    (summary.locationRequirement === "required" && !summary.useLocation ? 1 : 0);

  const aiFlagIssueCount = sortedAiFlags.filter(
    (flag) => flag.severity === "danger" || flag.severity === "warning"
  ).length;

  const qaIssueCount = analysis
    ? requiredMissingCount + aiFlagIssueCount + analysis.warnings.length
    : requiredMissingCount + clientSignalIssueCount;

  const workflowState = useMemo(() => {
    if (!collectionPlan) {
      return {
        tone: "idle",
        label: "Plan context required",
        detail: "Select a collection plan so AI quality control can evaluate the workflow scope.",
      };
    }

    if (summary.totalItems === 0) {
      return {
        tone: "idle",
        label: "Awaiting evidence",
        detail: "Add source material before running workflow-aware AI quality control.",
      };
    }

    if (requiredMissingCount > 0) {
      return {
        tone: "blocked",
        label: "Coverage gap detected",
        detail: `${requiredMissingCount} required capture step${requiredMissingCount === 1 ? "" : "s"} still need mapped material before final review.`,
      };
    }

    if (qaIssueCount > 0) {
      return {
        tone: "warning",
        label: "QA review recommended",
        detail: `${qaIssueCount} workflow signal${qaIssueCount === 1 ? "" : "s"} should be checked before Review & Sign.`,
      };
    }

    return {
      tone: "ready",
      label: "Ready for advisory QA",
      detail: "Required coverage is complete. Run AI quality control as a final metadata review gate.",
    };
  }, [collectionPlan, qaIssueCount, requiredMissingCount, summary.totalItems]);

  const missingCard = useMemo(() => {
    if (analysis?.flags?.length) {
      const missing = analysis.flags
        .filter(
          (flag) =>
            flag.severity === "danger" &&
            /missing|required/i.test(`${flag.title} ${flag.detail}`)
        )
        .map((flag) => flag.title);
      if (missing.length > 0) return missing;
    }

    if (summary.requiredStepsTotal === 0) {
      return ["No required capture steps are defined for the selected plan."];
    }

    const unmappedRequiredSteps =
      collectionPlan?.steps
        .filter(
          (step) =>
            step.required &&
            !sessionItems.some((item) => item.checklistStepId === step.id)
        )
        .map((step) => `Map evidence to required step: ${step.title}`) ?? [];

    if (unmappedRequiredSteps.length > 0) return unmappedRequiredSteps;

    if (summary.requiredStepsCompleted < summary.requiredStepsTotal) {
      return [
        `${summary.requiredStepsTotal - summary.requiredStepsCompleted} required capture item(s) appear missing.`,
      ];
    }

    return ["Required capture coverage appears complete."];
  }, [analysis, collectionPlan?.steps, sessionItems, summary]);

  const riskCard = useMemo(() => {
    if (analysis?.warnings.length) {
      return analysis.warnings;
    }

    const warnings: string[] = [];
    if (summary.locationRequirement === "required" && !summary.useLocation) {
      warnings.push("Location metadata is required by the selected plan but not enabled.");
    }
    if (signalSummary.duplicateItems > 0 || signalSummary.duplicateWarnings > 0) {
      warnings.push(
        `${signalSummary.duplicateItems + signalSummary.duplicateWarnings} duplicate-related client signal(s) need review.`
      );
    }
    if (signalSummary.genericMimeItems > 0) {
      warnings.push(`${signalSummary.genericMimeItems} item(s) reported a generic MIME type.`);
    }
    if (signalSummary.oldTimestampItems > 0) {
      warnings.push(`${signalSummary.oldTimestampItems} item(s) have older last modified timestamps.`);
    }
    if (signalSummary.screenshotLikeItems > 0) {
      warnings.push(`${signalSummary.screenshotLikeItems} screenshot-like item(s) should be confirmed against the evidence purpose.`);
    }

    return warnings.length
      ? warnings
      : ["No high-risk session issues were detected in the provided metadata."];
  }, [analysis, signalSummary, summary]);

  const actionCard = useMemo(() => {
    if (analysis?.suggestions.length) {
      return analysis.suggestions;
    }

    const actions: string[] = [];

    if (requiredMissingCount > 0) {
      actions.push("Map or add the missing required evidence before Review & Sign.");
    }

    if (summary.locationRequirement === "required" && !summary.useLocation) {
      actions.push("Enable location metadata or resolve the required-location workflow blocker.");
    }

    if (clientSignalIssueCount > 0) {
      actions.push("Review duplicate, generic MIME, and timestamp signals against the staged materials.");
    }

    actions.push("Confirm reviewer judgement before finalizing; AI remains advisory quality control.");

    return actions;
  }, [analysis, clientSignalIssueCount, requiredMissingCount, summary]);

  const groupedActions = useMemo(() => {
    return {
      high: actionCard.filter((item) =>
        /zip|required|missing|confirm|verify|review|blocker|finalizing/i.test(item)
      ),
      recommended: actionCard.filter((item) =>
        /location|collect|add|assign|map|label|metadata|timestamp|duplicate/i.test(item)
      ),
      info: actionCard.filter(
        (item) =>
          !/zip|required|missing|confirm|verify|review|blocker|finalizing|location|collect|add|assign|map|label|metadata|timestamp|duplicate/i.test(
            item
          )
      ),
    };
  }, [actionCard]);

  const reviewButtonLabel = loading
    ? "Reviewing workflow…"
    : !canAnalyze
      ? "Add evidence to run QA"
      : qaIssueCount > 0
        ? `Run AI QA review (${qaIssueCount})`
        : "Run AI QA review";

  return (
    <Card className="capture-phase7-ai-card rounded-[18px] border border-[rgba(36,55,59,0.12)] bg-[#fbfcfb] p-0 shadow-[0_14px_34px_rgba(15,23,42,0.08)]">
      <button
        type="button"
        onClick={() => setOpen(!isOpen)}
        className={`capture-phase7-ai-toggle ${workflowState.tone}`}
      >
        <div>
<span className="capture-phase7-ai-title">AI Review</span>
        </div>
<span className="capture-ai-count-pill">
  {isOpen ? "Hide" : qaIssueCount > 0 ? qaIssueCount : "Open"}
</span>
      </button>

      {isOpen ? (
        <div className="capture-phase7-ai-body">
          <div className={`capture-phase7-ai-status ${workflowState.tone}`}>
            <div>
              <strong>{workflowState.label}</strong>
              <span>{workflowState.detail}</span>
            </div>
            <span>{analysis ? "Analyzed" : "Pre-check"}</span>
          </div>

          <div className="capture-phase7-ai-context-grid">
            <div>
              <span>Workflow</span>
              <strong>{collectionPlan?.name ?? "No plan selected"}</strong>
              <small>{summary.planMode === "CHECKLIST_REQUIRED" ? "Checklist required" : "Flexible intake"}</small>
            </div>
            <div>
              <span>Coverage</span>
              <strong>{summary.requiredStepsCompleted}/{summary.requiredStepsTotal}</strong>
              <small>{requiredCoveragePercent}% required coverage</small>
            </div>
            <div>
              <span>Materials</span>
              <strong>{summary.totalItems}</strong>
              <small>{signalSummary.locationIncludedItems} with location signal</small>
            </div>
            <div>
              <span>Signals</span>
              <strong>{clientSignalIssueCount}</strong>
              <small>{sortedAiFlags.length} AI flag(s)</small>
            </div>
          </div>

          {error ? (
            <div className="rounded-3xl border border-rose-500/20 bg-rose-50 p-3 text-sm text-rose-800">
              {error}
            </div>
          ) : null}

          {unavailable ? (
            <div className="rounded-3xl border border-[rgba(183,157,132,0.22)] bg-[#faf6f1] p-3 text-sm text-[#705f50]">
              AI assistant unavailable. Continue capture and finish normally.
            </div>
          ) : null}

          <div className="capture-phase5-ai-action-shell capture-phase7-ai-action-shell">
            <div className="capture-ai-review-copy">
              <strong>Advisory workflow gate</strong>
              <span>
                Run after mapping evidence. The review checks coverage, metadata signals,
                and suggested next actions before the human Review & Sign decision.
              </span>
            </div>

            <button
              type="button"
              className="capture-ai-review-button capture-secondary-advisory-action"
              disabled={!canAnalyze || loading}
              onClick={async () => {
                setIsReviewModalOpen(true);

                if (!analysis) {
                  await handleAnalyze();
                }
              }}
            >
              {reviewButtonLabel}
            </button>
          </div>
        </div>
      ) : null}
      {isReviewModalOpen && typeof document !== "undefined"
        ? createPortal(
            <div
              className="capture-ai-modal-backdrop capture-phase7-ai-modal-backdrop"
              onClick={() => setIsReviewModalOpen(false)}
            >
              <div
                className="capture-ai-modal capture-phase7-ai-modal"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="capture-ai-modal-header capture-phase7-ai-modal-header">
                  <div>
                    <div className="capture-section-label">AI workflow quality control</div>
                    <h2>Session readiness review</h2>
                    <p>
                      Advisory metadata-based review only. This assistant does not determine
                      factual truth, authenticity, authorship, or legal admissibility.
                    </p>
                  </div>

                  <button
                    type="button"
                    className="capture-ai-modal-close"
                    onClick={() => setIsReviewModalOpen(false)}
                  >
                    Close
                  </button>
                </div>

                <div className="capture-ai-modal-body capture-phase7-ai-modal-body">
                  {loading ? (
                    <div className="capture-ai-section capture-phase7-ai-loading">
                      <h3>Reviewing workflow…</h3>
                      <p>Checking metadata, mappings, missing requirements, and risk flags.</p>
                    </div>
                  ) : error ? (
                    <div className="capture-ai-section">
                      <h3>AI unavailable</h3>
                      <p>{error}</p>
                    </div>
                  ) : (
                    <>
                      <div className="capture-phase7-ai-review-strip">
                        <div>
                          <span>Current QA state</span>
                          <strong>{workflowState.label}</strong>
                        </div>
                        <div>
                          <span>Required coverage</span>
                          <strong>{requiredCoveragePercent}%</strong>
                        </div>
                        <div>
                          <span>Workflow signals</span>
                          <strong>{qaIssueCount}</strong>
                        </div>
                      </div>

                      <div className="capture-ai-severity-grid capture-phase7-ai-severity-grid">
                        <div className={`capture-ai-severity-card ${requiredMissingCount > 0 ? "critical" : "success"}`}>
                          <strong>Coverage gate</strong>
                          <span>{missingCard[0]}</span>
                        </div>

                        <div className={`capture-ai-severity-card ${riskCard.length > 1 || clientSignalIssueCount > 0 ? "warning" : "success"}`}>
                          <strong>Risk signals</strong>
                          <span>{riskCard.length} workflow note(s).</span>
                        </div>

                        <div className="capture-ai-severity-card info">
                          <strong>Metadata review</strong>
                          <span>{sortedAiFlags.length} metadata flag(s).</span>
                        </div>

                        <div className="capture-ai-severity-card critical">
                          <strong>Human gate</strong>
                          <span>Reviewer confirmation is still required.</span>
                        </div>
                      </div>

                      <div className="capture-phase7-ai-workflow-grid">
                        <div className="capture-ai-section">
                          <h3>Coverage requirements</h3>
                          <ul>
                            {missingCard.map((item, index) => (
                              <li key={index}>{item}</li>
                            ))}
                          </ul>
                        </div>

                        <div className="capture-ai-section">
                          <h3>Risk signals</h3>
                          <ul>
                            {riskCard.map((item, index) => (
                              <li key={index}>{item}</li>
                            ))}
                          </ul>
                        </div>
                      </div>

                      {sortedAiFlags.length > 0 ? (
                        <div className="capture-ai-section">
                          <h3>Metadata review</h3>
                          <ul>
                            {sortedAiFlags.map((flag, index) => (
                              <li key={`${flag.title}-${index}`}>
                                [{flag.severity}] {flag.title}: {flag.detail}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}

                      <div className="capture-ai-section capture-phase7-ai-next-actions">
                        <h3>Workflow next actions</h3>

                        <div className="capture-ai-action-groups">
                          {groupedActions.high.length > 0 ? (
                            <div className="capture-ai-action-group high">
                              <strong>Resolve before final review</strong>
                              <ul>
                                {groupedActions.high.map((item, index) => (
                                  <li key={`high-${index}`}>{item}</li>
                                ))}
                              </ul>
                            </div>
                          ) : null}

                          {groupedActions.recommended.length > 0 ? (
                            <div className="capture-ai-action-group recommended">
                              <strong>Recommended QA check</strong>
                              <ul>
                                {groupedActions.recommended.map((item, index) => (
                                  <li key={`recommended-${index}`}>{item}</li>
                                ))}
                              </ul>
                            </div>
                          ) : null}

                          {groupedActions.info.length > 0 ? (
                            <div className="capture-ai-action-group info">
                              <strong>Informational</strong>
                              <ul>
                                {groupedActions.info.map((item, index) => (
                                  <li key={`info-${index}`}>{item}</li>
                                ))}
                              </ul>
                            </div>
                          ) : null}
                        </div>
                      </div>

                      <div className="capture-ai-section capture-phase7-ai-limitation">
                        <h3>Legal limitation</h3>
                        <p>
                          {analysis?.legalDisclaimer ??
                            "AI assistance is advisory and does not determine factual truth, authorship, authenticity, or legal admissibility."}
                        </p>
                      </div>

                      {/* Phase CAPTURE-CLOSURE Part D — explicit
                          transience disclaimer. The advisor result is
                          NOT persisted (no AI advisory table, no
                          column on Evidence). It is computed on
                          demand and discarded when this dialog
                          closes. Surfacing this honestly avoids the
                          "did my AI review save?" confusion and
                          documents the design without inventing a
                          fake save state. */}
                      <div
                        className="capture-ai-section"
                        data-capture-ai-transience
                        style={{
                          borderTop: "1px solid #e2e8f0",
                          marginTop: 12,
                          paddingTop: 10,
                        }}
                      >
                        <p style={{ margin: 0, fontSize: 12.5, color: "#64748b" }}>
                          <strong>AI advisory is not saved.</strong>{" "}
                          This review runs against your session
                          metadata only (uploaded contents are never
                          sent). Output is not persisted on the
                          evidence record, the report, or the
                          verification package. Re-run to see fresh
                          guidance after editing materials.
                        </p>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </Card>
  );
}
