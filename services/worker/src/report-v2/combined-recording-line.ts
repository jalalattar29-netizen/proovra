/**
 * COMBINE (2026-10-29) — the one sentence every report surface prints for the
 * DERIVED combined review video. Pure (no storage, no database).
 */
import type { ReportCombinedRecording } from "./types.js";

/** The one line every report surface prints for it (clearly derived). */
export function combinedRecordingReportLine(c: ReportCombinedRecording, formatUtc: (iso: string) => string): string {
  const gapSeconds = Math.round(c.gapTotalMs / 1000);
  const gaps =
    c.gapCount === 0
      ? "no gaps"
      : `gaps ${c.gapCount} (total ${gapSeconds} s${c.gapDurationUnknown ? " plus gaps of unknown length" : ""})`;
  return [
    `Combined review video (derived, not an original): sha256 ${c.derivedSha256 ?? "not recorded"}`,
    `${c.sourceSegmentCount} source segment${c.sourceSegmentCount === 1 ? "" : "s"}`,
    c.completeness,
    gaps,
    c.generatedAtUtc ? `generated ${formatUtc(c.generatedAtUtc)}` : null,
  ]
    .filter(Boolean)
    .join(", ");
}
