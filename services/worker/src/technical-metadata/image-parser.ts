/**
 * Image technical-metadata parser (worker side).
 *
 * Reuses the proven, redaction-aware exifr extractor from
 * @proovra/shared-runtime for EXIF facts, and adds sharp's header
 * read for dimensions / colour space. Never throws — returns a
 * FAILED/UNSUPPORTED TechnicalMetadata on any error so the lifecycle
 * is never blocked.
 *
 * Privacy: only `gpsPresent` boolean is ever produced. Raw GPS is
 * refused at the extractor layer (allowRawGps:false).
 */

import {
  extractExifSafe,
  type ExifSafeSummary,
} from "@proovra/shared-runtime/media-intelligence";
import {
  imageMetadataFromExif,
  unparsedMetadata,
  type TechnicalMetadata,
} from "@proovra/shared-runtime/technical-metadata";
import { logger } from "../logger.js";

const PARSER_VERSION = "exifr-v7+sharp";

export async function parseImageMetadata(
  bytes: Buffer,
  mimeType: string | null,
): Promise<TechnicalMetadata> {
  let exif: ExifSafeSummary | null = null;
  const result = await extractExifSafe({
    bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    mimeType,
    allowRawGps: false,
  });
  if (result.ok) {
    exif = result.summary;
  } else if (result.reason === "unsupported_format") {
    return unparsedMetadata(mimeType, "UNSUPPORTED", "exifr", PARSER_VERSION);
  } else {
    // empty / too_large / parse_failed — still try sharp for dimensions.
    exif = {
      exifPresent: false,
      dateTimeOriginalUtc: null,
      createDateUtc: null,
      dimensions: null,
      cameraMake: null,
      cameraModel: null,
      hasGps: false,
      orientation: null,
      software: null,
    };
  }

  const tm = imageMetadataFromExif(mimeType, exif, PARSER_VERSION);

  // Augment dimensions / colour space via sharp's header read (cheap —
  // sharp does not decode the full raster for .metadata()). Best-effort.
  try {
    const sharpMod = (await import("sharp")).default as unknown as typeof import("sharp");
    const meta = await sharpMod(bytes).metadata();
    if (tm.widthPx == null && typeof meta.width === "number") tm.widthPx = meta.width;
    if (tm.heightPx == null && typeof meta.height === "number") tm.heightPx = meta.height;
    if (typeof meta.space === "string") tm.colorSpace = meta.space;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message.slice(0, 120) : "unknown" },
      "technical_metadata.image.sharp_metadata_failed",
    );
  }

  return tm;
}
