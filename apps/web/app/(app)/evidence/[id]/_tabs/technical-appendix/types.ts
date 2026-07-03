/**
 * Types for the enterprise Technical Appendix (Evidence Detail).
 *
 * `TechnicalMetadataInternal` mirrors the INTERNAL projection returned by
 * `GET /v1/evidence/:id/technical-metadata` (see
 * services/api/src/services/technical-metadata/verify-projection.service.ts).
 * All labels are already humanized server-side — the UI never renders raw
 * enums.
 */

export type TechnicalMetadataPerPart = {
  partIndex: number;
  filename: string | null;
  role: "Primary" | "Supporting" | "Context";
  mappingLabel: string;
  mediaKind: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  codec: string | null;
  container: string | null;
  pageCount: number | null;
  metadataStatusLabel: string;
};

export type TechnicalMetadataInternal = {
  media: {
    filesAnalyzed: number;
    filesTotal: number;
    metadataStatus: string;
    primaryMediaType: string;
    resolutionSummary: string | null;
  };
  exif: {
    applicable: boolean;
    exifPresent: boolean;
    camera: string | null;
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
    metadataStatus: string;
  } | null;
  captureEnvironment: {
    uploadSource: string | null;
    captureMethod: string | null;
    browserName: string | null;
    browserVersion: string | null;
    osName: string | null;
    osVersion: string | null;
    deviceClass: string | null;
    engine: string | null;
    platform: string | null;
    timezone: string | null;
    locale?: string | null;
    userAgentHash?: string | null;
    ipAddressMasked?: string | null;
  } | null;
  network: {
    country: string | null;
    region?: string | null;
    maskedIp?: string | null;
    networkType?: string | null;
  } | null;
  perParts?: TechnicalMetadataPerPart[] | null;
  exifExtended?: {
    flash: string | null;
    meteringMode: string | null;
    exposureMode: string | null;
    colorSpace: string | null;
    focalLength: string | null;
    focalLength35mm: string | null;
    imageUniqueId: string | null;
  } | null;
  acquisition?: {
    method: string;
    deliveryChannel: string | null;
    submissionType: string;
    submissionStatus: string[];
    identityVerification: string;
    consentAccepted: boolean | null;
    consentVersion: string | null;
    submittedAtUtc: string | null;
    recipientType?: "phone" | "email" | null;
    recipientMasked?: string | null;
    consentAcceptedAtUtc?: string | null;
  } | null;
};

/** A meaningful, already-formatted display row. */
export type AppendixRow = {
  label: string;
  value: string;
  /** Render the value in monospace + expose a copy button (hashes / IDs). */
  mono?: boolean;
  copyable?: boolean;
};
