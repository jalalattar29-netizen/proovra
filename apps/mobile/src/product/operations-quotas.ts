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

import { OPS_COPY_EN, type OpsCopy } from "./ops-copy";

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

/**
 * The web's summary cards (`quotaCards`), keyed by the `/v1/quotas` line —
 * the English entries of the localized `quotaCardLabel` (ops-copy.ts).
 */
export const QUOTA_CARD_LABEL: Readonly<Record<string, string>> = OPS_COPY_EN.quotaCardLabel;

/** The web's "Current Quotas" bar labels (`renderQuotaBar`), English entries of `quotaBarLabel`. */
export const QUOTA_BAR_LABEL: Readonly<Record<string, string>> = OPS_COPY_EN.quotaBarLabel;

/**
 * A quota line's label in the viewer's language. The four line keys are fixed
 * by the endpoint; an unknown key (never produced by parseQuotas) falls back to
 * the line's own label rather than to a raw key.
 */
export function quotaLabel(
  kind: "card" | "bar",
  key: string,
  fallback: string,
  t: OpsCopy = OPS_COPY_EN,
): string {
  const table: Readonly<Record<string, string>> = kind === "card" ? t.quotaCardLabel : t.quotaBarLabel;
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : fallback;
}

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
