/**
 * CAPTURE AI REVIEW (T-15) — the native port of
 * `apps/web/components/ai/CaptureAiAssistant.tsx`.
 *
 *   POST /v1/ai/capture/analyze-session
 *        { collectionPlan, planMode, useLocation, items[] } → { data: AiResult }
 *
 * METADATA ONLY: file name, MIME type, size, the plan mapping and the client
 * signals the device actually has — never a byte of the files. The pre-check
 * (coverage, signals, next actions) is computed locally from the same session
 * the plan already reads, so the card is useful before any AI runs; the AI
 * answer, when it arrives, replaces the local guidance. The result is never
 * persisted (the web says so, and so does this).
 *
 * The plan mode is the session's Intake structure choice (FLEXIBLE when unset).
 */
import type { CollectionPlanTemplate } from "./capture-plan";

export const CAPTURE_ANALYZE_SESSION_PATH = "/v1/ai/capture/analyze-session";

export interface ReviewItem {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  checklistStepId: string | null;
  role: string | null;
  sourceLabel: string | null;
  locationIncluded: boolean;
}

export interface AiFlag {
  severity: "info" | "warning" | "danger";
  title: string;
  detail: string;
}
export interface AiResult {
  status: string;
  summary: string;
  warnings: string[];
  suggestions: string[];
  flags: AiFlag[];
  legalDisclaimer: string | null;
}

export function buildAnalyzeSessionBody(
  plan: CollectionPlanTemplate,
  useLocation: boolean,
  items: ReviewItem[],
  planMode: "FLEXIBLE" | "CHECKLIST_REQUIRED" = "FLEXIBLE",
) {
  return {
    collectionPlan: {
      id: plan.id,
      name: plan.name,
      // The route requires a non-empty description; the plan name stands in when the catalogue has none.
      description: plan.description.trim() || plan.name,
      locationRequirement: plan.locationRequirement,
      steps: plan.steps.map((s) => ({
        id: s.id,
        title: s.title,
        description: s.description.trim() || s.title,
        purposeLabel: s.purposeLabel,
        required: s.required,
        acceptedKinds: s.acceptedKinds,
      })),
    },
    planMode,
    useLocation,
    items: items.slice(0, 100).map((i) => ({
      id: i.id,
      fileName: i.fileName.slice(0, 255) || i.id,
      mimeType: i.mimeType.slice(0, 128),
      sizeBytes: Math.max(0, Math.round(i.sizeBytes)),
      checklistStepId: i.checklistStepId,
      ...(i.role ? { role: i.role.slice(0, 120) } : {}),
      ...(i.sourceLabel ? { sourceLabel: i.sourceLabel.slice(0, 120) } : {}),
      clientSignals: { locationIncluded: i.locationIncluded },
    })),
  };
}

function o(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
}

export function parseAiResult(payload: unknown): AiResult {
  const d = o(o(payload)["data"]);
  if (!("status" in d)) {
    return { status: "disabled", summary: "AI assistance is currently unavailable.", warnings: [], suggestions: [], flags: [], legalDisclaimer: "AI assistance is currently unavailable." };
  }
  const flags: AiFlag[] = [];
  for (const raw of Array.isArray(d["flags"]) ? (d["flags"] as unknown[]) : []) {
    const f = o(raw);
    const sev = f["severity"];
    if (sev !== "info" && sev !== "warning" && sev !== "danger") continue;
    flags.push({ severity: sev, title: typeof f["title"] === "string" ? (f["title"] as string) : "", detail: typeof f["detail"] === "string" ? (f["detail"] as string) : "" });
  }
  const priority = { danger: 0, warning: 1, info: 2 } as const;
  flags.sort((a, b) => priority[a.severity] - priority[b.severity] || a.title.localeCompare(b.title));
  return {
    status: typeof d["status"] === "string" ? (d["status"] as string) : "error",
    summary: typeof d["summary"] === "string" ? (d["summary"] as string) : "",
    warnings: strings(d["warnings"]),
    suggestions: strings(d["suggestions"]),
    flags,
    legalDisclaimer: typeof d["legalDisclaimer"] === "string" ? (d["legalDisclaimer"] as string) : null,
  };
}

/** 404/502/503/504 or AI_DISABLED mean "unavailable here"; anything else is a failed load. */
export function analyzeFailure(err: unknown): { unavailable: boolean; message: string } {
  const e = o(err);
  const status = typeof e["statusCode"] === "number" ? (e["statusCode"] as number) : 0;
  const unavailable = e["code"] === "AI_DISABLED" || status === 404 || status === 502 || status === 503 || status === 504;
  return unavailable
    ? { unavailable: true, message: "AI assistant unavailable." }
    : { unavailable: false, message: "AI assistance could not be loaded. Continue capture normally." };
}

export interface ReviewModel {
  requiredTotal: number;
  requiredDone: number;
  requiredMissing: number;
  coveragePercent: number;
  signalIssues: number;
  locationItems: number;
  qaIssues: number;
  state: { tone: "idle" | "blocked" | "warning" | "ready"; label: string; detail: string };
  coverage: string[];
  risks: string[];
  groups: { high: string[]; recommended: string[]; info: string[] };
}

const HIGH = /zip|required|missing|confirm|verify|review|blocker|finalizing/i;
const RECOMMENDED = /location|collect|add|assign|map|label|metadata|timestamp|duplicate/i;

