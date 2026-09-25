/**
 * OPERATIONS — pure projections for the two self-service operations consoles.
 *
 * Ports `apps/web/app/(app)/operations/quotas` (`GET /v1/quotas` +
 * `GET /v1/usage-stats`) and `apps/web/app/(app)/operations/batch-analysis`
 * (`GET /v1/batch-analysis`).
 *
 * ===========================================================================
 * WHY THESE TWO, WHEN EVERY OTHER /operations ROUTE IS EXCLUDED
 * ===========================================================================
 * The derived manifest classifies them NATIVE_REQUIRED while their URL
 * siblings are excluded, which looked like a registry entry that had missed
 * the `OPS` domain its neighbours carry. It is not. `routeRegistry.ts` states
 * the intent in the entries themselves:
 *
 *   dashboard.quotas          "Gate stays PERSONAL_WORKSPACE/DASHBOARD_VIEW:
 *                              this is a self-service quota view, NOT a
 *                              platform-admin tool."
 *   dashboard.batch_analysis  "Gate stays PERSONAL_WORKSPACE — self-service
 *                              view."
 *
 * Both moved to the `/operations/*` URL in Phase R7.5 (from `/dashboard/*`,
 * which now 308s). They share a URL PREFIX with the OPS console; they are not
 * members of it — their `domain` is PERSONAL_WORKSPACE. The derivation reads
 * the registry correctly and there is no registry omission to correct.
 *
 * They are two DIFFERENT consoles over different data, not an alias pair, so
 * both are preserved. Neither is reachable from any nav surface on the web
 * either (`commandPaletteVisible`/`allToolsVisible`/`sidebarEligible` are all
 * false) — they are reached contextually, and native matches that.
 *
 * Pure: no React, no react-native, no fetch.
 */
import type { ProovraStatusTone } from "@proovra/ui";

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

// ---------------------------------------------------------------------------
// Quotas
// ---------------------------------------------------------------------------

export const QUOTA_PATH = "/v1/quotas";
export const USAGE_STATS_PATH = "/v1/usage-stats";
export const BATCH_ANALYSIS_PATH = "/v1/batch-analysis";

export interface QuotaLine {
  key: string;
  label: string;
  used: number;
  limit: number;
  remaining: number;
  /** 0–100, clamped. `null` when the limit is not a positive number. */
  percent: number | null;
  resetIso: string | null;
}

/**
 * The four quota lines the web renders, in the web's order.
 *
 * The labels are the web's. They are UI copy for a fixed set of counters the
 * endpoint returns under fixed keys — not content this module invents, and not
 * a list it may extend.
 */
const QUOTA_LINES: ReadonlyArray<{ key: string; label: string }> = [
  { key: "analyses", label: "Analysis calls" },
  { key: "batchJobs", label: "Batch jobs" },
  { key: "apiKeys", label: "API keys" },
  { key: "teamMembers", label: "Team members" },
];

/**
 * A percentage that never lies about a missing denominator.
 *
 * `used / 0` is Infinity and `0 / 0` is NaN; both render as a filled or empty
 * bar that states a utilisation nobody measured. An unusable denominator
 * returns null and the surface shows the raw counts instead.
 */
export function quotaPercent(used: number, limit: number): number | null {
  if (!Number.isFinite(limit) || limit <= 0) return null;
  if (!Number.isFinite(used) || used < 0) return null;
  return Math.min(100, Math.round((used / limit) * 100));
}

/** The web's three-band treatment: ≥90 critical, ≥70 warning, else normal. */
export function quotaTone(percent: number | null): ProovraStatusTone {
  if (percent === null) return "neutral";
  if (percent >= 90) return "risk";
  if (percent >= 70) return "pending";
  return "verified";
}

export function parseQuotas(payload: unknown): QuotaLine[] {
  const data = obj(obj(payload).data);

  return QUOTA_LINES.map(({ key, label }) => {
    const line = obj(data[key]);
    const used = num(line.used) ?? 0;
    const limit = num(line.limit) ?? 0;
    return {
      key,
      label,
      used,
      limit,
      remaining: num(line.remaining) ?? Math.max(0, limit - used),
      percent: quotaPercent(used, limit),
      resetIso: str(line.resetDate),
    };
  }).filter((line) => {
    // A counter the endpoint did not return at all is not a quota of zero.
    const raw = obj(obj(obj(payload).data)[line.key]);
    return Object.keys(raw).length > 0;
  });
}

export interface UsageStats {
  today: number;
  thisWeek: number;
  thisMonth: number;
  averageCostPerAnalysis: number | null;
  totalCost: number | null;
}

