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

type DeletedEvidenceItem = {
  id: string;
  title: string;
  type: string;
  status: string;
  createdAt: string;
  deletedAt: string | null;
  deleteScheduledForUtc: string | null;
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

export default function DeletedEvidencePage() {
  const { addToast } = useToast();

  const [items, setItems] = useState<DeletedEvidenceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionBusyId, setActionBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadDeletedEvidence = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const data = await apiFetch("/v1/evidence?scope=deleted");
      setItems(Array.isArray(data?.items) ? data.items : []);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load deleted evidence";
      setError(message);
      captureException(err, { feature: "deleted_evidence_page_load" });
      addToast(message, "error");
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    void loadDeletedEvidence();
  }, [loadDeletedEvidence]);

  const handleRestore = async (evidenceId: string) => {
    setActionBusyId(evidenceId);

    try {
      addToast("Restoring evidence from trash...", "info");

      await apiFetch(`/v1/evidence/${evidenceId}/restore`, {
        method: "POST",
        body: JSON.stringify({ restore: true }),
      });

      setItems((current) => current.filter((item) => item.id !== evidenceId));
      addToast("Evidence restored from trash", "success");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to restore evidence";
      captureException(err, {
        feature: "deleted_evidence_restore_from_list",
        evidenceId,
      });
      addToast(message, "error");
    } finally {
      setActionBusyId(null);
    }
  };

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
                Deleted Evidence
              </h1>
              <p
                className="page-subtitle pricing-subtitle"
                style={{ marginTop: 6 }}
              >
                Review deleted records and restore them during the 90-day
                recovery window.
              </p>
            </div>

            <Link href="/evidence"></Link>
          </div>
        </div>
      </div>

      <div className="app-body app-body-full">
        <div className="container">
          <Card className="app-card">
            <div className="app-card-title">Deleted Records</div>

            <div
              style={{
                marginBottom: 16,
                padding: 14,
                borderRadius: 12,
                border: "1px solid rgba(248, 113, 113, 0.16)",
                background:
                  "linear-gradient(135deg, rgba(127,29,29,0.18), rgba(69,10,10,0.14))",
                color: "#fecaca",
                fontSize: 14,
                lineHeight: 1.65,
              }}
            >
              Items shown here are in secure trash. They remain recoverable until
              their scheduled permanent deletion date.
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
                title="No deleted evidence"
                subtitle="Your secure trash is currently empty."
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
                      borderRadius: 14,
                      border: "1px solid rgba(148, 163, 184, 0.14)",
                      background: "rgba(15, 23, 42, 0.32)",
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
                            fontWeight: 800,
                            color: "#f8fafc",
                            wordBreak: "break-word",
                          }}
                        >
                          {item.title || "Digital Evidence Record"}
                        </div>

                        <div
                          style={{
                            marginTop: 6,
                            fontSize: 13,
                            color: "#94a3b8",
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
                          border: "1px solid rgba(248, 113, 113, 0.2)",
                          background: "rgba(248, 113, 113, 0.12)",
                          color: "#fca5a5",
                        }}
                      >
                        In Trash
                      </div>
                    </div>

                    <div
                      style={{
                        display: "grid",
                        gap: 6,
                        fontSize: 13,
                        color: "#cbd5e1",
                        lineHeight: 1.6,
                      }}
                    >
                      <div>
                        <strong>Deleted At:</strong>{" "}
                        {formatUtcDateTime(item.deletedAt)}
                      </div>
                      <div>
                        <strong>Permanent Deletion Date:</strong>{" "}
                        {formatUtcDateTime(item.deleteScheduledForUtc)}
                      </div>
                      <div>
                        <strong>Items:</strong> {item.itemCount}
                      </div>
                    </div>

                    <div
                      style={{
                        display: "flex",
                        gap: 10,
                        flexWrap: "wrap",
                      }}
                    >
                      <Link href={`/evidence/${item.id}`}>
                        <Button variant="secondary">Open Record</Button>
                      </Link>

                      <Button
                        onClick={() => handleRestore(item.id)}
                        disabled={actionBusyId === item.id}
                      >
                        {actionBusyId === item.id
                          ? "Restoring..."
                          : "Restore from Trash"}
                      </Button>
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