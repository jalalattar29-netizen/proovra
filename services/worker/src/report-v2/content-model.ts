import {
  PresentationEvidenceItem,
  ReportEvidence,
  ReportEvidenceAsset,
  ReportEvidenceContentSummary,
  InventoryRow,
  PresentationMode,
  PreviewRenderKind,
} from "./types.js";
import { formatBytesHuman, safe } from "./formatters.js";
import { mapEvidenceAssetKindLabel } from "./normalizers.js";

type ParsedFingerprintSummary = {
  multipart: boolean;
  itemCount: number;
  imageCount: number;
  videoCount: number;
  audioCount: number;
  documentCount: number;
  mimeTypes: string[];
  partsCount: number;
};

export function parseFingerprintSummary(
  fingerprintCanonicalJson: string | null | undefined
): ParsedFingerprintSummary {
  const fallback: ParsedFingerprintSummary = {
    multipart: false,
    itemCount: 1,
    imageCount: 0,
    videoCount: 0,
    audioCount: 0,
    documentCount: 0,
    mimeTypes: [],
    partsCount: 0,
  };

  if (!fingerprintCanonicalJson) return fallback;

  try {
    const parsed = JSON.parse(fingerprintCanonicalJson) as {
      file?: {
        multipart?: boolean;
        summary?: {
          itemCount?: number;
          imageCount?: number;
          videoCount?: number;
          audioCount?: number;
          documentCount?: number;
          mimeTypes?: string[];
        };
        parts?: Array<unknown>;
      };
    };

    const multipart = Boolean(parsed?.file?.multipart);
    const partsCount = Array.isArray(parsed?.file?.parts)
      ? parsed.file.parts.length
      : 0;
    const summary = parsed?.file?.summary;

    const itemCount =
      typeof summary?.itemCount === "number"
        ? summary.itemCount
        : multipart
          ? partsCount || 0
          : 1;

    return {
      multipart,
      itemCount,
      imageCount:
        typeof summary?.imageCount === "number" ? summary.imageCount : 0,
      videoCount:
        typeof summary?.videoCount === "number" ? summary.videoCount : 0,
      audioCount:
        typeof summary?.audioCount === "number" ? summary.audioCount : 0,
      documentCount:
        typeof summary?.documentCount === "number"
          ? summary.documentCount
          : 0,
      mimeTypes: Array.isArray(summary?.mimeTypes)
        ? summary.mimeTypes.filter(
            (v): v is string => typeof v === "string" && v.trim().length > 0
          )
        : [],
      partsCount,
    };
  } catch {
    return fallback;
  }
}

export function buildFallbackContentSummary(
  evidence: ReportEvidence,
  parsed: ParsedFingerprintSummary
): ReportEvidenceContentSummary {
  const otherCount = Math.max(
    0,
    parsed.itemCount -
      (parsed.imageCount +
        parsed.videoCount +
        parsed.audioCount +
        parsed.documentCount)
  );

  return {
    structure: parsed.itemCount > 1 ? "multipart" : "single",
    itemCount: parsed.itemCount,
    previewableItemCount: 0,
    downloadableItemCount: parsed.itemCount > 0 ? parsed.itemCount : 0,
    imageCount: parsed.imageCount,
    videoCount: parsed.videoCount,
    audioCount: parsed.audioCount,
    pdfCount: parsed.documentCount,
    textCount: 0,
    otherCount,
    primaryKind: null,
    primaryMimeType: evidence.mimeType ?? null,
    totalSizeBytes: evidence.sizeBytes ?? null,
    totalSizeDisplay: formatBytesHuman(evidence.sizeBytes ?? null),
  };
}

export function resolveContentSummary(
  evidence: ReportEvidence,
  parsed: ParsedFingerprintSummary
): ReportEvidenceContentSummary {
  return evidence.contentSummary ?? buildFallbackContentSummary(evidence, parsed);
}

export function resolveContentItems(
  evidence: ReportEvidence
): ReportEvidenceAsset[] {
  const items = Array.isArray(evidence.contentItems) ? evidence.contentItems : [];

  const embeddedPreviewMap = new Map<
    string,
    {
      previewDataUrl?: string | null;
      previewTextExcerpt?: string | null;
      previewCaption?: string | null;
    }
  >();

  const embedded = evidence.embeddedPreviewsSnapshot;
  if (Array.isArray(embedded)) {
    for (const item of embedded) {
      if (item?.id) {
        embeddedPreviewMap.set(item.id, {
          previewDataUrl: item.previewDataUrl ?? null,
          previewTextExcerpt: item.previewTextExcerpt ?? null,
          previewCaption: item.previewCaption ?? null,
        });
      }
    }
  }

  return items.map((item) => {
    const preview = embeddedPreviewMap.get(item.id);
    if (!preview) return item;

    return Object.assign({}, item, {
      previewDataUrl: item.previewDataUrl ?? preview.previewDataUrl ?? null,
      previewTextExcerpt:
        item.previewTextExcerpt ?? preview.previewTextExcerpt ?? null,
      previewCaption: item.previewCaption ?? preview.previewCaption ?? null,
    });
  });
}

