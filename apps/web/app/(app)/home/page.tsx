"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Badge,
  Button,
  Card,
  ListRow,
  useToast,
  EmptyState,
  Skeleton,
} from "../../../components/ui";
import { useLocale } from "../../providers";
import { apiFetch } from "../../../lib/api";
import { captureException } from "../../../lib/sentry";

type HomeEvidenceItem = {
  id: string;
  title: string;
  type: string;
  status: string;
  createdAt: string;
  itemCount: number;
  displaySubtitle: string;
};

export default function HomePage() {
  const { t } = useLocale();
  const { addToast } = useToast();

  const [items, setItems] = useState<HomeEvidenceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isUuid = (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    );

  useEffect(() => {
    setLoading(true);
    setError(null);

    apiFetch("/v1/evidence?scope=active")
      .then((data) => {
        setItems(data.items ?? []);
      })
      .catch((err) => {
        const errorMessage = err?.message || "Failed to load evidence";
        setError(errorMessage);
        captureException(err, { feature: "home_page_evidence_list" });
        addToast(errorMessage, "error");
      })
      .finally(() => setLoading(false));
  }, [addToast]);

  return (
    <div className="section app-section">
      <div className="app-hero app-hero-full">
        <div className="container">
          <div
            className="page-title app-page-title"
            style={{ alignItems: "center", marginBottom: 0 }}
          >
            <div>
              <h1
                className="hero-title pricing-hero-title"
                style={{ margin: 0 }}
              >
                {t("home")}
              </h1>
              <p
                className="page-subtitle pricing-subtitle"
                style={{ marginTop: 6 }}
              >
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
                    title="No evidence yet"
                    subtitle="Capture your first file to see it here."
                    action={() => (
                      <Link href="/capture">
                        <Button className="navy-btn">{t("ctaCapture")}</Button>
                      </Link>
                    )}
                  />
                ) : (
                  items.map((item) => {
                    const row = (
                      <ListRow
                        title={item.title || "Digital Evidence Record"}
                        subtitle={item.displaySubtitle}
                        badge={
                          item.status === "SIGNED" ? (
                            <Badge tone="signed">{t("statusSigned")}</Badge>
                          ) : item.status === "PROCESSING" ? (
                            <Badge tone="processing">
                              {t("statusProcessing")}
                            </Badge>
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

            <Card className="app-card">
              <div className="app-card-title">Quick Actions</div>

              <div className="app-actions-grid">
                <Link href="/capture">
                  <Button
                    className="navy-btn action-btn"
                    onClick={() => addToast("Opening capture...", "info")}
                  >
                    New Capture
                  </Button>
                </Link>

                <Link href="/cases">
                  <Button
                    variant="secondary"
                    className="navy-btn action-btn"
                    onClick={() => addToast("Loading cases...", "info")}
                  >
                    View Cases
                  </Button>
                </Link>

                <Link href="/archive">
                  <Button
                    variant="secondary"
                    className="navy-btn action-btn"
                    onClick={() => addToast("Opening archive...", "info")}
                  >
                    Archived Evidence
                  </Button>
                </Link>

                <Link href="/deleted">
                  <Button
                    variant="secondary"
                    className="navy-btn action-btn"
                    onClick={() => addToast("Opening deleted evidence...", "info")}
                  >
                    Deleted Evidence
                  </Button>
                </Link>

                <Link href="/settings">
                  <Button
                    variant="secondary"
                    className="navy-btn action-btn"
                    onClick={() => addToast("Opening settings...", "info")}
                  >
                    Manage Settings
                  </Button>
                </Link>
              </div>

              <div className="status-banner" style={{ marginTop: 18 }}>
                <div className="status-badge">✓</div>
                <div>
                  <div style={{ fontWeight: 700 }}>
                    Trusted chain of custody
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.85 }}>
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