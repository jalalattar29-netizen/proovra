/**
 * Phase 31.7 — Real EXIF / metadata extractor.
 *
 * Pure-function library that turns image bytes into a BOUNDED,
 * redaction-aware EXIF summary. Intentionally I/O-free: callers
 * provide the bytes (the worker that already has S3 helpers is the
 * natural integration point). Keeping I/O out of this module lets
 * the analyzer-side contract — "read-only against the DB, never
 * throws" — stay intact: this module is invoked from the worker,
 * the summary is persisted, the analyzer reads the persisted summary
 * on its next pass.
 *
 * Hard custody / safety rules:
 *   * NEVER throws. Every error path returns
 *     `{ ok: false, reason }` with a bounded reason string.
 *   * Redaction-aware. Raw GPS coordinates are NEVER returned by
 *     default — only `hasGps: true | false`. The caller must opt
 *     in explicitly via `{ allowRawGps: true }` AND the policy
 *     layer above must have approved it. The default policy is
 *     refusal.
 *   * Bounded output. Every string field is truncated, every
 *     numeric range is clamped, every shape is closed. Operators
 *     never see free-text EXIF blobs that could carry user-
 *     controlled prose (e.g. a PII description in `XPComment`).
 *   * NEVER carries forbidden vocabulary. The output shape exposes
 *     observations only — no "tampered" / "manipulated" / "fake" /
 *     "authentic" classifications and no truth claims.
 *   * Pure function. No process.env reads, no fs, no network, no
 *     side effects. Deterministic given the same input bytes.
 *
 * Output shape (anti-leak by construction):
 *   * exifPresent: boolean — true if any well-known EXIF / XMP tag
 *     parsed cleanly.
 *   * dateTimeOriginalUtc: ISO-8601 string OR null.
 *   * createDateUtc: ISO-8601 string OR null.
 *   * dimensions: { width, height } OR null.
 *   * cameraMake / cameraModel: string OR null (truncated to 64
 *     chars; rejected if it contains characters outside the
 *     `[\w\s\-\.\/]` set — keeps prose injection out).
 *   * hasGps: boolean — presence flag only.
 *   * rawGps: NEVER present in the default output. Only included
 *     when callers explicitly request `allowRawGps: true`. Lat/lon
 *     are clamped to bounded ranges; precision is rounded to 5
 *     decimal places (≈ 1.1 m precision) so we don't expose
 *     sub-meter coordinates.
 *
 * What this extractor does NOT do (deferred):
 *   * Video / audio container parsing (needs ffprobe; reserved).
 *   * Perceptual hashing.
 *   * OCR / transcript extraction.
 *   * Device identifier reconciliation across evidence.
 */

import exifr from "exifr";

// =============================================================================
// Public types
// =============================================================================

export type ExifSafeSummary = {
  exifPresent: boolean;
  dateTimeOriginalUtc: string | null;
  createDateUtc: string | null;
  dimensions: { width: number; height: number } | null;
  cameraMake: string | null;
  cameraModel: string | null;
  /** Presence flag only — raw GPS is never returned in the default
   *  policy. See `allowRawGps`. */
  hasGps: boolean;
  /** Only present when the caller explicitly opted in AND the input
   *  carried valid GPS coordinates. Rounded to 5 decimal places. */
  rawGps?: { latitude: number; longitude: number };
  /** Best-effort orientation flag (1..8 per EXIF spec) or null. */
  orientation: number | null;
  /** Software/firmware string truncated to 64 chars or null. */
  software: string | null;
  /** Photographic EXIF — present only when the file carried them.
   *  Bounded strings / clamped numbers; PII-safe. */
  lensModel: string | null;
  iso: number | null;
  /** Formatted aperture, e.g. "f/1.8". */
  aperture: string | null;
  /** Formatted exposure time, e.g. "1/200s". */
  exposureTime: string | null;
  /** Formatted shutter speed, e.g. "1/200s". */
  shutterSpeed: string | null;
  whiteBalance: string | null;
  compression: string | null;
};

