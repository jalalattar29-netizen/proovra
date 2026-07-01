/**
 * Pure projections over TechnicalMetadata — used by the package
 * builder, PDF report, verify page, and internal evidence surfaces.
 * No I/O, no deps. Never throw.
 */

import {
  TECHNICAL_METADATA_SCHEMA_VERSION,
  type ExifSummary,
  type MediaKind,
  type TechnicalMetadata,
} from "./types.js";
import type { ExifSafeSummary } from "../media-intelligence/exif-extractor.service.js";

/** Map a MIME type to a coarse MediaKind. */
export function classifyMediaKind(mimeType: string | null | undefined): MediaKind {
  if (!mimeType) return "OTHER";
  const m = mimeType.toLowerCase();
  if (m.startsWith("image/")) return "IMAGE";
  if (m.startsWith("video/")) return "VIDEO";
  if (m.startsWith("audio/")) return "AUDIO";
  if (m === "application/pdf") return "PDF";
  return "OTHER";
}

/**
 * Build an ImageMetadata-flavoured TechnicalMetadata from the existing
 * bounded EXIF summary (ExifSafeSummary). Lets us reuse the proven
 * exifr extractor for the image branch without a second parser.
 */
export function imageMetadataFromExif(
  mimeType: string | null,
  exif: ExifSafeSummary,
  parserVersion: string,
): TechnicalMetadata {
  const exifPresent = exif.exifPresent === true;
  const hasCamera = Boolean(exif.cameraMake || exif.cameraModel);
  const hasTime = Boolean(exif.dateTimeOriginalUtc || exif.createDateUtc);
  let metadataStatus: TechnicalMetadata["metadataStatus"];
  if (!exifPresent) metadataStatus = "MISSING";
  else if (hasCamera && hasTime) metadataStatus = "PRESENT";
  else metadataStatus = "PARTIAL";

  return {
    schemaVersion: TECHNICAL_METADATA_SCHEMA_VERSION,
    mediaKind: "IMAGE",
    mimeType,
    parseResult: "OK",
    metadataStatus,
    parserName: "exifr",
    parserVersion,
    widthPx: exif.dimensions?.width ?? null,
    heightPx: exif.dimensions?.height ?? null,
    colorSpace: exif.colorSpace ?? null,
    exifPresent,
    cameraMake: exif.cameraMake ?? null,
    cameraModel: exif.cameraModel ?? null,
    originalCaptureTime: exif.dateTimeOriginalUtc ?? exif.createDateUtc ?? null,
    gpsPresent: exif.hasGps === true,
    softwareTag: exif.software ?? null,
    orientation: exif.orientation ?? null,
    lensModel: exif.lensModel ?? null,
    iso: exif.iso ?? null,
    aperture: exif.aperture ?? null,
    exposureTime: exif.exposureTime ?? null,
    shutterSpeed: exif.shutterSpeed ?? null,
    whiteBalance: exif.whiteBalance ?? null,
    compression: exif.compression ?? null,
    flash: exif.flash ?? null,
    meteringMode: exif.meteringMode ?? null,
    exposureMode: exif.exposureMode ?? null,
    focalLength: exif.focalLength ?? null,
    focalLength35mm: exif.focalLength35mm ?? null,
    imageUniqueId: exif.imageUniqueId ?? null,
  };
}

/** A FAILED/UNSUPPORTED placeholder for a part we couldn't parse. */
export function unparsedMetadata(
  mimeType: string | null,
  parseResult: "FAILED" | "UNSUPPORTED",
  parserName = "dispatch",
  parserVersion = "1.0",
): TechnicalMetadata {
  return {
    schemaVersion: TECHNICAL_METADATA_SCHEMA_VERSION,
    mediaKind: classifyMediaKind(mimeType),
    mimeType,
    parseResult,
    metadataStatus: "UNKNOWN",
    parserName,
    parserVersion,
  };
}

function coerceTechnical(value: unknown): TechnicalMetadata | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<TechnicalMetadata>;
  if (!v.mediaKind || !v.parseResult) return null;
  return v as TechnicalMetadata;
}

/**
 * Derive the reviewer-facing EXIF summary from a part's technical
 * metadata. Returns `applicable: false` for non-image/video or when
 * EXIF was absent. Never carries GPS coordinates.
 */
