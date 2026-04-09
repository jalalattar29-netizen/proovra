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
    <div className="page landing-page">
      <div className="relative overflow-hidden">
        <div className="absolute inset-0">
          <img
            src="/images/site-velvet-bg.webp.png"
            alt=""
            className="h-full w-full object-cover object-center"
          />
        </div>

        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,18,22,0.84)_0%,rgba(8,18,22,0.76)_34%,rgba(8,18,22,0.68)_62%,rgba(8,18,22,0.74)_100%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_16%_16%,rgba(158,216,207,0.09),transparent_24%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_82%_24%,rgba(214,184,157,0.06),transparent_18%)]" />
        <div className="absolute inset-0 opacity-[0.04] [background:repeating-linear-gradient(0deg,rgba(255,255,255,0.026)_0px,rgba(255,255,255,0.026)_1px,transparent_1px,transparent_4px)]" />

        <div className="relative z-10">
          <section className="mx-auto max-w-7xl px-6 pb-10 pt-10 md:px-8 md:pb-12 md:pt-14">
            <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
              <div className="max-w-[760px]">
                <div className="inline-flex rounded-full border border-white/10 bg-white/[0.055] px-4 py-2 text-[0.74rem] font-medium uppercase tracking-[0.2em] text-[#dce3e0] shadow-[0_10px_24px_rgba(0,0,0,0.10)] backdrop-blur-md">
                  Deleted Evidence
                </div>

                <h1 className="mt-5 max-w-[720px] text-[1.62rem] font-medium leading-[1.01] tracking-[-0.04em] text-[#edf1ef] md:text-[2.18rem] lg:text-[2.7rem]">
                  Recover evidence inside the{" "}
                  <span className="text-[#bfe8df]">trash window</span>.
                </h1>

                <p className="mt-5 max-w-[700px] text-[0.94rem] font-normal leading-[1.78] tracking-[-0.006em] text-[#c7cfcc] md:text-[0.98rem]">
                  Review deleted records, inspect their{" "}
                  <span className="text-[#e7ece9]">scheduled removal date</span>, and restore them
                  before the <span className="text-[#d6b89d]">90-day recovery period</span> ends.
                </p>

                <div className="mt-6 flex flex-wrap gap-2.5">
                  <div className="rounded-full border border-white/10 bg-white/[0.055] px-3.5 py-2 text-[0.78rem] font-normal text-[#d7dfdb] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                    <span className="mr-2 text-[#9dd2ca]">✓</span>
                    Secure trash visibility
                  </div>

                  <div className="rounded-full border border-white/10 bg-white/[0.055] px-3.5 py-2 text-[0.78rem] font-normal text-[#d7dfdb] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                    <span className="mr-2 text-[#9dd2ca]">✓</span>
                    Recovery before permanent removal
                  </div>

                  <div className="rounded-full border border-[rgba(214,184,157,0.24)] bg-[linear-gradient(180deg,rgba(183,157,132,0.08)_0%,rgba(255,255,255,0.03)_100%)] px-3.5 py-2 text-[0.78rem] font-normal text-[#e1d4c7] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                    <span className="mr-2 text-[#d6b89d]">✓</span>
                    Permanent deletion tracking
                  </div>
                </div>
              </div>

              <div className="flex shrink-0">
                <Link href="/evidence">
                  <Button className="rounded-[16px] border border-[rgba(158,216,207,0.22)] bg-[linear-gradient(180deg,rgba(191,232,223,0.20)_0%,rgba(255,255,255,0.08)_100%)] px-6 py-3 text-[0.95rem] font-medium text-[#e8f1ef] shadow-[0_12px_26px_rgba(0,0,0,0.12)] backdrop-blur-md transition-all duration-200 hover:-translate-y-[1px] hover:border-[rgba(158,216,207,0.30)] hover:bg-[linear-gradient(180deg,rgba(191,232,223,0.26)_0%,rgba(255,255,255,0.10)_100%)]">
                    Open Evidence
                  </Button>
                </Link>
              </div>
            </div>
          </section>

          <section className="relative px-6 pb-14 md:px-8 md:pb-16">
            <div className="mx-auto max-w-7xl">
              <Card
                className="relative overflow-hidden rounded-[28px] border bg-transparent p-0 shadow-none"
                style={{
                  border: "1px solid rgba(158,216,207,0.16)",
                  boxShadow:
                    "0 18px 34px rgba(0, 0, 0, 0.10), inset 0 1px 0 rgba(255,255,255,0.06)",
                }}
              >
                <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(3,18,44,0.88)_0%,rgba(2,16,40,0.90)_100%)]" />
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_0%,rgba(158,216,207,0.06),transparent_28%)]" />
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_84%_16%,rgba(214,184,157,0.05),transparent_22%)]" />

                <div className="relative z-10 p-5 md:p-6">
                  <div
                    className="mb-5 text-[1rem] font-semibold tracking-[-0.02em]"
                    style={{ color: "rgba(246,252,255,0.96)" }}
                  >
                    Deleted Records
                  </div>

                  <div
                    style={{
                      marginBottom: 16,
                      padding: 14,
                      borderRadius: 18,
                      border: "1px solid rgba(248, 113, 113, 0.16)",
                      background:
                        "linear-gradient(135deg, rgba(127,29,29,0.18), rgba(214,184,157,0.10))",
                      color: "#fecaca",
                      fontSize: 14,
                      lineHeight: 1.65,
                    }}
                  >
                    Items shown here are in secure trash. They remain recoverable until their
                    scheduled permanent deletion date.
                  </div>

                  {loading ? (
                    <div style={{ display: "grid", gap: 12 }}>
                      <div className="rounded-[22px] border border-white/5 bg-white/[0.02] p-4">
                        <Skeleton width="100%" height="72px" />
                      </div>
                      <div className="rounded-[22px] border border-white/5 bg-white/[0.02] p-4">
                        <Skeleton width="100%" height="72px" />
                      </div>
                      <div className="rounded-[22px] border border-white/5 bg-white/[0.02] p-4">
                        <Skeleton width="100%" height="72px" />
                      </div>
                    </div>
                  ) : error ? (
                    <div className="rounded-[20px] border border-[rgba(255,120,120,0.16)] bg-[rgba(120,20,20,0.12)] px-4 py-3 text-[0.92rem] text-[#ffd7d7]">
                      {error}
                    </div>
                  ) : items.length === 0 ? (
                    <div className="rounded-[24px] border border-white/5 bg-white/[0.02] p-4">
                      <EmptyState
                        title="No deleted evidence"
                        subtitle="Your secure trash is currently empty."
                        action={() => (
                          <Link href="/evidence">
                            <Button className="rounded-[14px] border border-[rgba(158,216,207,0.22)] bg-[linear-gradient(180deg,rgba(191,232,223,0.20)_0%,rgba(255,255,255,0.08)_100%)] px-5 py-3 text-[0.92rem] font-medium text-[#e8f1ef]">
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
                          className="rounded-[22px] border border-white/5 bg-[linear-gradient(180deg,rgba(255,255,255,0.022)_0%,rgba(255,255,255,0.012)_100%)] p-5 transition-all duration-200 hover:border-[rgba(158,216,207,0.12)] hover:bg-[linear-gradient(180deg,rgba(255,255,255,0.035)_0%,rgba(255,255,255,0.018)_100%)]"
                          style={{
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
                              <strong style={{ color: "#f3f7f5" }}>Deleted At:</strong>{" "}
                              {formatUtcDateTime(item.deletedAt)}
                            </div>
                            <div>
                              <strong style={{ color: "#f3f7f5" }}>Permanent Deletion Date:</strong>{" "}
                              {formatUtcDateTime(item.deleteScheduledForUtc)}
                            </div>
                            <div>
                              <strong style={{ color: "#f3f7f5" }}>Items:</strong> {item.itemCount}
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
                              <Button
                                variant="secondary"
                                className="rounded-[16px] border border-[rgba(158,216,207,0.16)] bg-[linear-gradient(180deg,rgba(255,255,255,0.045)_0%,rgba(255,255,255,0.02)_100%)] px-5 py-3 text-[0.92rem] font-medium text-[#edf2f1] shadow-none transition-all duration-200 hover:-translate-y-[1px] hover:border-[rgba(158,216,207,0.26)] hover:bg-[linear-gradient(180deg,rgba(191,232,223,0.12)_0%,rgba(255,255,255,0.03)_100%)]"
                              >
                                Open Record
                              </Button>
                            </Link>

                            <Button
                              onClick={() => handleRestore(item.id)}
                              disabled={actionBusyId === item.id}
                              className="rounded-[16px] border border-[rgba(158,216,207,0.22)] bg-[linear-gradient(180deg,rgba(191,232,223,0.20)_0%,rgba(255,255,255,0.08)_100%)] px-5 py-3 text-[0.92rem] font-medium text-[#e8f1ef] shadow-[0_10px_22px_rgba(0,0,0,0.10)] backdrop-blur-md transition-all duration-200 hover:-translate-y-[1px] hover:border-[rgba(158,216,207,0.30)] hover:bg-[linear-gradient(180deg,rgba(191,232,223,0.26)_0%,rgba(255,255,255,0.10)_100%)] disabled:cursor-not-allowed disabled:opacity-70"
                            >
                              {actionBusyId === item.id ? "Restoring..." : "Restore from Trash"}
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
    </div>
  );
}