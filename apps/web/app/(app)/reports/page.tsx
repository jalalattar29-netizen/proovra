"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { captureException } from "@/lib/sentry";
import Link from "next/link";
import { Card, ListRow, Badge, useToast, EmptyState, Skeleton, Button } from "../../../components/ui";
import { useLocale } from "../../providers";

export default function ReportsPage() {
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
        addToast("Reports loaded successfully", "success");
      })
      .catch((err) => {
        const errorMessage = err?.message || "Failed to load reports";
        setError(errorMessage);
        setItems([]);
        captureException(err, { feature: "reports_page_list" });
        addToast(errorMessage, "error");
      })
      .finally(() => setLoading(false));
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
          {loading ? (
            <div style={{ display: "grid", gap: 8 }}>
              <Skeleton width="100%" height="40px" />
              <Skeleton width="100%" height="40px" />
              <Skeleton width="100%" height="40px" />
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
          ) : withReports.length === 0 ? (
            <EmptyState
              title="No reports yet"
              subtitle="Capture evidence and complete signing to generate verifiable reports."
              action={() => (
                <Link href="/capture">
                  <Button>{t("ctaCapture")}</Button>
                </Link>
              )}
            />
          ) : (
            withReports.map((item) => (
              <Card key={item.id} style={{ cursor: "pointer", transition: "all 0.2s" }}>
                {isUuid(item.id) ? (
                  <Link href={`/evidence/${item.id}`} style={{ display: "block", textDecoration: "none" }}>
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
