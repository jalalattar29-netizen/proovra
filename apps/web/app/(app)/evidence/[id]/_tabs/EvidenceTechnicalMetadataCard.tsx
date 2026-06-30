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
    userAgentHash?: string | null;
    ipAddressMasked?: string | null;
    locale?: string | null;
  } | null;
};

function na(v: string | null | undefined): string {
  const t = (v ?? "").trim();
  return t.length > 0 ? t : "Not available";
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
                  items={[
                    { label: "EXIF present", value: "Yes" },
                    { label: "Camera", value: na(data.exif.camera) },
                    {
                      label: "Original capture time (from file)",
                      value: na(data.exif.originalCaptureTime),
                    },
                    {
                      label: "EXIF GPS",
                      value: data.exif.gpsPresent
                        ? "Present (coordinates withheld)"
                        : "Not present",
                    },
                    { label: "Resolution", value: na(data.exif.resolution) },
                    { label: "Software / editor tag", value: na(data.exif.softwareTag) },
                    { label: "Metadata status", value: na(data.exif.metadataStatus) },
                  ]}
                />
              </div>
            ) : (
              <div data-testid="evidence-technical-exif">
                <h3 style={{ margin: "0 0 6px 0", fontSize: 13, fontWeight: 650 }}>
                  EXIF (file-embedded metadata)
                </h3>
                <p className="evidence-detail-muted">
                  No EXIF metadata available for this record.
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
                  items={[
                    { label: "Capture method", value: na(data.captureEnvironment.captureMethod) },
                    { label: "Upload source", value: na(data.captureEnvironment.uploadSource) },
                    { label: "Browser", value: na(data.captureEnvironment.browserName) },
                    { label: "Operating system", value: na(data.captureEnvironment.osName) },
                    { label: "Device class", value: na(data.captureEnvironment.deviceClass) },
                    { label: "Timezone", value: na(data.captureEnvironment.timezone) },
                    { label: "Locale", value: na(data.captureEnvironment.locale) },
                    { label: "Masked IP", value: na(data.captureEnvironment.ipAddressMasked) },
                    {
                      label: "User-Agent hash",
                      value: na(data.captureEnvironment.userAgentHash),
                    },
                  ]}
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
          </div>
        )}
      </div>
    </details>
  );
}
