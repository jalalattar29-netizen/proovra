/**
 * AUD-019 — the LOCAL OCR capability a worker actually has, as the worker
 * reports it on its heartbeat (`worker_telemetry_snapshots.metadata_json.localOcr`).
 *
 * The API cannot see the worker's filesystem, so it must never state a
 * constant about the OCR engine. It reads the newest report a worker published
 * and projects it here; with no fresh report it says "not reported", never
 * "enabled" and never "not enabled".
 */

/** What one worker probed: `tesseract --version` + `tesseract --list-langs`. */
export type LocalOcrCapabilityReport = {
  engine: "tesseract";
  available: boolean;
  version: string | null;
  installedLanguages: string[];
  /** The "+"-joined request (UC4_OCR_LANG or the default). */
  requested: string | null;
  /** requested ∩ installed — what OCR runs with; null when nothing can run. */
  effective: string | null;
  missing: string[];
  observedAtUtc: string;
};

export type LocalOcrCapabilityView =
  | {
      state: "AVAILABLE";
      version: string | null;
      effectiveLanguages: string;
      missingLanguages: string[];
      reportedAtUtc: string;
    }
  | { state: "ENGINE_UNAVAILABLE"; reportedAtUtc: string }
  | { state: "LANGUAGE_UNAVAILABLE"; version: string | null; missingLanguages: string[]; reportedAtUtc: string }
  | { state: "NOT_REPORTED" };

const LANG_RE = /^[A-Za-z0-9_]{2,32}$/;
const langList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && LANG_RE.test(x)).slice(0, 64) : [];
const strOrNull = (v: unknown, max = 64): string | null =>
  typeof v === "string" && v.length > 0 ? v.slice(0, max) : null;

/** PURE: read a report out of an untyped heartbeat metadata document. Null when absent/malformed. */
export function parseLocalOcrCapabilityReport(metadata: unknown): LocalOcrCapabilityReport | null {
  const m = metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>).localOcr : null;
  if (!m || typeof m !== "object") return null;
  const r = m as Record<string, unknown>;
  if (r.engine !== "tesseract" || typeof r.available !== "boolean") return null;
  const observedAtUtc = strOrNull(r.observedAtUtc, 40);
  if (!observedAtUtc || Number.isNaN(Date.parse(observedAtUtc))) return null;
  return {
    engine: "tesseract",
    available: r.available,
    version: strOrNull(r.version),
    installedLanguages: langList(r.installedLanguages),
    requested: strOrNull(r.requested, 200),
    effective: strOrNull(r.effective, 200),
    missing: langList(r.missing),
    observedAtUtc,
  };
}

/**
 * PURE: the view a surface may show. A report older than `maxAgeMs` is NOT
 * the current truth (the worker may have been redeployed without the engine)
 * and reads as NOT_REPORTED.
 */
export function projectLocalOcrCapability(
  report: LocalOcrCapabilityReport | null,
  nowMs: number,
  maxAgeMs: number,
): LocalOcrCapabilityView {
  if (!report) return { state: "NOT_REPORTED" };
  const age = nowMs - Date.parse(report.observedAtUtc);
  if (!(age >= 0 && age <= maxAgeMs)) return { state: "NOT_REPORTED" };
  if (!report.available) return { state: "ENGINE_UNAVAILABLE", reportedAtUtc: report.observedAtUtc };
  if (!report.effective) {
    return {
      state: "LANGUAGE_UNAVAILABLE",
      version: report.version,
      missingLanguages: report.missing,
      reportedAtUtc: report.observedAtUtc,
    };
  }
  return {
    state: "AVAILABLE",
    version: report.version,
    effectiveLanguages: report.effective,
    missingLanguages: report.missing,
    reportedAtUtc: report.observedAtUtc,
  };
}
