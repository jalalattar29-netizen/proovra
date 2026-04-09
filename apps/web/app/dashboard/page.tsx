"use client";

import { Badge, Button, Card, ListRow, TopBar } from "../../components/ui";
import { useLocale } from "../providers";

export default function DashboardPage() {
  const { t } = useLocale();

return (
  <div className="page">
    {/* TOP */}
    <div className="blue-shell">
      <TopBar title={t("brand")} />

      <div className="container" style={{ padding: "32px 0 60px" }}>
        <h1 className="hero-title">Dashboard</h1>
        <p className="page-subtitle">
          Your evidence overview and activity
        </p>
      </div>
    </div>

    {/* BODY */}
    <section className="section section-body">
      <div className="container">
        <div className="grid-2">
          <Card className="app-card">
            <h2 className="card-title">Evidence</h2>

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

          <Card className="app-card">
            <div className="status-banner">
              <div className="status-icon" />
              <div>
                <div className="card-title-sm">VIDEO</div>
                <div className="card-muted">{t("statusSigned")}</div>
              </div>
            </div>

            <div className="card-meta">2026-02-04 14:22 UTC</div>

            <div className="hash-block">
              <div className="hash-label">SHA-256</div>
              <div className="hash-value">261577e3fb77c3eb2467...</div>
            </div>

            <div className="hash-block">
              <div className="hash-label">Ed25519</div>
              <div className="hash-value">t+knXQVoWnnqqcPZJi46...</div>
            </div>

            <div className="footer-actions">
              <Button>{t("downloadReport")}</Button>
              <Button variant="secondary">{t("shareLink")}</Button>
            </div>
          </Card>
        </div>
      </div>
    </section>
  </div>
);
}
