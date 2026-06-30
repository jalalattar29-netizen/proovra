/**
 * Verify token page — Technical Metadata section.
 *
 * Smart, enterprise rendering: Media / EXIF / Capture Environment /
 * Network cards. Only meaningful rows render (no null / empty / "unknown"
 * rows; a card hides entirely when it has no useful rows). Labels are
 * already humanized by the API projection (never raw enums). No raw GPS
 * coordinates, no raw IP, no raw User-Agent are ever present in this
 * public payload. When EXIF is absent, a short reassuring note is shown
 * instead of empty rows. Renders nothing when the projection is null.
 */

import type { CSSProperties } from "react";

const EXIF_ABSENT_NOTE =
  "Embedded camera metadata was not present in the uploaded file. This is common for downloaded, exported, screenshotted, generated, or stripped files and does not affect the recorded integrity result.";

export type VerifyTechnicalMetadata = {
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
    locale: string | null;
  } | null;
  network: {
    country: string | null;
  } | null;
};

function meaningful(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") {
    const t = v.trim().toUpperCase();
    return t !== "" && t !== "UNKNOWN" && t !== "N/A";
  }
  if (typeof v === "number") return Number.isFinite(v) && v !== 0;
  return true;
}

export function VerifyTechnicalMetadataSection({
  technicalMetadata,
  typo,
  brand,
}: {
  technicalMetadata: VerifyTechnicalMetadata | null;
  typo: Record<string, CSSProperties>;
  brand: Record<string, string>;
}) {
  if (!technicalMetadata) return null;

  const Row = ({ label, value }: { label: string; value: unknown }) =>
    meaningful(value) ? (
      <div style={typo.small}>
        {label}: {String(value)}
      </div>
    ) : null;

  const exif = technicalMetadata.exif;
  const ce = technicalMetadata.captureEnvironment;
  const net = technicalMetadata.network;

  return (
    <div
      data-testid="verify-technical-metadata"
      style={{
        border: "1px solid rgba(11,46,39,0.16)",
        borderRadius: 18,
        padding: 18,
        display: "grid",
        gap: 14,
      }}
    >
      <div style={{ ...typo.kicker, fontSize: 10.5, color: brand.accent }}>
        Technical metadata
      </div>

      {/* Media card */}
      <div data-testid="verify-technical-media" style={{ display: "grid", gap: 4 }}>
        <div style={{ ...typo.small, fontWeight: 700 }}>Media</div>
        <Row label="Primary type" value={technicalMetadata.media.primaryMediaType} />
        <div style={typo.small}>
          Files analysed: {technicalMetadata.media.filesAnalyzed} / {technicalMetadata.media.filesTotal}
        </div>
        <Row label="Resolution / duration / pages" value={technicalMetadata.media.resolutionSummary} />
        <Row label="Metadata status" value={technicalMetadata.media.metadataStatus} />
      </div>

      {/* EXIF card — rich rows when present; reassuring note when absent */}
      {exif && exif.applicable ? (
        <div data-testid="verify-technical-exif" style={{ display: "grid", gap: 4 }}>
          <div style={{ ...typo.small, fontWeight: 700 }}>EXIF (file-embedded metadata)</div>
          {exif.exifPresent ? (
            <>
              <Row label="Camera" value={exif.camera} />
              <Row label="Lens" value={exif.lensModel} />
              <Row label="Original capture time (from file)" value={exif.originalCaptureTime} />
              <Row label="ISO" value={exif.iso} />
              <Row label="Aperture" value={exif.aperture} />
              <Row label="Exposure" value={exif.exposureTime} />
              <Row label="Shutter speed" value={exif.shutterSpeed} />
              <Row label="Orientation" value={exif.orientation} />
              <Row label="Software" value={exif.softwareTag} />
              <div style={typo.small}>
                EXIF GPS: {exif.gpsPresent ? "Present (coordinates withheld)" : "Not present"}
              </div>
              <Row label="Resolution" value={exif.resolution} />
            </>
          ) : (
            <div style={{ ...typo.small, fontSize: 12, opacity: 0.85 }}>{EXIF_ABSENT_NOTE}</div>
          )}
        </div>
      ) : null}

      {/* Capture environment card */}
      {ce ? (
        <div data-testid="verify-technical-capture-env" style={{ display: "grid", gap: 4 }}>
          <div style={{ ...typo.small, fontWeight: 700 }}>Capture environment</div>
          <div style={{ ...typo.small, fontSize: 12, opacity: 0.8 }}>
            How this material entered PROOVRA. This is distinct from the
            file&apos;s embedded metadata above.
          </div>
          <Row label="Submitted through" value={ce.uploadSource} />
          <Row
            label="Browser"
            value={[ce.browserName, ce.browserVersion].filter(Boolean).join(" ") || null}
          />
          <Row
            label="Operating system"
            value={[ce.osName, ce.osVersion].filter(Boolean).join(" ") || null}
          />
          <Row label="Device" value={ce.deviceClass} />
          <Row label="Engine" value={ce.engine} />
          <Row label="Platform" value={ce.platform} />
          <Row label="Timezone" value={ce.timezone} />
        </div>
      ) : null}

      {/* Network card — public shows Country only (when available) */}
      {net && meaningful(net.country) ? (
        <div data-testid="verify-technical-network" style={{ display: "grid", gap: 4 }}>
          <div style={{ ...typo.small, fontWeight: 700 }}>Network</div>
          <Row label="Country" value={net.country} />
        </div>
      ) : null}
    </div>
  );
}