/** The web's pre-check + result cards, from the plan, the session and (when present) the AI answer. */
export function buildReviewModel(plan: CollectionPlanTemplate | null, useLocation: boolean, items: ReviewItem[], analysis: AiResult | null): ReviewModel {
  const required = plan?.steps.filter((s) => s.required) ?? [];
  const requiredDone = required.filter((s) => items.some((i) => i.checklistStepId === s.id)).length;
  const requiredMissing = Math.max(0, required.length - requiredDone);
  const coveragePercent = required.length > 0 ? Math.round((requiredDone / required.length) * 100) : 100;
  const locationRequiredUnmet = plan?.locationRequirement === "required" && !useLocation;
  // Native reports no duplicate / generic-MIME / old-timestamp signals, so only the location gate counts.
  const signalIssues = locationRequiredUnmet ? 1 : 0;
  const aiFlagIssues = (analysis?.flags ?? []).filter((f) => f.severity === "danger" || f.severity === "warning").length;
  const qaIssues = analysis ? requiredMissing + aiFlagIssues + analysis.warnings.length : requiredMissing + signalIssues;

  const state: ReviewModel["state"] = !plan
    ? { tone: "idle", label: "Plan context required", detail: "Select a collection plan so AI quality control can evaluate the workflow scope." }
    : items.length === 0
      ? { tone: "idle", label: "Awaiting evidence", detail: "Add source material before running workflow-aware AI quality control." }
      : requiredMissing > 0
        ? {
            tone: "blocked",
            label: "Coverage gap detected",
            detail: `${requiredMissing} required capture step${requiredMissing === 1 ? "" : "s"} still need mapped material before final review.`,
          }
        : qaIssues > 0
          ? { tone: "warning", label: "QA review recommended", detail: `${qaIssues} workflow signal${qaIssues === 1 ? "" : "s"} should be checked before Review & Sign.` }
          : { tone: "ready", label: "Ready for advisory QA", detail: "Required coverage is complete. Run AI quality control as a final metadata review gate." };

  let coverage: string[] = [];
  const aiMissing = (analysis?.flags ?? []).filter((f) => f.severity === "danger" && /missing|required/i.test(`${f.title} ${f.detail}`)).map((f) => f.title);
  if (aiMissing.length > 0) coverage = aiMissing;
  else if (required.length === 0) coverage = ["No required capture steps are defined for the selected plan."];
  else {
    const unmapped = required.filter((s) => !items.some((i) => i.checklistStepId === s.id)).map((s) => `Map evidence to required step: ${s.title}`);
    coverage = unmapped.length > 0 ? unmapped : ["Required capture coverage appears complete."];
  }

  let risks: string[];
  if (analysis?.warnings.length) risks = analysis.warnings;
  else {
    risks = locationRequiredUnmet ? ["Location metadata is required by the selected plan but not enabled."] : [];
    if (risks.length === 0) risks = ["No high-risk session issues were detected in the provided metadata."];
  }

  let actions: string[];
  if (analysis?.suggestions.length) actions = analysis.suggestions;
  else {
    actions = [];
    if (requiredMissing > 0) actions.push("Map or add the missing required evidence before Review & Sign.");
    if (locationRequiredUnmet) actions.push("Enable location metadata or resolve the required-location workflow blocker.");
    actions.push("Confirm reviewer judgement before finalizing; AI remains advisory quality control.");
  }
  const groups = {
    high: actions.filter((a) => HIGH.test(a)),
    recommended: actions.filter((a) => RECOMMENDED.test(a)),
    info: actions.filter((a) => !HIGH.test(a) && !RECOMMENDED.test(a)),
  };

  return {
    requiredTotal: required.length,
    requiredDone,
    requiredMissing,
    coveragePercent,
    signalIssues,
    locationItems: items.filter((i) => i.locationIncluded).length,
    qaIssues,
    state,
    coverage,
    risks,
    groups,
  };
}

export const CAPTURE_AI_COPY = {
  title: "AI Review",
  advisoryTitle: "AI advisory review",
  advisory:
    "Metadata-only quality control. It may surface missing mappings or client-side risk signals, but it does not determine authenticity, truth, authorship, legal admissibility, or final outcome.",
  gateTitle: "Advisory workflow gate",
  gateBody: "Run after mapping evidence. The review checks coverage, metadata signals, and suggested next actions before the human Review & Sign decision.",
  unavailable: "AI assistant unavailable. Continue capture and finish normally.",
  addEvidence: "Add evidence to run QA",
  reviewing: "Reviewing workflow…",
  reviewingBody: "Checking metadata, mappings, missing requirements, and risk flags.",
  sheetTitle: "Session readiness review",
  sheetIntro: "Advisory metadata-based review only. This assistant does not determine factual truth, authenticity, authorship, or legal admissibility.",
  aiUnavailable: "AI unavailable",
  humanGate: "Reviewer confirmation is still required.",
  legalTitle: "Legal limitation",
  legalFallback: "AI assistance is advisory and does not determine factual truth, authorship, authenticity, or legal admissibility.",
  notSaved:
    "AI advisory is not saved. This review runs against your session metadata only (uploaded contents are never sent). Output is not persisted on the evidence record, the report, or the verification package. Re-run to see fresh guidance after editing materials.",
} as const;

export function reviewButtonLabel(loading: boolean, canAnalyze: boolean, qaIssues: number): string {
  if (loading) return CAPTURE_AI_COPY.reviewing;
  if (!canAnalyze) return CAPTURE_AI_COPY.addEvidence;
  return qaIssues > 0 ? `Run AI QA review (${qaIssues})` : "Run AI QA review";
}
