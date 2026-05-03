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

export function getReviewerEvidenceTypeLabel(
  input: ReviewerEvidenceTypeInput
): string {
  if (isMultipartEvidence(input)) {
    const hasImage = toPositiveNumber(input.imageCount) > 0;
    const hasVideo = toPositiveNumber(input.videoCount) > 0;
    const hasAudio = toPositiveNumber(input.audioCount) > 0;
    const hasDocument =
      toPositiveNumber(input.pdfCount) > 0 || toPositiveNumber(input.textCount) > 0;

    const categories = [
      hasImage ? "Image" : null,
      hasVideo ? "Video" : null,
      hasAudio ? "Audio" : null,
      hasDocument ? "Document" : null,
    ].filter(Boolean) as string[];

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
