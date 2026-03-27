"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import {
  Button,
  Card,
  useToast,
  EmptyState,
  Skeleton,
} from "../../../components/ui";
import { SilverWatermarkSection } from "../../../components/SilverWatermarkSection";
import { useLocale } from "../../providers";
import { apiFetch } from "../../../lib/api";
import { captureException } from "../../../lib/sentry";

type VerifyResponse = {
  fileSha256?: string | null;
  fingerprintHash?: string | null;
  signatureBase64?: string | null;
  custodyEvents?: Array<{
    eventType?: string | null;
    atUtc?: string | null;
    payloadSummary?: string | null;
  }>;
  status?: string | null;
  evidenceId?: string | null;
  id?: string | null;
  reportGeneratedAtUtc?: string | null;
  generatedAtUtc?: string | null;
  verifiedAtUtc?: string | null;
  verificationCheckedAtUtc?: string | null;
  mimeType?: string | null;
  reportVersion?: number | string | null;
  signingKeyId?: string | null;
  tsaStatus?: string | null;
  timestampStatus?: string | null;
  stampStatus?: string | null;
  publicKeyPem?: string | null;
  tsaProvider?: string | null;
  tsaUrl?: string | null;
  tsaSerialNumber?: string | null;
  tsaGenTimeUtc?: string | null;
  tsaHashAlgorithm?: string | null;
  tsa?: {
    status?: string | null;
    provider?: string | null;
    genTimeUtc?: string | null;
    url?: string | null;
    serialNumber?: string | null;
    hashAlgorithm?: string | null;
  } | null;
  timestamp?: {
    status?: string | null;
    provider?: string | null;
    genTimeUtc?: string | null;
    url?: string | null;
    serialNumber?: string | null;
    hashAlgorithm?: string | null;
  } | null;
};

type TimelineItem = {
  eventType: string;
  atUtc: string | null;
  payloadSummary: string | null;
};

type ToastFn = (
  message: string,
  type: "success" | "info" | "error" | "warning",
  duration?: number
) => void;

function formatDateTime(value?: string | null): string {
  if (!value) return "N/A";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function shortText(value: string, head = 14, tail = 10): string {
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function normalizeEventLabel(value?: string | null): string {
  if (!value) return "Unknown Event";
  return value
    .toLowerCase()
    .split("_")
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(" ");
}

function extractTimestampStatus(data: VerifyResponse): string | null {
  const raw =
    data.tsaStatus ??
    data.timestampStatus ??
    data.stampStatus ??
    data.tsa?.status ??
    data.timestamp?.status ??
    null;

  if (!raw || !String(raw).trim()) return null;
  return String(raw).trim().toUpperCase();
}

function findEventTime(
  timeline: TimelineItem[],
  eventNames: string[]
): string | null {
  const targets = new Set(eventNames.map((v) => v.toUpperCase()));

  const matched = timeline
    .filter((item) => targets.has((item.eventType ?? "").toUpperCase()) && item.atUtc)
    .sort((a, b) => {
      const ta = a.atUtc ? new Date(a.atUtc).getTime() : 0;
      const tb = b.atUtc ? new Date(b.atUtc).getTime() : 0;
      return tb - ta;
    });

  return matched[0]?.atUtc ?? null;
}

function statusTone(
  status?: string | null
): { label: string; bg: string; color: string; border: string } {
  const s = (status ?? "").toUpperCase();

  if (
    s === "GRANTED" ||
    s === "STAMPED" ||
    s === "VERIFIED" ||
    s === "SUCCEEDED"
  ) {
    return {
      label: s || "VERIFIED",
      bg: "#ECFDF3",
      color: "#067647",
      border: "#ABEFC6",
    };
  }

  if (s === "PENDING") {
    return {
      label: "PENDING",
      bg: "#FFFAEB",
      color: "#B54708",
      border: "#FAD7A0",
    };
  }

  if (s) {
    return {
      label: s,
      bg: "#FEF3F2",
      color: "#B42318",
      border: "#FECDCA",
    };
  }

  return {
    label: "AVAILABLE",
    bg: "#F8F9FC",
    color: "#344054",
    border: "#D0D5DD",
  };
}

function timestampTone(
  status?: string | null
): { label: string; tone: "success" | "warning" | "neutral" } {
  const s = (status ?? "").toUpperCase();

  if (s === "STAMPED") {
    return { label: "STAMPED", tone: "success" };
  }

  if (s === "GRANTED") {
    return { label: "GRANTED", tone: "success" };
  }

  if (s === "PENDING") {
    return { label: "PENDING", tone: "warning" };
  }

  if (s) {
    return { label: s, tone: "warning" };
  }

  return { label: "Unavailable", tone: "neutral" };
}

function CopyMiniButton({
  value,
  successMessage,
  addToast,
}: {
  value: string;
  successMessage: string;
  addToast: ToastFn;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(value);
        addToast(successMessage, "success");
      }}
      style={{
        border: "1px solid #D0D5DD",
        background: "#FFFFFF",
        color: "#344054",
        borderRadius: 10,
        padding: "6px 10px",
        fontSize: 12,
        fontWeight: 600,
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      Copy
    </button>
  );
}

function Badge({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: "success" | "neutral" | "info" | "warning";
}) {
  const palette =
    tone === "success"
      ? { bg: "#ECFDF3", color: "#067647", border: "#ABEFC6" }
      : tone === "info"
        ? { bg: "#EFF8FF", color: "#175CD3", border: "#B2DDFF" }
        : tone === "warning"
          ? { bg: "#FFFAEB", color: "#B54708", border: "#FAD7A0" }
          : { bg: "#F2F4F7", color: "#344054", border: "#D0D5DD" };

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "7px 11px",
        borderRadius: 999,
        border: `1px solid ${palette.border}`,
        background: palette.bg,
        color: palette.color,
        fontSize: 12,
        fontWeight: 700,
        lineHeight: 1,
      }}
    >
      {label}
    </span>
  );
}

