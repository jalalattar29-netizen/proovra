"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Button, Card, TopBar } from "../../../components/ui";
import { useLocale } from "../../providers";
import { apiFetch } from "../../../lib/api";

export default function VerifyPage() {
  const { t } = useLocale();
  const params = useParams<{ token: string }>();
  const [reportUrl, setReportUrl] = useState<string | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [fingerprintHash, setFingerprintHash] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!params?.token) return;
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
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Verify failed"));

    apiFetch(`/public/share/${params.token}`)
      .then((data) => setReportUrl(data.report?.url ?? null))
      .catch(() => setReportUrl(null));
  }, [params?.token, t]);

  return (
    <div className="page">
      <TopBar title={t("brand")} right={<a href="/">{t("home")}</a>} />
      <div className="section container">
        <div className="page-title">
          <div>
            <h1 style={{ margin: 0 }}>{t("verifyTitle")}</h1>
            <p className="page-subtitle">Evidence verification result</p>
          </div>
        </div>
        {error ? (
          <Card>{error}</Card>
        ) : (
          <div className="grid-2">
            <Card>
              <div style={{ fontWeight: 700, marginBottom: 10 }}>Integrity</div>
              <div style={{ fontSize: 12, color: "#64748b" }}>SHA-256</div>
              <div style={{ fontWeight: 600 }}>{hash ?? "—"}</div>
              <div style={{ marginTop: 10, fontSize: 12, color: "#64748b" }}>Fingerprint Hash</div>
              <div style={{ fontWeight: 600 }}>{fingerprintHash ?? "—"}</div>
              <div style={{ marginTop: 10, fontSize: 12, color: "#64748b" }}>Signature</div>
              <div style={{ fontWeight: 600 }}>{signature ?? "—"}</div>
            </Card>
            <Card>
              <div style={{ fontWeight: 700, marginBottom: 10 }}>{t("verifyTimeline")}</div>
              <div style={{ display: "grid", gap: 8, fontSize: 13 }}>
                {timeline.length === 0 ? "No custody events." : timeline.map((line) => <div key={line}>{line}</div>)}
              </div>
            </Card>
          </div>
        )}
        <div style={{ marginTop: 16 }}>
          <Button onClick={() => reportUrl && window.open(reportUrl, "_blank")}>
            {t("downloadReport")}
          </Button>
        </div>
      </div>
    </div>
  );
}
