import { getReviewerEvidenceTypeLabel } from "@proovra/shared";
import type { AppTone } from "../../../../components/app-primitives";
import type {
  DetailWorkspaceState,
  EvidenceListItem,
  EvidenceListScope,
  EvidenceRecord,
} from "./evidence-library-types";

export function detectEvidenceKind(
  mimeType: string | null | undefined
): "image" | "video" | "audio" | "document" | "other" {
  const mime = (mimeType ?? "").trim().toLowerCase();

  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (
    mime === "application/pdf" ||
    mime.startsWith("text/") ||
    mime.includes("json") ||
    mime.includes("xml")
  ) {
    return "document";
  }

  return "other";
}

export function getEvidenceScope(item: Pick<EvidenceListItem, "archivedAt" | "deletedAt">): EvidenceListScope | "active" {
  if (item.deletedAt) return "deleted";
  if (item.archivedAt) return "archived";
  return "active";
}

/**
 * Phase EVIDENCE-LIBRARY-NAMES — generic-title sentinels.
 *
 * The backend's `mapEvidenceListItem` (evidence.routes.ts) routes
 * every list item's title through `resolveEvidenceTitle`, which
 * substitutes the literal "Digital Evidence Record" for null/empty
 * titles. That backend default is reasonable for surfaces that
 * cannot run a fallback cascade — but on the Evidence Library /
 * preview / row / duplicate / relationship surfaces it MASKS the
 * empty state from this client cascade and causes every untitled
 * record to render the same generic line.
 *
 * `GENERIC_TITLE_SENTINELS` lists every legacy backend fallback we
 * treat as "no title set" so the UI cascade can fall through to
 * the file name / type label / short id.
 */
const GENERIC_TITLE_SENTINELS = new Set<string>([
  "Digital Evidence Record",
  "Evidence record",
  "Untitled evidence record",
]);

function isGenericFallbackTitle(value: string | null | undefined): boolean {
  const trimmed = value?.trim();
  return !trimmed || GENERIC_TITLE_SENTINELS.has(trimmed);
}

/**
 * Build a "N files" label for multipart packages when no
 * user-provided label exists. Falls back to the canonical type
 * label + count when the type helper does not already include the
 * count. Returns null for single-item records.
 */
function buildMultipartPackageLabel(item: {
  itemCount: number | null | undefined;
  type: EvidenceListItem["type"] | EvidenceRecord["type"] | string | null | undefined;
  mimeType: string | null | undefined;
}): string | null {
  const count = item.itemCount ?? 0;
  if (count <= 1) return null;
  const typeLabel = getReviewerEvidenceTypeLabel({
    itemCount: count,
    evidenceType: item.type,
    mimeType: item.mimeType,
  });
  if (/\d/.test(typeLabel)) return typeLabel;
  return `${typeLabel} · ${count} files`;
}

/**
 * Phase EVIDENCE-LIBRARY-NAMES — shared title cascade.
 *
 * Display priority (FIX 1 of "targeted enterprise fixes"):
 *   1. user-provided evidence title (if NOT a generic sentinel)
 *   2. displayFileName  — e.g. "Witness Statement.pdf"
 *   3. originalFileName — e.g. "v1 (31).pdf"
 *   4. multipart package label — e.g. "Document · 5 files"
 *   5. type + short record id  — e.g. "Photo · 7c4f9d"
 *   6. "Evidence record {shortId}" — last resort
 *
 * Used on every Evidence Library + Evidence Detail surface so the
 * cascade can't drift between row / preview / duplicate /
 * relationship consumers.
 */
/**
 * Structural input shape for the title cascade. Accepts either the
 * Evidence Library list item, the Evidence Detail record, or any
 * surface that exposes the same nullable filename fields (e.g.
 * Case Detail matter-workspace evidence rows — Phase
 * CASES-EVIDENCE-NAMES). The function is already null-safe
 * internally (every field is read through optional chaining), so
 * widening the contract here does not change runtime behaviour for
 * the original callers — it only stops surfaces with `title:
 * string | null` from needing a cast.
 */
