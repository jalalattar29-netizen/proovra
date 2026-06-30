/**
 * Enterprise display helpers for the technical-metadata layer.
 *
 * Pure, dependency-free. Used by the PDF report, public verify page, and
 * the internal evidence card so that:
 *   * internal enum constants are NEVER shown to reviewers,
 *   * empty / null / zero / "unknown-only" rows are NEVER rendered,
 *   * status enums read as plain English.
 */

import type { MetadataStatus, ParseResult } from "./types.js";

// =============================================================================
// Human-readable enum labels
// =============================================================================

export function humanizeUploadSource(value: string | null | undefined): string {
  switch ((value ?? "").toUpperCase()) {
    case "WEB_APP":
      return "PROOVRA Web Application";
    case "INTAKE_LINK":
      return "Intake Link Submission";
    case "MOBILE_APP":
      return "Mobile Capture";
    case "API":
      return "API Submission";
    default:
      return "Unknown";
  }
}

export function humanizeCaptureMethod(value: string | null | undefined): string {
  switch ((value ?? "").toUpperCase()) {
    case "SECURE_CAPTURE":
      return "Secure Browser Capture";
    case "UPLOAD":
      return "Direct Upload";
    case "INTAKE_LINK":
      return "Intake Link Upload";
    case "MOBILE":
      return "Mobile Capture";
    case "API":
      return "API Upload";
    default:
      return "Unknown";
  }
}

/** Plain-English label for the parse/metadata status enums. */
export function metadataStatusLabel(
  status: MetadataStatus | ParseResult | string | null | undefined,
): string {
  switch ((status ?? "").toUpperCase()) {
    case "PRESENT":
      return "Embedded metadata available";
    case "PARTIAL":
      return "Embedded metadata partially available";
    case "MISSING":
      return "No embedded metadata detected";
    case "CONFLICT":
      return "Embedded metadata conflict detected";
    case "OK":
      return "Parsed";
    case "FAILED":
      return "Metadata parsing failed";
    case "UNSUPPORTED":
      return "Metadata extraction unsupported for this file type";
    case "UNKNOWN":
    default:
      return "Metadata status unavailable";
  }
}

/** Standard note shown when a file carried no embedded EXIF. */
export const EXIF_ABSENT_NOTE =
  "Embedded camera metadata was not present in the uploaded file. This is common for downloaded, exported, screenshotted, generated, or stripped files and does not affect the recorded integrity result.";

// =============================================================================
// Smart row filtering
// =============================================================================

const NON_MEANINGFUL_STRINGS = new Set([
  "",
  "UNKNOWN",
  "UNAVAILABLE",
  "N/A",
  "NOT AVAILABLE",
  "NULL",
  "NONE",
]);

/**
 * True when a value is worth rendering. False for null/undefined, empty
 * strings, the "unknown" family, empty arrays/objects. Numeric zero is
 * non-meaningful by default (file sizes / counts of 0 are noise) unless
 * `zeroIsMeaningful` is set for a field where 0 is a real value.
 */
export function isMeaningfulMetadataValue(
  value: unknown,
  opts?: { zeroIsMeaningful?: boolean },
): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") {
    return !NON_MEANINGFUL_STRINGS.has(value.trim().toUpperCase());
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return false;
    if (value === 0) return opts?.zeroIsMeaningful === true;
    return true;
  }
  if (typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

export type MetadataRowInput = {
  label: string;
  value: unknown;
  /** Pre-formatted display string; falls back to String(value). */
  display?: string | null;
  zeroIsMeaningful?: boolean;
};

export type MetadataRow = { label: string; value: string };

/**
 * Filter label/value pairs down to the meaningful rows only. Returns []
 * when nothing meaningful exists, so callers can hide the whole block.
 */
export function metadataRows(
  fields: ReadonlyArray<MetadataRowInput>,
): MetadataRow[] {
  const out: MetadataRow[] = [];
  for (const f of fields) {
    if (!isMeaningfulMetadataValue(f.value, { zeroIsMeaningful: f.zeroIsMeaningful })) {
      continue;
    }
    const display =
      f.display != null && f.display !== ""
        ? f.display
        : typeof f.value === "string"
          ? f.value
          : String(f.value);
    out.push({ label: f.label, value: display });
  }
  return out;
}