export function parseUsageStats(payload: unknown): UsageStats | null {
  const data = obj(obj(payload).data);
  const daily = obj(data.dailyAnalyses);
  const cost = obj(data.costBreakdown);

  if (Object.keys(daily).length === 0) return null;

  return {
    today: num(daily.today) ?? 0,
    thisWeek: num(daily.thisWeek) ?? 0,
    thisMonth: num(daily.thisMonth) ?? 0,
    averageCostPerAnalysis: num(cost.averagePerAnalysis),
    totalCost: num(cost.totalCost),
  };
}

// ---------------------------------------------------------------------------
// Batch analysis
// ---------------------------------------------------------------------------

export interface BatchJob {
  id: string;
  name: string;
  status: string;
  totalItems: number;
  processedItems: number;
  failedItems: number;
  /** 0–100, clamped; null when the job declares no items. */
  progress: number | null;
  createdAtIso: string | null;
  completedAtIso: string | null;
}

/** The statuses `BatchStatus` defines, lower-cased as the service emits them. */
const BATCH_TONES: Readonly<Record<string, ProovraStatusTone>> = {
  pending: "neutral",
  processing: "pending",
  completed: "verified",
  failed: "risk",
  cancelled: "neutral",
};

export function batchStatusTone(status: string): ProovraStatusTone {
  return BATCH_TONES[status.toLowerCase()] ?? "neutral";
}

export function batchStatusLabel(status: string): string {
  const s = status.toLowerCase();
  return s.length === 0 ? "Unknown" : s.charAt(0).toUpperCase() + s.slice(1);
}

export function parseBatchJobs(payload: unknown): BatchJob[] {
  return rows(obj(payload).data)
    .map((raw) => {
      const j = obj(raw);
      const id = str(j.id);
      if (!id) return null;

      const total = num(j.totalItems) ?? 0;
      const processed = num(j.processedItems) ?? 0;
      const failed = num(j.failedItems) ?? 0;

      // The endpoint computes `progress` itself, but as
      // `(processed + failed) / totalItems` with no guard — a job with zero
      // items yields NaN, which renders as a progress bar of unknown width.
      const reported = num(j.progress);
      const progress =
        total > 0
          ? Math.min(100, Math.max(0, Math.round(reported ?? ((processed + failed) / total) * 100)))
          : null;

      return {
        id,
        name: str(j.name) ?? id,
        status: str(j.status) ?? "pending",
        totalItems: total,
        processedItems: processed,
        failedItems: failed,
        progress,
        createdAtIso: str(j.createdAt),
        completedAtIso: str(j.completedAt),
      };
    })
    .filter((j): j is BatchJob => j !== null);
}

/** Newest first, which is the order a job list is read in. */
export function sortBatchJobs(jobs: BatchJob[]): BatchJob[] {
  return [...jobs].sort((a, b) => {
    const at = a.createdAtIso ? Date.parse(a.createdAtIso) : 0;
    const bt = b.createdAtIso ? Date.parse(b.createdAtIso) : 0;
    if (Number.isNaN(at) || Number.isNaN(bt)) return 0;
    return bt - at;
  });
}

// ---------------------------------------------------------------------------
// Batch analysis — the job lifecycle
// ---------------------------------------------------------------------------
//
// The whole lifecycle, as the endpoints define it:
//
//   POST /v1/batch-analysis            create   {evidenceIds[], name, description?}
//   POST /v1/batch-analysis/:id/process         start it
//   GET  /v1/batch-analysis/:id                 one job
//   POST /v1/batch-analysis/:id/cancel          stop a running one
//   GET  /v1/batch-analysis/:id/export          text/csv
//
// Creation does not start the job — the create response says so itself:
// "Batch job created. Call /batch-analysis/{id}/process to start." The web
// page chains the two calls, and so does Native, because a job sitting at
// `pending` that the user believes is running is a worse outcome than either.

export function buildBatchJobPath(id: string): string {
  return `${BATCH_ANALYSIS_PATH}/${encodeURIComponent(id)}`;
}
export function buildBatchProcessPath(id: string): string {
  return `${buildBatchJobPath(id)}/process`;
}
export function buildBatchCancelPath(id: string): string {
  return `${buildBatchJobPath(id)}/cancel`;
}
export function buildBatchExportPath(id: string): string {
  return `${buildBatchJobPath(id)}/export`;
}

/**
 * What the create endpoint requires, checked before the request rather than
 * after: an empty name and an empty selection are both VALIDATION_ERROR, and a
 * round trip to be told so is a round trip the phone did not need.
 */
