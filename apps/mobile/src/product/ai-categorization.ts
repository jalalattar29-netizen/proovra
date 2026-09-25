/**
 * AI CATEGORIZATION (T-14 AiCategorizationPanel) — the metadata-only advisory
 * categorization on the evidence Review tab, which the web shows on every
 * plan (EvidenceReviewTab review tools).
 *
 *   GET  /v1/evidence/:id/ai-categorization      → { categorization }   (evidence.routes.ts:8517)
 *   POST /v1/evidence/:id/ai-categorization/run  → { categorization }   (:8592; 429 cost/burst guard,
 *                                                  403 AI_WORKSPACE_POLICY_DENIED)
 *
 * A record never categorized is answered with status DISABLED (:8559-8571),
 * and the web then offers no Run — it offers Run only when there is no record
 * or the last one FAILED. Ported as it is. Pure: no React, no fetch.
 */

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : []);

export interface AiRiskFlag {
  severity: string | null;
  title: string;
  detail: string | null;
}

export interface AiCategorization {
  status: string;
  summary: string | null;
  categories: string[];
  suggestedTags: string[];
  riskFlags: AiRiskFlag[];
  model: string | null;
  updatedAtIso: string | null;
}

export function buildAiCategorizationPath(evidenceId: string): string {
  return `/v1/evidence/${encodeURIComponent(evidenceId)}/ai-categorization`;
}
export function buildAiCategorizationRunPath(evidenceId: string): string {
  return `${buildAiCategorizationPath(evidenceId)}/run`;
}

export function parseAiCategorization(raw: unknown): AiCategorization | null {
  const c = obj(obj(raw).categorization);
  const status = str(c.status);
  if (!status) return null;
  return {
    status,
    summary: str(c.summary),
    categories: strings(c.categories),
    suggestedTags: strings(c.suggestedTags),
    riskFlags: (Array.isArray(c.riskFlags) ? c.riskFlags : [])
      .map(obj)
      .filter((f) => str(f.title))
      .map((f) => ({ severity: str(f.severity), title: f.title as string, detail: str(f.detail) })),
    model: str(c.model),
    updatedAtIso: str(c.updatedAt),
  };
}

/** The web offers Run when there is no record, or the last one failed. */
export function canRunCategorization(c: AiCategorization | null): boolean {
  return c === null || c.status === "FAILED";
}

export const AI_CATEGORIZATION_COPY = {
  title: "AI categorization",
  advisory:
    "AI categorization is advisory and metadata-only. It does not determine factual truth, authorship, integrity, or legal outcome.",
  loading: "Loading AI categorization...",
  unavailable: "AI categorization unavailable",
  failed: "AI categorization failed",
  disabled: "AI categorization is not active for this record.",
  run: "Run metadata-only AI categorization",
  running: "Running...",
  rerun: "Re-run AI advisory review",
  rerunning: "Refreshing…",
  summary: "Summary",
  noSummary: "No summary recorded.",
  categories: "Suggested categories",
  noCategories: "No categories recorded.",
  tags: "Suggested tags",
  noTags: "No suggested tags recorded.",
  risk: "Risk flags",
  noRisk: "No AI risk flags recorded.",
  model: "Model and timing",
  noModel: "Model not recorded",
  noTime: "No update timestamp",
} as const;
