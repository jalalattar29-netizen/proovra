"use client";

import { useMemo, useState } from "react";
import { Button, Card } from "../ui";
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

  return (
    <Card className="rounded-3xl border border-slate-700 bg-slate-950/95 p-0 shadow-xl shadow-slate-900/15">
      <button
        type="button"
        onClick={() => setOpen(!isOpen)}
        className="w-full rounded-[24px] border-b border-slate-800 bg-slate-900 px-4 py-4 text-left text-sm font-semibold text-slate-100"
      >
        <div className="flex items-center justify-between gap-4">
          <span>Capture AI assistant</span>
          <span className="text-slate-400">{isOpen ? "Hide" : "Show"}</span>
        </div>
      </button>

      {isOpen ? (
        <div className="space-y-4 px-4 py-4">
          <div className="rounded-3xl border border-slate-800 bg-slate-900/80 p-4 text-sm leading-6 text-slate-300">
            This assistant provides intake guidance only. It does not determine legal admissibility, authenticity, or the factual truth of an event.
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-3xl border border-slate-800 bg-slate-900/80 p-4">
              <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Plan</div>
              <div className="mt-2 text-sm font-semibold text-slate-100">
                {collectionPlan?.name ?? "No plan selected"}
              </div>
              <div className="mt-1 text-sm text-slate-400">{collectionPlan?.locationRequirement ?? "optional"} location</div>
            </div>
            <div className="rounded-3xl border border-slate-800 bg-slate-900/80 p-4">
              <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Session</div>
              <div className="mt-2 text-sm font-semibold text-slate-100">{summary.totalItems} item(s)</div>
              <div className="mt-1 text-sm text-slate-400">
                {summary.requiredStepsCompleted} / {summary.requiredStepsTotal} required steps complete
              </div>
            </div>
          </div>

          {error ? (
            <div className="rounded-3xl border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-200">
              {error}
            </div>
          ) : null}

          {unavailable ? (
            <div className="rounded-3xl border border-slate-700 bg-slate-900/80 p-3 text-sm text-slate-300">
              AI assistant unavailable. Continue capture and finish normally.
            </div>
          ) : null}

          <div className="grid gap-3">
            <Button
              onClick={handleAnalyze}
              disabled={!canAnalyze || loading || unavailable}
              variant="primary"
              className="rounded-full px-4 py-3 text-sm"
            >
              {loading ? "Analyzing…" : "Review session with AI"}
            </Button>

            <div className="grid gap-3">
              <div className="rounded-3xl border border-slate-800 bg-slate-900/80 p-4">
                <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Missing requirements</div>
                {missingCard.map((item, index) => (
                  <div key={index} className="mt-2 text-sm text-slate-200">
                    • {item}
                  </div>
                ))}
              </div>

              <div className="rounded-3xl border border-slate-800 bg-slate-900/80 p-4">
                <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Risk flags</div>
                {riskCard.map((item, index) => (
                  <div key={index} className="mt-2 text-sm text-slate-200">
                    • {item}
                  </div>
                ))}
              </div>
              {analysis?.flags?.length ? (
  <div className="rounded-3xl border border-slate-800 bg-slate-900/80 p-4">
    <div className="text-xs uppercase tracking-[0.18em] text-slate-400">
      Detailed AI flags
    </div>
    {analysis.flags.map((flag, index) => (
      <div key={`${flag.title}-${index}`} className="mt-2 text-sm text-slate-200">
        • [{flag.severity}] {flag.title}: {flag.detail}
      </div>
    ))}
  </div>
) : null}

              <div className="rounded-3xl border border-slate-800 bg-slate-900/80 p-4">
                <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Suggested next actions</div>
                {actionCard.map((item, index) => (
                  <div key={index} className="mt-2 text-sm text-slate-200">
                    • {item}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </Card>
  );
}
