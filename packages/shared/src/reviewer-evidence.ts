type ReviewerEvidenceTypeInput = {
  itemCount?: number | null;
  structure?: "single" | "multipart" | string | null;
  imageCount?: number | null;
  videoCount?: number | null;
  audioCount?: number | null;
  pdfCount?: number | null;
  textCount?: number | null;
  otherCount?: number | null;
  evidenceType?: string | null;
  mimeType?: string | null;
};

export type ReviewerEvidenceCategory =
  | "Image"
  | "Video"
  | "Audio"
  | "Document"
  | "Other";

type ReviewerUploadModeInput = {
  itemCount?: number | null;
  structure?: "single" | "multipart" | string | null;
  rawMode?: string | null;
};

function toPositiveNumber(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function isMultipartEvidence(input: {
  itemCount?: number | null;
  structure?: string | null;
}): boolean {
  if (typeof input.itemCount === "number" && input.itemCount > 1) {
    return true;
  }

  return String(input.structure ?? "").trim().toLowerCase() === "multipart";
}

function normalizeDisplayToken(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  return raw
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function getReviewerEvidenceCategories(
  input: ReviewerEvidenceTypeInput
): ReviewerEvidenceCategory[] {
  const categories = [
    toPositiveNumber(input.imageCount) > 0 ? "Image" : null,
    toPositiveNumber(input.videoCount) > 0 ? "Video" : null,
    toPositiveNumber(input.audioCount) > 0 ? "Audio" : null,
    toPositiveNumber(input.pdfCount) > 0 || toPositiveNumber(input.textCount) > 0
      ? "Document"
      : null,
    toPositiveNumber(input.otherCount) > 0 ? "Other" : null,
  ].filter(Boolean) as ReviewerEvidenceCategory[];

  return categories;
}

export function getReviewerEvidenceTypeLabel(
  input: ReviewerEvidenceTypeInput
): string {
  if (isMultipartEvidence(input)) {
    const categories = getReviewerEvidenceCategories(input).filter(
      (category) => category !== "Other"
    );

    if (categories.length > 1) return "Mixed Media Evidence Package";
    if (categories.length === 1) return `${categories[0]} Evidence Package`;
    return "Multipart Evidence Package";
  }

  switch (String(input.evidenceType ?? "").trim().toUpperCase()) {
    case "PHOTO":
      return "Photo Evidence";
    case "VIDEO":
      return "Video Evidence";
    case "AUDIO":
      return "Audio Evidence";
    case "DOCUMENT":
      return "Document Evidence";
    default:
      if (String(input.mimeType ?? "").startsWith("image/")) {
        return "Photo Evidence";
      }
      if (String(input.mimeType ?? "").startsWith("video/")) {
        return "Video Evidence";
      }
      if (String(input.mimeType ?? "").startsWith("audio/")) {
        return "Audio Evidence";
      }
      if (String(input.mimeType ?? "").includes("pdf")) {
        return "Document Evidence";
      }
      return "Digital Evidence Record";
  }
}

export function getReviewerUploadModeLabel(
  input: ReviewerUploadModeInput
): string | null {
  if (isMultipartEvidence(input)) {
    return "multipart package";
  }

  const normalized = normalizeDisplayToken(input.rawMode);
  if (!normalized) return null;

  switch (normalized) {
    case "single":
      return "single";
    case "multipart":
    case "multipart package":
      return "multipart package";
    default:
      return normalized;
  }
}
