"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Button, Card, useToast } from "../../../../components/ui";
import { useLocale } from "../../../providers";
import { apiFetch } from "../../../../lib/api";
import { captureException } from "../../../../lib/sentry";

function formatBytes(sizeBytes: string | null): string {
  const n = sizeBytes ? Number(sizeBytes) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return "Unknown size";

  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let value = n;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

function getEvidenceKind(
  mimeType: string | null
): "image" | "video" | "audio" | "pdf" | "text" | "other" {
  const mime = (mimeType ?? "").toLowerCase();

  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  if (
    mime.startsWith("text/") ||
    mime.includes("json") ||
    mime.includes("xml")
  ) {
    return "text";
  }

  return "other";
}

export default function EvidenceDetailPage() {
  const { t } = useLocale();
  const params = useParams<{ id: string }>();
  const { addToast } = useToast();
  const evidenceId = params?.id ?? "unknown";

  const [status, setStatus] = useState("SIGNED");
  const [reportUrl, setReportUrl] = useState<string | null>(null);
  const [createdAt, setCreatedAt] = useState<string | null>(null);
  const [type, setType] = useState<string>("EVIDENCE");
  const [lockedAt, setLockedAt] = useState<string | null>(null);
  const [plan, setPlan] = useState<string>("FREE");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  const [originalFileUrl, setOriginalFileUrl] = useState<string | null>(null);
  const [originalMimeType, setOriginalMimeType] = useState<string | null>(null);
  const [originalSizeBytes, setOriginalSizeBytes] = useState<string | null>(null);

  const originalKind = useMemo(
    () => getEvidenceKind(originalMimeType),
    [originalMimeType]
  );

  useEffect(() => {
    if (!params?.id) return;

    setLoading(true);
    setError(null);

    apiFetch(`/v1/evidence/${params.id}`)
      .then((data) => {
        setStatus(data.evidence?.status ?? "SIGNED");
        setCreatedAt(data.evidence?.createdAt ?? null);
        setType(data.evidence?.type ?? "EVIDENCE");
        setLockedAt(data.evidence?.lockedAt ?? null);
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Failed to load evidence")
      )
      .finally(() => setLoading(false));

    apiFetch("/v1/billing/status")
      .then((data) => setPlan(data.entitlement?.plan ?? "FREE"))
      .catch(() => setPlan("FREE"));

    apiFetch(`/v1/evidence/${params.id}/report/latest`)
      .then((data) => setReportUrl(data.url ?? null))
      .catch(() => setReportUrl(null));

    apiFetch(`/v1/evidence/${params.id}/original`)
      .then((data) => {
        setOriginalFileUrl(data.url ?? null);
        setOriginalMimeType(data.mimeType ?? null);
        setOriginalSizeBytes(data.sizeBytes ?? null);
      })
      .catch(() => {
        setOriginalFileUrl(null);
        setOriginalMimeType(null);
        setOriginalSizeBytes(null);
      });
  }, [params?.id]);

  const handleLock = async () => {
    if (!params?.id) return;

    setActionBusy(true);
    try {
      addToast("Locking evidence...", "info");
      const data = await apiFetch(`/v1/evidence/${params.id}/lock`, {
        method: "POST",
        body: JSON.stringify({ locked: true }),
      });
      setLockedAt(data.evidence?.lockedAt ?? new Date().toISOString());
      addToast("Evidence locked", "success");
    } catch (err) {
      captureException(err, { feature: "web_evidence_lock", evidenceId: params.id });
      const message = err instanceof Error ? err.message : "Failed to lock evidence";
      setError(message);
      addToast(message, "error");
    } finally {
      setActionBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!params?.id) return;
    if (!window.confirm("Delete this evidence? This cannot be undone.")) return;

    setActionBusy(true);
    try {
      addToast("Deleting evidence...", "info");
      await apiFetch(`/v1/evidence/${params.id}`, { method: "DELETE" });
      addToast("Evidence deleted", "success");
      setTimeout(() => {
        window.location.href = "/home";
      }, 500);
    } catch (err) {
      captureException(err, { feature: "web_evidence_delete", evidenceId: params.id });
      const message = err instanceof Error ? err.message : "Failed to delete evidence";
      setError(message);
      addToast(message, "error");
    } finally {
      setActionBusy(false);
    }
  };

  const handleDownloadReport = async () => {
    if (!reportUrl) {
      addToast("Report not available", "info");
      return;
    }

    try {
      addToast("Downloading report...", "info");
      window.open(reportUrl, "_blank", "noopener,noreferrer");
      addToast("Report downloaded", "success");
    } catch (err) {
      captureException(err, { feature: "web_evidence_download", evidenceId: params?.id });
      addToast("Failed to download report", "error");
    }
  };

  const handleDownloadVerificationPackage = async () => {
    if (!params?.id) return;

    try {
      addToast("Preparing verification package...", "info");
      const data = await apiFetch(`/v1/evidence/${params.id}/verification-package`);

      if (!data?.url) {
        addToast("Verification package not available", "info");
        return;
      }

      window.open(data.url, "_blank", "noopener,noreferrer");
      addToast("Verification package downloaded", "success");
    } catch (err) {
      captureException(err, {
        feature: "web_evidence_verification_package_download",
        evidenceId: params.id,
      });
      addToast("Failed to download verification package", "error");
    }
  };

  const handleOpenOriginal = () => {
    if (!originalFileUrl) {
      addToast("Original file not available", "info");
      return;
    }
    window.open(originalFileUrl, "_blank", "noopener,noreferrer");
  };

  const handleDownloadOriginal = () => {
    if (!originalFileUrl) {
      addToast("Original file not available", "info");
      return;
    }
    window.open(originalFileUrl, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="section app-section">
      <div className="app-hero app-hero-full">
        <div className="container">
          <div className="page-title" style={{ marginBottom: 0 }}>
            <div>
              <h1 className="hero-title pricing-hero-title" style={{ margin: 0 }}>
                Evidence #{evidenceId}
              </h1>
              <p className="page-subtitle pricing-subtitle" style={{ marginTop: 6 }}>
                {type}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="app-body app-body-full">
        <div className="container">
          <div className="grid-2">
            <Card>
              <div className="status-banner">
                <div
                  style={{
                    width: 54,
                    height: 54,
                    borderRadius: 16,
                    background: "rgba(255,255,255,0.18)",
                    display: "grid",
                    placeItems: "center",
                    fontWeight: 900,
                  }}
                >
                  ✓
                </div>

                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 800, fontSize: 14 }}>{type}</div>
                  <div style={{ marginTop: 6 }}>
                    {status === "SIGNED" ? (
                      <span className="badge signed">{t("statusSigned")}</span>
                    ) : status === "PROCESSING" ? (
                      <span className="badge processing">{t("statusProcessing")}</span>
                    ) : (
                      <span className="badge ready">{status}</span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 8 }}>
                    {createdAt ? `Created ${new Date(createdAt).toLocaleString()}` : "—"}
                  </div>
                </div>
              </div>

              <div style={{ marginTop: 14 }}>
                {loading ? (
                  <div className="app-loading">Loading…</div>
                ) : error ? (
                  <div className="error-text">{error}</div>
                ) : (
                  <div style={{ display: "grid", gap: 10 }}>
                    <div className="row" style={{ borderTop: "none", paddingTop: 0 }}>
                      <div className="rowTitle">Status</div>
                      <div style={{ display: "flex", justifyContent: "flex-end" }}>
                        {status === "SIGNED" ? (
                          <span className="badge signed">{t("statusSigned")}</span>
                        ) : status === "PROCESSING" ? (
                          <span className="badge processing">{t("statusProcessing")}</span>
                        ) : (
                          <span className="badge ready">{status}</span>
                        )}
                      </div>
                    </div>

                    <div className="row">
                      <div className="rowTitle">Locked</div>
                      <div className="rowSub" style={{ margin: 0 }}>
                        {lockedAt ? "Locked" : "Editable"}
                      </div>
                    </div>

                    <div className="row">
                      <div className="rowTitle">Plan</div>
                      <div className="rowSub" style={{ margin: 0 }}>
                        {plan}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </Card>

            <Card>
              <div style={{ fontWeight: 800, marginBottom: 12 }}>Actions</div>

              <div className="footer-actions">
                <Button onClick={handleDownloadReport} disabled={!reportUrl || plan === "FREE"}>
                  {t("downloadReport")}
                </Button>

                <Button
                  variant="secondary"
                  onClick={handleDownloadVerificationPackage}
                  disabled={actionBusy}
                >
                  Download Verification Package
                </Button>

                <Link href={`/share/${evidenceId}`}>
                  <Button variant="secondary">{t("shareLink")}</Button>
                </Link>
              </div>

              {plan === "FREE" && (
                <div style={{ fontSize: 12, color: "#64748b", marginTop: 10 }}>
                  Reports are disabled on Free. Upgrade to access PDF reports.
                </div>
              )}

              <div style={{ display: "grid", gap: 10, marginTop: 14 }}>
                <Button
                  variant="secondary"
                  onClick={handleLock}
                  disabled={
                    actionBusy ||
                    Boolean(lockedAt) ||
                    !(status === "SIGNED" || status === "REPORTED")
                  }
                >
                  {lockedAt ? "Locked" : "Lock Evidence"}
                </Button>

                <Button variant="secondary" onClick={handleDelete} disabled={actionBusy}>
                  Delete Evidence
                </Button>
              </div>
            </Card>
          </div>

          {originalFileUrl && (
            <Card className="mt-6">
              <div style={{ fontWeight: 800, marginBottom: 12 }}>Original Evidence</div>

              <div style={{ fontSize: 13, color: "#64748b", marginBottom: 14 }}>
                {originalMimeType && <div>Type: {originalMimeType}</div>}
                {originalSizeBytes && <div>Size: {formatBytes(originalSizeBytes)}</div>}
              </div>

              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 10,
                  marginBottom: 14,
                }}
              >
                <Button variant="secondary" onClick={handleOpenOriginal}>
                  Open Original
                </Button>

                <Button variant="secondary" onClick={handleDownloadOriginal}>
                  Download Original
                </Button>
              </div>

              {originalKind === "image" && (
                <div style={{ marginBottom: 12 }}>
                  <img
                    src={originalFileUrl}
                    alt="Evidence preview"
                    style={{
                      display: "block",
                      width: "100%",
                      maxWidth: "100%",
                      maxHeight: 560,
                      objectFit: "contain",
                      borderRadius: 12,
                      background: "rgba(15,23,42,0.35)",
                    }}
                  />
                </div>
              )}

              {originalKind === "video" && (
                <div style={{ marginBottom: 12 }}>
                  <video
                    src={originalFileUrl}
                    controls
                    preload="metadata"
                    style={{
                      display: "block",
                      width: "100%",
                      maxWidth: "100%",
                      maxHeight: 560,
                      borderRadius: 12,
                      background: "#000",
                    }}
                  />
                </div>
              )}

              {originalKind === "audio" && (
                <div
                  style={{
                    marginBottom: 12,
                    padding: 16,
                    borderRadius: 12,
                    background: "rgba(15,23,42,0.35)",
                  }}
                >
                  <audio
                    src={originalFileUrl}
                    controls
                    preload="metadata"
                    style={{ width: "100%" }}
                  />
                </div>
              )}

              {originalKind === "pdf" && (
                <div
                  style={{
                    marginBottom: 12,
                    borderRadius: 12,
                    overflow: "hidden",
                    background: "#fff",
                  }}
                >
                  <iframe
                    src={originalFileUrl}
                    title="Original PDF evidence"
                    style={{
                      width: "100%",
                      height: 760,
                      border: "none",
                      display: "block",
                    }}
                  />
                </div>
              )}

              {(originalKind === "text" || originalKind === "other") && (
                <div
                  style={{
                    marginBottom: 12,
                    padding: 16,
                    borderRadius: 12,
                    background: "rgba(15,23,42,0.35)",
                    color: "#cbd5e1",
                    fontSize: 14,
                    lineHeight: 1.6,
                  }}
                >
                  <div style={{ marginBottom: 8 }}>
                    Preview is not available for this file type inside the page.
                  </div>
                  <div>Use Open Original or Download Original.</div>
                </div>
              )}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}