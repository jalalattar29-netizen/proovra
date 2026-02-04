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

  useEffect(() => {
    apiFetch("/v1/evidence")
      .then((data) => setItems(data.items ?? []))
      .catch(() => setItems([]));
  }, []);

  return (
    <div className="section">
      <div className="page-title">
        <div>
          <h1 style={{ margin: 0 }}>{t("home")}</h1>
          <p className="page-subtitle">{t("bullets")}</p>
        </div>
        <Link href="/capture">
          <Button>{t("ctaCapture")}</Button>
        </Link>
      </div>
      <div className="grid-2">
        <Card>
          <div style={{ fontWeight: 700, marginBottom: 12 }}>{t("recentEvidence")}</div>
          <div style={{ display: "grid", gap: 10 }}>
            {items.length === 0 ? (
              <>
                <ListRow
                  title={t("photo")}
                  subtitle="3 minutes ago"
                  badge={<Badge tone="signed">{t("statusSigned")}</Badge>}
                />
                <ListRow
                  title={t("video")}
                  subtitle="Today, 09:45"
                  badge={<Badge tone="processing">{t("statusProcessing")}</Badge>}
                />
                <ListRow
                  title={t("document")}
                  subtitle="Yesterday"
                  badge={<Badge tone="ready">{t("statusReady")}</Badge>}
                />
              </>
            ) : (
            items.map((item) => (
              <Link key={item.id} href={`/evidence/${item.id}`}>
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
              </Link>
            ))
            )}
          </div>
        </Card>
        <Card>
          <div style={{ fontWeight: 700, marginBottom: 12 }}>Quick Actions</div>
          <div style={{ display: "grid", gap: 10 }}>
            <Link href="/capture">
              <Button>New Capture</Button>
            </Link>
            <Link href="/cases">
              <Button variant="secondary">View Cases</Button>
            </Link>
            <Link href="/settings">
              <Button variant="secondary">Manage Settings</Button>
            </Link>
          </div>
        </Card>
      </div>
    </div>
  );
}
