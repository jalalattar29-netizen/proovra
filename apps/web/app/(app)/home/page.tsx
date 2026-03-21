// D:\digital-witness\apps\web\app\(app)\home\page.tsx
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Badge, Button, Card, ListRow, useToast, EmptyState, Skeleton } from "../../../components/ui";
import { useLocale } from "../../providers";
import { apiFetch } from "../../../lib/api";
import { captureException } from "../../../lib/sentry";

export default function HomePage() {
  const { t } = useLocale();
  const { addToast } = useToast();

  const [filter, setFilter] = useState<"active" | "archived" | "all">("active");
  const [items, setItems] = useState<Array<{ id: string; type: string; status: string; createdAt: string; archivedAt?: string | null }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [allItems, setAllItems] = useState<Array<{ id: string; type: string; status: string; createdAt: string; archivedAt?: string | null }>>([]);

  const isUuid = (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

  useEffect(() => {
    setLoading(true);
    setError(null);

    apiFetch("/v1/evidence?includeArchived=true")
      .then((data) => {
        const fetchedItems = data.items ?? [];
        setAllItems(fetchedItems);
        if (fetchedItems.length > 0) addToast(`Loaded ${fetchedItems.length} evidence item(s)`, "success");
      })
      .catch((err) => {
        const errorMessage = err?.message || "Failed to load evidence";
        setError(errorMessage);
        captureException(err, { feature: "home_page_evidence_list" });
        addToast(errorMessage, "error");
      })
      .finally(() => setLoading(false));
  }, [addToast]);

  useEffect(() => {
    let filtered = allItems;
    if (filter === "active") {
      filtered = allItems.filter((item) => !item.archivedAt);
    } else if (filter === "archived") {
      filtered = allItems.filter((item) => item.archivedAt);
    }
    setItems(filtered);
  }, [filter, allItems]);

  return (
    <div className="section app-section">
      <div className="app-hero app-hero-full">
        <div className="container">
          <div className="page-title app-page-title" style={{ alignItems: "center", marginBottom: 0 }}>
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
            <Card className="app-card">
              <div className="app-card-title">{t("recentEvidence")}</div>

              <div style={{ display: "flex", gap: 8, marginBottom: 16, borderBottom: "1px solid rgba(148, 163, 184, 0.15)", paddingBottom: 12 }}>
                <button
                  onClick={() => setFilter("active")}
                  style={{
                    padding: "8px 12px",
                    border: "none",
                    background: filter === "active" ? "rgba(101, 235, 255, 0.15)" : "transparent",
                    color: filter === "active" ? "#65ebff" : "#94a3b8",
                    borderRadius: 6,
                    cursor: "pointer",
                    fontSize: 13,
                    fontWeight: filter === "active" ? 600 : 500,
                    borderBottom: filter === "active" ? "2px solid #65ebff" : "none",
                    transition: "all 0.2s ease",
                  }}
                >
                  Active ({allItems.filter((i) => !i.archivedAt).length})
                </button>

                <button
                  onClick={() => setFilter("archived")}
                  style={{
                    padding: "8px 12px",
                    border: "none",
                    background: filter === "archived" ? "rgba(101, 235, 255, 0.15)" : "transparent",
                    color: filter === "archived" ? "#65ebff" : "#94a3b8",
                    borderRadius: 6,
                    cursor: "pointer",
                    fontSize: 13,
                    fontWeight: filter === "archived" ? 600 : 500,
                    borderBottom: filter === "archived" ? "2px solid #65ebff" : "none",
                    transition: "all 0.2s ease",
                  }}
                >
                  Archived ({allItems.filter((i) => i.archivedAt).length})
                </button>

                <button
                  onClick={() => setFilter("all")}
                  style={{
                    padding: "8px 12px",
                    border: "none",
                    background: filter === "all" ? "rgba(101, 235, 255, 0.15)" : "transparent",
                    color: filter === "all" ? "#65ebff" : "#94a3b8",
                    borderRadius: 6,
                    cursor: "pointer",
                    fontSize: 13,
                    fontWeight: filter === "all" ? 600 : 500,
                    borderBottom: filter === "all" ? "2px solid #65ebff" : "none",
                    transition: "all 0.2s ease",
                  }}
                >
                  All ({allItems.length})
                </button>
              </div>

              <div style={{ display: "grid", gap: 10 }}>
                {loading ? (
                  <div style={{ display: "grid", gap: 8 }}>
                    <Skeleton width="100%" height="20px" />
                    <Skeleton width="100%" height="20px" />
                    <Skeleton width="100%" height="20px" />
                  </div>
                ) : error ? (
                  <div className="app-inline-error">{error}</div>
                ) : items.length === 0 ? (
                  <EmptyState
                    title={
                      filter === "active"
                        ? "No active evidence"
                        : filter === "archived"
                          ? "No archived evidence"
                          : "No evidence yet"
                    }
                    subtitle={
                      filter === "active"
                        ? "Capture your first file to see it here."
                        : filter === "archived"
                          ? "Archived evidence will appear here."
                          : "Capture your first file to see it here."
                    }
                    action={() => (
                      filter !== "archived" ? (
                        <Link href="/capture">
                          <Button className="navy-btn">{t("ctaCapture")}</Button>
                        </Link>
                      ) : undefined
                    )}
                  />
                ) : (
                  items.map((item) => {
                    const row = (
                      <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between" }}>
                        <div style={{ flex: 1 }}>
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
                        </div>
                        {item.archivedAt && (
                          <div style={{ fontSize: 12, color: "#94a3b8", whiteSpace: "nowrap", paddingRight: 8 }}>
                            📦 Archived
                          </div>
                        )}
                      </div>
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

            <Card className="app-card">
              <div className="app-card-title">Quick Actions</div>

              <div className="app-actions-grid">
                <Link href="/capture">
                  <Button className="navy-btn action-btn" onClick={() => addToast("Opening capture...", "info")}>
                    New Capture
                  </Button>
                </Link>

                <Link href="/cases">
                  <Button variant="secondary" className="navy-btn action-btn" onClick={() => addToast("Loading cases...", "info")}>
                    View Cases
                  </Button>
                </Link>

                <Link href="/settings">
                  <Button variant="secondary" className="navy-btn action-btn" onClick={() => addToast("Opening settings...", "info")}>
                    Manage Settings
                  </Button>
                </Link>
              </div>

              <div className="status-banner" style={{ marginTop: 18 }}>
                <div className="status-badge">✓</div>
                <div>
                  <div style={{ fontWeight: 700 }}>Trusted chain of custody</div>
                  <div style={{ fontSize: 12, opacity: 0.85 }}>Capture → Sign → Report → Share</div>
                </div>
              </div>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}