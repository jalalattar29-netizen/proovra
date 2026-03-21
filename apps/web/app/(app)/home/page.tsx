"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Badge, Button, Card, ListRow, useToast, EmptyState, Skeleton } from "../../../components/ui";
import { useLocale } from "../../providers";
import { apiFetch } from "../../../lib/api";
import { captureException } from "../../../lib/sentry";

type EvidenceItem = {
  id: string;
  type: string;
  status: string;
  createdAt: string;
  archivedAt?: string | null;
};

export default function HomePage() {
  const { t } = useLocale();
  const { addToast } = useToast();

  const [filter, setFilter] = useState<"active" | "archived" | "all">("active");
  const [items, setItems] = useState<EvidenceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [allItems, setAllItems] = useState<EvidenceItem[]>([]);

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

  const counts = useMemo(
    () => ({
      active: allItems.filter((i) => !i.archivedAt).length,
      archived: allItems.filter((i) => i.archivedAt).length,
      all: allItems.length,
    }),
    [allItems]
  );

  return (
    <div className="section app-section home-dashboard-pro">
      <div className="app-hero app-hero-full home-hero-pro">
        <div className="container">
          <div className="page-title app-page-title home-hero-header-pro">
            <div className="home-hero-copy-pro">
              <h1 className="hero-title pricing-hero-title home-hero-title-pro" style={{ margin: 0 }}>
                {t("home")}
              </h1>
              <p className="page-subtitle pricing-subtitle home-hero-subtitle-pro" style={{ marginTop: 6 }}>
                {t("bullets")}
              </p>
            </div>

            <Link href="/capture">
              <Button className="navy-btn home-capture-btn-pro">{t("ctaCapture")}</Button>
            </Link>
          </div>
        </div>
      </div>

      <div className="app-body app-body-full">
        <div className="container">
          <div className="home-dashboard-grid-pro">
            <Card className="app-card home-main-card-pro">
              <div className="home-card-topline-pro">
                <div className="home-card-brand-pro">PROOVRA</div>

                <div className="home-filter-tabs-pro">
                  <button
                    type="button"
                    onClick={() => setFilter("active")}
                    className={filter === "active" ? "home-filter-tab-pro active" : "home-filter-tab-pro"}
                  >
                    Active ({counts.active})
                  </button>

                  <button
                    type="button"
                    onClick={() => setFilter("archived")}
                    className={filter === "archived" ? "home-filter-tab-pro active" : "home-filter-tab-pro"}
                  >
                    Archived ({counts.archived})
                  </button>

                  <button
                    type="button"
                    onClick={() => setFilter("all")}
                    className={filter === "all" ? "home-filter-tab-pro active" : "home-filter-tab-pro"}
                  >
                    All ({counts.all})
                  </button>
                </div>
              </div>

              <div className="home-section-header-pro">
                <h2 className="app-card-title home-section-title-pro">{t("recentEvidence")}</h2>
                <Link href="/capture">
                  <button type="button" className="home-inline-capture-pro">
                    Capture Evidence
                  </button>
                </Link>
              </div>

              <div className="home-evidence-list-pro">
                {loading ? (
                  <div className="home-skeleton-stack-pro">
                    <Skeleton width="100%" height="64px" />
                    <Skeleton width="100%" height="64px" />
                    <Skeleton width="100%" height="64px" />
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
                  />
                ) : (
                  items.map((item) => {
                    const row = (
                      <div className="home-evidence-row-pro">
                        <div className="home-evidence-row-main-pro">
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
                          <div className="home-archived-mark-pro">📦 Archived</div>
                        )}
                      </div>
                    );

                    return isUuid(item.id) ? (
                      <Link key={item.id} href={`/evidence/${item.id}`} className="home-evidence-link-pro">
                        {row}
                      </Link>
                    ) : (
                      <div key={item.id}>{row}</div>
                    );
                  })
                )}
              </div>
            </Card>

            <Card className="app-card home-side-card-pro">
              <div className="app-card-title home-side-title-pro">Quick Actions</div>

              <div className="app-actions-grid home-actions-grid-pro">
                <Link href="/capture">
                  <Button
                    className="navy-btn action-btn home-action-btn-pro"
                    onClick={() => addToast("Opening capture...", "info")}
                  >
                    New Capture
                  </Button>
                </Link>

                <Link href="/cases">
                  <Button
                    variant="secondary"
                    className="navy-btn action-btn home-action-btn-pro"
                    onClick={() => addToast("Loading cases...", "info")}
                  >
                    View Cases
                  </Button>
                </Link>

                <Link href="/settings">
                  <Button
                    variant="secondary"
                    className="navy-btn action-btn home-action-btn-pro"
                    onClick={() => addToast("Opening settings...", "info")}
                  >
                    Manage Settings
                  </Button>
                </Link>
              </div>

              <div className="home-preview-card-pro">
                <div className="home-preview-card-head-pro">
                  <span className="home-preview-label-pro">PHOTO</span>
                  <div className="home-preview-pills-pro">
                    <span>Recent</span>
                    <span>Verified</span>
                    <span>Archived</span>
                  </div>
                </div>

                <div className="home-preview-media-pro">
                  <div className="home-preview-media-frame-pro">
                    <div className="home-preview-media-glow-pro" />
                  </div>
                </div>

                <div className="home-preview-actions-pro">
                  <Button variant="secondary" className="home-preview-btn-pro">
                    Primary
                  </Button>
                  <Button variant="secondary" className="home-preview-btn-pro">
                    Secondary
                  </Button>
                  <Button className="button-danger home-preview-btn-pro">
                    Danger
                  </Button>
                  <Button variant="secondary" className="home-preview-btn-pro">
                    Download
                  </Button>
                </div>
              </div>

              <div className="status-banner home-status-banner-pro">
                <div className="status-badge">✓</div>
                <div>
                  <div className="home-status-title-pro">Trusted chain of custody</div>
                  <div className="home-status-subtitle-pro">Capture → Sign → Report → Share</div>
                </div>
              </div>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}