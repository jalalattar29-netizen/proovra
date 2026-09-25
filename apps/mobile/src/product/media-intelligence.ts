/**
 * MEDIA INTELLIGENCE — advisory signals (T-15) — the native port of
 * `apps/web/components/media-intelligence/MediaIntelligencePanel.tsx` (signal
 * list, acknowledge/dismiss, analyzer run lifecycle) and
 * `apps/web/lib/media-intelligence/types.ts`.
 *
 *   GET  /v1/evidence/:id/media-intelligence?teamId=      → { signals, catalog, latestRun }
 *   POST /v1/evidence/:id/media-intelligence/run { teamId, async: true }
 *        → 202 { queued, runId }  (queued:false = recorded but the queue refused it)
 *   POST /v1/media-intelligence/signals/:signalId/action { teamId, action }
 *
 * Tone is ADVISORY: bounded labels only, never a verdict word; the server's
 * `safeSummary` is the only prose about an observation. The run's terminal
 * state comes from `latestRun`, never inferred from the signal count.
 */
export function buildMediaIntelligencePath(evidenceId: string, teamId: string): string {
  return `/v1/evidence/${encodeURIComponent(evidenceId)}/media-intelligence?teamId=${encodeURIComponent(teamId)}`;
}
export function buildMediaIntelligenceRunPath(evidenceId: string): string {
  return `/v1/evidence/${encodeURIComponent(evidenceId)}/media-intelligence/run`;
}
export function buildSignalActionPath(signalId: string): string {
  return `/v1/media-intelligence/signals/${encodeURIComponent(signalId)}/action`;
}

export type SignalSeverity = "INFO" | "REVIEW_RECOMMENDED" | "ATTENTION";
export type SignalConfidence = "LOW" | "MEDIUM" | "HIGH";
export type SignalStatus = "PENDING" | "ACKNOWLEDGED" | "DISMISSED";
export type SignalAction = "ACKNOWLEDGED" | "DISMISSED";

export interface MediaSignal {
  id: string;
  signalType: string;
  severity: SignalSeverity;
  confidence: SignalConfidence;
  safeSummary: string;
  status: SignalStatus;
  createdAtUtc: string;
}
export interface CatalogEntry {
  signalType: string;
  displayLabel: string;
  implemented: boolean;
}
export interface LatestRun {
  runId: string;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "DISMISSED" | string;
  startedAtUtc: string | null;
  completedAtUtc: string | null;
  lastError: string | null;
}
export interface MediaIntelligenceView {
  signals: MediaSignal[];
  catalog: CatalogEntry[];
  latestRun: LatestRun | null;
}

