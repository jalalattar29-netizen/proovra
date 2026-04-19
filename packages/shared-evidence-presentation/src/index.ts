export type EvidenceAssetKind =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "text"
  | "other";

export type EvidenceContentSummary = {
  structure: "single" | "multipart";
  itemCount: number;
  previewableItemCount: number;
  downloadableItemCount: number;
  imageCount: number;
  videoCount: number;
  audioCount: number;
  pdfCount: number;
  textCount: number;
  otherCount: number;
  primaryKind: EvidenceAssetKind | null;
  primaryMimeType: string | null;
  totalSizeBytes: string | null;
  totalSizeDisplay: string | null;
};

export type EvidenceDisplayDescriptor = {
  displayTitle: string;
  displayDescription: string | null;
};

export type EvidencePreviewPolicy = {
  contentVisible: boolean;
  previewEnabled: boolean;
  downloadableFromVerify: boolean;
  rationale: string;
  privacyNotice: string;
};

export type EvidenceContentAccessMode =
  | "metadata_only"
  | "preview_only"
  | "full_access";

export type EvidenceContentAccessPolicy = {
  mode: EvidenceContentAccessMode;
  allowContentView: boolean;
  allowDownload: boolean;
};

export function resolveEvidenceTitle(title: string | null | undefined): string {
  const t = typeof title === "string" ? title.trim() : "";
  return t || "Digital Evidence Record";
}

export function detectEvidenceAssetKind(
  mimeType: string | null | undefined
): EvidenceAssetKind {
  const mime = (mimeType ?? "").trim().toLowerCase();

  if (!mime) return "other";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  if (
    mime.startsWith("text/") ||
    mime.includes("json") ||
    mime.includes("xml")
  ) {
    return "text";
  }
  return "other";
}

export function isPreviewableEvidenceKind(kind: EvidenceAssetKind): boolean {
  return (
    kind === "image" ||
    kind === "video" ||
    kind === "audio" ||
    kind === "pdf" ||
    kind === "text"
  );
}

export function extensionFromMimeType(
  mimeType: string | null | undefined
): string {
  const mime = (mimeType ?? "").toLowerCase().trim();

  if (!mime) return "bin";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "video/mp4") return "mp4";
  if (mime === "video/webm") return "webm";
  if (mime === "audio/mpeg") return "mp3";
  if (mime === "audio/wav") return "wav";
  if (mime === "audio/webm") return "webm";
  if (mime === "application/pdf") return "pdf";
  if (mime === "text/plain") return "txt";
  if (mime === "application/json") return "json";

  const slashIndex = mime.indexOf("/");
  if (slashIndex >= 0 && slashIndex < mime.length - 1) {
    return mime.slice(slashIndex + 1).replace(/[^a-z0-9]+/gi, "") || "bin";
  }

  return "bin";
}

export function basenameFromStorageKey(
  key: string | null | undefined,
  fallback: string
): string {
  const raw = typeof key === "string" ? key.trim() : "";
  if (!raw) return fallback;
  const parts = raw.split("/");
  const base = parts[parts.length - 1]?.trim();
  return base || fallback;
}

export function getEvidencePartDisplayLabel(params: {
  partIndex: number;
  mimeType: string | null | undefined;
  originalFileName?: string | null | undefined;
  storageKey?: string | null | undefined;
}): string {
  const existingName =
    typeof params.originalFileName === "string" && params.originalFileName.trim()
      ? params.originalFileName.trim()
      : basenameFromStorageKey(params.storageKey, "").trim();

  if (existingName) return existingName;

  const ext = extensionFromMimeType(params.mimeType);
  return `item-${params.partIndex + 1}.${ext}`;
}

export function formatBytesForDisplay(
  sizeBytes: string | number | bigint | null | undefined
): string | null {
  if (sizeBytes === null || sizeBytes === undefined) return null;

  let numeric = Number.NaN;

  if (typeof sizeBytes === "bigint") {
    numeric = Number(sizeBytes);
  } else if (typeof sizeBytes === "number") {
    numeric = sizeBytes;
  } else if (typeof sizeBytes === "string" && sizeBytes.trim()) {
    numeric = Number(sizeBytes);
  }

  if (!Number.isFinite(numeric) || numeric <= 0) return null;

  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let value = numeric;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const fixed = unitIndex === 0 ? value.toFixed(0) : value.toFixed(2);
  return `${fixed} ${units[unitIndex]}`;
}

