/**
 * Enterprise Technical Metadata layer — internal Evidence Detail card.
 *
 * Compact Media / EXIF / Capture Environment surface for authenticated
 * workspace reviewers. Self-contained: fetches the privacy-safe internal
 * projection from `GET /v1/evidence/:id/technical-metadata` so it does
 * not need to be threaded through the page view-model.
 *
 * Privacy rules (enforced by the API projection):
 *   * No raw IP — masked IP only (e.g. "203.0.x.x").
 *   * No raw User-Agent — a UA hash only.
 *   * No EXIF GPS coordinates — a "Present / Not present" flag only.
 *   * EXIF capture time is labelled as file-embedded, distinct from the
 *     PROOVRA upload/capture time in the Capture Environment block.
 */

"use client";

import { useEffect, useState } from "react";
import { Cpu } from "lucide-react";
import { apiFetch } from "../../../../../lib/api";
import { KeyValueGrid } from "./_lib";

type VerifyTechnicalMetadata = {
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
    userAgentHash?: string | null;
    ipAddressMasked?: string | null;
  } | null;
  network: {
    country: string | null;
    region?: string | null;
    maskedIp?: string | null;
    networkType?: string | null;
  } | null;
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

function na(v: string | null | undefined): string {
  const t = (v ?? "").trim();
  return t.length > 0 ? t : "Not available";
}

/** Drop rows whose value is empty / "Not available" so the internal card
 *  never shows hollow rows. */
function meaningfulRows(
  items: Array<{ label: string; value: string }>,
): Array<{ label: string; value: string }> {
  return items.filter((r) => {
    const t = (r.value ?? "").trim().toUpperCase();
    return t !== "" && t !== "NOT AVAILABLE" && t !== "UNKNOWN";
  });
}

