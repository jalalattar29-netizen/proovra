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
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load evidence");
      })
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

  return (
    <div className="section">
      <div className="page-title">
        <div>
          <h1 style={{ margin: 0 }}>Evidence #{evidenceId}</h1>
          <p className="page-subtitle">{type}</p>
        </div>
      </div>
      <div className="grid-2">
        <Card>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>Status</div>
          {loading ? (
            <div>Loading...</div>
          ) : error ? (
            <div className="error-text">{error}</div>
          ) : (
            <div style={{ display: "grid", gap: 6 }}>
              <div>
                {status === "SIGNED" ? t("statusSigned") : status === "PROCESSING" ? t("statusProcessing") : status}
              </div>
              <div style={{ fontSize: 12, color: "#64748b" }}>
                {createdAt ? new Date(createdAt).toLocaleString() : "—"}
              </div>
              <div style={{ fontSize: 12, color: "#64748b" }}>
                {lockedAt ? "Locked" : "Editable"}
              </div>
            </div>
          )}
        </Card>
        <Card>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>Actions</div>
          <div style={{ display: "grid", gap: 10 }}>
            <Button
              onClick={() => reportUrl && window.open(reportUrl, "_blank")}
              disabled={!reportUrl || plan === "FREE"}
            >
              {t("downloadReport")}
            </Button>
            {plan === "FREE" && (
              <div style={{ fontSize: 12, color: "#64748b" }}>
                Reports are disabled on Free. Upgrade to access PDF reports.
              </div>
            )}
            <Link href={`/share/${evidenceId}`}>
              <Button variant="secondary">{t("shareLink")}</Button>
            </Link>
            <Button
              variant="secondary"
              onClick={handleLock}
              disabled={actionBusy || Boolean(lockedAt) || !(status === "SIGNED" || status === "REPORTED")}
            >
              {lockedAt ? "Locked" : "Lock Evidence"}
            </Button>
            <Button variant="secondary" onClick={handleDelete} disabled={actionBusy}>
              Delete Evidence
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