export function buildContentCompositionSummary(
  summary: EvidenceContentSummary | null
): string | null {
  if (!summary) return null;

  const parts: string[] = [];

  if (summary.imageCount > 0) {
    parts.push(`${summary.imageCount} image${summary.imageCount === 1 ? "" : "s"}`);
  }
  if (summary.videoCount > 0) {
    parts.push(`${summary.videoCount} video${summary.videoCount === 1 ? "" : "s"}`);
  }
  if (summary.audioCount > 0) {
    parts.push(`${summary.audioCount} audio`);
  }
  if (summary.pdfCount > 0) {
    parts.push(`${summary.pdfCount} PDF${summary.pdfCount === 1 ? "" : "s"}`);
  }
  if (summary.textCount > 0) {
    parts.push(`${summary.textCount} text`);
  }
  if (summary.otherCount > 0) {
    parts.push(`${summary.otherCount} other`);
  }

  if (parts.length === 0) {
    return summary.structure === "multipart"
      ? "Multipart evidence package"
      : "Single evidence item";
  }

  return parts.join(" • ");
}

export function buildPrimaryContentLabel(
  primaryKind: EvidenceAssetKind | null | undefined
): string | null {
  switch (primaryKind) {
    case "image":
      return "Image";
    case "video":
      return "Video";
    case "audio":
      return "Audio";
    case "pdf":
      return "PDF";
    case "text":
      return "Text";
    case "other":
      return "Other";
    default:
      return null;
  }
}

export function buildEvidenceDisplayDescriptor(params: {
  title: string | null | undefined;
  summary: EvidenceContentSummary | null;
  itemCount: number;
}): EvidenceDisplayDescriptor {
  const displayTitle = resolveEvidenceTitle(params.title);

  const structureLabel =
    params.summary?.structure === "multipart"
      ? "Multipart evidence package"
      : "Single evidence item";

  const composition = buildContentCompositionSummary(params.summary);

  const displayDescription = [
    composition && composition !== structureLabel ? structureLabel : null,
    composition,
    params.summary?.totalSizeDisplay ?? null,
  ]
    .filter(Boolean)
    .join(" • ");

  return {
    displayTitle,
    displayDescription: displayDescription || null,
  };
}

export function resolveEvidenceContentAccessPolicy(
  rawValue?: string | null
): EvidenceContentAccessPolicy {
  const raw = (rawValue ?? "preview_only").trim().toLowerCase();

  switch (raw) {
    case "metadata_only":
      return {
        mode: "metadata_only",
        allowContentView: false,
        allowDownload: false,
      };
    case "full_access":
      return {
        mode: "full_access",
        allowContentView: true,
        allowDownload: true,
      };
    case "preview_only":
    default:
      return {
        mode: "preview_only",
        allowContentView: true,
        allowDownload: false,
      };
  }
}

export function buildEvidencePreviewPolicy(params: {
  itemCount: number;
  previewableItemCount: number;
  downloadableItemCount: number;
  accessPolicy: EvidenceContentAccessPolicy;
}): EvidencePreviewPolicy {
  const accessPolicy = params.accessPolicy;

  return {
    contentVisible: accessPolicy.allowContentView && params.itemCount > 0,
    previewEnabled:
      accessPolicy.allowContentView && params.previewableItemCount > 0,
    downloadableFromVerify:
      accessPolicy.allowDownload && params.downloadableItemCount > 0,
    rationale:
      accessPolicy.mode === "metadata_only"
        ? "This verification flow exposes metadata and technical verification materials without exposing the evidence content itself."
        : accessPolicy.mode === "preview_only"
          ? "This verification flow may expose reviewer-facing preview access to the evidence content while technical verification separately validates the recorded integrity state."
          : "This verification flow may expose direct access to the submitted evidence content together with technical verification materials.",
    privacyNotice:
      accessPolicy.mode === "metadata_only"
        ? "Evidence content is not directly exposed through this verification flow."
        : accessPolicy.mode === "preview_only"
          ? "Anyone with access to this verification flow may be able to preview evidence items exposed here, but download access may remain restricted."
          : "Anyone with access to this verification flow may be able to view or download the exposed evidence items.",
  };
}