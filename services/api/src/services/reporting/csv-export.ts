/**
 * Phase 8 (Enterprise Production Readiness) — SCOPE C.
 * Shared CSV-export helper for enterprise OPERATIONAL reports.
 *
 * This is the SINGLE sanctioned RFC-4180 CSV serializer for the org
 * operational-reports surface. It EXTRACTS the escape logic that was
 * previously inline in `routes/admin-audit.routes.ts` (`csvEscape` +
 * the `\r\n`-joined reply pattern) so the new org report endpoints do
 * NOT duplicate it.
 *
 * Hard rules:
 *   - No data logic lives here. This module only serializes rows that
 *     the caller already resolved from a REAL data source. It never
 *     fabricates values.
 *   - RFC-4180 quoting: a field is quoted iff it contains a comma,
 *     double-quote, CR, or LF; embedded double-quotes are doubled.
 *   - Rows are joined with CRLF (`\r\n`), matching the existing
 *     admin-audit export the frontend already consumes.
 *   - Values are coerced to strings deterministically: `null` /
 *     `undefined` render as the empty string, booleans as
 *     "true"/"false", everything else via `String(...)`. Objects
 *     should be pre-flattened by the caller (we JSON-stringify as a
 *     defensive fallback rather than emit "[object Object]").
 */

/**
 * RFC-4180-safe escape for a single already-stringified cell. Mirrors
 * the historical `csvEscape` in admin-audit.routes.ts exactly so the
 * output byte-shape is unchanged for consumers.
 */
export function csvEscape(value: string | null | undefined): string {
  const safe = value ?? "";
  if (/[",\n\r]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

/** Deterministic scalar → string coercion for a CSV cell. */
function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "";
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  }
  // Defensive: never emit "[object Object]"; a caller that hands us a
  // structured value gets a stable JSON rendering instead.
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/** A single output column: a stable header + an accessor over the row. */
export interface CsvColumn<Row> {
  /** Header cell written as the first CSV line. */
  header: string;
  /** Extract this column's raw value from a row. */
  value: (row: Row) => unknown;
}

/**
 * Serialize `rows` to an RFC-4180 CSV string using `columns`.
 *
 * The header line is always emitted (so an empty dataset still produces
 * a valid, honest single-line CSV of just the headers — never a
 * fabricated data row). Rows are joined with CRLF.
 */
export function toCsv<Row>(rows: readonly Row[], columns: readonly CsvColumn<Row>[]): string {
  const headerLine = columns.map((c) => csvEscape(c.header)).join(",");
  const dataLines = rows.map((row) =>
    columns.map((c) => csvEscape(stringifyCell(c.value(row)))).join(","),
  );
  return [headerLine, ...dataLines].join("\r\n");
}

/**
 * The shared `content-type` + `content-disposition` reply headers for a
 * CSV download. Matches the admin-audit export reply exactly.
 */
export function csvDownloadHeaders(filename: string): {
  "content-type": string;
  "content-disposition": string;
} {
  // Guard the filename against header-injection / quote-breaking. Only
  // a conservative filename charset is allowed; anything else falls
  // back to a safe default.
  const safeName = /^[A-Za-z0-9._-]+$/.test(filename) ? filename : "report.csv";
  return {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${safeName}"`,
  };
}
