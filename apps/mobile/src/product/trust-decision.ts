/**
 * TRUST DECISION (T-14 TrustDecisionSummary) — the worker's structured trust
 * decision, as the review workspace carries it
 * (`artifactVersions.trustDecision`, evidence.routes.ts). Rendered as given:
 * nothing here scores, re-weights or re-labels a signal.
 *
 * Pure: no React, no fetch.
 */

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export interface TrustSignal {
  key: string;
  label: string;
  status: string;
  points: number;
  maxPoints: number;
  summary: string | null;
  detail: string | null;
}

export interface TrustDecision {
  facts: Array<{ label: string; value: string }>;
  totals: Array<{ key: string; label: string; value: number | null }>;
  primaryReason: string | null;
  reviewerAction: string | null;
  summary: string | null;
  signals: TrustSignal[];
  /** The sum of maxPoints — the web's "Weighting: N points". */
  totalPoints: number;
}

const capitalise = (s: string) => (s.length === 0 ? s : s[0].toUpperCase() + s.slice(1));

/** Null when there is neither a verdict nor a signal (the web's "not yet available"). */
export function projectTrustDecision(rw: unknown): TrustDecision | null {
  const t = obj(obj(obj(rw).artifactVersions).trustDecision);
  const signals: TrustSignal[] = (Array.isArray(t.signals) ? t.signals : [])
    .map(obj)
    .filter((s) => str(s.key))
    .map((s) => ({
      key: str(s.key) as string,
      label: str(s.label) ?? (str(s.key) as string),
      status: str(s.status) ?? "unavailable",
      points: num(s.points) ?? 0,
      maxPoints: num(s.maxPoints) ?? 0,
      summary: str(s.summary),
      detail: str(s.detail),
    }));
  const verdict = str(t.verdictLabel);
  if (!verdict && signals.length === 0) return null;
  const facts: Array<{ label: string; value: string }> = [];
  if (verdict) facts.push({ label: "Verdict", value: verdict });
  if (str(t.scoreLabel)) facts.push({ label: "Score", value: str(t.scoreLabel) as string });
  if (str(t.confidenceLabel)) facts.push({ label: "Confidence", value: str(t.confidenceLabel) as string });
  if (str(t.relianceLevel)) facts.push({ label: "Reliance level", value: capitalise(str(t.relianceLevel) as string) });
  if (str(t.anchoringStatusLabel)) facts.push({ label: "Anchoring", value: str(t.anchoringStatusLabel) as string });
  return {
    facts,
    totals: [
      { key: "passed", label: "Passed signals", value: num(t.passedSignals) },
      { key: "degraded", label: "Degraded signals", value: num(t.degradedSignals) },
      { key: "failed", label: "Failed signals", value: num(t.failedSignals) },
    ],
    primaryReason: str(t.primaryReason),
    reviewerAction: str(t.reviewerAction),
    summary: str(t.summary),
    signals,
    totalPoints: signals.reduce((sum, s) => sum + s.maxPoints, 0),
  };
}

/** The web SIGNAL_STATES vocabulary; an unknown status is shown raw, neutrally. */
export function trustSignalState(status: string): { label: string; tone: "verified" | "pending" | "risk" | "neutral" } {
  switch (status) {
    case "passed":
      return { label: "Passed", tone: "verified" };
    case "partial":
    case "degraded":
      return { label: "Degraded", tone: "pending" };
    case "failed":
      return { label: "Failed", tone: "risk" };
    case "pending":
      return { label: "Pending", tone: "neutral" };
    case "missing":
    case "unavailable":
      return { label: "Unavailable", tone: "neutral" };
    case "not_applicable":
      return { label: "Not applicable", tone: "neutral" };
    default:
      return { label: status, tone: "neutral" };
  }
}

export const TRUST_POINTS_BOUNDARY =
  "Scores show each signal’s contribution to the 100-point technical assessment; they are not counts of separate checks.";
