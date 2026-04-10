"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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

  const outerCardStyle = useMemo(
    () =>
      ({
        border: "1px solid rgba(183,157,132,0.18)",
        boxShadow:
          "0 22px 42px rgba(0,0,0,0.16), inset 0 1px 0 rgba(255,255,255,0.03)",
      }) as const,
    []
  );

  const primaryButtonStyle = useMemo(
    () =>
      ({
        borderColor: "rgba(158,216,207,0.14)",
        color: "#aebbb6",
        background:
          "linear-gradient(180deg, rgba(62,98,96,0.26) 0%, rgba(14,30,34,0.38) 100%)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.04), 0 14px 28px rgba(0,0,0,0.08)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
      }) as const,
    []
  );

  const rowCardStyle = useMemo(
    () =>
      ({
        border: "1px solid rgba(158,216,207,0.14)",
        background:
          "linear-gradient(180deg, rgba(62,98,96,0.24) 0%, rgba(14,30,34,0.36) 100%)",
        borderRadius: 22,
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.04), 0 14px 28px rgba(0,0,0,0.08)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
      }) as const,
    []
  );

  return (
    <div className="section app-section">
      <div className="app-hero app-hero-full">
        <div className="container">
          <div className="page-title app-page-title" style={{ marginBottom: 0 }}>
            <div className="max-w-[760px]">
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  borderRadius: 999,
                  border: "1px solid rgba(255,255,255,0.10)",
                  background: "rgba(255,255,255,0.04)",
                  padding: "8px 16px",
                  fontSize: "0.68rem",
                  fontWeight: 500,
                  textTransform: "uppercase",
                  letterSpacing: "0.28em",
                  color: "#afbbb7",
                  boxShadow: "0 10px 24px rgba(0,0,0,0.08)",
                }}
              >
                <span
                  style={{
                    width: 4,
                    height: 4,
                    borderRadius: 999,
                    background: "#b79d84",
                    opacity: 0.8,
                    display: "inline-block",
                  }}
                />
                Locked Evidence
              </div>

              <h1 className="mt-5 max-w-[720px] text-[1.72rem] font-medium leading-[1.02] tracking-[-0.045em] text-[#d9e2df] md:text-[2.22rem] lg:text-[2.72rem]">
                Permanently sealed{" "}
                <span className="text-[#c3ebe2]">evidence records</span>.
              </h1>

              <p className="mt-5 max-w-[700px] text-[0.95rem] font-normal leading-[1.8] tracking-[-0.006em] text-[#aab5b2] md:text-[0.99rem]">
                Review evidence that has been{" "}
                <span className="text-[#cfd8d5]">irreversibly locked</span> and
                removed from the active workspace while remaining fully{" "}
                <span className="text-[#bbc7c3]">preserved for audit and review</span>.
              </p>

              <div className="mt-6 flex flex-wrap gap-2.5">
                <div className="rounded-full border border-white/10 bg-white/[0.055] px-3.5 py-2 text-[0.78rem] font-normal text-[#c7d1ce] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                  <span className="mr-2 text-[#91aca5]">✓</span>
                  Permanently sealed state
                </div>

                <div className="rounded-full border border-white/10 bg-white/[0.055] px-3.5 py-2 text-[0.78rem] font-normal text-[#c7d1ce] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                  <span className="mr-2 text-[#91aca5]">✓</span>
                  Removed from active workspace
                </div>

                <div className="rounded-full border border-[rgba(214,184,157,0.18)] bg-[linear-gradient(180deg,rgba(183,157,132,0.07)_0%,rgba(255,255,255,0.028)_100%)] px-3.5 py-2 text-[0.78rem] font-normal text-[#d9ccbf] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                  <span className="mr-2 text-[#c2a07f]">✓</span>
                  Preserved for review
                </div>
              </div>
            </div>

            <div className="flex shrink-0">
              <Link href="/evidence" style={{ textDecoration: "none" }}>
                <Button
                  className="rounded-[999px] border px-6 py-3 text-[0.95rem] font-semibold"
                  style={primaryButtonStyle}
                >
                  Open Evidence
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </div>

      <div className="app-body app-body-full">
        <section className="relative px-6 pb-14 md:px-8 md:pb-16">
          <div className="mx-auto max-w-7xl">
            <Card
              className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
              style={outerCardStyle}
            >
              <div className="absolute inset-0">
                <img
                  src="/images/site-velvet-bg.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center scale-[1.12]"
                />
              </div>
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,20,24,0.82)_0%,rgba(7,18,22,0.88)_100%)]" />
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_14%,rgba(158,216,207,0.05),transparent_28%)]" />
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_86%_18%,rgba(214,184,157,0.04),transparent_24%)]" />

              <div className="relative z-10 p-5 md:p-6">
                <div className="mb-5 text-[1.08rem] font-semibold tracking-[-0.02em] text-[#d8e0dd]">
                  Locked Records
                </div>

                <div
                  style={{
                    marginBottom: 16,
                    padding: 14,
                    borderRadius: 18,
                    border: "1px solid rgba(214,184,157,0.18)",
                    background:
                      "linear-gradient(135deg, rgba(214,184,157,0.10), rgba(158,216,207,0.08))",
                    color: "#dcc0a5",
                    fontSize: 14,
                    lineHeight: 1.7,
                  }}
                >
                  Items shown here are permanently sealed evidence records. They are excluded from
                  the active evidence list to keep the workspace clean, while remaining fully
                  preserved for review.
                </div>

                {loading ? (
                  <div style={{ display: "grid", gap: 12 }}>
                    <div style={{ ...rowCardStyle, padding: 18 }}>
                      <Skeleton width="100%" height="72px" />
                    </div>
                    <div style={{ ...rowCardStyle, padding: 18 }}>
                      <Skeleton width="100%" height="72px" />
                    </div>
                    <div style={{ ...rowCardStyle, padding: 18 }}>
                      <Skeleton width="100%" height="72px" />
                    </div>
                  </div>
                ) : error ? (
                  <div className="rounded-[20px] border border-[rgba(255,120,120,0.16)] bg-[rgba(120,20,20,0.12)] px-4 py-3 text-[0.92rem] text-[#ffd7d7]">
                    {error}
                  </div>
                ) : items.length === 0 ? (
                  <div className="rounded-[24px] p-4" style={rowCardStyle}>
                    <EmptyState
                      title="No locked evidence"
                      subtitle="You do not have any permanently locked evidence yet."
                      action={() => (
                        <Link href="/evidence">
                          <Button
                            className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                            style={primaryButtonStyle}
                          >
                            Open Evidence
                          </Button>
                        </Link>
                      )}
                    />
                  </div>
                ) : (
                  <div style={{ display: "grid", gap: 14 }}>
                    {items.map((item) => (
                      <div
                        key={item.id}
                        style={{
                          ...rowCardStyle,
                          padding: 20,
                          display: "grid",
                          gap: 14,
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
                                color: "#d8e0dd",
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
                                color: "rgba(194,204,201,0.72)",
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
                              background:
                                "linear-gradient(180deg, rgba(183,157,132,0.12) 0%, rgba(255,255,255,0.03) 100%)",
                              color: "#dcc0a5",
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
                            color: "rgba(194,204,201,0.82)",
                            lineHeight: 1.6,
                          }}
                        >
                          <div>
                            <strong style={{ color: "#d8e0dd" }}>Locked At:</strong>{" "}
                            {formatUtcDateTime(item.lockedAt)}
                          </div>
                          <div>
                            <strong style={{ color: "#d8e0dd" }}>Items:</strong> {item.itemCount}
                          </div>
                          <div>
                            <strong style={{ color: "#d8e0dd" }}>Legal State:</strong> Permanently
                            sealed
                          </div>
                        </div>

                        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                          <Link href={`/evidence/${item.id}`}>
                            <Button
                              variant="secondary"
                              className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                              style={primaryButtonStyle}
                            >
                              Open Record
                            </Button>
                          </Link>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Card>
          </div>
        </section>
      </div>
    </div>
  );
}