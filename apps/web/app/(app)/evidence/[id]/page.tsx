"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Button, Card } from "../../../../components/ui";
import { useLocale } from "../../../providers";
import { apiFetch } from "../../../../lib/api";

export default function EvidenceDetailPage() {
  const { t } = useLocale();
  const params = useParams<{ id: string }>();
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
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load evidence"))
      .finally(() => setLoading(false));

    apiFetch("/v1/billing/status")
      .then((data) => setPlan(data.entitlement?.plan ?? "FREE"))
      .catch(() => setPlan("FREE"));

    apiFetch(`/v1/evidence/${params.id}/report/latest`)
      .then((data) => setReportUrl(data.url ?? null))
      .catch(() => setReportUrl(null));
  }, [params?.id]);

  const handleLock = async () => {
    if (!params?.id) return;
    setActionBusy(true);
    try {
      const data = await apiFetch(`/v1/evidence/${params.id}/lock`, {
        method: "POST",
        body: JSON.stringify({ locked: true })
      });
      setLockedAt(data.evidence?.lockedAt ?? new Date().toISOString());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to lock evidence");
    } finally {
      setActionBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!params?.id) return;
    if (!window.confirm("Delete this evidence? This cannot be undone.")) return;
    setActionBusy(true);
    try {
      await apiFetch(`/v1/evidence/${params.id}`, { method: "DELETE" });
      window.location.href = "/home";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete evidence");
    } finally {
      setActionBusy(false);
    }
  };

  const statusBadge =
    status === "SIGNED" ? (
      <span className="badge signed">{t("statusSigned")}</span>
    ) : status === "PROCESSING" ? (
      <span className="badge processing">{t("statusProcessing")}</span>
    ) : (
      <span className="badge ready">{status}</span>
    );

  return (
    <div className="section app-section">
      <div className="app-hero">
        <div className="page-title" style={{ marginBottom: 0 }}>
          <div>
            <h1 style={{ margin: 0 }}>Evidence #{evidenceId}</h1>
            <p className="page-subtitle">{type}</p>
          </div>
        </div>
      </div>

      <div className="app-body">
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
                  fontWeight: 900
                }}
              >
                ✓
              </div>

              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 900, fontSize: 14 }}>{type}</div>
                <div style={{ marginTop: 6 }}>{statusBadge}</div>
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
                    <div style={{ display: "flex", justifyContent: "flex-end" }}>{statusBadge}</div>
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
            <div style={{ fontWeight: 900, marginBottom: 12 }}>Actions</div>

            <div className="footer-actions" style={{ flexWrap: "wrap" }}>
              <Button
                className="navy-btn"
                onClick={() => reportUrl && window.open(reportUrl, "_blank")}
                disabled={!reportUrl || plan === "FREE"}
              >
                {t("downloadReport")}
              </Button>

              <Link href={`/share/${evidenceId}`}>
                <Button className="navy-btn" variant="secondary">
                  {t("shareLink")}
                </Button>
              </Link>
            </div>

            {plan === "FREE" && (
              <div style={{ fontSize: 12, color: "#64748b", marginTop: 10 }}>
                Reports are disabled on Free. Upgrade to access PDF reports.
              </div>
            )}

            <div style={{ display: "grid", gap: 10, marginTop: 14 }}>
              <Button
                className="navy-btn"
                variant="secondary"
                onClick={handleLock}
                disabled={actionBusy || Boolean(lockedAt) || !(status === "SIGNED" || status === "REPORTED")}
              >
                {lockedAt ? "Locked" : "Lock Evidence"}
              </Button>

              <Button className="navy-btn" variant="secondary" onClick={handleDelete} disabled={actionBusy}>
                Delete Evidence
              </Button>

              <Link href="/home" style={{ marginTop: 4 }}>
                <span style={{ fontSize: 12, color: "#64748b" }}>← Back to Home</span>
              </Link>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
