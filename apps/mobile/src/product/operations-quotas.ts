/**
 * OPERATIONS › QUOTAS — the parts of the web page
 * (`apps/web/app/(app)/operations/quotas/page.tsx`) that `./operations`
 * does not project: the web's card and bar labels, the cost overview, the
 * active services and the evidence-type breakdown.
 *
 * All of it is read from `GET /v1/usage-stats` → `{ data }`
 * (enterprise.routes.ts getRealUsageStats):
 *   costBreakdown { totalCost, thisMonth, averagePerAnalysis }
 *   topEvidenceTypes: Record<type, count>
 *   activeApiKeys, activeBatches
 *
 * Pure: no React, no react-native, no fetch.
 */

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

export const QUOTAS_COPY = {
  eyebrow: "Usage & Quotas",
  title: "Monitor platform usage and current limits.",
  subtitle:
    "Review analysis activity, cost metrics, quota consumption, and active service usage from one dashboard.",
  currentQuotas: "Current Quotas",
  costOverview: "Cost Overview",
  activeServices: "Active Services",
  evidenceTypes: "Evidence Types Analyzed",
} as const;

/** The web's summary cards (`quotaCards`), keyed by the `/v1/quotas` line. */
export const QUOTA_CARD_LABEL: Readonly<Record<string, string>> = {
  analyses: "Analysis Calls",
  batchJobs: "Batch Jobs",
  apiKeys: "API Keys",
  teamMembers: "Team Members",
};

/** The web's "Current Quotas" bar labels (`renderQuotaBar`). */
export const QUOTA_BAR_LABEL: Readonly<Record<string, string>> = {
  analyses: "Analysis API Calls",
  batchJobs: "Batch Jobs",
  apiKeys: "API Keys",
  teamMembers: "Team Members",
};

export interface UsageExtras {
  totalCost: number | null;
  thisMonthCost: number | null;
  activeApiKeys: number | null;
  activeBatches: number | null;
  /** In the server's order; empty when it sent none. */
  evidenceTypes: Array<{ type: string; count: number }>;
}

export function parseUsageExtras(payload: unknown): UsageExtras {
  const data = obj(obj(payload).data);
  const cost = obj(data.costBreakdown);
  return {
    totalCost: num(cost.totalCost),
    thisMonthCost: num(cost.thisMonth),
    activeApiKeys: num(data.activeApiKeys),
    activeBatches: num(data.activeBatches),
    evidenceTypes: Object.entries(obj(data.topEvidenceTypes))
      .map(([type, count]) => ({ type, count: num(count) }))
      .filter((e): e is { type: string; count: number } => e.count !== null),
  };
}

/** `$12.34` — the web's `toFixed(2)` currency figure. */
export function formatCost(value: number | null, digits = 2): string {
  return value === null ? "—" : `$${value.toFixed(digits)}`;
}
