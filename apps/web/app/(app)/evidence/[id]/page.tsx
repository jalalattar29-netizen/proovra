"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Button, Card, Modal, useToast } from "../../../../components/ui";
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
  const [archivedAt, setArchivedAt] = useState<string | null>(null);
  const [plan, setPlan] = useState<string>("FREE");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [lockModalOpen, setLockModalOpen] = useState(false);
  const [archiveModalOpen, setArchiveModalOpen] = useState(false);

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
        setArchivedAt(data.evidence?.archivedAt ?? null);
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

  const handleLock = () => {
    setLockModalOpen(true);
  };

  const handleConfirmLock = async () => {
    if (!params?.id) return;

    setActionBusy(true);
    try {
      addToast("Permanently sealing evidence...", "info");
      const data = await apiFetch(`/v1/evidence/${params.id}/lock`, {
        method: "POST",
        body: JSON.stringify({ locked: true }),
      });
      setLockedAt(data.evidence?.lockedAt ?? new Date().toISOString());
      addToast("Evidence permanently locked", "success");
      setLockModalOpen(false);
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
    if (lockedAt) {
      addToast("Cannot delete locked evidence", "error");
      return;
    }
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

  const handleArchive = () => {
    setArchiveModalOpen(true);
  };

  const handleConfirmArchive = async () => {
    if (!params?.id) return;

    setActionBusy(true);
    try {
      addToast("Archiving evidence...", "info");
      const data = await apiFetch(`/v1/evidence/${params.id}/archive`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setArchivedAt(data.evidence?.archivedAt ?? new Date().toISOString());
      addToast("Evidence archived", "success");
      setArchiveModalOpen(false);
    } catch (err) {
      captureException(err, { feature: "web_evidence_archive", evidenceId: params.id });
      const message = err instanceof Error ? err.message : "Failed to archive evidence";
      setError(message);
      addToast(message, "error");
    } finally {
      setActionBusy(false);
    }
  };

  const handleUnarchive = async () => {
    if (!params?.id) return;

    setActionBusy(true);
    try {
      addToast("Restoring evidence...", "info");
      const data = await apiFetch(`/v1/evidence/${params.id}/unarchive`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setArchivedAt(data.evidence?.archivedAt ?? null);
      addToast("Evidence restored", "success");
    } catch (err) {
      captureException(err, { feature: "web_evidence_unarchive", evidenceId: params.id });
      const message = err instanceof Error ? err.message : "Failed to restore evidence";
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
                      <div className="rowTitle">Status</div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                        {lockedAt && (
                          <span style={{ fontSize: 14, fontWeight: 700, color: "#65ebff" }}>
                            🔒 Evidence Locked
                          </span>
                        )}
                        {archivedAt && (
                          <span style={{ fontSize: 14, fontWeight: 600, color: "#94a3b8" }}>
                            📦 Archived
                          </span>
                        )}
                        {!lockedAt && !archivedAt && (
                          <span style={{ color: "#94a3b8" }}>Active</span>
                        )}
                      </div>
                    </div>

                    {lockedAt && (
                      <div className="row" style={{ borderTop: "1px solid rgba(101, 235, 255, 0.15)" }}>
                        <div style={{ fontSize: 13, color: "#cbd5e1", lineHeight: 1.5 }}>
                          This evidence is permanently sealed and cannot be modified or deleted.
                        </div>
                      </div>
                    )}

                    {archivedAt && (
                      <div className="row" style={{ borderTop: "1px solid rgba(148, 163, 184, 0.15)" }}>
                        <div style={{ fontSize: 13, color: "#cbd5e1", lineHeight: 1.5 }}>
                          This evidence has been archived and removed from your active workspace.
                        </div>
                      </div>
                    )}

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
                  onClick={handleLock}
                  disabled={
                    actionBusy ||
                    Boolean(lockedAt) ||
                    !(status === "SIGNED" || status === "REPORTED")
                  }
                  className={lockedAt ? "button-disabled" : "button-danger"}
                >
                  {lockedAt ? "🔒 Permanently Locked" : "🔒 Lock Evidence Permanently"}
                </Button>

                {lockedAt && (
                  <div style={{ fontSize: 12, color: "#94a3b8", padding: "8px 0" }}>
                    ✓ This evidence is legally sealed and cannot be edited or deleted.
                  </div>
                )}

                {archivedAt ? (
                  <>
                    <Button
                      variant="secondary"
                      onClick={handleUnarchive}
                      disabled={actionBusy}
                    >
                      Restore Evidence
                    </Button>
                    <div style={{ fontSize: 12, color: "#94a3b8", padding: "8px 0" }}>
                      This evidence is archived. Click restore to bring it back to your active workspace.
                    </div>
                  </>
                ) : (
                  <>
                    <Button
                      variant="secondary"
                      onClick={handleArchive}
                      disabled={actionBusy}
                    >
                      📦 Archive Evidence
                    </Button>
                    <div style={{ fontSize: 12, color: "#64748b", padding: "8px 0" }}>
                      {lockedAt
                        ? "You can archive this evidence as an alternative to deletion."
                        : "Archive this evidence to remove it from your active workspace."}
                    </div>
                  </>
                )}

                <Button 
                  variant="secondary" 
                  onClick={handleDelete} 
                  disabled={actionBusy || Boolean(lockedAt)}
                >
                  Delete Evidence
                </Button>

                {lockedAt && (
                  <div style={{ fontSize: 12, color: "#ef4444", padding: "8px 0" }}>
                    This evidence is locked and cannot be deleted. Archive it instead.
                  </div>
                )}
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

      <Modal
        isOpen={lockModalOpen}
        onClose={() => setLockModalOpen(false)}
        title="Lock this evidence?"
        actions={
          <div style={{ display: "flex", gap: 10 }}>
            <Button
              variant="secondary"
              onClick={() => setLockModalOpen(false)}
              disabled={actionBusy}
            >
              Cancel
            </Button>
            <div style={{ position: "relative" }}>
              <Button
                onClick={handleConfirmLock}
                disabled={actionBusy}
                className="button-danger"
              >
                {actionBusy ? "Locking..." : "🔒 Lock permanently"}
              </Button>
            </div>
          </div>
        }
      >
        <div style={{ fontSize: 15, lineHeight: 1.6, color: "#e2e8f0" }}>
          <p style={{ marginBottom: 16 }}>
            Once locked:
          </p>
          <ul style={{ marginLeft: 20, marginBottom: 16, color: "#cbd5e1" }}>
            <li style={{ marginBottom: 8 }}>
              • The evidence cannot be edited
            </li>
            <li style={{ marginBottom: 8 }}>
              • It cannot be deleted
            </li>
            <li>
              • It becomes legally sealed
            </li>
          </ul>
          <p style={{ marginTop: 16, fontWeight: 600, color: "#f87171" }}>
            This action is irreversible.
          </p>
        </div>
      </Modal>

      <Modal
        isOpen={archiveModalOpen}
        onClose={() => setArchiveModalOpen(false)}
        title="Archive this evidence?"
        actions={
          <div style={{ display: "flex", gap: 10 }}>
            <Button
              variant="secondary"
              onClick={() => setArchiveModalOpen(false)}
              disabled={actionBusy}
            >
              Cancel
            </Button>
            <Button
              onClick={handleConfirmArchive}
              disabled={actionBusy}
            >
              {actionBusy ? "Archiving..." : "📦 Archive"}
            </Button>
          </div>
        }
      >
        <div style={{ fontSize: 15, lineHeight: 1.6, color: "#e2e8f0" }}>
          <p style={{ marginBottom: 12 }}>
            This will remove the evidence from your active workspace.
          </p>
          <p style={{ marginBottom: 12 }}>
            The evidence will remain stored and can be restored later if needed.
          </p>
        </div>
      </Modal>
    </div>
  );
}