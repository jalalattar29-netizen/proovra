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

  const outerCardStyle = useMemo(
    () =>
      ({
        border: "1px solid rgba(79,112,107,0.16)",
        boxShadow:
          "0 18px 38px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.48)",
      }) as const,
    []
  );

  const heroButtonStyle = useMemo(
    () =>
      ({
        borderColor: "rgba(79,112,107,0.22)",
        color: "#eef3f1",
        background:
          "linear-gradient(180deg, rgba(58,92,95,0.96) 0%, rgba(20,38,42,0.98) 100%)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 34px rgba(18,40,44,0.22)",
        textShadow: "0 1px 0 rgba(0,0,0,0.22)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
      }) as const,
    []
  );

  const restoreButtonStyle = useMemo(
    () =>
      ({
        borderColor: "rgba(183,157,132,0.18)",
        color: "#fff7f1",
        background:
          "linear-gradient(180deg, rgba(142,102,72,0.95) 0%, rgba(102,68,45,0.98) 100%)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.06), 0 14px 28px rgba(90,58,36,0.14)",
        textShadow: "0 1px 0 rgba(0,0,0,0.22)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
      }) as const,
    []
  );

  const rowActionButtonStyle = useMemo(
    () =>
      ({
        borderColor: "rgba(79,112,107,0.22)",
        color: "#eef3f1",
        background:
          "linear-gradient(180deg, rgba(58,92,95,0.96) 0%, rgba(20,38,42,0.98) 100%)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 34px rgba(18,40,44,0.16)",
        textShadow: "0 1px 0 rgba(0,0,0,0.20)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
      }) as const,
    []
  );

  const rowCardStyle = useMemo(
    () =>
      ({
        border: "1px solid rgba(79,112,107,0.10)",
        backgroundImage:
          "linear-gradient(180deg, rgba(255,255,255,0.64) 0%, rgba(243,245,242,0.92) 100%), url('/images/panel-silver.webp.png')",
        backgroundSize: "cover",
        backgroundPosition: "center",
        borderRadius: 24,
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.44), 0 12px 26px rgba(0,0,0,0.05)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
      }) as const,
    []
  );

  const trashPillStyle = useMemo(
    () =>
      ({
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: 34,
        padding: "8px 14px",
        borderRadius: 999,
        fontSize: 11.5,
        fontWeight: 800,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        border: "1px solid rgba(194,78,78,0.14)",
        background:
          "linear-gradient(180deg, rgba(255,242,242,0.94) 0%, rgba(248,231,231,0.92) 100%)",
        color: "#b54a4a",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.62), 0 6px 14px rgba(160,90,90,0.05)",
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
                  gap: "0.72rem",
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
                    width: 6,
                    height: 6,
                    borderRadius: 999,
                    background: "#b79d84",
                    opacity: 0.95,
                    display: "inline-block",
                    flexShrink: 0,
                  }}
                />
                Deleted Evidence
              </div>

              <h1 className="mt-5 max-w-[720px] text-[1.72rem] font-medium leading-[1.02] tracking-[-0.045em] text-[#d9e2df] md:text-[2.22rem] lg:text-[2.72rem]">
                Recover evidence inside the{" "}
                <span className="text-[#c3ebe2]">trash window</span>.
              </h1>

              <p className="mt-5 max-w-[700px] text-[0.95rem] font-normal leading-[1.8] tracking-[-0.006em] text-[#aab5b2] md:text-[0.99rem]">
                Review deleted records, inspect their{" "}
                <span className="text-[#cfd8d5]">scheduled removal date</span>, and
                restore them before the{" "}
                <span className="text-[#d9ccbf]">90-day recovery period</span> ends.
              </p>

              <div className="mt-6 flex flex-wrap gap-2.5">
                <div className="rounded-full border border-white/10 bg-white/[0.055] px-3.5 py-2 text-[0.78rem] font-normal text-[#c7d1ce] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                  <span className="mr-2 text-[#91aca5]">✓</span>
                  Secure trash visibility
                </div>

                <div className="rounded-full border border-white/10 bg-white/[0.055] px-3.5 py-2 text-[0.78rem] font-normal text-[#c7d1ce] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                  <span className="mr-2 text-[#91aca5]">✓</span>
                  Recovery before permanent removal
                </div>

                <div className="rounded-full border border-[rgba(214,184,157,0.18)] bg-[linear-gradient(180deg,rgba(183,157,132,0.07)_0%,rgba(255,255,255,0.028)_100%)] px-3.5 py-2 text-[0.78rem] font-normal text-[#d9ccbf] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                  <span className="mr-2 text-[#c2a07f]">✓</span>
                  Permanent deletion tracking
                </div>
              </div>
            </div>

            <div className="flex shrink-0">
              <Link href="/evidence">
                <Button
                  className="rounded-[999px] border px-6 py-3 text-[0.95rem] font-semibold"
                  style={heroButtonStyle}
                >
                  Open Evidence
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </div>

      <div
        className="app-body app-body-full pt-8 md:pt-10"
        style={{
          position: "relative",
          overflow: "hidden",
          background:
            "linear-gradient(180deg, rgba(239,241,238,0.96) 0%, rgba(234,237,234,0.98) 100%)",
        }}
      >
        <div className="pointer-events-none absolute inset-0 z-0" aria-hidden="true">
          <img
            src="/images/landing-network-bg.png"
            alt=""
            className="absolute inset-0 h-full w-full object-cover object-top opacity-[0.12] saturate-[0.55] brightness-[1.02] contrast-[0.94]"
          />
          <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.08)_0%,rgba(255,255,255,0.03)_22%,rgba(255,255,255,0.03)_78%,rgba(255,255,255,0.08)_100%)]" />
          <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(255,255,255,0.10)_0%,rgba(255,255,255,0.03)_12%,rgba(255,255,255,0.00)_24%,rgba(255,255,255,0.00)_76%,rgba(255,255,255,0.03)_88%,rgba(255,255,255,0.10)_100%)]" />
        </div>

        <section className="relative z-10 px-6 pb-14 md:px-8 md:pb-16">
          <div className="mx-auto max-w-7xl">
            <Card
              className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
              style={outerCardStyle}
            >
              <div className="absolute inset-0">
                <img
                  src="/images/panel-silver.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center"
                />
              </div>
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.24)_0%,rgba(248,249,246,0.34)_42%,rgba(239,241,238,0.42)_100%)]" />
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_16%_12%,rgba(255,255,255,0.34),transparent_28%)] opacity-90" />

              <div className="relative z-10 p-5 md:p-6">
                <div className="mb-5 text-[1.08rem] font-semibold tracking-[-0.02em] text-[#21353a]">
                  Deleted Records
                </div>

                <div
                  style={{
                    marginBottom: 16,
                    padding: 14,
                    borderRadius: 18,
                    border: "1px solid rgba(194,78,78,0.12)",
                    background:
                      "linear-gradient(135deg, rgba(255,246,246,0.92), rgba(248,239,235,0.86))",
                    color: "#9f4d4d",
                    fontSize: 14,
                    lineHeight: 1.65,
                  }}
                >
                  Items shown here are in secure trash. They remain recoverable
                  until their scheduled permanent deletion date.
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
                  <div className="rounded-[20px] border border-[rgba(255,120,120,0.16)] bg-[rgba(120,20,20,0.12)] px-4 py-3 text-[0.92rem] text-[#b42318]">
                    {error}
                  </div>
                ) : items.length === 0 ? (
                  <div className="rounded-[24px] p-4" style={rowCardStyle}>
                    <EmptyState
                      title="No deleted evidence"
                      subtitle="Your secure trash is currently empty."
                      action={() => {}}
                      actionLabel=""
                    />
                    <div className="mt-4">
                      <Link href="/evidence">
                        <Button
                          className="rounded-[999px] border px-6 py-3 text-[0.92rem] font-semibold"
                          style={heroButtonStyle}
                        >
                          Open Evidence
                        </Button>
                      </Link>
                    </div>
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
                                fontWeight: 800,
                                color: "#23373b",
                                wordBreak: "break-word",
                              }}
                            >
                              {item.title || "Digital Evidence Record"}
                            </div>

                            <div
                              style={{
                                marginTop: 6,
                                fontSize: 13,
                                color: "#6d7a7d",
                                lineHeight: 1.6,
                              }}
                            >
                              {item.displaySubtitle}
                            </div>
                          </div>

                          <div style={trashPillStyle}>In Trash</div>
                        </div>

                        <div
                          style={{
                            display: "grid",
                            gap: 6,
                            fontSize: 13,
                            color: "#5f6f73",
                            lineHeight: 1.6,
                          }}
                        >
                          <div>
                            <strong style={{ color: "#24373b" }}>Deleted At:</strong>{" "}
                            {formatUtcDateTime(item.deletedAt)}
                          </div>
                          <div>
                            <strong style={{ color: "#24373b" }}>
                              Permanent Deletion Date:
                            </strong>{" "}
                            {formatUtcDateTime(item.deleteScheduledForUtc)}
                          </div>
                          <div>
                            <strong style={{ color: "#24373b" }}>Items:</strong>{" "}
                            {item.itemCount}
                          </div>
                        </div>

                        <div
                          style={{
                            display: "flex",
                            gap: 12,
                            flexWrap: "wrap",
                            alignItems: "center",
                          }}
                        >
                          <Link href={`/evidence/${item.id}`}>
                            <Button
                              className="rounded-[999px] border px-6 py-3 text-[0.92rem] font-semibold min-w-[190px] justify-center"
                              style={rowActionButtonStyle}
                            >
                              Open Record
                            </Button>
                          </Link>

                          <Button
                            onClick={() => handleRestore(item.id)}
                            disabled={actionBusyId === item.id}
                            className="rounded-[999px] border px-6 py-3 text-[0.92rem] font-semibold min-w-[190px] justify-center"
                            style={restoreButtonStyle}
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
              </div>
            </Card>
          </div>
        </section>
      </div>
    </div>
  );
}