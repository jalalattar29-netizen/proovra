/**
 * Enterprise Technical Metadata layer — shared types.
 *
 * Three DISTINCT concepts, never to be conflated (see audit doc
 * docs/operations/media-intelligence-exif-capture-environment-enterprise-audit.md):
 *
 *   1. TechnicalMetadata   — deterministic Layer-1 facts about the
 *                            FILE itself (MIME, dimensions, codec,
 *                            embedded EXIF presence). Produced by a
 *                            byte-parser in the worker.
 *   2. ExifSummary         — reviewer-facing subset of the file's
 *                            embedded camera/device metadata. Derived
 *                            from TechnicalMetadata. Image/video only.
 *   3. CaptureEnvironment  — the PROOVRA upload/capture environment
 *                            (browser/OS/device/timezone). Recorded at
 *                            ingest time. NOT the file's metadata.
 *
 * These are also distinct from PRESERVATION state (OTS / RFC3161 /
 * Bitcoin anchoring / report signature), which lives elsewhere.
 *
 * Privacy invariants enforced by construction:
 *   * No raw GPS coordinates in any reviewer-facing shape — only a
 *     `gpsPresent` boolean.
 *   * No raw IP, no raw User-Agent in CaptureEnvironment — only a
 *     masked IP and a UA hash.
 *
 * This module is dependency-light (only node:crypto) so api, worker,
 * and web can all import the types and the pure projections.
 */

export const TECHNICAL_METADATA_SCHEMA_VERSION = "1.0" as const;

export type MediaKind = "IMAGE" | "VIDEO" | "AUDIO" | "PDF" | "OTHER";

/** Completeness verdict for the file's embedded metadata. */
export type MetadataStatus =
  | "PRESENT"
  | "PARTIAL"
  | "MISSING"
  | "CONFLICT"
  | "UNKNOWN";

/** Did the byte-parser run cleanly? */
export type ParseResult = "OK" | "FAILED" | "UNSUPPORTED";

/**
 * Single flat shape (rather than a discriminated union) so the
 * package/report/verify renderers can read fields uniformly and
 * gracefully show "Not available" for any null. `mediaKind` tells the
 * renderer which fields are meaningful.
 *
 * All fields beyond the base four are optional/null. Strings are
 * expected to be bounded by the producing parser (≤ 128 chars).
 */
export type TechnicalMetadata = {
  schemaVersion: typeof TECHNICAL_METADATA_SCHEMA_VERSION;
  mediaKind: MediaKind;
  mimeType: string | null;
  parseResult: ParseResult;
  metadataStatus: MetadataStatus;
  parserName: string;
  parserVersion: string;

  // ---- Image / video shared ----
  widthPx?: number | null;
  heightPx?: number | null;

  // ---- Image ----
  colorSpace?: string | null;
  exifPresent?: boolean | null;
  cameraMake?: string | null;
  cameraModel?: string | null;
  /** Embedded original-capture time (EXIF DateTimeOriginal) — ISO-8601. */
  originalCaptureTime?: string | null;
  /** Presence flag ONLY — raw coordinates are never carried. */
  gpsPresent?: boolean | null;
  softwareTag?: string | null;
  orientation?: number | null;
  // Rich EXIF (camera/photographic). Present only when the source file
  // carried them; bounded strings. GPS stays a presence flag only.
  lensModel?: string | null;
  iso?: number | null;
  aperture?: string | null;
  exposureTime?: string | null;
  shutterSpeed?: string | null;
  whiteBalance?: string | null;
  compression?: string | null;
  flash?: string | null;
  meteringMode?: string | null;
  exposureMode?: string | null;
  focalLength?: string | null;
  focalLength35mm?: string | null;
  imageUniqueId?: string | null;

  // ---- Video / audio ----
  /** Container/format label, e.g. "mov,mp4,m4a,3gp" or "matroska,webm". */
  container?: string | null;
  durationMs?: number | null;
  videoCodec?: string | null;
  audioCodec?: string | null;
  frameRate?: number | null;
  bitrate?: number | null;
  /** Container creation-time metadata — ISO-8601. */
  creationTime?: string | null;
  streamCount?: number | null;

  // ---- PDF ----
  pageCount?: number | null;
  producer?: string | null;
  creator?: string | null;
  creationDate?: string | null;
  modificationDate?: string | null;
  encrypted?: boolean | null;
  signed?: boolean | null;
};

/** Reviewer-facing EXIF summary (image/video only). */
export type ExifSummary = {
  applicable: boolean;
  exifPresent: boolean;
  cameraMake: string | null;
  cameraModel: string | null;
  lensModel: string | null;
  originalCaptureTime: string | null;
  iso: number | null;
  aperture: string | null;
  exposureTime: string | null;
  shutterSpeed: string | null;
  whiteBalance: string | null;
  orientation: number | null;
  gpsPresent: boolean;
  resolution: string | null;
  softwareTag: string | null;
  compression: string | null;
  // Extended photographic EXIF (package/internal only — never on public
  // surfaces). Present only when the source file carried them.
  flash: string | null;
  meteringMode: string | null;
  exposureMode: string | null;
  colorSpace: string | null;
  focalLength: string | null;
  focalLength35mm: string | null;
  imageUniqueId: string | null;
  metadataStatus: MetadataStatus;
};

export type CaptureMethodLabel =
  | "SECURE_CAPTURE"
  | "UPLOAD"
  | "INTAKE_LINK"
  | "API"
  | "MOBILE"
  | "UNKNOWN";

export type UploadSource =
  | "WEB_APP"
  | "MOBILE_APP"
  | "INTAKE_LINK"
  | "API"
  | "UNKNOWN";

export type DeviceClass =
  | "DESKTOP"
  | "MOBILE"
  | "TABLET"
  | "SERVER"
  | "UNKNOWN";

/**
 * Privacy-safe capture environment. NEVER contains raw IP or raw UA.
 * Persisted on Evidence.captureEnvironment and surfaced (selectively)
 * in the package, report, and verify page.
 */
export type CaptureEnvironment = {
  schemaVersion: typeof TECHNICAL_METADATA_SCHEMA_VERSION;
  captureMethod: CaptureMethodLabel;
  uploadSource: UploadSource;
  browserName: string | null;
  browserVersion: string | null;
  osName: string | null;
  osVersion: string | null;
  deviceClass: DeviceClass;
  /** Rendering engine parsed from the UA: Blink / WebKit / Gecko / null. */
  engine: string | null;
  /** Platform/arch parsed from the UA: "Windows x64" / "macOS" / "iOS" /
   *  "Android" / "Linux" / null. */
  platform: string | null;
  timezone: string | null;
  locale: string | null;
  /** SHA-256 of the raw UA, prefixed "sha256:". Never the raw UA. */
  userAgentHash: string | null;
  /** Masked IP, e.g. "203.0.x.x" / "2001:db8:…". Never the raw IP. */
  ipAddressMasked: string | null;
  // Privacy-safe network summary. Country/region come from the existing
  // geo service when available (never the raw IP). networkType defaults
  // to "UNKNOWN". Full IP / ASN / ISP / VPN are NOT collected.
  country: string | null;
  region: string | null;
  networkType: string | null;
  /** Which request field the IP was read from (e.g. "req.ip"). */
  ipSourceHeader: string | null;
  attestationAttempted: boolean;
  attestationResult: string | null;
};
