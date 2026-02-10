"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, ListRow, Badge } from "../../../components/ui";
import { useLocale } from "../../providers";
import { apiFetch } from "../../../lib/api";
import { Icons } from "../../../components/icons";

export default function ReportsPage() {
  const { t } = useLocale();
  const [items, setItems] = useState<
    Array<{ id: string; type: string; status: string; createdAt: string }>
  >([]);

  const isUuid = (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

  useEffect(() => {
    apiFetch("/v1/evidence")
      .then((data) => setItems(data.items ?? []))
      .catch(() => setItems([]));
  }, []);

  const withReports = items.filter((i) => i.status === "REPORTED" || i.status === "SIGNED");

  return (
    <div className="section app-section">
      <div className="app-hero app-hero-full">
        <div className="container">
          <div className="page-title" style={{ marginBottom: 0 }}>
            <div>
              <h1 className="hero-title pricing-hero-title" style={{ margin: 0 }}>
                Reports
              </h1>
              <p className="page-subtitle pricing-subtitle" style={{ marginTop: 6 }}>
                Verifiable reports and custody timelines.
              </p>
            </div>
          </div>
        </div>
      </div>
      <div className="app-body app-body-full">
        <div className="container" style={{ display: "grid", gap: 16 }}>
          {withReports.length === 0 ? (
            <Card>
              <div className="empty-state">
                <div className="empty-state-icon" style={{ display: "flex" }}>
                  <Icons.Reports />
                </div>
                <div>No reports yet. Capture evidence and complete signing to generate reports.</div>
                <div style={{ marginTop: 16 }}>
                  <Link href="/capture">
                    <button className="btn primary" type="button">
                      {t("ctaCapture")}
                    </button>
                  </Link>
                </div>
              </div>
            </Card>
          ) : (
            withReports.map((item) => (
              <Card key={item.id}>
                {isUuid(item.id) ? (
                  <Link href={`/evidence/${item.id}`} style={{ display: "block" }}>
                    <ListRow
                      title={item.type}
                      subtitle={new Date(item.createdAt).toLocaleString()}
                      badge={
                        item.status === "SIGNED" ? (
                          <Badge tone="signed">{t("statusSigned")}</Badge>
                        ) : (
                          <Badge tone="ready">{t("statusReady")}</Badge>
                        )}
                    />
                  </Link>
                ) : (
                  <ListRow
                    title={item.type}
                    subtitle={new Date(item.createdAt).toLocaleString()}
                    badge={<Badge tone="ready">{item.status}</Badge>}
                  />
                )}
              </Card>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
