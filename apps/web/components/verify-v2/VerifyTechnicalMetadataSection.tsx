/**
 * Verify token page — Technical Metadata section (CR4 extraction).
 *
 * Extracted VERBATIM from `apps/web/app/verify/[token]/page.tsx` to keep
 * the orchestrator under its byte-pin. ZERO behaviour change: same
 * privacy-safe Media / EXIF / Capture Environment cards, same testids,
 * same "Not available" fallbacks. No raw GPS coordinates, no raw IP, no
 * raw User-Agent are ever present in this payload. Renders nothing when
 * the projection is null.
 *
 * `typo` / `brand` are passed in from the orchestrator so the verify
 * design tokens stay single-source on the page.
 */

import type { CSSProperties } from "react";

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
    camera: string | null;
    originalCaptureTime: string | null;
    gpsPresent: boolean;
    resolution: string | null;
    softwareTag: string | null;
    metadataStatus: string;
  } | null;
  captureEnvironment: {
    uploadSource: string | null;
    captureMethod: string | null;
    browserName: string | null;
    osName: string | null;
    deviceClass: string | null;
    timezone: string | null;
  } | null;
};

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
        <div style={typo.small}>
          Files analysed: {technicalMetadata.media.filesAnalyzed} / {technicalMetadata.media.filesTotal}
        </div>
        <div style={typo.small}>
          Primary type: {technicalMetadata.media.primaryMediaType}
        </div>
        <div style={typo.small}>
          Resolution / duration / pages: {technicalMetadata.media.resolutionSummary || "Not available"}
        </div>
        <div style={typo.small}>
          Metadata status: {technicalMetadata.media.metadataStatus}
        </div>
      </div>

      {/* EXIF card — only when applicable */}
      {technicalMetadata.exif && technicalMetadata.exif.applicable ? (
        <div data-testid="verify-technical-exif" style={{ display: "grid", gap: 4 }}>
          <div style={{ ...typo.small, fontWeight: 700 }}>EXIF (file-embedded metadata)</div>
          <div style={typo.small}>
            Camera: {technicalMetadata.exif.camera || "Not available"}
          </div>
          <div style={typo.small}>
            Original capture time (from file): {technicalMetadata.exif.originalCaptureTime || "Not available"}
          </div>
          <div style={typo.small}>
            EXIF GPS: {technicalMetadata.exif.gpsPresent ? "Present (coordinates withheld)" : "Not present"}
          </div>
          <div style={typo.small}>
            Resolution: {technicalMetadata.exif.resolution || "Not available"}
          </div>
          <div style={typo.small}>
            Software / editor tag: {technicalMetadata.exif.softwareTag || "Not available"}
          </div>
        </div>
      ) : null}

      {/* Capture environment card */}
      {technicalMetadata.captureEnvironment ? (
        <div data-testid="verify-technical-capture-env" style={{ display: "grid", gap: 4 }}>
          <div style={{ ...typo.small, fontWeight: 700 }}>Capture environment</div>
          <div style={{ ...typo.small, fontSize: 12, opacity: 0.8 }}>
            How this material entered PROOVRA. This is distinct from the
            file&apos;s embedded metadata above.
          </div>
          <div style={typo.small}>
            Submitted via: {technicalMetadata.captureEnvironment.uploadSource || "Not available"}
          </div>
          <div style={typo.small}>
            Browser / OS: {[technicalMetadata.captureEnvironment.browserName, technicalMetadata.captureEnvironment.osName].filter(Boolean).join(" on ") || "Not available"}
          </div>
          <div style={typo.small}>
            Device class: {technicalMetadata.captureEnvironment.deviceClass || "Not available"}
          </div>
          <div style={typo.small}>
            Timezone at submission: {technicalMetadata.captureEnvironment.timezone || "Not available"}
          </div>
        </div>
      ) : null}
    </div>
  );
}
