"use client";

import { Badge, Button, Card, ListRow, TopBar } from "../../components/ui";
import { useLocale } from "../providers";

export default function DashboardPage() {
  const { t } = useLocale();

  return (
    <div className="page">
      <TopBar title={t("brand")} />
      <section className="section">
        <div className="grid-2">
          <Card>
            <h2 style={{ marginTop: 0 }}>Evidence</h2>
            <div style={{ display: "grid", gap: 14 }}>
              <ListRow
                title="Photo"
                subtitle="3 minutes ago"
                badge={<Badge tone="signed">{t("statusSigned")}</Badge>}
              />
              <ListRow
                title="Video"
                subtitle="Today, 09:45"
                badge={<Badge tone="processing">{t("statusProcessing")}</Badge>}
              />
              <ListRow
                title="Document"
                subtitle="Yesterday"
                badge={<Badge tone="ready">{t("statusReady")}</Badge>}
              />
            </div>
          </Card>
          <Card>
            <div className="status-banner">
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 14,
                  background: "rgba(255,255,255,0.2)"
                }}
              />
              <div>
                <div style={{ fontWeight: 700 }}>VIDEO</div>
                <div style={{ opacity: 0.8 }}>{t("statusSigned")}</div>
              </div>
            </div>
            <div style={{ marginTop: 14, fontSize: 12, color: "#64748b" }}>
              2026-02-04 14:22 UTC
            </div>
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 11, color: "#64748b" }}>SHA-256</div>
              <div style={{ fontWeight: 600 }}>261577e3fb77c3eb2467...</div>
            </div>
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 11, color: "#64748b" }}>Ed25519</div>
              <div style={{ fontWeight: 600 }}>t+knXQVoWnnqqcPZJi46...</div>
            </div>
            <div className="footer-actions">
              <Button>{t("downloadReport")}</Button>
              <Button variant="secondary">{t("shareLink")}</Button>
            </div>
          </Card>
        </div>
      </section>
    </div>
  );
}
