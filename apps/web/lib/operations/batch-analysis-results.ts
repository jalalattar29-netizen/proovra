/**
 * Free audit B6-F-41 — what a batch run actually produces.
 *
 * The batch analyser reads each record's METADATA only. `GET
 * /v1/batch-analysis/:id/results` now says so (`mode: "METADATA_ONLY"`) and
 * carries the two breakdowns the run can honestly produce: record type and
 * verification status. The legacy classification / safety / tag maps stay in
 * the body for compatibility and are always empty, so they are never drawn.
 *
 * An older API sends no `mode` and no breakdowns: the summary then says the
 * run recorded no breakdown rather than drawing empty charts.
 */

export const BATCH_ANALYSIS_MODE_NOTE =
  "This batch reads each record's metadata only (type, verification status, size). " +
  "It does not classify content and does not determine factual truth, authorship, " +
  "authenticity, or legal admissibility.";

export type BatchBreakdownRow = { label: string; count: number };

export type BatchResultsSummary = {
  metadataOnly: boolean;
  typeBreakdown: BatchBreakdownRow[];
  verificationBreakdown: BatchBreakdownRow[];
};

function rows(value: unknown): BatchBreakdownRow[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]))
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** Accepts `{ data: results }` or the bare results object (old or new shape). */
export function summarizeBatchResults(body: unknown): BatchResultsSummary {
  const root = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const data = root.data && typeof root.data === "object" ? (root.data as Record<string, unknown>) : root;
  return {
    // Every run is metadata-only; an older API simply did not say it.
    metadataOnly: data.mode === undefined || data.mode === "METADATA_ONLY",
    typeBreakdown: rows(data.typeBreakdown),
    verificationBreakdown: rows(data.verificationBreakdown),
  };
}