export function resolvePrimaryContentItem(
  evidence: ReportEvidence,
  items: ReportEvidenceAsset[]
): ReportEvidenceAsset | null {
  if (evidence.defaultPreviewItemId) {
    const previewItem = items.find(
      (item) => item.id === evidence.defaultPreviewItemId
    );
    if (previewItem) return previewItem;
  }

  if (evidence.primaryContentItem) return evidence.primaryContentItem;
  return items.find((item) => item.isPrimary) ?? items[0] ?? null;
}

export function determinePreviewRenderKind(
  item: ReportEvidenceAsset
): PreviewRenderKind {
  switch (item.kind) {
    case "image":
      return "image";
    case "pdf":
      return "document";
    case "text":
      return "text";
    case "video":
      return "video";
    case "audio":
      return "audio";
    default:
      return "placeholder";
  }
}

export function isPreviewRenderable(item: ReportEvidenceAsset): boolean {
  if (item.previewable) return true;
  if (item.previewDataUrl) return true;
  if (item.kind === "text" && safe(item.previewTextExcerpt, "") !== "") return true;
  return false;
}

export function buildPresentationBuckets(params: {
  items: ReportEvidenceAsset[];
  primaryItem: ReportEvidenceAsset | null;
  presentationMode: PresentationMode;
}) {
  const mapped: PresentationEvidenceItem[] = params.items.map((asset) => ({
    asset,
    previewRenderKind: determinePreviewRenderKind(asset),
    hasRenderablePreview: isPreviewRenderable(asset),
    prominent: params.primaryItem ? asset.id === params.primaryItem.id : false,
  }));

  const heroItem =
    mapped.find((item) => item.prominent) ??
    mapped.find((item) => item.hasRenderablePreview) ??
    mapped[0] ??
    null;

  const previewable = mapped.filter(
    (item) => item.hasRenderablePreview && (!heroItem || item.asset.id !== heroItem.asset.id)
  );

  const metadataOnly = mapped.filter((item) => !item.hasRenderablePreview);

  const primaryPreviewItems =
    heroItem && heroItem.hasRenderablePreview ? [heroItem] : heroItem ? [heroItem] : [];

  const supportingPreviewItems =
    params.presentationMode === "heavy"
      ? previewable
      : previewable;

  return {
    heroItem,
    primaryPreviewItems,
    supportingPreviewItems,
    metadataOnlyItems: metadataOnly,
  };
}

export function evidenceStructureLabel(
  summary: ReportEvidenceContentSummary
): string {
  if (summary.itemCount <= 1) return "Single evidence item";
  return "Multipart evidence package";
}

function buildRoleAndStatus(item: ReportEvidenceAsset): string {
  const parts = [
    item.artifactRole === "primary_evidence"
      ? "Primary Evidence"
      : item.artifactRole === "supporting_evidence"
        ? "Supporting Evidence"
        : item.artifactRole === "attachment"
          ? "Attachment"
          : null,
    item.previewable ? "Previewable" : "No Preview",
    item.downloadable ? "Downloadable" : "Restricted",
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(" • ") : "Not recorded";
}

export function buildInventoryRows(items: ReportEvidenceAsset[]): InventoryRow[] {
  return items.map((item) => {
    const fileName =
      safe(item.originalFileName, "") || safe(item.label, "Unnamed evidence item");

    const displayLabel =
      safe(item.label, "") && safe(item.label, "") !== fileName
        ? safe(item.label)
        : null;

    return {
      indexLabel: String(item.index + 1),
      fileName,
      displayLabel,
      kindLabel: mapEvidenceAssetKindLabel(item.kind),
      formatAndSize: [
        item.mimeType ? `MIME: ${item.mimeType}` : "MIME: N/A",
        item.displaySizeLabel
          ? `Size: ${item.displaySizeLabel}`
          : `Size: ${formatBytesHuman(item.sizeBytes)}`,
      ].join("\n"),
      sha256: item.sha256 ?? "N/A",
      roleAndStatus: buildRoleAndStatus(item),
    };
  });
}

export function buildFingerprintNarrative(
  parsedSummary: ParsedFingerprintSummary,
  contentSummary: ReportEvidenceContentSummary
): string {
  const mimeText =
    parsedSummary.mimeTypes.length > 0
      ? parsedSummary.mimeTypes.join(", ")
      : safe(contentSummary.primaryMimeType, "not recorded");

  if (contentSummary.itemCount <= 1) {
    return `Single evidence item represented by a canonical fingerprint and recorded MIME metadata. MIME: ${mimeText}.`;
  }

  return `Multipart evidence package (${contentSummary.itemCount} items) represented by a canonical fingerprint describing structure, metadata, and integrity values. MIME types: ${mimeText}.`;
}
