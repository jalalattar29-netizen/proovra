/**
 * T-056 (stage C) — review metrics are per review and null when there is
 * nothing to divide by. A missing figure reads "No data", never 0 % or "0s".
 */
export const METRIC_NO_DATA = "No data";

export function formatMetricPct(v: number | null | undefined): string {
  return typeof v === "number" ? `${v}%` : METRIC_NO_DATA;
}

export function formatMetricDuration(ms: number | null | undefined): string {
  if (typeof ms !== "number" || ms <= 0) return METRIC_NO_DATA;
  const s = Math.round(ms / 1000);
  if (s < 120) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 120) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
}