export function deriveExifSummary(
  value: unknown,
): ExifSummary {
  const tm = coerceTechnical(value);
  const notApplicable: ExifSummary = {
    applicable: false,
    exifPresent: false,
    cameraMake: null,
    cameraModel: null,
    lensModel: null,
    originalCaptureTime: null,
    iso: null,
    aperture: null,
    exposureTime: null,
    shutterSpeed: null,
    whiteBalance: null,
    orientation: null,
    gpsPresent: false,
    resolution: null,
    softwareTag: null,
    compression: null,
    flash: null,
    meteringMode: null,
    exposureMode: null,
    colorSpace: null,
    focalLength: null,
    focalLength35mm: null,
    imageUniqueId: null,
    metadataStatus: "UNKNOWN",
  };
  if (!tm) return notApplicable;
  if (tm.mediaKind !== "IMAGE" && tm.mediaKind !== "VIDEO") return notApplicable;

  const resolution =
    tm.widthPx != null && tm.heightPx != null
      ? `${tm.widthPx}x${tm.heightPx}`
      : null;
  const applicable =
    tm.exifPresent === true ||
    Boolean(tm.cameraMake || tm.cameraModel || tm.originalCaptureTime);

  return {
    applicable,
    exifPresent: tm.exifPresent === true,
    cameraMake: tm.cameraMake ?? null,
    cameraModel: tm.cameraModel ?? null,
    lensModel: tm.lensModel ?? null,
    originalCaptureTime: tm.originalCaptureTime ?? null,
    iso: tm.iso ?? null,
    aperture: tm.aperture ?? null,
    exposureTime: tm.exposureTime ?? null,
    shutterSpeed: tm.shutterSpeed ?? null,
    whiteBalance: tm.whiteBalance ?? null,
    orientation: tm.orientation ?? null,
    gpsPresent: tm.gpsPresent === true,
    resolution,
    softwareTag: tm.softwareTag ?? null,
    compression: tm.compression ?? null,
    flash: tm.flash ?? null,
    meteringMode: tm.meteringMode ?? null,
    exposureMode: tm.exposureMode ?? null,
    colorSpace: tm.colorSpace ?? null,
    focalLength: tm.focalLength ?? null,
    focalLength35mm: tm.focalLength35mm ?? null,
    imageUniqueId: tm.imageUniqueId ?? null,
    metadataStatus: tm.metadataStatus,
  };
}

/** Human "Apple iPhone 14 Pro" / null from make+model. */
export function formatCameraLabel(
  make: string | null | undefined,
  model: string | null | undefined,
): string | null {
  const m = (make ?? "").trim();
  const mo = (model ?? "").trim();
  if (!m && !mo) return null;
  if (m && mo && mo.toLowerCase().startsWith(m.toLowerCase())) return mo;
  return [m, mo].filter(Boolean).join(" ") || null;
}

export type PerPartMediaSummary = {
  partId: string;
  filename: string | null;
  mediaKind: MediaKind;
  mimeType: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  codec: string | null;
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  frameRate: number | null;
  bitrate: number | null;
  streamCount: number | null;
  pageCount: number | null;
  metadataStatus: TechnicalMetadata["metadataStatus"];
  parseResult: TechnicalMetadata["parseResult"];
};

/** Flatten one part's technical metadata into a package/report row. */
export function toPerPartMediaSummary(
  part: {
    id: string;
    filename: string | null;
    sizeBytes: number | null;
    sha256: string | null;
    technicalMetadata: unknown;
    mimeType: string | null;
  },
): PerPartMediaSummary {
  const tm = coerceTechnical(part.technicalMetadata);
  const codec =
    tm?.videoCodec ?? tm?.audioCodec ?? null;
  return {
    partId: part.id,
    filename: part.filename,
    mediaKind: tm?.mediaKind ?? classifyMediaKind(part.mimeType),
    mimeType: tm?.mimeType ?? part.mimeType,
    sizeBytes: part.sizeBytes,
    sha256: part.sha256,
    width: tm?.widthPx ?? null,
    height: tm?.heightPx ?? null,
    durationMs: tm?.durationMs ?? null,
    codec,
    container: tm?.container ?? null,
    videoCodec: tm?.videoCodec ?? null,
    audioCodec: tm?.audioCodec ?? null,
    frameRate: tm?.frameRate ?? null,
    bitrate: tm?.bitrate ?? null,
    streamCount: tm?.streamCount ?? null,
    pageCount: tm?.pageCount ?? null,
    metadataStatus: tm?.metadataStatus ?? "UNKNOWN",
    parseResult: tm?.parseResult ?? "UNSUPPORTED",
  };
}

/** Aggregate metadata status across parts for the compact report header. */
export function aggregateMetadataStatus(
  parts: ReadonlyArray<PerPartMediaSummary>,
): "Complete" | "Partial" | "Missing" | "Unavailable" {
  if (parts.length === 0) return "Unavailable";
  const statuses = parts.map((p) => p.metadataStatus);
  if (statuses.every((s) => s === "PRESENT")) return "Complete";
  if (statuses.every((s) => s === "MISSING" || s === "UNKNOWN")) {
    return statuses.every((s) => s === "UNKNOWN") ? "Unavailable" : "Missing";
  }
  return "Partial";
}

/** Primary media type label for the report header. */
export function primaryMediaTypeLabel(
  parts: ReadonlyArray<PerPartMediaSummary>,
): string {
  const kinds = new Set(parts.map((p) => p.mediaKind));
  if (kinds.size === 0) return "Unavailable";
  if (kinds.size > 1) return "Mixed";
  const only = [...kinds][0]!;
  switch (only) {
    case "IMAGE":
      return "Image";
    case "VIDEO":
      return "Video";
    case "AUDIO":
      return "Audio";
    case "PDF":
      return "PDF";
    default:
      return "Other";
  }
}