type DisplayTitleInput = {
  id: string | null | undefined;
  title: string | null | undefined;
  displayFileName: string | null | undefined;
  originalFileName: string | null | undefined;
  type: EvidenceListItem["type"] | EvidenceRecord["type"] | string | null | undefined;
  mimeType: string | null | undefined;
  itemCount: number | null | undefined;
};

export function getDisplayTitle(item: DisplayTitleInput): string {
  const direct = item.title?.trim();
  if (direct && !isGenericFallbackTitle(direct)) return direct;

  const fileLabel = item.displayFileName?.trim() || item.originalFileName?.trim();
  if (fileLabel) return fileLabel;

  const multipart = buildMultipartPackageLabel(item);
  if (multipart) return multipart;

  const typeLabel = getReviewerEvidenceTypeLabel({
    itemCount: item.itemCount,
    evidenceType: item.type,
    mimeType: item.mimeType,
  });
  if (typeLabel && !isGenericFallbackTitle(typeLabel)) {
    const shortRef = String(item.id ?? "").slice(0, 6);
    return shortRef ? `${typeLabel} · ${shortRef}` : typeLabel;
  }

  const id = String(item.id ?? "");
  return id ? `Evidence record ${id.slice(0, 8)}` : "Evidence record";
}

export function getRecordStatusLabel(status: string | null | undefined): string {
  switch (String(status ?? "").trim().toUpperCase()) {
    case "REPORTED":
      return "Reported";
    case "SIGNED":
      return "Signed";
    case "UPLOADED":
      return "Uploaded";
    case "UPLOADING":
      return "Uploading";
    case "CREATED":
      return "Created";
    default:
      return "Status not recorded";
  }
}

export function getVerificationStatusLabel(status: string | null | undefined): string {
  switch (String(status ?? "").trim().toUpperCase()) {
    case "RECORDED_INTEGRITY_VERIFIED":
      return "Recorded integrity state verified";
    case "MATERIALS_AVAILABLE":
      return "Technical materials available";
    case "REVIEW_REQUIRED":
      return "Review required";
    case "FAILED":
      return "Verification failed";
    default:
      return "Verification status not recorded";
  }
}

export function getCaptureMethodLabel(value: string | null | undefined): string {
  switch (String(value ?? "").trim().toUpperCase()) {
    case "SECURE_CAMERA":
      return "Captured with PROOVRA secure camera";
    case "UPLOADED_FILE":
      return "Uploaded existing file";
    case "IMPORTED_DOCUMENT":
      return "Imported document";
    case "MULTIPART_PACKAGE":
      return "Multipart package";
    default:
      return "Capture method not recorded";
  }
}

export function getIdentityLevelLabel(value: string | null | undefined): string {
  switch (String(value ?? "").trim().toUpperCase()) {
    case "BASIC_ACCOUNT":
      return "Basic account";
    case "VERIFIED_EMAIL":
      return "Verified email";
    case "OAUTH_BACKED_IDENTITY":
      return "OAuth-backed identity";
    case "ORGANIZATION_ACCOUNT":
      return "Organization account";
    case "VERIFIED_ORGANIZATION":
      return "Verified organization";
    default:
      return "Identity level not recorded";
  }
}

export function getEvidenceTypeLabel(
  item: Pick<EvidenceListItem, "type" | "mimeType" | "itemCount">,
  detail?: DetailWorkspaceState | null
): string {
  const summary = detail?.evidence?.contentSummary ?? null;

  return getReviewerEvidenceTypeLabel({
    itemCount: detail?.evidence?.itemCount ?? item.itemCount,
    structure: summary?.structure ?? null,
    imageCount: summary?.imageCount ?? null,
    videoCount: summary?.videoCount ?? null,
    audioCount: summary?.audioCount ?? null,
    pdfCount: summary?.pdfCount ?? null,
    textCount: summary?.textCount ?? null,
    otherCount: summary?.otherCount ?? null,
    evidenceType: item.type,
    mimeType: detail?.evidence?.mimeType ?? item.mimeType,
  });
}