function o(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function s(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
const SEVERITIES = new Set(["INFO", "REVIEW_RECOMMENDED", "ATTENTION"]);
const CONFIDENCES = new Set(["LOW", "MEDIUM", "HIGH"]);
const STATUSES = new Set(["PENDING", "ACKNOWLEDGED", "DISMISSED"]);

export function parseMediaIntelligence(payload: unknown): MediaIntelligenceView {
  const d = o(payload);
  const signals: MediaSignal[] = [];
  for (const raw of Array.isArray(d["signals"]) ? (d["signals"] as unknown[]) : []) {
    const x = o(raw);
    const id = s(x["id"]);
    const severity = s(x["severity"]);
    const confidence = s(x["confidence"]);
    const status = s(x["status"]);
    // Bounded vocabularies only: a row outside them is not rendered with an invented label.
    if (!id || !severity || !SEVERITIES.has(severity) || !confidence || !CONFIDENCES.has(confidence) || !status || !STATUSES.has(status)) continue;
    signals.push({
      id,
      signalType: s(x["signalType"]) ?? "",
      severity: severity as SignalSeverity,
      confidence: confidence as SignalConfidence,
      safeSummary: s(x["safeSummary"]) ?? "",
      status: status as SignalStatus,
      createdAtUtc: s(x["createdAtUtc"]) ?? "",
    });
  }
  const catalog: CatalogEntry[] = [];
  for (const raw of Array.isArray(d["catalog"]) ? (d["catalog"] as unknown[]) : []) {
    const c = o(raw);
    const signalType = s(c["signalType"]);
    if (!signalType) continue;
    catalog.push({ signalType, displayLabel: s(c["displayLabel"]) ?? signalType, implemented: c["implemented"] === true });
  }
  const lr = o(d["latestRun"]);
  const runId = s(lr["runId"]);
  return {
    signals,
    catalog,
    latestRun: runId
      ? {
          runId,
          status: s(lr["status"]) ?? "PENDING",
          startedAtUtc: s(lr["startedAtUtc"]),
          completedAtUtc: s(lr["completedAtUtc"]),
          lastError: s(lr["lastError"]),
        }
      : null,
  };
}

export function parseRunAccepted(payload: unknown): { runId: string | null; queued: boolean } {
  const d = o(payload);
  return { runId: s(d["runId"]), queued: d["queued"] === true };
}

export function severityLabel(v: SignalSeverity): string {
  return v === "ATTENTION" ? "Needs attention" : v === "REVIEW_RECOMMENDED" ? "Review recommended" : "Observation";
}
export function confidenceLabel(v: SignalConfidence): string {
  return v === "HIGH" ? "High confidence" : v === "MEDIUM" ? "Medium confidence" : "Low confidence";
}
export function signalStatusLabel(v: SignalStatus): string {
  return v === "ACKNOWLEDGED" ? "Acknowledged" : v === "DISMISSED" ? "Dismissed" : "Awaiting review";
}

/** ATTENTION first, then REVIEW_RECOMMENDED, then INFO; newest first within a severity. */
export function sortSignals(list: MediaSignal[]): MediaSignal[] {
  const rank: Record<SignalSeverity, number> = { ATTENTION: 0, REVIEW_RECOMMENDED: 1, INFO: 2 };
  return [...list].sort((a, b) => rank[a.severity] - rank[b.severity] || b.createdAtUtc.localeCompare(a.createdAtUtc));
}

/** Implemented categories with no observation on this record. */
export function missingCategories(view: MediaIntelligenceView): CatalogEntry[] {
  const present = new Set(view.signals.map((x) => x.signalType));
  return view.catalog.filter((c) => c.implemented && !present.has(c.signalType));
}

export type RunPhase = "idle" | "queued" | "running" | "completed" | "failed" | "stalled";
export const RUN_POLL_MS = 4_000;
export const RUN_STALL_AFTER_POLLS = 30;

export function completedLines(added: number | null, total: number): [string, string] {
  const first =
    added === 0 || added === null ? "No new observations were found." : `${added} new observation${added === 1 ? "" : "s"} ${added === 1 ? "was" : "were"} recorded.`;
  const second =
    total === 0
      ? "No observations are recorded for this evidence."
      : added === 0 || added === null
        ? `${total} existing observation${total === 1 ? "" : "s"} remain available for review.`
        : `${total} observation${total === 1 ? " is" : "s are"} now recorded in total.`;
  return [first, second];
}

export const MEDIA_INTELLIGENCE_COPY = {
  title: "Media intelligence",
  subtitle: "Deterministic metadata observations",
  run: "Run analyzer",
  queuedBtn: "Queued…",
  runningBtn: "Running…",
  advisory:
    "These are deterministic metadata observations. They are advisory workflow signals only: they do not establish authenticity, factual truth, or legal admissibility.",
  starting: "Starting the analyzer…",
  queued: "Analysis queued.",
  notQueued: "The analysis was recorded but could not be queued for processing. It stays pending until the queue is available.",
  running: "Analysis running…",
  complete: "Analysis complete",
  failedNoReason: "The analysis failed. No reason was recorded.",
  stalled: "The analysis has not reported a result yet. It may still be processing.",
  retry: "Retry analysis",
  refreshStatus: "Refresh status",
  ackFailed: "The observation could not be acknowledged. Nothing was changed.",
  dismissFailed: "The observation could not be dismissed. Nothing was changed.",
  loading: "Loading…",
  none: "No signals recorded yet. Run the analyzer to populate the known categories below.",
  help:
    "Acknowledge marks an observation as reviewed for workflow purposes; it does not verify the evidence. Dismiss marks it as not actionable; it does not delete the evidence or its audit history.",
  acknowledge: "Acknowledge",
  dismiss: "Dismiss",
  working: "Working…",
  missing: "Categories not yet computed for this evidence",
} as const;