function SummaryField({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div
      style={{
        padding: 14,
        borderRadius: 14,
        border: "1px solid #EAECF0",
        background: "#FFFFFF",
        minHeight: 74,
      }}
    >
      <div
        style={{
          fontSize: 12,
          color: "#667085",
          fontWeight: 600,
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 14,
          color: "#101828",
          fontWeight: 700,
          lineHeight: 1.45,
          wordBreak: "break-word",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function MaterialField({
  label,
  value,
  addToast,
  copyMessage,
  subtitle,
}: {
  label: string;
  value: string;
  addToast: ToastFn;
  copyMessage: string;
  subtitle?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const long = value.length > 180;
  const shown = expanded || !long ? value : `${value.slice(0, 180)}...`;

  return (
    <div
      style={{
        border: "1px solid #E4E7EC",
        background: "#FCFCFD",
        borderRadius: 16,
        padding: 16,
        display: "grid",
        gap: 10,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 12,
              color: "#667085",
              fontWeight: 700,
              marginBottom: subtitle ? 4 : 0,
            }}
          >
            {label}
          </div>
          {subtitle ? (
            <div
              style={{
                fontSize: 12,
                color: "#98A2B3",
                lineHeight: 1.45,
              }}
            >
              {subtitle}
            </div>
          ) : null}
        </div>

        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          <CopyMiniButton
            value={value}
            successMessage={copyMessage}
            addToast={addToast}
          />
          {long ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              style={{
                border: "1px solid #D0D5DD",
                background: "#FFFFFF",
                color: "#344054",
                borderRadius: 10,
                padding: "6px 10px",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {expanded ? "Collapse" : "Expand"}
            </button>
          ) : null}
        </div>
      </div>

      <div
        style={{
          padding: 14,
          borderRadius: 12,
          border: "1px solid #EAECF0",
          background: "#F8FAFC",
          fontSize: 12,
          color: "#344054",
          fontFamily:
            'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
          lineHeight: 1.65,
          wordBreak: "break-all",
        }}
      >
        {shown}
      </div>
    </div>
  );
}

export default function VerifyPage() {
  const { t } = useLocale();
  const params = useParams<{ token: string }>();
  const { addToast } = useToast();

  const [hash, setHash] = useState<string | null>(null);
  const [fingerprintHash, setFingerprintHash] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [evidenceId, setEvidenceId] = useState<string | null>(null);
  const [mimeType, setMimeType] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [verifiedAt, setVerifiedAt] = useState<string | null>(null);
  const [reportVersion, setReportVersion] = useState<string | null>(null);
  const [tsaStatus, setTsaStatus] = useState<string | null>(null);
  const [publicKeyPem, setPublicKeyPem] = useState<string | null>(null);
  const [verifyStatus, setVerifyStatus] = useState<string | null>(null);
  const [signingKeyId, setSigningKeyId] = useState<string | null>(null);

  useEffect(() => {
    if (!params?.token) return;

    setLoading(true);
    setError(null);

    apiFetch(`/public/verify/${params.token}`)
      .then((data: VerifyResponse) => {
        const resolvedTsaStatus = extractTimestampStatus(data);

        const mappedTimeline = (data.custodyEvents ?? []).map((ev) => ({
          eventType: ev.eventType ?? "UNKNOWN_EVENT",
          atUtc: ev.atUtc ?? null,
          payloadSummary: ev.payloadSummary ?? null,
        }));

        const generatedAtFallback =
          data.reportGeneratedAtUtc ??
          data.generatedAtUtc ??
          data.tsaGenTimeUtc ??
          data.tsa?.genTimeUtc ??
          data.timestamp?.genTimeUtc ??
          findEventTime(mappedTimeline, ["REPORT_GENERATED"]) ??
          null;

        const verifiedAtFallback =
          data.verifiedAtUtc ??
          data.verificationCheckedAtUtc ??
          findEventTime(mappedTimeline, ["VERIFY_VIEWED", "EVIDENCE_VIEWED"]) ??
          null;

        setHash(data.fileSha256 ?? null);
        setFingerprintHash(data.fingerprintHash ?? null);
        setSignature(data.signatureBase64 ?? null);
        setVerifyStatus(data.status ?? "VERIFIED");
        setEvidenceId(data.evidenceId ?? data.id ?? params.token ?? null);
        setMimeType(data.mimeType ?? null);
        setGeneratedAt(generatedAtFallback);
        setVerifiedAt(verifiedAtFallback);
        setReportVersion(
          data.reportVersion !== undefined && data.reportVersion !== null
            ? String(data.reportVersion)
            : null
        );
        setTsaStatus(resolvedTsaStatus);
        setPublicKeyPem(data.publicKeyPem ?? null);
        setSigningKeyId(data.signingKeyId ?? null);
        setTimeline(mappedTimeline);

        addToast("Evidence verified successfully", "success");
      })
      .catch((err) => {
        captureException(err, { feature: "web_verify", token: params.token });
        const message = err instanceof Error ? err.message : "Verification failed";
        setError(message);
        addToast(message, "error");
      })
      .finally(() => {
        setLoading(false);
      });
  }, [params?.token, t, addToast]);

  const verificationBadges = useMemo(() => {
    const ts = (tsaStatus ?? "").toUpperCase();

    return [
      { label: "Hash Matched", tone: "success" as const, show: Boolean(hash) },
      {
        label: "Signature Verified",
        tone: "success" as const,
        show: Boolean(signature),
      },
      {
        label:
          ts === "STAMPED"
            ? "Timestamp Stamped"
            : ts === "GRANTED"
              ? "Timestamp Granted"
              : ts
                ? `Timestamp ${ts}`
                : "Timestamp Unavailable",
        tone:
          ts === "STAMPED" || ts === "GRANTED"
            ? ("success" as const)
            : ts
              ? ("warning" as const)
              : ("neutral" as const),
        show: true,
      },
      {
        label:
          timeline.length > 0 ? "Custody Trail Available" : "Custody Trail Pending",
        tone: timeline.length > 0 ? ("info" as const) : ("neutral" as const),
        show: true,
      },
    ].filter((item) => item.show);
  }, [hash, signature, tsaStatus, timeline.length]);

  const summaryFields = useMemo(
    () =>
      [
        {
          label: "Verification Status",
          value: statusTone(verifyStatus).label,
          show: true,
        },
        {
          label: "Evidence ID",
          value: evidenceId ?? params?.token ?? "N/A",
          show: true,
        },
        {
          label: "Generated At",
          value: generatedAt ? formatDateTime(generatedAt) : "N/A",
          show: Boolean(generatedAt),
        },
        {
          label: "Verification Checked At",
          value: verifiedAt ? formatDateTime(verifiedAt) : "N/A",
          show: Boolean(verifiedAt),
        },
        {
          label: "File Type",
          value: mimeType ?? "N/A",
          show: Boolean(mimeType),
        },
        {
          label: "Report Version",
          value: reportVersion ?? "N/A",
          show: Boolean(reportVersion),
        },
      ].filter((item) => item.show),
    [verifyStatus, evidenceId, params?.token, generatedAt, verifiedAt, mimeType, reportVersion]
  );

  return (
    <div className="page">
      <SilverWatermarkSection
        className="section"
        style={{
          position: "relative",
          overflow: "hidden",
          paddingTop: 20,
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "linear-gradient(180deg, rgba(248,250,252,0.96) 0%, rgba(248,250,252,0.985) 52%, rgba(248,250,252,0.995) 100%)",
            pointerEvents: "none",
          }}
        />
        <div
          style={{
            position: "absolute",
            right: "-6%",
            bottom: "-8%",
            width: "38vw",
            maxWidth: 520,
            minWidth: 240,
            aspectRatio: "1 / 1",
            borderRadius: "50%",
            background:
              "radial-gradient(circle, rgba(31,58,95,0.05) 0%, rgba(31,58,95,0.02) 38%, rgba(31,58,95,0) 72%)",
            pointerEvents: "none",
            filter: "blur(2px)",
          }}
        />

        <div className="container" style={{ position: "relative", zIndex: 1 }}>
          <div
            style={{
              marginBottom: 28,
              padding: "14px 18px",
              borderRadius: 18,
              border: "1px solid rgba(208,213,221,0.85)",
              background: "rgba(255,255,255,0.78)",
              backdropFilter: "blur(14px)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 16,
              flexWrap: "wrap",
              boxShadow: "0 8px 30px rgba(16,24,40,0.05)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div
                style={{
                  width: 42,
                  height: 42,
                  borderRadius: 12,
                  background: "linear-gradient(180deg, #12315A 0%, #1F3A5F 100%)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#fff",
                  fontSize: 16,
                  fontWeight: 800,
                  boxShadow: "0 8px 18px rgba(18,49,90,0.18)",
                  flexShrink: 0,
                }}
                aria-hidden="true"
              >
                P
              </div>

              <div>
                <div
                  style={{
                    fontSize: 18,
                    fontWeight: 900,
                    color: "#101828",
                    letterSpacing: "-0.02em",
                    lineHeight: 1.1,
                  }}
                >
                  PROOVRA
                </div>
                <div
                  style={{
                    marginTop: 4,
                    fontSize: 12,
                    color: "#667085",
                    fontWeight: 600,
                  }}
                >
                  Secure Evidence Verification
                </div>
              </div>
            </div>

            <a
              href="/"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "10px 14px",
                borderRadius: 12,
                border: "1px solid #D0D5DD",
                background: "#FFFFFF",
                color: "#344054",
                fontSize: 13,
                fontWeight: 700,
                textDecoration: "none",
                whiteSpace: "nowrap",
              }}
            >
              Back to Home
            </a>
          </div>

          <div
            className="page-title"
            style={{
              marginBottom: 24,
              display: "flex",
              alignItems: "flex-end",
              justifyContent: "space-between",
              gap: 16,
              flexWrap: "wrap",
            }}
          >
            <div>
              <h1
                style={{
                  margin: 0,
                  fontSize: 48,
                  lineHeight: 1.05,
                  letterSpacing: "-0.03em",
                  color: "#101828",
                }}
              >
                Evidence Verification
              </h1>
              <p
                className="page-subtitle"
                style={{
                  marginTop: 12,
                  marginBottom: 0,
                  fontSize: 18,
                  color: "#667085",
                  maxWidth: 720,
                }}
              >
                Review integrity status, cryptographic materials, and the custody
                timeline for this evidence record.
              </p>
            </div>

            <div
              style={{
                padding: "10px 14px",
                borderRadius: 999,
                border: "1px solid #D0D5DD",
                background: "rgba(255,255,255,0.82)",
                color: "#344054",
                fontSize: 13,
                fontWeight: 700,
                backdropFilter: "blur(10px)",
              }}
            >
              Token: {shortText(params?.token ?? "", 8, 8)}
            </div>
          </div>

          {loading ? (
            <div style={{ display: "grid", gap: 18 }}>
              <Card>
                <div style={{ display: "grid", gap: 14 }}>
                  <Skeleton width="42%" height="18px" />
                  <Skeleton width="100%" height="72px" />
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(3, 1fr)",
                      gap: 12,
                    }}
                  >
                    <Skeleton width="100%" height="78px" />
                    <Skeleton width="100%" height="78px" />
                    <Skeleton width="100%" height="78px" />
                  </div>
                </div>
              </Card>

              <Card>
                <div style={{ display: "grid", gap: 12 }}>
                  <Skeleton width="28%" height="18px" />
                  <Skeleton width="100%" height="110px" />
                  <Skeleton width="100%" height="110px" />
                </div>
              </Card>
            </div>
          ) : error ? (
            <Card>
              <EmptyState
                title="Verification Failed"
                subtitle={error}
                action={() => (
                  <Button onClick={() => window.location.reload()}>Try Again</Button>
                )}
              />
            </Card>
          ) : !hash && !signature ? (
            <Card>
              <EmptyState
                title="Evidence Not Found"
                subtitle="The evidence token is invalid or has expired."
                action={() => (
                  <Button onClick={() => (window.location.href = "/")}>
                    Back to Home
                  </Button>
                )}
              />
            </Card>
          ) : (
            <div style={{ display: "grid", gap: 18 }}>
              <Card>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(0, 1fr)",
                    gap: 18,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      justifyContent: "space-between",
                      gap: 18,
                      flexWrap: "wrap",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 16,
                      }}
                    >
                      <div
                        style={{
                          width: 60,
                          height: 60,
                          borderRadius: 999,
                          background:
                            "linear-gradient(180deg, #16A34A 0%, #15803D 100%)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          color: "#fff",
                          fontSize: 28,
                          fontWeight: 800,
                          boxShadow: "0 10px 24px rgba(22,163,74,0.22)",
                          flexShrink: 0,
                        }}
                      >
                        ✓
                      </div>

                      <div>
                        <div
                          style={{
                            fontSize: 12,
                            fontWeight: 700,
                            color: "#667085",
                            textTransform: "uppercase",
                            letterSpacing: "0.08em",
                            marginBottom: 6,
                          }}
                        >
                          Verification Status
                        </div>
                        <div
                          style={{
                            fontSize: 28,
                            lineHeight: 1.12,
                            fontWeight: 800,
                            color: "#101828",
                            marginBottom: 8,
                          }}
                        >
                          Evidence Verified
                        </div>
                        <div
                          style={{
                            fontSize: 15,
                            color: "#667085",
                            lineHeight: 1.6,
                            maxWidth: 760,
                          }}
                        >
                          This evidence record has been cryptographically verified.
                          The integrity materials currently available indicate no
                          post-verification tampering.
                        </div>
                      </div>
                    </div>

                    <div
                      style={{
                        padding: "10px 14px",
                        borderRadius: 14,
                        border: `1px solid ${statusTone(verifyStatus).border}`,
                        background: statusTone(verifyStatus).bg,
                        color: statusTone(verifyStatus).color,
                        fontSize: 13,
                        fontWeight: 800,
                        alignSelf: "flex-start",
                      }}
                    >
                      {statusTone(verifyStatus).label}
                    </div>
                  </div>

                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 10,
                    }}
                  >
                    {verificationBadges.map((item) => (
                      <Badge key={item.label} label={item.label} tone={item.tone} />
                    ))}
                  </div>
                </div>
              </Card>

              <Card>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                    flexWrap: "wrap",
                    marginBottom: 16,
                  }}
                >
                  <div>
                    <h3
                      style={{
                        margin: 0,
                        fontSize: 18,
                        fontWeight: 800,
                        color: "#101828",
                      }}
                    >
                      Verification Summary
                    </h3>
                    <div
                      style={{
                        marginTop: 6,
                        fontSize: 13,
                        color: "#667085",
                      }}
                    >
                      Core identification and verification metadata for this record.
                    </div>
                  </div>
                </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                    gap: 14,
                  }}
                >
                  {summaryFields.map((field) => (
                    <SummaryField
                      key={field.label}
                      label={field.label}
                      value={field.value}
                    />
                  ))}
                </div>
              </Card>

              <Card>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                    flexWrap: "wrap",
                    marginBottom: 16,
                  }}
                >
                  <div>
                    <h3
                      style={{
                        margin: 0,
                        fontSize: 18,
                        fontWeight: 800,
                        color: "#101828",
                      }}
                    >
                      Integrity Materials
                    </h3>
                    <div
                      style={{
                        marginTop: 6,
                        fontSize: 13,
                        color: "#667085",
                        maxWidth: 760,
                      }}
                    >
                      Review cryptographic identifiers and verification-related
                      materials used to support this evidence record.
                    </div>
                  </div>
                </div>

                <div style={{ display: "grid", gap: 14 }}>
                  {hash ? (
                    <MaterialField
                      label="File SHA-256"
                      subtitle="Primary content hash for the evidence file."
                      value={hash}
                      addToast={addToast}
                      copyMessage="File hash copied"
                    />
                  ) : null}

                  {fingerprintHash ? (
                    <MaterialField
                      label="Fingerprint Hash"
                      subtitle="Hash derived from the canonical fingerprint record."
                      value={fingerprintHash}
                      addToast={addToast}
                      copyMessage="Fingerprint hash copied"
                    />
                  ) : null}

                  {signature ? (
                    <MaterialField
                      label="Digital Signature"
                      subtitle="Recorded signature material associated with this evidence."
                      value={signature}
                      addToast={addToast}
                      copyMessage="Digital signature copied"
                    />
                  ) : null}

                  {publicKeyPem ? (
                    <MaterialField
                      label="Public Key"
                      subtitle="Public key material available for advanced technical review."
                      value={publicKeyPem}
                      addToast={addToast}
                      copyMessage="Public key copied"
                    />
                  ) : null}

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
                      gap: 14,
                    }}
                  >
                    <div
                      style={{
                        border: "1px solid #E4E7EC",
                        background: "#FCFCFD",
                        borderRadius: 16,
                        padding: 16,
                      }}
                    >
                      <div
                        style={{
                          fontSize: 12,
                          color: "#667085",
                          fontWeight: 700,
                          marginBottom: 10,
                        }}
                      >
                        Signature Status
                      </div>
                      <Badge
                        label={signature ? "Present" : "Unavailable"}
                        tone={signature ? "success" : "neutral"}
                      />
                    </div>

                    <div
                      style={{
                        border: "1px solid #E4E7EC",
                        background: "#FCFCFD",
                        borderRadius: 16,
                        padding: 16,
                      }}
                    >
                      <div
                        style={{
                          fontSize: 12,
                          color: "#667085",
                          fontWeight: 700,
                          marginBottom: 10,
                        }}
                      >
                        Timestamp Status
                      </div>
                      <Badge
                        label={timestampTone(tsaStatus).label}
                        tone={timestampTone(tsaStatus).tone}
                      />
                    </div>

                    <div
                      style={{
                        border: "1px solid #E4E7EC",
                        background: "#FCFCFD",
                        borderRadius: 16,
                        padding: 16,
                      }}
                    >
                      <div
                        style={{
                          fontSize: 12,
                          color: "#667085",
                          fontWeight: 700,
                          marginBottom: 8,
                        }}
                      >
                        Signing Key
                      </div>
                      <div
                        style={{
                          fontSize: 14,
                          color: "#101828",
                          fontWeight: 700,
                          wordBreak: "break-word",
                        }}
                      >
                        {signingKeyId ?? "N/A"}
                      </div>
                    </div>
                  </div>
                </div>
              </Card>

              <Card>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                    flexWrap: "wrap",
                    marginBottom: 18,
                  }}
                >
                  <div>
                    <h3
                      style={{
                        margin: 0,
                        fontSize: 18,
                        fontWeight: 800,
                        color: "#101828",
                      }}
                    >
                      Chain of Custody Timeline
                    </h3>
                    <div
                      style={{
                        marginTop: 6,
                        fontSize: 13,
                        color: "#667085",
                      }}
                    >
                      Recorded sequence of system events associated with this
                      evidence item.
                    </div>
                  </div>

                  <Badge
                    label={`${timeline.length} Event${timeline.length === 1 ? "" : "s"}`}
                    tone="info"
                  />
                </div>

                {timeline.length === 0 ? (
                  <div style={{ fontSize: 13, color: "#667085" }}>
                    No custody events recorded.
                  </div>
                ) : (
                  <div
                    style={{
                      position: "relative",
                      display: "grid",
                      gap: 14,
                    }}
                  >
                    {timeline.map((event, idx) => {
                      const isLast = idx === timeline.length - 1;

                      return (
                        <div
                          key={`${event.eventType}-${event.atUtc}-${idx}`}
                          style={{
                            display: "grid",
                            gridTemplateColumns: "28px minmax(0, 1fr)",
                            gap: 14,
                            alignItems: "start",
                          }}
                        >
                          <div
                            style={{
                              position: "relative",
                              display: "flex",
                              justifyContent: "center",
                              minHeight: 80,
                            }}
                          >
                            <div
                              style={{
                                width: 14,
                                height: 14,
                                borderRadius: 999,
                                background: "#175CD3",
                                border: "3px solid #D1E9FF",
                                marginTop: 6,
                                zIndex: 1,
                              }}
                            />
                            {!isLast ? (
                              <div
                                style={{
                                  position: "absolute",
                                  top: 22,
                                  bottom: -18,
                                  width: 2,
                                  background: "#D0D5DD",
                                }}
                              />
                            ) : null}
                          </div>

                          <div
                            style={{
                              border: "1px solid #EAECF0",
                              background: "#FFFFFF",
                              borderRadius: 16,
                              padding: 16,
                              boxShadow: "0 1px 2px rgba(16,24,40,0.04)",
                            }}
                          >
                            <div
                              style={{
                                display: "flex",
                                alignItems: "flex-start",
                                justifyContent: "space-between",
                                gap: 12,
                                flexWrap: "wrap",
                                marginBottom: 10,
                              }}
                            >
                              <div
                                style={{
                                  fontSize: 15,
                                  fontWeight: 800,
                                  color: "#101828",
                                  minWidth: 0,
                                  flex: "1 1 260px",
                                }}
                              >
                                {normalizeEventLabel(event.eventType)}
                              </div>

                              <div
                                style={{
                                  fontSize: 12,
                                  color: "#475467",
                                  fontWeight: 700,
                                  padding: "6px 10px",
                                  borderRadius: 999,
                                  background: "#F2F4F7",
                                  border: "1px solid #EAECF0",
                                  whiteSpace: "nowrap",
                                  flexShrink: 0,
                                }}
                              >
                                {formatDateTime(event.atUtc)}
                              </div>
                            </div>

                            <div
                              style={{
                                fontSize: 13,
                                lineHeight: 1.7,
                                color: "#667085",
                                wordBreak: "break-word",
                                overflowWrap: "anywhere",
                                whiteSpace: "pre-wrap",
                                maxWidth: "100%",
                              }}
                            >
                              {event.payloadSummary?.trim()
                                ? event.payloadSummary
                                : "No additional event summary provided."}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </Card>

              <Card>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                    flexWrap: "wrap",
                    marginBottom: 16,
                  }}
                >
                  <div>
                    <h3
                      style={{
                        margin: 0,
                        fontSize: 18,
                        fontWeight: 800,
                        color: "#101828",
                      }}
                    >
                      Actions
                    </h3>
                    <div
                      style={{
                        marginTop: 6,
                        fontSize: 13,
                        color: "#667085",
                      }}
                    >
                      Copy the verification link for reference or sharing.
                    </div>
                  </div>
                </div>

                <div
                  style={{
                    display: "flex",
                    justifyContent: "center",
                    alignItems: "center",
                    marginTop: 8,
                  }}
                >
                  <div style={{ width: "100%", maxWidth: 460 }}>
                    <Button
                      onClick={() => {
                        const url = window.location.href;
                        navigator.clipboard.writeText(url);
                        addToast("Verification link copied", "success");
                      }}
                      variant="secondary"
                    >
                      Copy Verification Link
                    </Button>
                  </div>
                </div>
              </Card>
            </div>
          )}
        </div>
      </SilverWatermarkSection>
    </div>
  );
}