export type ExifExtractInput = {
  bytes: Uint8Array;
  /** Hint for the parser; if provided, used as a quick reject for
   *  formats exifr doesn't support. Optional. */
  mimeType?: string | null;
  /** Default false — the policy layer must affirmatively allow raw
   *  GPS before this is set true. Internal default = redact. */
  allowRawGps?: boolean;
  /** Hard byte ceiling. EXIF data lives in the first few KB of a
   *  JPEG/TIFF; reading more is wasted work. Default 5 MB
   *  (typical phone photo header well under this). */
  maxBytes?: number;
};

export type ExifExtractResult =
  | { ok: true; summary: ExifSafeSummary }
  | {
      ok: false;
      reason:
        | "empty_input"
        | "input_too_large"
        | "unsupported_format"
        | "parse_failed";
    };

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const STRING_FIELD_MAX = 64;
const SUPPORTED_MIME_PREFIXES = [
  "image/jpeg",
  "image/jpg",
  "image/tiff",
  "image/png",
  "image/heic",
  "image/heif",
  "image/webp",
];
const SAFE_STRING_CHARSET = /^[\w\s\-./()]+$/;

// =============================================================================
// Entry point
// =============================================================================

export async function extractExifSafe(
  input: ExifExtractInput,
): Promise<ExifExtractResult> {
  if (!input.bytes || input.bytes.byteLength === 0) {
    return { ok: false, reason: "empty_input" };
  }
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  if (input.bytes.byteLength > maxBytes) {
    return { ok: false, reason: "input_too_large" };
  }
  if (
    input.mimeType &&
    !SUPPORTED_MIME_PREFIXES.some((p) =>
      input.mimeType!.toLowerCase().startsWith(p),
    )
  ) {
    return { ok: false, reason: "unsupported_format" };
  }

  let raw: ParsedExifRaw | null = null;
  try {
    raw = (await exifr.parse(input.bytes, {
      // Bound what exifr extracts so we don't pull unknown vendor
      // blocks. Each list here is intentionally narrow.
      pick: [
        "DateTimeOriginal",
        "CreateDate",
        "ImageWidth",
        "ImageHeight",
        "ExifImageWidth",
        "ExifImageHeight",
        "Make",
        "Model",
        "Orientation",
        "Software",
        // Photographic EXIF (bounded; numeric/short strings only — these
        // are not free-form prose blocks, so they are PII-safe).
        "LensModel",
        "LensMake",
        "ISO",
        "FNumber",
        "ApertureValue",
        "ExposureTime",
        "ShutterSpeedValue",
        "WhiteBalance",
        "Compression",
        "GPSLatitude",
        "GPSLongitude",
        "GPSLatitudeRef",
        "GPSLongitudeRef",
        "latitude",
        "longitude",
      ],
      // Disable XMP / IPTC / ICC by default — those blocks carry
      // free-form prose (titles, descriptions, copyright fields)
      // that can leak PII or trigger forbidden-wording checks.
      // The bounded EXIF tags above are what operators actually
      // need for the bounded summary.
      tiff: true,
      exif: true,
      gps: true,
      xmp: false,
      iptc: false,
      icc: false,
      ifd1: false,
      // exifr will throw on truly malformed inputs; we catch.
      reviveValues: true,
      translateValues: true,
    })) as ParsedExifRaw | null;
  } catch {
    return { ok: false, reason: "parse_failed" };
  }
  if (!raw) {
    // exifr returns undefined when the input has no recognisable
    // metadata — that's a legitimate "no EXIF" answer, not a parse
    // error.
    return {
      ok: true,
      summary: emptySummary(),
    };
  }

  return { ok: true, summary: projectSafeSummary(raw, input.allowRawGps === true) };
}

// =============================================================================
// Internals
// =============================================================================

