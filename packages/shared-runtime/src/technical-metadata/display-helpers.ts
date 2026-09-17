/**
 * Enterprise display helpers for the technical-metadata layer.
 *
 * Pure, dependency-free. Used by the PDF report, public verify page, and
 * the internal evidence card so that:
 *   * internal enum constants are NEVER shown to reviewers,
 *   * empty / null / zero / "unknown-only" rows are NEVER rendered,
 *   * status enums read as plain English.
 */

import { resolveEvidenceAcquisition } from "@proovra/shared";

import type { MetadataStatus, ParseResult } from "./types.js";

// =============================================================================
// Human-readable enum labels
// =============================================================================

/**
 * UC-0 — the acquisition CHANNEL label for reviewer surfaces ("Capture
 * method", "Submitted through"), derived ONLY from the acquisition authority.
 *
 * It used to read `captureEnvironment.uploadSource` (inverted for the mobile
 * and citizen routes) and then the `captureMethod` structure enum, and fell
 * back to "PROOVRA Web Upload" for anything it did not recognise — a guess
 * rendered as a fact. A record whose acquisition was never recorded now reads
 * "Not recorded". `isIntake` is the reliable intake-session join, which is
 * the same proof the D9 backfill uses.
 */
export function captureMethodDisplayLabel(input: {
  acquisitionMode: string | null | undefined;
  isIntake?: boolean | null;
}): string {
  const a = resolveEvidenceAcquisition({ acquisitionMode: input.acquisitionMode });
  if (input.isIntake === true || a.mode === "SECURE_INTAKE_LINK") {
    return "Secure Intake Link";
  }
  switch (a.mode) {
    case "PROOVRA_WEB_UPLOAD":
      return "PROOVRA Web Upload";
    case "PROOVRA_MOBILE_APP":
      return "PROOVRA Mobile App";
    default:
      return "Not recorded";
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

// =============================================================================
// Evidence-part role + reviewer mapping labels
// =============================================================================

/**
 * Reviewer-facing role label for one evidence part. Maps the internal
 * `private_role` / artifact-role token to a short badge label. The raw enum
 * (PRIMARY_EVIDENCE, SUPPORTING_EVIDENCE, ATTACHMENT, …) is never surfaced.
 *
 *   Primary   — the lead review item / primary evidence set member.
 *   Supporting — corroborating media/files.
 *   Context   — attachments, logs, and other contextual material.
 */
export function evidencePartRoleLabel(
  role: string | null | undefined,
): "Primary" | "Supporting" | "Context" {
  switch ((role ?? "").toUpperCase()) {
    case "PRIMARY":
    case "PRIMARY_EVIDENCE":
    case "PRIMARY_MEDIA":
    case "LEAD":
    case "LEAD_ITEM":
      return "Primary";
    case "ATTACHMENT":
    case "CONTEXT":
    case "LOG":
    case "SUPPLEMENTARY":
      return "Context";
    case "SUPPORTING":
    case "SUPPORTING_EVIDENCE":
    default:
      return "Supporting";
  }
}

/**
 * Longer reviewer-facing "mapping label" describing how a part is represented
 * in review, derived from its role + media kind. Mirrors the PDF report's
 * per-part representation wording. Never surfaces raw enums.
 */
export function evidencePartMappingLabel(input: {
  role?: string | null;
  mediaKind?: string | null;
  mimeType?: string | null;
}): string {
  const role = evidencePartRoleLabel(input.role);
  const kind = (input.mediaKind ?? "").toUpperCase();
  const mime = (input.mimeType ?? "").toLowerCase();
  const isVideo = kind === "VIDEO" || mime.startsWith("video/");
  const isImage = kind === "IMAGE" || mime.startsWith("image/");
  const isAudio = kind === "AUDIO" || mime.startsWith("audio/");

  if (role === "Primary") {
    if (isVideo) return "Primary video reviewer representation";
    if (isImage) return "Primary image reviewer representation";
    if (isAudio) return "Primary audio reviewer representation";
    return "Primary reviewer representation";
  }
  if (role === "Supporting") {
    if (isImage) return "Supporting image reviewer preview";
    if (isVideo) return "Supporting video reviewer preview";
    if (isAudio) return "Witness/media statement";
    return "Supporting file/log";
  }
  // Context
  return "Supporting file/log";
}