export function getStructureLabel(
  item: Pick<EvidenceListItem, "itemCount">,
  detail?: DetailWorkspaceState | null
): string {
  const structure = detail?.evidence?.contentSummary?.structure;
  if (structure === "multipart") return "Multipart package";
  const count = detail?.evidence?.itemCount ?? item.itemCount ?? 1;
  return count > 1 ? "Multipart package" : "Single item";
}

/**
 * Status -> semantic tone for a BARE status string.
 *
 * Extracted so the Evidence Record header can tone its status badge without
 * an EvidenceListItem, and without a second status map existing anywhere.
 * `getStatusTone` below layers the list-only scope rules on top of it.
 */
export function getRecordStatusSemanticTone(
  status: string | null | undefined,
): "neutral" | "success" | "warning" | "danger" | "processing" {
  switch (String(status ?? "").trim().toUpperCase()) {
    case "REPORTED":
    case "SIGNED":
      return "success";
    case "UPLOADING":
    case "CREATED":
      return "processing";
    default:
      return "neutral";
  }
}

/** Canonical AppTone for a bare status string. ONE translation point. */
export function getRecordStatusBadgeTone(status: string | null | undefined): AppTone {
  return SEMANTIC_TONE_TO_APP_TONE[getRecordStatusSemanticTone(status)];
}

export function getStatusTone(item: EvidenceListItem): "neutral" | "success" | "warning" | "danger" | "processing" {
  const scope = getEvidenceScope(item);
  if (scope === "deleted") return "danger";
  if (scope === "archived") return "warning";

  return getRecordStatusSemanticTone(item.status);
}

/**
 * Part 3 — CANONICAL BADGE TONE AUTHORITY.
 *
 * `getStatusTone` speaks the product's own semantic vocabulary
 * ("success" / "warning" / …). The shared badge primitive
 * (`.app-status-badge[data-tone]`, `AppTone`) speaks a DIFFERENT,
 * smaller vocabulary ("green" / "amber" / …). Emitting the product
 * vocabulary straight into `data-tone` matched no rule at all, so every
 * queue badge rendered in the untoned base style and status was
 * communicated by TEXT ONLY.
 *
 * These two functions are the single translation point. Nothing on the
 * route may hand a raw semantic tone to a badge again.
 */
const SEMANTIC_TONE_TO_APP_TONE = {
  success: "green",
  warning: "amber",
  danger: "red",
  processing: "indigo",
  neutral: "slate",
} as const satisfies Record<
  ReturnType<typeof getStatusTone>,
  "green" | "amber" | "red" | "indigo" | "slate"
>;

export function getStatusBadgeTone(item: EvidenceListItem): AppTone {
  return SEMANTIC_TONE_TO_APP_TONE[getStatusTone(item)];
}

export type ReviewPriorityLevel =
  | "critical"
  | "operational"
  | "informational"
  | "stable";

/**
 * Review priority is an OPERATIONAL signal, not a workflow status. Green stays
 * reserved for integrity-ready workflow states (Reported / Signed) — sharing
 * it made a record with operational notes look like a completed one.
 *
 * `stable` is ORANGE, and `informational` keeps the blue it had. The two were
 * the same colour, which meant the settled majority of the library and the
 * rows that actually carry notes were indistinguishable — the one distinction
 * this column exists to draw. Orange here is the CLASSIFICATION tone, not a
 * caution: "Stable review state" is not asking for attention, and `amber`
 * (which `operational` uses) is the tone that does.
 */
const PRIORITY_LEVEL_TO_APP_TONE = {
  critical: "red",
  operational: "amber",
  informational: "blue",
  stable: "orange",
} as const satisfies Record<ReviewPriorityLevel, AppTone>;

export function getReviewPriorityTone(level: ReviewPriorityLevel): AppTone {
  return PRIORITY_LEVEL_TO_APP_TONE[level];
}