type ParsedExifRaw = {
  DateTimeOriginal?: Date | string | null;
  CreateDate?: Date | string | null;
  ImageWidth?: number | null;
  ImageHeight?: number | null;
  ExifImageWidth?: number | null;
  ExifImageHeight?: number | null;
  Make?: string | null;
  Model?: string | null;
  Orientation?: number | string | null;
  Software?: string | null;
  LensModel?: string | null;
  LensMake?: string | null;
  ISO?: number | string | null;
  FNumber?: number | string | null;
  ApertureValue?: number | string | null;
  ExposureTime?: number | string | null;
  ShutterSpeedValue?: number | string | null;
  WhiteBalance?: number | string | null;
  Compression?: number | string | null;
  GPSLatitude?: number | null;
  GPSLongitude?: number | null;
  GPSLatitudeRef?: string | null;
  GPSLongitudeRef?: string | null;
  latitude?: number | null;
  longitude?: number | null;
};

function emptySummary(): ExifSafeSummary {
  return {
    exifPresent: false,
    dateTimeOriginalUtc: null,
    createDateUtc: null,
    dimensions: null,
    cameraMake: null,
    cameraModel: null,
    hasGps: false,
    orientation: null,
    software: null,
    lensModel: null,
    iso: null,
    aperture: null,
    exposureTime: null,
    shutterSpeed: null,
    whiteBalance: null,
    compression: null,
  };
}

function projectSafeSummary(
  raw: ParsedExifRaw,
  allowRawGps: boolean,
): ExifSafeSummary {
  const out: ExifSafeSummary = emptySummary();

  const dto = toUtcIso(raw.DateTimeOriginal);
  if (dto) {
    out.dateTimeOriginalUtc = dto;
    out.exifPresent = true;
  }
  const cd = toUtcIso(raw.CreateDate);
  if (cd) {
    out.createDateUtc = cd;
    out.exifPresent = true;
  }

  const w = pickDimension(raw.ImageWidth, raw.ExifImageWidth);
  const h = pickDimension(raw.ImageHeight, raw.ExifImageHeight);
  if (w !== null && h !== null) {
    out.dimensions = { width: w, height: h };
    out.exifPresent = true;
  }

  const make = sanitizeShortString(raw.Make);
  if (make) {
    out.cameraMake = make;
    out.exifPresent = true;
  }
  const model = sanitizeShortString(raw.Model);
  if (model) {
    out.cameraModel = model;
    out.exifPresent = true;
  }

  const orientation = pickOrientation(raw.Orientation);
  if (orientation !== null) {
    out.orientation = orientation;
    out.exifPresent = true;
  }

  const software = sanitizeShortString(raw.Software);
  if (software) {
    out.software = software;
    out.exifPresent = true;
  }

  // Photographic EXIF — each only sets exifPresent when it parses cleanly.
  const lens = sanitizeShortString(raw.LensModel ?? raw.LensMake);
  if (lens) {
    out.lensModel = lens;
    out.exifPresent = true;
  }
  const iso = clampIso(raw.ISO);
  if (iso !== null) {
    out.iso = iso;
    out.exifPresent = true;
  }
  const aperture = formatAperture(raw.FNumber ?? raw.ApertureValue);
  if (aperture) {
    out.aperture = aperture;
    out.exifPresent = true;
  }
  const exposure = formatSeconds(raw.ExposureTime);
  if (exposure) {
    out.exposureTime = exposure;
    out.exifPresent = true;
  }
  const shutter = formatSeconds(raw.ShutterSpeedValue) ?? exposure;
  if (shutter) {
    out.shutterSpeed = shutter;
    out.exifPresent = true;
  }
  const wb = formatWhiteBalance(raw.WhiteBalance);
  if (wb) {
    out.whiteBalance = wb;
    out.exifPresent = true;
  }
  const compression = sanitizeShortString(
    typeof raw.Compression === "number" ? String(raw.Compression) : raw.Compression,
  );
  if (compression) {
    out.compression = compression;
    out.exifPresent = true;
  }

  const lat = pickLatLon(raw.latitude ?? raw.GPSLatitude, "lat");
  const lon = pickLatLon(raw.longitude ?? raw.GPSLongitude, "lon");
  if (lat !== null && lon !== null) {
    out.hasGps = true;
    out.exifPresent = true;
    if (allowRawGps) {
      out.rawGps = {
        latitude: roundTo(lat, 5),
        longitude: roundTo(lon, 5),
      };
    }
  }

  return out;
}

