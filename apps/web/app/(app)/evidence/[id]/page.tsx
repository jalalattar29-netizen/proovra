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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!params?.id) return;
    setLoading(true);
    setError(null);
    apiFetch(`/v1/evidence/${params.id}`)
      .then((data) => {
        setStatus(data.evidence?.status ?? "SIGNED");
        setCreatedAt(data.evidence?.createdAt ?? null);
        setType(data.evidence?.type ?? "EVIDENCE");
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load evidence");
      })
      .finally(() => setLoading(false));
    apiFetch(`/v1/evidence/${params.id}/report/latest`)
      .then((data) => setReportUrl(data.url ?? null))
      .catch(() => setReportUrl(null));
  }, [params?.id]);

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
            </div>
          )}
        </Card>
        <Card>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>Actions</div>
          <div style={{ display: "grid", gap: 10 }}>
            <Button onClick={() => reportUrl && window.open(reportUrl, "_blank")}>
              {t("downloadReport")}
            </Button>
            <Link href={`/share/${evidenceId}`}>
              <Button variant="secondary">{t("shareLink")}</Button>
            </Link>
          </div>
        </Card>
      </div>
    </div>
  );
}
