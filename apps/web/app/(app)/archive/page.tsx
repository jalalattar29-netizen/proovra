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

type ArchiveEvidenceItem = {
  id: string;
  title: string;
  type: string;
  status: string;
  createdAt: string;
  archivedAt: string | null;
  itemCount: number;
  displaySubtitle: string;
};

export default function ArchivePage() {
  const { t } = useLocale();
  const { addToast } = useToast();

  const [items, setItems] = useState<ArchiveEvidenceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isUuid = (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    );

  useEffect(() => {
    setLoading(true);
    setError(null);

    apiFetch("/v1/evidence?scope=archived")
      .then((data) => {
        setItems(data.items ?? []);
      })
      .catch((err) => {
        const errorMessage = err?.message || "Failed to load archived evidence";
        setError(errorMessage);
        setItems([]);
        captureException(err, { feature: "archive_page_list" });
        addToast(errorMessage, "error");
      })
      .finally(() => setLoading(false));
  }, [addToast]);

  return (
    <div className="section app-section">
      <div className="app-hero app-hero-full">
        <div className="container">
          <div className="page-title" style={{ marginBottom: 0 }}>
            <div>
              <h1 className="hero-title pricing-hero-title" style={{ margin: 0 }}>
                Archived Evidence
              </h1>
              <p className="page-subtitle pricing-subtitle" style={{ marginTop: 6 }}>
                Previously archived evidence records.
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
            <Card className="app-card">
              <div className="app-inline-error">{error}</div>
            </Card>
          ) : items.length === 0 ? (
            <Card className="app-card">
              <EmptyState
                title="No archived evidence"
                subtitle="When you archive evidence, it will appear here."
                action={() => (
                  <Link href="/home">
                    <Button>{t("home")}</Button>
                  </Link>
                )}
              />
            </Card>
          ) : (
            items.map((item) => (
              <Card key={item.id} className="app-card">
                {isUuid(item.id) ? (
                  <Link
                    href={`/evidence/${item.id}`}
                    style={{ display: "block", textDecoration: "none" }}
                  >
                    <ListRow
                      title={item.title || "Digital Evidence Record"}
                      subtitle={
                        item.archivedAt
                          ? `${item.displaySubtitle} • Archived ${new Date(
                              item.archivedAt
                            ).toLocaleString()}`
                          : item.displaySubtitle
                      }
                      badge={
                        <Badge tone="ready">
                          Archived
                        </Badge>
                      }
                    />
                  </Link>
                ) : (
                  <ListRow
                    title={item.title || "Digital Evidence Record"}
                    subtitle={item.displaySubtitle}
                    badge={<Badge tone="ready">Archived</Badge>}
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