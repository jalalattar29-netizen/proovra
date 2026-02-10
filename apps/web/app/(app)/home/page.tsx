"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Badge, Button, Card, ListRow, useToast, EmptyState, Skeleton } from "../../../components/ui";
import { useLocale } from "../../providers";
import { Icons } from "../../../components/icons";
import { apiFetch } from "../../../lib/api";
import { captureException } from "../../../lib/sentry";

export default function HomePage() {
  const { t } = useLocale();
  const { addToast } = useToast();
  const [items, setItems] = useState<
    Array<{ id: string; type: string; status: string; createdAt: string }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isUuid = (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

  useEffect(() => {
    setLoading(true);
    setError(null);
    
    apiFetch("/v1/evidence")
      .then((data) => {
        setItems(data.items ?? []);
        if (data.items && data.items.length > 0) {
          addToast(`Loaded ${data.items.length} evidence item(s)`, "success");
        }
      })
      .catch((err) => {
        const errorMessage = err?.message || "Failed to load evidence";
        setError(errorMessage);
        captureException(err, { feature: "home_page_evidence_list" });
        addToast(errorMessage, "error");
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="section app-section">
      <div className="app-hero app-hero-full">
        <div className="container">
          <div className="page-title" style={{ alignItems: "center", marginBottom: 0 }}>
            <div>
              <h1 className="hero-title pricing-hero-title" style={{ margin: 0 }}>
                {t("home")}
              </h1>
              <p className="page-subtitle pricing-subtitle" style={{ marginTop: 6 }}>
                {t("bullets")}
              </p>
            </div>
            <Link href="/capture">
              <Button className="navy-btn">{t("ctaCapture")}</Button>
            </Link>
          </div>
        </div>
      </div>

      <div className="app-body app-body-full">
        <div className="container">
          <div className="grid-2">
            <Card>
              <div style={{ fontWeight: 700, marginBottom: 12 }}>{t("recentEvidence")}</div>
              <div style={{ display: "grid", gap: 10 }}>
                {loading ? (
                  <div style={{ display: "grid", gap: 8 }}>
                    <Skeleton width="100%" height={20} />
                    <Skeleton width="100%" height={20} />
                    <Skeleton width="100%" height={20} />
                  </div>
                ) : error ? (
                  <div style={{
                    padding: 16,
                    background: "#FEE2E2",
                    borderRadius: 8,
                    color: "#991B1B",
                    fontSize: 12
                  }}>
                    {error}
                  </div>
                ) : items.length === 0 ? (
                  <EmptyState
                    title="No evidence yet"
                    subtitle="Capture your first file to see it here."
                  >
                    <Link href="/capture">
                      <Button>{t("ctaCapture")}</Button>
                    </Link>
                  </EmptyState>
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
              <div style={{ fontWeight: 700, marginBottom: 12 }}>Quick Actions</div>
              <div style={{ display: "grid", gap: 10 }}>
                <Link href="/capture">
                  <Button 
                    className="action-btn"
                    onClick={() => addToast("Opening capture...", "info")}
                  >
                    New Capture
                  </Button>
                </Link>
                <Link href="/cases">
                  <Button 
                    variant="secondary" 
                    className="action-btn"
                    onClick={() => addToast("Loading cases...", "info")}
                  >
                    View Cases
                  </Button>
                </Link>
                <Link href="/settings">
                  <Button 
                    variant="secondary" 
                    className="action-btn"
                    onClick={() => addToast("Opening settings...", "info")}
                  >
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
                    fontWeight: 800
                  }}
                >
                  ✓
                </div>
                <div>
                  <div style={{ fontWeight: 700 }}>Trusted chain of custody</div>
                  <div style={{ fontSize: 12, opacity: 0.8 }}>
                    Capture → Sign → Report → Share
                  </div>
                </div>
              </div>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