export function EvidenceTechnicalMetadataCard({
  evidenceId,
}: {
  evidenceId: string;
}) {
  const [data, setData] = useState<VerifyTechnicalMetadata | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = (await apiFetch(
          `/v1/evidence/${encodeURIComponent(evidenceId)}/technical-metadata`,
        )) as { technicalMetadata: VerifyTechnicalMetadata | null };
        if (cancelled) return;
        setData(res?.technicalMetadata ?? null);
        setState("ready");
      } catch {
        if (cancelled) return;
        setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [evidenceId]);

  return (
    <details data-evidence-technical-block="technical-metadata" style={{ marginBottom: 8 }}>
      <summary className="evidence-detail-raw-summary">
        <Cpu size={14} style={{ marginRight: 6, verticalAlign: "middle" }} />
        Technical metadata (media, EXIF, capture environment)
      </summary>
      <div data-testid="evidence-technical-metadata" style={{ marginTop: 8 }}>
        {state === "loading" ? (
          <p className="evidence-detail-muted">Loading technical metadata…</p>
        ) : state === "error" || !data ? (
          <p className="evidence-detail-muted">
            Technical metadata is not available for this record.
          </p>
        ) : (
          <div style={{ display: "grid", gap: 14 }}>
            {/* Media */}
            <div data-testid="evidence-technical-media">
              <h3 style={{ margin: "0 0 6px 0", fontSize: 13, fontWeight: 650 }}>
                Media
              </h3>
              <KeyValueGrid
                items={[
                  { label: "Primary media type", value: na(data.media.primaryMediaType) },
                  {
                    label: "Files analysed",
                    value: `${data.media.filesAnalyzed} / ${data.media.filesTotal}`,
                  },
                  {
                    label: "Resolution / duration / pages",
                    value: na(data.media.resolutionSummary),
                  },
                  { label: "Metadata status", value: na(data.media.metadataStatus) },
                ]}
              />
            </div>

            {/* EXIF — only when applicable */}
            {data.exif && data.exif.applicable ? (
              <div data-testid="evidence-technical-exif">
                <h3 style={{ margin: "0 0 6px 0", fontSize: 13, fontWeight: 650 }}>
                  EXIF (file-embedded metadata)
                </h3>
                <KeyValueGrid
                  items={meaningfulRows([
                    { label: "Camera", value: na(data.exif.camera) },
                    { label: "Lens", value: na(data.exif.lensModel) },
                    {
                      label: "EXIF Original Capture Time",
                      value: na(data.exif.originalCaptureTime),
                    },
                    { label: "ISO", value: data.exif.iso != null ? String(data.exif.iso) : "Not available" },
                    { label: "Aperture", value: na(data.exif.aperture) },
                    { label: "Exposure", value: na(data.exif.exposureTime) },
                    { label: "Shutter speed", value: na(data.exif.shutterSpeed) },
                    { label: "White balance", value: na(data.exif.whiteBalance) },
                    {
                      label: "Orientation",
                      value: data.exif.orientation != null ? String(data.exif.orientation) : "Not available",
                    },
                    {
                      label: "EXIF GPS",
                      value: data.exif.gpsPresent
                        ? "Present (coordinates withheld)"
                        : "Not present",
                    },
                    { label: "Resolution", value: na(data.exif.resolution) },
                    { label: "Software / editor tag", value: na(data.exif.softwareTag) },
                  ])}
                />
                {data.exifExtended &&
                meaningfulRows([
                  { label: "Flash", value: na(data.exifExtended.flash) },
                  { label: "Metering mode", value: na(data.exifExtended.meteringMode) },
                  { label: "Exposure mode", value: na(data.exifExtended.exposureMode) },
                  { label: "Colour space", value: na(data.exifExtended.colorSpace) },
                  { label: "Focal length", value: na(data.exifExtended.focalLength) },
                  { label: "Focal length (35mm)", value: na(data.exifExtended.focalLength35mm) },
                  { label: "Image unique ID", value: na(data.exifExtended.imageUniqueId) },
                ]).length > 0 ? (
                  <div data-testid="evidence-technical-exif-extended" style={{ marginTop: 8 }}>
                    <KeyValueGrid
                      items={meaningfulRows([
                        { label: "Flash", value: na(data.exifExtended.flash) },
                        { label: "Metering mode", value: na(data.exifExtended.meteringMode) },
                        { label: "Exposure mode", value: na(data.exifExtended.exposureMode) },
                        { label: "Colour space", value: na(data.exifExtended.colorSpace) },
                        { label: "Focal length", value: na(data.exifExtended.focalLength) },
                        { label: "Focal length (35mm)", value: na(data.exifExtended.focalLength35mm) },
                        { label: "Image unique ID", value: na(data.exifExtended.imageUniqueId) },
                      ])}
                    />
                  </div>
                ) : null}
              </div>
            ) : (
              <div data-testid="evidence-technical-exif">
                <h3 style={{ margin: "0 0 6px 0", fontSize: 13, fontWeight: 650 }}>
                  EXIF (file-embedded metadata)
                </h3>
                <p className="evidence-detail-muted">
                  No embedded camera metadata was present in the uploaded file.
                  This is common for downloaded, exported, screenshotted,
                  generated, or stripped files and does not affect the recorded
                  integrity result.
                </p>
              </div>
            )}

            {/* Capture environment */}
            {data.captureEnvironment ? (
              <div data-testid="evidence-technical-capture-env">
                <h3 style={{ margin: "0 0 2px 0", fontSize: 13, fontWeight: 650 }}>
                  Capture environment
                </h3>
                <p
                  className="evidence-detail-muted"
                  style={{ margin: "0 0 6px 0", fontSize: 12 }}
                >
                  How this material entered PROOVRA — distinct from the file&apos;s
                  embedded metadata above and from the preservation state.
                </p>
                <KeyValueGrid
                  items={meaningfulRows([
                    { label: "Submitted through", value: na(data.captureEnvironment.uploadSource) },
                    { label: "Capture method", value: na(data.captureEnvironment.captureMethod) },
                    {
                      label: "Browser",
                      value: na(
                        [data.captureEnvironment.browserName, data.captureEnvironment.browserVersion]
                          .filter(Boolean)
                          .join(" ") || null,
                      ),
                    },
                    {
                      label: "Operating system",
                      value: na(
                        [data.captureEnvironment.osName, data.captureEnvironment.osVersion]
                          .filter(Boolean)
                          .join(" ") || null,
                      ),
                    },
                    { label: "Device class", value: na(data.captureEnvironment.deviceClass) },
                    { label: "Engine", value: na(data.captureEnvironment.engine) },
                    { label: "Platform", value: na(data.captureEnvironment.platform) },
                    { label: "Timezone", value: na(data.captureEnvironment.timezone) },
                    { label: "Locale", value: na(data.captureEnvironment.locale) },
                    { label: "Masked IP", value: na(data.captureEnvironment.ipAddressMasked) },
                    {
                      label: "User-Agent hash",
                      value: na(data.captureEnvironment.userAgentHash),
                    },
                  ])}
                />
              </div>
            ) : (
              <div data-testid="evidence-technical-capture-env">
                <h3 style={{ margin: "0 0 6px 0", fontSize: 13, fontWeight: 650 }}>
                  Capture environment
                </h3>
                <p className="evidence-detail-muted">
                  No capture environment was recorded for this record.
                </p>
              </div>
            )}

            {/* Network — internal: masked IP + country/region + type */}
            {data.network &&
            meaningfulRows([
              { label: "Masked IP", value: na(data.network.maskedIp) },
              { label: "Country", value: na(data.network.country) },
              { label: "Region", value: na(data.network.region) },
              { label: "Network type", value: na(data.network.networkType) },
            ]).length > 0 ? (
              <div data-testid="evidence-technical-network">
                <h3 style={{ margin: "0 0 6px 0", fontSize: 13, fontWeight: 650 }}>
                  Network
                </h3>
                <KeyValueGrid
                  items={meaningfulRows([
                    { label: "Masked IP", value: na(data.network.maskedIp) },
                    { label: "Country", value: na(data.network.country) },
                    { label: "Region", value: na(data.network.region) },
                    { label: "Network type", value: na(data.network.networkType) },
                  ])}
                />
              </div>
            ) : null}

            {/* Evidence Acquisition — masked recipient only (never full
                phone/email; never provider IDs). */}
            {data.acquisition ? (
              <div data-testid="evidence-technical-acquisition">
                <h3 style={{ margin: "0 0 2px 0", fontSize: 13, fontWeight: 650 }}>
                  Evidence Acquisition
                </h3>
                <p className="evidence-detail-muted">
                  How the contributor was reached and how the evidence entered
                  PROOVRA. The recipient is masked; the full phone/email is never
                  shown here.
                </p>
                <KeyValueGrid
                  items={meaningfulRows([
                    { label: "Method", value: na(data.acquisition.method) },
                    { label: "Channel", value: na(data.acquisition.deliveryChannel) },
                    {
                      label: "Recipient",
                      value: na(data.acquisition.recipientMasked ?? null),
                    },
                    {
                      label: "Status",
                      value: na(
                        data.acquisition.submissionStatus.length
                          ? data.acquisition.submissionStatus.join(" • ")
                          : null,
                      ),
                    },
                    {
                      label: "Consent",
                      value:
                        data.acquisition.consentAccepted === true
                          ? "Accepted"
                          : "Not recorded",
                    },
                    {
                      label: "Submitted",
                      value: na(data.acquisition.submittedAtUtc),
                    },
                  ])}
                />
              </div>
            ) : null}
          </div>
        )}
      </div>
    </details>
  );
}
