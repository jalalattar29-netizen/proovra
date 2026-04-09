"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Button,
  Card,
  EmptyState,
  Skeleton,
  useToast,
} from "../../../components/ui";
import { apiFetch } from "../../../lib/api";
import { captureException } from "../../../lib/sentry";

type LockedEvidenceItem = {
  id: string;
  title: string;
  type: string;
  status: string;
  createdAt: string;
  lockedAt: string | null;
  itemCount: number;
  displaySubtitle: string;
};

function formatUtcDateTime(value: string | null | undefined): string {
  if (!value) return "Not available";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not available";

  const day = date.getUTCDate().toString().padStart(2, "0");
  const month = date.toLocaleString("en-GB", {
    month: "short",
    timeZone: "UTC",
  });
  const year = date.getUTCFullYear();
  const hours = date.getUTCHours().toString().padStart(2, "0");
  const minutes = date.getUTCMinutes().toString().padStart(2, "0");
  const seconds = date.getUTCSeconds().toString().padStart(2, "0");

  return `${day} ${month} ${year}, ${hours}:${minutes}:${seconds} UTC`;
}

export default function LockedEvidencePage() {
  const { addToast } = useToast();

  const [items, setItems] = useState<LockedEvidenceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadLockedEvidence = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const data = await apiFetch("/v1/evidence?scope=locked");
      setItems(Array.isArray(data?.items) ? data.items : []);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load locked evidence";
      setError(message);
      captureException(err, { feature: "locked_evidence_page_load" });
      addToast(message, "error");
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    void loadLockedEvidence();
  }, [loadLockedEvidence]);

return (
  <div className="section app-section">
    <div className="app-hero app-hero-full">
      <div className="container">
        <div className="page-title app-page-title" style={{ alignItems: "center", marginBottom: 0 }}>
          <div>
            <h1 className="hero-title pricing-hero-title" style={{ margin: 0 }}>
              Locked Evidence
            </h1>
            <p className="page-subtitle pricing-subtitle" style={{ marginTop: 6 }}>
              Review permanently sealed evidence records that were removed from the active workspace.
            </p>
          </div>

          <Link href="/evidence" style={{ textDecoration: "none" }}>
            <Button variant="secondary">Open Evidence</Button>
          </Link>
        </div>
      </div>
    </div>

    <div className="app-body app-body-full">
      <div className="container">
        <Card className="app-card">
          <div className="app-card-title">Locked Records</div>

          <div
            style={{
              marginBottom: 16,
              padding: 14,
              borderRadius: 14,
              border: "1px solid rgba(214,184,157,0.18)",
              background:
                "linear-gradient(135deg, rgba(183,157,132,0.10), rgba(15,23,42,0.18))",
              color: "#e6c9ae",
              fontSize: 14,
              lineHeight: 1.7,
            }}
          >
            Items shown here are permanently sealed evidence records. They are excluded from the active
            evidence list to keep the workspace clean, while remaining fully preserved for review.
          </div>

          {loading ? (
            <div style={{ display: "grid", gap: 12 }}>
              <Skeleton width="100%" height="72px" />
              <Skeleton width="100%" height="72px" />
              <Skeleton width="100%" height="72px" />
            </div>
          ) : error ? (
            <div className="app-inline-error">{error}</div>
          ) : items.length === 0 ? (
            <EmptyState
              title="No locked evidence"
              subtitle="You do not have any permanently locked evidence yet."
              action={() => (
                <Link href="/evidence">
                  <Button className="navy-btn">Open Evidence</Button>
                </Link>
              )}
            />
          ) : (
            <div style={{ display: "grid", gap: 14 }}>
              {items.map((item) => (
                <div
                  key={item.id}
                  style={{
                    display: "grid",
                    gap: 12,
                    padding: 16,
                    borderRadius: 16,
                    border: "1px solid rgba(255,255,255,0.08)",
                    background: "rgba(255,255,255,0.035)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "flex-start",
                      gap: 12,
                      flexWrap: "wrap",
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 18,
                          fontWeight: 700,
                          color: "rgba(246,252,255,0.96)",
                          wordBreak: "break-word",
                          letterSpacing: "-0.02em",
                        }}
                      >
                        {item.title || "Digital Evidence Record"}
                      </div>

                      <div
                        style={{
                          marginTop: 6,
                          fontSize: 13,
                          color: "rgba(219,235,248,0.72)",
                          lineHeight: 1.6,
                        }}
                      >
                        {item.displaySubtitle}
                      </div>
                    </div>

                    <div
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        minHeight: 32,
                        padding: "7px 11px",
                        borderRadius: 999,
                        fontSize: 12,
                        fontWeight: 800,
                        letterSpacing: "0.04em",
                        textTransform: "uppercase",
                        border: "1px solid rgba(214,184,157,0.22)",
                        background: "rgba(214,184,157,0.12)",
                        color: "#e6c9ae",
                      }}
                    >
                      Locked
                    </div>
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gap: 6,
                      fontSize: 13,
                      color: "rgba(219,235,248,0.82)",
                      lineHeight: 1.6,
                    }}
                  >
                    <div>
                      <strong style={{ color: "#f3f7f5" }}>Locked At:</strong> {formatUtcDateTime(item.lockedAt)}
                    </div>
                    <div>
                      <strong style={{ color: "#f3f7f5" }}>Items:</strong> {item.itemCount}
                    </div>
                    <div>
                      <strong style={{ color: "#f3f7f5" }}>Legal State:</strong> Permanently sealed
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <Link href={`/evidence/${item.id}`}>
                      <Button variant="secondary">Open Record</Button>
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  </div>
);
}