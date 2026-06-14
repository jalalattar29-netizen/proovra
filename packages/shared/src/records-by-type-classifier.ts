/**
 * Phase HOME-RECORDS-BY-TYPE — single source of truth for the
 * 7-category UI taxonomy used by the Home dashboard's
 * "Records by primary type" and "Preserved files by type" widgets.
 *
 * Backend aggregations (services/api/src/services/dashboard/
 * records-by-type.service.ts) and the frontend view-model both call
 * `classifyEvidenceCategory()` so the bucket assignment is identical
 * regardless of which side computes the aggregate.
 *
 * Inputs we trust (in precedence order):
 *
 *   1. Specific MIME types — image/*, video/*, audio/*, archive
 *      family, document family. A real file content type wins
 *      regardless of how the record was ingested.
 *   2. EvidenceType enum (PHOTO/VIDEO/AUDIO/DOCUMENT) — fallback
 *      when MIME is absent or generic (`application/octet-stream`).
 *   3. captureMethod = "MULTIPART_PACKAGE" → "Folders" — used ONLY
 *      when steps 1 + 2 produce no specific category (a true
 *      container with no resolvable file content).
 *   4. "Other Files" — everything else.
 *
 * Categories are UI-only: Archives / Folders / Other Files are NOT
 * EvidenceType enum values, they are operator-readable groupings.
 */

export const RECORDS_BY_TYPE_CATEGORIES = [
  "Images",
  "Documents",
  "Videos",
  "Audio",
  "Archives",
  "Folders",
  "Other Files",
] as const;

export type RecordsByTypeCategory =
  (typeof RECORDS_BY_TYPE_CATEGORIES)[number];

const ARCHIVE_MIME = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/gzip",
  "application/x-gzip",
  "application/x-7z-compressed",
  "application/x-rar-compressed",
  "application/vnd.rar",
  "application/x-tar",
  "application/x-bzip2",
]);

function isArchiveMime(mime: string): boolean {
  return ARCHIVE_MIME.has(mime);
}

function isDocumentMime(mime: string): boolean {
  if (mime === "application/pdf") return true;
  if (mime.startsWith("text/")) return true;
  if (mime.includes("json") || mime.includes("xml")) return true;
  if (mime.includes("msword")) return true;
  if (mime.includes("officedocument")) return true;
  if (mime.includes("spreadsheet")) return true;
  if (mime.includes("presentation")) return true;
  if (mime === "application/rtf" || mime === "text/rtf") return true;
  return false;
}

function normalizeMime(mime: string | null | undefined): string {
  return String(mime ?? "").trim().toLowerCase();
}

/**
 * Classify a single Evidence row (or EvidencePart row) into the
 * canonical 7-category taxonomy.
 *
 * - For RECORDS mode, pass the parent Evidence's
 *   `(mimeType, type, captureMethod)`.
 * - For FILES mode, pass the EvidencePart's `mimeType` and leave
 *   `type` / `captureMethod` undefined — parts don't carry the
 *   parent's EvidenceType enum or capture method.
 */
export function classifyEvidenceCategory(input: {
  mimeType?: string | null;
  type?: string | null;
  captureMethod?: string | null;
}): RecordsByTypeCategory {
  const mime = normalizeMime(input.mimeType);
  const type = String(input.type ?? "").toUpperCase();
  const captureMethod = String(input.captureMethod ?? "").toUpperCase();
  const mimeIsGeneric =
    mime === "application/octet-stream" || mime === "binary/octet-stream";

  // 1. Specific MIME types win first.
  if (mime && isArchiveMime(mime)) return "Archives";
  if (mime.startsWith("image/")) return "Images";
  if (mime.startsWith("video/")) return "Videos";
  if (mime.startsWith("audio/")) return "Audio";
  if (mime && isDocumentMime(mime)) return "Documents";

  // 2. EvidenceType enum fallback when MIME is absent or generic.
  if (!mime || mimeIsGeneric) {
    if (type === "PHOTO") return "Images";
    if (type === "VIDEO") return "Videos";
    if (type === "AUDIO") return "Audio";
    if (type === "DOCUMENT" && !mime) return "Documents";
  }

  // 3. Multipart container with no resolvable content type.
  if (captureMethod === "MULTIPART_PACKAGE") return "Folders";

  return "Other Files";
}

export type RecordsByTypeAggregate = {
  total: number;
  byCategory: Record<RecordsByTypeCategory, number>;
};

/** Build an empty zero-bucket aggregate (the canonical empty value). */
export function emptyRecordsByTypeAggregate(): RecordsByTypeAggregate {
  const byCategory = Object.fromEntries(
    RECORDS_BY_TYPE_CATEGORIES.map((c) => [c, 0]),
  ) as Record<RecordsByTypeCategory, number>;
  return { total: 0, byCategory };
}
