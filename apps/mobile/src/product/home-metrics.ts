/**
 * CANONICAL NATIVE HOME METRICS (Master Program §9, H5) — pure projection.
 *
 * Home KPIs come from GET /v1/dashboard/trust-summary (buildTrustSummary), a
 * workspace-scoped, member-accessible endpoint. Every number is a real server
 * calculation — nothing is fabricated. This projects the envelope into a small
 * set of honest KPI tiles; the RN Home screen renders them responsively.
 *
 * Honesty (§4.7): endToEndReady is the deliverable-chain headline (NOT `signed`,
 * which can look green while the report worker has stalled); needingAttention is
 * surfaced as risk. We never invent a "verified" headline.
 */
import type { ProovraStatusTone } from "@proovra/ui";

export interface TrustSummary {
  totalEvidence?: number;
  signed?: number;
  endToEndReady?: number;
  needingAttention?: number;
  tsa?: { stamped?: number; pending?: number; failed?: number; none?: number };
  ots?: { anchored?: number; pending?: number; failed?: number; none?: number };
  publicVerify?: { published?: number; unpublished?: number; suspended?: number };
}

export interface Kpi {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly tone: ProovraStatusTone;
}

function n(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Parse the trust-summary envelope defensively. */
export function parseTrustSummary(data: unknown): TrustSummary {
  return (data && typeof data === "object" ? (data as TrustSummary) : {});
}

/**
 * The KPI tiles shown on Home, in priority order. Tones reflect meaning: ready is
 * positive (verified) only when >0; attention is risk only when >0; totals/counts
 * stay neutral/info. All values are real server counts.
 */
export function projectTrustKpis(summary: TrustSummary): Kpi[] {
  const total = n(summary.totalEvidence);
  const ready = n(summary.endToEndReady);
  const attention = n(summary.needingAttention);
  const timestamped = n(summary.tsa?.stamped);
  return [
    { key: "total", label: "Total evidence", value: total, tone: "neutral" },
    { key: "ready", label: "End-to-end ready", value: ready, tone: ready > 0 ? "verified" : "neutral" },
    { key: "attention", label: "Needs attention", value: attention, tone: attention > 0 ? "risk" : "neutral" },
    { key: "timestamped", label: "Timestamped", value: timestamped, tone: timestamped > 0 ? "info" : "neutral" },
  ];
}
