"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Button, Card, TopBar, useToast, EmptyState, Skeleton } from "../../../components/ui";
import { SilverWatermarkSection } from "../../../components/SilverWatermarkSection";
import { useLocale } from "../../providers";
import { apiFetch } from "../../../lib/api";
import { captureException } from "../../../lib/sentry";

export default function VerifyPage() {
  const { t } = useLocale();
  const params = useParams<{ token: string }>();
  const { addToast } = useToast();
  const [reportUrl, setReportUrl] = useState<string | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [fingerprintHash, setFingerprintHash] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!params?.token) return;
    
    setLoading(true);
    setError(null);

    Promise.all([
      apiFetch(`/public/verify/${params.token}`)
        .then((data) => {
          setHash(data.fileSha256 ?? null);
          setFingerprintHash(data.fingerprintHash ?? null);
          setSignature(data.signatureBase64 ?? null);
          setTimeline(
            (data.custodyEvents ?? []).map(
              (ev: { eventType: string; atUtc: string }) =>
                `${ev.eventType} ${new Date(ev.atUtc).toLocaleString()}`
            )
          );
          addToast("Evidence verified successfully", "success");
        })
        .catch((err) => {
          captureException(err, { feature: "web_verify", token: params.token });
          const message = err instanceof Error ? err.message : "Verification failed";
          setError(message);
          addToast(message, "error");
        }),
      apiFetch(`/public/share/${params.token}`)
        .then((data) => setReportUrl(data.report?.url ?? null))
        .catch((err) => {
          captureException(err, { feature: "web_verify_report", token: params.token });
          setReportUrl(null);
        })
    ]).finally(() => {
      setLoading(false);
    });
  }, [params?.token, t, addToast]);

  return (
    <div className="page">
      <TopBar title={t("brand")} right={<a href="/">{t("home")}</a>} />
      <SilverWatermarkSection className="section">
        <div className="container">
          <div className="page-title">
            <div>
              <h1 style={{ margin: 0 }}>Verify Evidence</h1>
              <p className="page-subtitle">Check the integrity and chain of custody</p>
            </div>
          </div>

          {loading ? (
            <div style={{ display: "grid", gap: 20 }}>
              <Card>
                <div style={{ display: "grid", gap: 12 }}>
                  <div>
                    <div style={{ fontSize: 12, color: "#999", marginBottom: 4 }}>Loading...</div>
                    <Skeleton width="100%" height={20} />
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: "#999", marginBottom: 4 }}>Hash</div>
                    <Skeleton width="100%" height={16} />
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: "#999", marginBottom: 4 }}>Signature</div>
                    <Skeleton width="100%" height={16} />
                  </div>
                </div>
              </Card>
            </div>
          ) : error ? (
            <Card>
              <EmptyState
                title="Verification Failed"
                subtitle={error}
              >
                <Button onClick={() => window.location.reload()}>
                  Try Again
                </Button>
              </EmptyState>
            </Card>
          ) : !hash && !signature ? (
            <Card>
              <EmptyState
                title="Evidence Not Found"
                subtitle="The evidence token is invalid or has expired."
              >
                <Button onClick={() => window.location.href = "/"}>
                  Back to Home
                </Button>
              </EmptyState>
            </Card>
          ) : (
            <div style={{ display: "grid", gap: 20 }}>
              {/* Verification Status */}
              <Card>
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
                  <div
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: 20,
                      background: "#1F9D55",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "#fff",
                      fontSize: 20,
                      fontWeight: "bold"
                    }}
                  >
                    ✓
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: "#999" }}>Verification Status</div>
                    <div style={{ fontSize: 16, fontWeight: 600 }}>Evidence Verified</div>
                  </div>
                </div>
                <div style={{ fontSize: 12, color: "#666" }}>
                  This evidence has been cryptographically verified and has not been tampered with.
                </div>
              </Card>

              {/* Integrity Card */}
              <Card>
                <h3 style={{ margin: "0 0 16px 0", fontSize: 14, fontWeight: 600 }}>
                  Cryptographic Proof
                </h3>
                <div style={{ display: "grid", gap: 12 }}>
                  {hash && (
                    <div>
                      <div style={{ fontSize: 11, color: "#999", fontWeight: 600, marginBottom: 6 }}>
                        File Hash (SHA-256)
                      </div>
                      <div
                        style={{
                          padding: 10,
                          background: "#F7F9FB",
                          borderRadius: 8,
                          fontSize: 11,
                          fontFamily: "monospace",
                          wordBreak: "break-all",
                          color: "#666",
                          maxHeight: 60,
                          overflowY: "auto"
                        }}
                      >
                        {hash}
                      </div>
                    </div>
                  )}
                  {fingerprintHash && (
                    <div>
                      <div style={{ fontSize: 11, color: "#999", fontWeight: 600, marginBottom: 6 }}>
                        Fingerprint Hash
                      </div>
                      <div
                        style={{
                          padding: 10,
                          background: "#F7F9FB",
                          borderRadius: 8,
                          fontSize: 11,
                          fontFamily: "monospace",
                          wordBreak: "break-all",
                          color: "#666",
                          maxHeight: 60,
                          overflowY: "auto"
                        }}
                      >
                        {fingerprintHash}
                      </div>
                    </div>
                  )}
                  {signature && (
                    <div>
                      <div style={{ fontSize: 11, color: "#999", fontWeight: 600, marginBottom: 6 }}>
                        Digital Signature
                      </div>
                      <div
                        style={{
                          padding: 10,
                          background: "#F7F9FB",
                          borderRadius: 8,
                          fontSize: 11,
                          fontFamily: "monospace",
                          wordBreak: "break-all",
                          color: "#666",
                          maxHeight: 60,
                          overflowY: "auto"
                        }}
                      >
                        {signature}
                      </div>
                    </div>
                  )}
                </div>
              </Card>

              {/* Chain of Custody */}
              <Card>
                <h3 style={{ margin: "0 0 16px 0", fontSize: 14, fontWeight: 600 }}>
                  Chain of Custody
                </h3>
                {timeline.length === 0 ? (
                  <div style={{ fontSize: 12, color: "#999" }}>No custody events recorded.</div>
                ) : (
                  <div style={{ display: "grid", gap: 8 }}>
                    {timeline.map((event, idx) => (
                      <div
                        key={idx}
                        style={{
                          padding: 10,
                          background: "#F7F9FB",
                          borderRadius: 8,
                          fontSize: 12,
                          borderLeft: "3px solid #0B7BE5"
                        }}
                      >
                        {event}
                      </div>
                    ))}
                  </div>
                )}
              </Card>

              {/* Actions */}
              <Card>
                <div style={{ display: "grid", gap: 10 }}>
                  <Button
                    onClick={() => {
                      if (reportUrl) {
                        addToast("Downloading report...", "info");
                        window.open(reportUrl, "_blank");
                        addToast("Report opened", "success");
                      } else {
                        addToast("Report not available", "warning");
                      }
                    }}
                    disabled={!reportUrl}
                  >
                    {t("downloadReport")}
                  </Button>
                  <Button
                    onClick={() => {
                      const url = window.location.href;
                      navigator.clipboard.writeText(url);
                      addToast("Verification link copied", "success");
                    }}
                    variant="secondary"
                  >
                    Copy Link
                  </Button>
                </div>
              </Card>
            </div>
          )}
        </div>
      </SilverWatermarkSection>
    </div>
  );
}