export function validateBatchDraft(name: string, evidenceIds: string[]): string | null {
  if (name.trim().length === 0) return "Give this batch a name.";
  if (evidenceIds.length === 0) return "Choose at least one evidence record.";
  return null;
}

export function buildBatchCreateBody(
  name: string,
  evidenceIds: string[],
  description?: string | null,
) {
  const d = (description ?? "").trim();
  return {
    name: name.trim(),
    evidenceIds,
    // Absent, not empty: the route takes `description?`, and sending "" would
    // record a description the user did not write.
    ...(d.length > 0 ? { description: d } : {}),
  };
}

/**
 * The records a batch may actually contain.
 *
 * `POST /v1/batch-analysis` accepts only the caller's OWN undeleted evidence
 * (`ownerUserId: userId` — anything else is 404 EVIDENCE_NOT_FOUND) from ONE
 * workspace. `GET /v1/evidence?scope=active` also lists team-mates' records
 * and every workspace the caller belongs to, so the picker must narrow it:
 * the workspace by the request's `teamId`, the owner here, from the
 * `ownerUserId` every list item carries. No known caller → nothing offered.
 * Returns the list envelope narrowed, for `parseEvidencePickerRows`.
 */
export function selectBatchCandidateItems(
  payload: unknown,
  ownerUserId: string | null,
): { items: unknown[] } {
  if (!ownerUserId) return { items: [] };
  return { items: rows(obj(payload).items).filter((raw) => obj(raw).ownerUserId === ownerUserId) };
}

/** The id the create response carries, or null if the server shaped it otherwise. */
export function readCreatedBatchId(payload: unknown): string | null {
  return str(obj(obj(payload).data).id);
}

/**
 * Whether cancelling this job would actually do anything.
 *
 * BOTH non-terminal states, now that the server cancels both (BD-1).
 *
 * `cancelJob` used to act only on PROCESSING while returning success for
 * PENDING, so a surface that offered Cancel on a pending job reported
 * something untrue and the job ran anyway. Native withheld the control rather
 * than say that. With the service fixed, withholding it would BE the untruth:
 * a pending job is the easiest one to stop, and the one an operator is most
 * likely to want stopped.
 *
 * A terminal job is not offered it, and the route answers 409 if one is tried.
 */
export function canCancelBatch(job: BatchJob): boolean {
  const status = job.status.toLowerCase();
  return status === "processing" || status === "pending";
}

/**
 * The export is offered on a COMPLETED job only — the web's exact condition
 * (`job.status === "completed" && <Export CSV>`, batch-analysis/page.tsx).
 * A failed or cancelled job is not offered it.
 *
 * (The `/results` read this used to share a predicate with is gone — see
 * BATCH_ANALYSIS_MODE_NOTE.)
 */
export function canExportBatch(job: BatchJob): boolean {
  return job.status.toLowerCase() === "completed";
}

/**
 * The list refresh cadence while a job is still running: the web's
 * `window.setInterval(loadJobs, 4000)` (batch-analysis/page.tsx).
 */
export const BATCH_POLL_INTERVAL_MS = 4000;

/**
 * Whether any job is still running — the web's own "running" definition,
 * `["pending", "processing"].includes(job.status)` (its `pendingJobs` count
 * and its Cancel condition). Polling runs only while this holds: a list of
 * terminal jobs cannot change without an action, which re-reads it itself.
 */
export function hasRunningBatch(jobs: readonly BatchJob[]): boolean {
  return jobs.some((j) => {
    const s = j.status.toLowerCase();
    return s === "pending" || s === "processing";
  });
}

/**
 * THE AGGREGATE IS NOT READ, AND THAT IS THE FINDING.
 *
 * `GET /v1/batch-analysis/:id/results` is dispositioned SUPERSEDED_REMOVE.
 * Its triage states that it aggregates "classification/moderation/tag fields
 * that processBatch never writes", and the service confirms it: a completed
 * item carries only { status, analysisMode: "metadata_only_legacy_batch",
 * summary, evidence, warnings }.
 *
 * A card of classifications and an average confidence built from that endpoint
 * would be an empty list and a zero presented as an analysis of the operator's
 * evidence. An absent panel is honest; that would not be.
 *
 * What the batch DOES produce is stated instead, in the service's own words.
 */
export const BATCH_ANALYSIS_MODE_NOTE =
  "This batch reads each record's metadata only. It does not determine factual truth, " +
  "authorship, authenticity, or legal admissibility.";

/** The filename the export route sets in its own Content-Disposition. */
export function batchExportFilename(id: string): string {
  return `batch-${id.replace(/[^A-Za-z0-9_-]/g, "_")}.csv`;
}