function clampIso(v: number | string | null | undefined): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  if (n < 1 || n > 4_000_000) return null;
  return Math.round(n);
}

function formatAperture(v: number | string | null | undefined): string | null {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0 || n > 1000) {
    return null;
  }
  return `f/${Math.round(n * 10) / 10}`;
}

/** Format an exposure/shutter value in seconds → "1/200s" or "2s". */
function formatSeconds(v: number | string | null | undefined): string | null {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0 || n > 36_000) {
    return null;
  }
  if (n >= 1) return `${Math.round(n * 10) / 10}s`;
  return `1/${Math.round(1 / n)}s`;
}

function formatWhiteBalance(v: number | string | null | undefined): string | null {
  if (v == null) return null;
  // exifr returns 0 (Auto) / 1 (Manual) for WhiteBalance, or a string.
  if (typeof v === "number") {
    if (v === 0) return "Auto";
    if (v === 1) return "Manual";
    return null;
  }
  return sanitizeShortString(v);
}

function toUtcIso(v: Date | string | null | undefined): string | null {
  if (v == null) return null;
  try {
    const d = v instanceof Date ? v : new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    // EXIF DateTimeOriginal is naive local time — exifr already
    // reviveValues:true returns a Date object. We surface ISO UTC
    // so downstream consumers don't argue about timezone semantics.
    // The naive-vs-tz ambiguity is documented in the safe wording.
    return d.toISOString();
  } catch {
    return null;
  }
}

function pickDimension(
  a: number | null | undefined,
  b: number | null | undefined,
): number | null {
  const candidate = typeof a === "number" ? a : typeof b === "number" ? b : null;
  if (candidate == null) return null;
  if (!Number.isFinite(candidate)) return null;
  if (candidate <= 0) return null;
  if (candidate > 200_000) return null; // sanity ceiling
  return Math.floor(candidate);
}

function sanitizeShortString(v: string | null | undefined): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (s.length === 0) return null;
  // Reject strings with characters outside a safe charset — keeps
  // PII / control codes / forbidden vocabulary out of operator
  // surfaces. The exifr library may surface prose-y fields if the
  // device wrote them in unusual forms; we don't trust that.
  if (!SAFE_STRING_CHARSET.test(s)) return null;
  return s.slice(0, STRING_FIELD_MAX);
}

function pickOrientation(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  if (n < 1 || n > 8) return null;
  return Math.floor(n);
}

function pickLatLon(
  v: number | null | undefined,
  kind: "lat" | "lon",
): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const bound = kind === "lat" ? 90 : 180;
  if (n < -bound || n > bound) return null;
  return n;
}

function roundTo(n: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(n * factor) / factor;
}

// =============================================================================
// Helpers exported for the analyzer / signal emitters
// =============================================================================

/**
 * Compute the bounded gap between the EXIF-recorded capture time
 * and the server-side upload time. Used by the analyzer to decide
 * whether to emit EXIF_TIMESTAMP_MISMATCH.
 */
export function computeExifVsServerGapSeconds(
  exifIso: string | null,
  serverUtc: Date | null,
): number | null {
  if (!exifIso || !serverUtc) return null;
  try {
    const exifMs = new Date(exifIso).getTime();
    const serverMs = serverUtc.getTime();
    if (!Number.isFinite(exifMs) || !Number.isFinite(serverMs)) return null;
    return Math.floor(Math.abs(serverMs - exifMs) / 1000);
  } catch {
    return null;
  }
}
