"use client";

import { useMemo, useState } from "react";
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

  const missingCard = useMemo(() => {
    if (analysis?.flags?.length) {
const missing = analysis.flags
  .filter((flag) =>
    flag.severity === "danger" &&
    /missing|required/i.test(`${flag.title} ${flag.detail}`)
  )
  .map((flag) => flag.title);
        if (missing.length > 0) return missing;
    }

    if (summary.requiredStepsTotal === 0) {
      return ["No required capture steps are defined for the selected plan."];
    }
    if (summary.requiredStepsCompleted < summary.requiredStepsTotal) {
      return [
        `${summary.requiredStepsTotal - summary.requiredStepsCompleted} required capture item(s) appear missing.`,
      ];
    }
    return ["Required capture coverage appears complete."];
  }, [analysis, summary]);

  const riskCard = useMemo(() => {
    if (analysis?.warnings.length) {
      return analysis.warnings;
    }

    const warnings: string[] = [];
    if (summary.locationRequirement === "required" && !summary.useLocation) {
      warnings.push("Location metadata is required by the selected plan but not enabled.");
    }
    if (sessionItems.some((item) => item.clientSignals?.duplicateStatus === "duplicate")) {
      warnings.push("Duplicate file signals were detected for one or more items.");
    }
    if (sessionItems.some((item) => item.clientSignals?.genericMime)) {
      warnings.push("One or more items reported a generic MIME type that should be reviewed.");
    }
    if (sessionItems.some((item) => item.clientSignals?.oldLastModified)) {
      warnings.push("One or more items have an older last modified timestamp.");
    }

    return warnings.length
      ? warnings
      : ["No high-risk session issues were detected in the provided metadata."];
  }, [analysis, summary, sessionItems]);

  const actionCard = useMemo(() => {
    if (analysis?.suggestions.length) {
      return analysis.suggestions;
    }

    return [
      "Confirm required items are mapped to the selected plan steps.",
      "Review duplicate and generic MIME signals before signing.",
      "Use location metadata when the plan requires it.",
    ];
  }, [analysis]);

  const groupedActions = useMemo(() => {
  return {
    high: actionCard.filter((item) =>
      /zip|required|missing|confirm|verify|review/i.test(item)
    ),
    recommended: actionCard.filter((item) =>
      /location|collect|add|assign|map|label/i.test(item)
    ),
    info: actionCard.filter(
      (item) =>
        !/zip|required|missing|confirm|verify|review|location|collect|add|assign|map|label/i.test(
          item
        )
    ),
  };
}, [actionCard]);

  return (
    <Card className="rounded-[18px] border border-[rgba(36,55,59,0.12)] bg-[#fbfcfb] p-0 shadow-[0_14px_34px_rgba(15,23,42,0.08)]">
      <button
        type="button"
        onClick={() => setOpen(!isOpen)}
        className="w-full rounded-t-[18px] border-b border-[rgba(36,55,59,0.10)] bg-[linear-gradient(180deg,#3a5d61,#203a3f)] px-4 py-3 text-left text-sm font-semibold text-[#f4f7f6]"
      >
        <div className="flex items-center justify-between gap-4">
          <span>Capture AI assistant</span>
          <span className="text-[#e6c9ae]">{isOpen ? "Hide" : "Show"}</span>
        </div>
      </button>

      {isOpen ? (
        <div className="space-y-3 px-4 py-3">
          <div className="rounded-2xl border border-[rgba(58,93,97,0.14)] bg-[#f1f6f4] p-3 text-sm leading-5 text-[#425458]">
            This assistant provides intake guidance only. It does not determine legal admissibility, authenticity, or the factual truth of an event.
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-[rgba(58,93,97,0.12)] bg-white p-3 shadow-sm">
              <div className="text-xs font-black uppercase tracking-[0.18em] text-[#8f745c]">Plan</div>
              <div className="mt-2 text-sm font-extrabold text-[#12252a]">
                {collectionPlan?.name ?? "No plan selected"}
              </div>
              <div className="mt-1 text-sm text-[#647174]">
                {collectionPlan?.locationRequirement ?? "optional"} location
              </div>
            </div>

            <div className="rounded-2xl border border-[rgba(58,93,97,0.12)] bg-white p-3 shadow-sm">
              <div className="text-xs font-black uppercase tracking-[0.18em] text-[#8f745c]">Session</div>
              <div className="mt-2 text-sm font-extrabold text-[#12252a]">
                {summary.totalItems} item(s)
              </div>
              <div className="mt-1 text-sm text-[#647174]">
                {summary.requiredStepsCompleted} / {summary.requiredStepsTotal} required steps complete
              </div>
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

          <div className="grid gap-3">
<button
  type="button"
  className="capture-ai-review-button"
  disabled={!canAnalyze || loading}
  onClick={async () => {
    setIsReviewModalOpen(true);

    if (!analysis) {
      await handleAnalyze();
    }
  }}
>
  {loading ? "Reviewing session..." : "Review session with AI"}
</button>

          </div>
        </div>
      ) : null}
      {isReviewModalOpen ? (
  <div
    className="capture-ai-modal-backdrop"
    onClick={() => setIsReviewModalOpen(false)}
  >
    <div
      className="capture-ai-modal"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="capture-ai-modal-header">
        <div>
          <div className="capture-section-label">AI intake review</div>
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

      <div className="capture-ai-modal-body">
        {loading ? (
          <div className="capture-ai-section">
            <h3>Reviewing session…</h3>
            <p>Checking metadata, mappings, missing requirements, and risk flags.</p>
          </div>
        ) : error ? (
          <div className="capture-ai-section">
            <h3>AI unavailable</h3>
            <p>{error}</p>
          </div>
        ) : (
          <>
            <div className="capture-ai-severity-grid">
              <div className="capture-ai-severity-card success">
                <strong>Requirements</strong>
                <span>{missingCard[0]}</span>
              </div>

              <div className="capture-ai-severity-card warning">
                <strong>Warnings</strong>
                <span>{riskCard.length} item(s) need review.</span>
              </div>

              <div className="capture-ai-severity-card info">
                <strong>Metadata review</strong>
                <span>{sortedAiFlags.length} metadata flag(s).</span>
              </div>

              <div className="capture-ai-severity-card critical">
                <strong>Human review</strong>
                <span>Reviewer confirmation is still required.</span>
              </div>
            </div>

            <div className="capture-ai-section">
              <h3>Missing requirements</h3>
              <ul>
                {missingCard.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </div>

            <div className="capture-ai-section">
              <h3>Risk flags</h3>
              <ul>
                {riskCard.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
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

<div className="capture-ai-section">
  <h3>Suggested next actions</h3>

  <div className="capture-ai-action-groups">
    {groupedActions.high.length > 0 ? (
      <div className="capture-ai-action-group high">
        <strong>High priority</strong>
        <ul>
          {groupedActions.high.map((item, index) => (
            <li key={`high-${index}`}>{item}</li>
          ))}
        </ul>
      </div>
    ) : null}

    {groupedActions.recommended.length > 0 ? (
      <div className="capture-ai-action-group recommended">
        <strong>Recommended</strong>
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
            <div className="capture-ai-section">
              <h3>Legal limitation</h3>
              <p>
                {analysis?.legalDisclaimer ??
                  "AI assistance is advisory and does not determine factual truth, authorship, authenticity, or legal admissibility."}
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  </div>
) : null}
    </Card>
  );
}