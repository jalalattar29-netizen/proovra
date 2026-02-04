"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Button, TimelineBlock } from "../../../components/ui";
import { useLocale } from "../../providers";
import { apiFetch } from "../../../lib/api";

export default function VerifyPage() {
  const { t } = useLocale();
  const params = useParams<{ token: string }>();
  const [reportUrl, setReportUrl] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<string[]>([
    `${t("createdAt")} 12:05`,
    `${t("uploaded")} 12:10`,
    `${t("signed")} 12:12`,
    `${t("reportGenerated")} 12:15`
  ]);

  useEffect(() => {
    if (!params?.token) return;
    apiFetch(`/public/verify/${params.token}`)
      .then((data) => {
        setTimeline(
          (data.custodyEvents ?? []).map(
            (ev: { eventType: string; atUtc: string }) =>
              `${ev.eventType} ${new Date(ev.atUtc).toLocaleTimeString()}`
          )
        );
        setReportUrl(data.publicUrl ?? null);
      })
      .catch(() => {});
  }, [params?.token, t]);

  return (
    <div className="section" style={{ display: "flex", justifyContent: "center" }}>
      <div className="phone phone-lg phone-soft">
        <div className="phone-header-bar">
          <span>‹</span>
          <span style={{ fontWeight: 600 }}>{t("verifyTitle")}</span>
          <span>⋮</span>
        </div>
        <div className="phone-card-light">
          <div style={{ fontWeight: 700, color: "var(--color-green)" }}>{t("verifyTitle")}</div>
          <div style={{ marginTop: 6, fontWeight: 600 }}>Video</div>
          <div style={{ marginTop: 6, color: "#64748b" }}>2026-02-04 14:22 UTC</div>
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, color: "#64748b" }}>SHA-256</div>
            <div style={{ fontWeight: 600 }}>261577e3fb77c3eb2467...</div>
          </div>
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 12, color: "#64748b" }}>Ed25519</div>
            <div style={{ fontWeight: 600 }}>t+knXQVoWnnqqcPZJi46...</div>
          </div>
        </div>
        <div className="phone-card-light" style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 700 }}>{t("verifyTimeline")}</div>
          <TimelineBlock items={timeline} />
        </div>
        <div style={{ marginTop: 14 }}>
          <Button onClick={() => reportUrl && window.open(reportUrl, "_blank")}>
            {t("downloadReport")}
          </Button>
        </div>
        <div className="phone-nav">
          <span className="active">{t("home")}</span>
          <span>{t("cases")}</span>
          <span>{t("teams")}</span>
          <span>{t("settings")}</span>
        </div>
      </div>
    </div>
  );
}
