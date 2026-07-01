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
  /** Public Evidence Acquisition context — never any recipient value. */
  acquisition?: {
    method: string;
    deliveryChannel: string | null;
    submissionType: string;
    submissionStatus: string[];
    identityVerification: string;
    consentAccepted: boolean | null;
    consentVersion: string | null;
    submittedAtUtc: string | null;
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

  // Reviewer-safe Capture Device card only. Camera (the physical device)
  // comes from EXIF; OS/device from the parsed capture environment. NO
  // media-status / resolution / network / IP / UA / engine / platform /
  // EXIF-GPS — those are duplicative or non-public.
  const camera = exif && exif.exifPresent ? exif.camera : null;
  const os = ce ? [ce.osName, ce.osVersion].filter(Boolean).join(" ") || null : null;
  const deviceClass = ce?.deviceClass ?? null;
  const captureTime = exif && exif.exifPresent ? exif.originalCaptureTime : null;

  const hasDevice =
    meaningful(camera) ||
    meaningful(os) ||
    meaningful(deviceClass) ||
    meaningful(captureTime);

  // Public Evidence Acquisition — high-level only. NEVER a recipient value
  // (phone/email/masked/hash), never provider IDs.
  const acq = technicalMetadata.acquisition ?? null;
  const submittedThrough =
    acq?.method === "Direct Upload"
      ? "PROOVRA Web Application"
      : acq?.method === "Intake Link" || acq?.method === "Public Secure Link"
        ? "Secure Intake Link"
        : (acq?.method ?? null);
  const acqStatus = acq?.submissionStatus?.length
    ? acq.submissionStatus.join(" • ")
    : null;
  const hasAcq =
    acq != null &&
    (meaningful(submittedThrough) ||
      meaningful(acq.deliveryChannel) ||
      meaningful(acq.submissionType) ||
      acq.consentAccepted != null);

  if (!hasDevice && !hasAcq) return null;

  const border = "1px solid rgba(11,46,39,0.16)";
  const cardStyle: CSSProperties = {
    border,
    borderRadius: 18,
    padding: 18,
    display: "grid",
    gap: 6,
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {hasAcq ? (
        <div data-testid="verify-evidence-acquisition" style={cardStyle}>
          <div style={{ ...typo.kicker, fontSize: 10.5, color: brand.accent }}>
            Evidence Acquisition
          </div>
          <div style={{ display: "grid", gap: 4 }}>
            <Row label="Submitted through" value={submittedThrough} />
            <Row label="Delivery Channel" value={acq!.deliveryChannel} />
            <Row label="Submission" value={acq!.submissionType} />
            <Row
              label="Consent"
              value={acq!.consentAccepted === true ? "Accepted" : null}
            />
            <Row label="Submission Status" value={acqStatus} />
          </div>
        </div>
      ) : null}

      {hasDevice ? (
        <div data-testid="verify-technical-metadata" style={cardStyle}>
          <div style={{ ...typo.kicker, fontSize: 10.5, color: brand.accent }}>
            Capture device
          </div>
          <div data-testid="verify-technical-capture-device" style={{ display: "grid", gap: 4 }}>
            <Row label="Capture Device" value={camera} />
            <Row label="Operating system" value={os} />
            <Row label="Device" value={deviceClass} />
            <Row label="EXIF Original Capture Time" value={captureTime} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
