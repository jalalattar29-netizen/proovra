"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Badge, Button, Card, ListRow } from "../../../components/ui";
import { useLocale } from "../../providers";
import { apiFetch } from "../../../lib/api";

export default function HomePage() {
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

  return (
    <div className="app-page-wrap">
      <div className="app-hero">
        <div className="page-title" style={{ alignItems: "center", marginBottom: 0 }}>
          <div>
            <h1 style={{ margin: 0 }}>{t("home")}</h1>
            <p className="page-subtitle">{t("bullets")}</p>
          </div>
          <Link href="/capture">
            <Button className="navy-btn">{t("ctaCapture")}</Button>
          </Link>
        </div>
      </div>

      <div className="app-body" style={{ marginTop: 0, paddingTop: 18 }}>
        <div className="grid-2">
          <Card>
            <div style={{ fontWeight: 800, marginBottom: 12 }}>{t("recentEvidence")}</div>
            <div style={{ display: "grid", gap: 10 }}>
              {items.length === 0 ? (
                <div style={{ color: "#64748b", fontSize: 13 }}>
                  No evidence yet. Capture your first file to see it here.
                </div>
              ) : (
                items.map((item) => {
                  const row = (
                    <ListRow
                      title={item.type}
                      subtitle={new Date(item.createdAt).toLocaleString()}
                      badge={
                        item.status === "SIGNED" ? (
                          <Badge tone="signed">{t("statusSigned")}</Badge>
                        ) : item.status === "PROCESSING" ? (
                          <Badge tone="processing">{t("statusProcessing")}</Badge>
                        ) : (
                          <Badge tone="ready">{t("statusReady")}</Badge>
                        )
                      }
                    />
                  );
                  return isUuid(item.id) ? (
                    <Link key={item.id} href={`/evidence/${item.id}`}>
                      {row}
                    </Link>
                  ) : (
                    <div key={item.id}>{row}</div>
                  );
                })
              )}
            </div>
          </Card>

          <Card>
            <div style={{ fontWeight: 800, marginBottom: 12 }}>Quick Actions</div>
            <div style={{ display: "grid", gap: 10 }}>
              <Link href="/capture">
                <Button className="navy-btn">New Capture</Button>
              </Link>
              <Link href="/cases">
                <Button variant="secondary" className="navy-btn">
                  View Cases
                </Button>
              </Link>
              <Link href="/settings">
                <Button variant="secondary" className="navy-btn">
                  Manage Settings
                </Button>
              </Link>
            </div>

            <div style={{ marginTop: 18 }} className="status-banner">
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 14,
                  background: "rgba(255,255,255,0.18)",
                  display: "grid",
                  placeItems: "center",
                  fontWeight: 900
                }}
              >
                ✓
              </div>
              <div>
                <div style={{ fontWeight: 800 }}>Trusted chain of custody</div>
                <div style={{ fontSize: 12, opacity: 0.85 }}>Capture → Sign → Report → Share</div>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
