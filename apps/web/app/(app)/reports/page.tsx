"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Card,
  ListRow,
  Badge,
  useToast,
  EmptyState,
  Skeleton,
  Button,
} from "../../../components/ui";
import { useLocale } from "../../providers";
import { apiFetch } from "../../../lib/api";
import { captureException } from "../../../lib/sentry";

type ReportItem = {
  id: string;
  title: string;
  type: string;
  status: string;
  createdAt: string;
  itemCount: number;
  displaySubtitle: string;
};

export default function ReportsPage() {
  const { t } = useLocale();
  const { addToast } = useToast();

  const [items, setItems] = useState<ReportItem[]>([]);
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
      .then((data: { items?: ReportItem[] }) => {
        setItems(Array.isArray(data?.items) ? data.items : []);
      })
      .catch((err: Error | unknown) => {
        const errorMessage =
          err instanceof Error ? err.message : "Failed to load reports";
        setError(errorMessage);
        setItems([]);
        captureException(err, { feature: "reports_page_list" });
        addToast(errorMessage, "error");
      })
      .finally(() => setLoading(false));
  }, [addToast]);

  const withReports = items.filter(
    (item) => item.status === "REPORTED" || item.status === "SIGNED"
  );

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
        {loading ? (
          <div style={{ display: "grid", gap: 8 }}>
            <Skeleton width="100%" height="56px" />
            <Skeleton width="100%" height="56px" />
            <Skeleton width="100%" height="56px" />
          </div>
        ) : error ? (
          <Card className="app-card">
            <div
              style={{
                padding: 16,
                borderRadius: 14,
                background: "rgba(127,29,29,0.18)",
                border: "1px solid rgba(248,113,113,0.18)",
                color: "#fecaca",
                fontSize: 13,
              }}
            >
              {error}
            </div>
          </Card>
        ) : withReports.length === 0 ? (
          <Card className="app-card">
            <EmptyState
              title="No reports yet"
              subtitle="Capture evidence and complete signing to generate verifiable reports."
              action={() => (
                <Link href="/capture">
                  <Button>{t("ctaCapture")}</Button>
                </Link>
              )}
            />
          </Card>
        ) : (
          withReports.map((item) => (
            <div key={item.id} style={{ cursor: "pointer", transition: "all 0.2s" }}>
              <Card className="app-card">
                {isUuid(item.id) ? (
                  <Link href={`/evidence/${item.id}`} style={{ display: "block", textDecoration: "none" }}>
                    <ListRow
                      title={item.title || "Digital Evidence Record"}
                      subtitle={item.displaySubtitle}
                      badge={
                        item.status === "SIGNED" ? (
                          <Badge tone="signed">{t("statusSigned")}</Badge>
                        ) : (
                          <Badge tone="ready">{t("statusReady")}</Badge>
                        )
                      }
                    />
                  </Link>
                ) : (
                  <ListRow
                    title={item.title || "Digital Evidence Record"}
                    subtitle={item.displaySubtitle}
                    badge={
                      item.status === "SIGNED" ? (
                        <Badge tone="signed">{t("statusSigned")}</Badge>
                      ) : (
                        <Badge tone="ready">{t("statusReady")}</Badge>
                      )
                    }
                  />
                )}
              </Card>
            </div>
          ))
        )}
      </div>
    </div>
  </div>
);
}