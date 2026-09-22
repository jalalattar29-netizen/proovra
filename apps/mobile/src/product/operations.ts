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
