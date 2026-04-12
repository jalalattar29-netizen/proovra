"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Card,
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

type ArchiveEvidenceResponse = {
  items?: ArchiveEvidenceItem[];
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
    let cancelled = false;

    setLoading(true);
    setError(null);

    apiFetch("/v1/evidence?scope=archived")
      .then((data: ArchiveEvidenceResponse) => {
        if (cancelled) return;
        setItems(Array.isArray(data?.items) ? data.items : []);
      })
      .catch((err: unknown) => {
        if (cancelled) return;

        const errorMessage =
          err instanceof Error ? err.message : "Failed to load archived evidence";

        setError(errorMessage);
        setItems([]);
        captureException(err, { feature: "archive_page_list" });
        addToast(errorMessage, "error");
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [addToast]);

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

  const rowCardStyle = useMemo(
    () =>
      ({
        border: "1px solid rgba(79,112,107,0.18)",
        backgroundImage:
          "linear-gradient(180deg, rgba(8,20,24,0.82) 0%, rgba(7,18,22,0.90) 100%), url('/images/site-velvet-bg.webp.png')",
        backgroundSize: "cover",
        backgroundPosition: "center",
        borderRadius: 24,
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.04), 0 14px 28px rgba(0,0,0,0.10)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
      }) as const,
    []
  );

  const archivedBadgeStyle = useMemo(
    () =>
      ({
        color: "#8a6e57",
        background:
          "linear-gradient(180deg, rgba(255,255,255,0.96) 0%, rgba(247,244,240,0.92) 100%)",
        border: "1px solid rgba(183,157,132,0.18)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.78), 0 6px 14px rgba(92,69,50,0.05)",
      }) as const,
    []
  );

  return (
    <div className="section app-section archive-page-shell">
      <style jsx global>{`
        .archive-page-shell .archive-row-link {
          display: block;
          text-decoration: none;
        }

        .archive-page-shell .archive-row-surface {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 14px;
          flex-wrap: wrap;
          padding: 14px;
        }

        .archive-page-shell .archive-row-left {
          display: flex;
          align-items: center;
          gap: 12px;
          min-width: 0;
          flex: 1 1 auto;
        }

        .archive-page-shell .archive-row-copy {
          min-width: 0;
          flex: 1 1 auto;
        }

        .archive-page-shell .archive-row-title {
          color: #eef3f1;
          font-size: 18px;
          font-weight: 700;
          letter-spacing: -0.02em;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .archive-page-shell .archive-row-subtitle {
          margin-top: 4px;
          color: rgba(194,204,201,0.72);
          font-size: 13px;
          line-height: 1.6;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .archive-page-shell .archive-row-right {
          display: flex;
          align-items: center;
          gap: 10px;
          flex-shrink: 0;
        }

        @media (max-width: 760px) {
          .archive-page-shell .archive-row-surface {
            align-items: flex-start;
            padding: 14px;
          }

          .archive-page-shell .archive-row-left {
            width: 100%;
            align-items: flex-start;
          }

          .archive-page-shell .archive-row-right {
            width: 100%;
            justify-content: flex-start;
          }
        }
      `}</style>

      <div className="app-hero app-hero-full">
        <div className="container">
          <div className="page-title app-page-title" style={{ marginBottom: 0 }}>
            <div style={{ maxWidth: 780 }}>
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
                Archived Evidence
              </div>

              <h1
                className="mt-5 max-w-[760px] text-[1.72rem] font-medium leading-[1.02] tracking-[-0.045em] text-[#d9e2df] md:text-[2.22rem] lg:text-[2.72rem]"
                style={{ margin: "20px 0 0" }}
              >
                Previously archived{" "}
                <span style={{ color: "#c3ebe2" }}>evidence records</span>.
              </h1>

              <p
                style={{
                  marginTop: 20,
                  maxWidth: 720,
                  fontSize: "0.95rem",
                  lineHeight: 1.8,
                  letterSpacing: "-0.006em",
                  color: "#aab5b2",
                }}
              >
                Review evidence moved out of the active workspace while keeping its{" "}
                <span style={{ color: "#cfd8d5" }}>history</span>,{" "}
                <span style={{ color: "#bbc7c3" }}>metadata</span>, and archived
                state <span style={{ color: "#d9ccbf" }}>easy to inspect</span>.
              </p>
            </div>

            <div className="flex shrink-0">
              <Link href="/evidence" style={{ textDecoration: "none" }}>
                <Button
                  className="app-responsive-btn rounded-[999px] border px-6 py-3 text-[0.95rem] font-semibold"
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

        <div
          className="container relative z-10"
          style={{ display: "grid", gap: 16, paddingBottom: 72 }}
        >
          {loading ? (
            <div style={{ display: "grid", gap: 12 }}>
              <div style={{ ...rowCardStyle, padding: 18 }}>
                <Skeleton width="100%" height="40px" />
              </div>
              <div style={{ ...rowCardStyle, padding: 18 }}>
                <Skeleton width="100%" height="40px" />
              </div>
              <div style={{ ...rowCardStyle, padding: 18 }}>
                <Skeleton width="100%" height="40px" />
              </div>
            </div>
          ) : error ? (
            <Card
              className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
              style={{ ...outerCardStyle, border: "1px solid rgba(220,120,120,0.22)" }}
            >
              <div className="absolute inset-0">
                <img
                  src="/images/panel-silver.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center"
                />
              </div>
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,245,245,0.84)_0%,rgba(248,232,232,0.92)_100%)]" />
              <div className="relative z-10 p-6 text-[#b42318]">{error}</div>
            </Card>
          ) : items.length === 0 ? (
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

              <div className="relative z-10 p-6 md:p-7">
                <EmptyState
                  title="No archived evidence"
                  subtitle="When you archive evidence, it will appear here."
                  action={() => (
                    <Link href="/home" style={{ textDecoration: "none" }}>
                      <Button
                        className="app-responsive-btn rounded-[999px] border px-6 py-3 text-[0.92rem] font-semibold"
                        style={heroButtonStyle}
                      >
                        {t("home")}
                      </Button>
                    </Link>
                  )}
                />
              </div>
            </Card>
          ) : (
            items.map((item) => (
              <Card
                key={item.id}
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

                <div className="relative z-10 p-2">
                  {isUuid(item.id) ? (
                    <Link href={`/evidence/${item.id}`} className="archive-row-link">
                      <div className="archive-row-surface" style={rowCardStyle}>
                        <div className="archive-row-left">
                          <div
                            style={{
                              width: 42,
                              height: 42,
                              borderRadius: 14,
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              background:
                                "linear-gradient(180deg, rgba(18,45,48,0.96) 0%, rgba(10,28,31,0.98) 100%)",
                              border: "1px solid rgba(79,112,107,0.18)",
                              color: "#e6f1ee",
                              fontSize: 13,
                              fontWeight: 800,
                              letterSpacing: "0.08em",
                              boxShadow:
                                "inset 0 1px 0 rgba(255,255,255,0.05), 0 10px 20px rgba(0,0,0,0.12)",
                              flexShrink: 0,
                            }}
                          >
                            EV
                          </div>

                          <div className="archive-row-copy">
                            <div className="archive-row-title">
                              {item.title || "Digital Evidence Record"}
                            </div>

                            <div className="archive-row-subtitle">
                              {item.archivedAt
                                ? `${item.displaySubtitle} • Archived ${new Date(
                                    item.archivedAt
                                  ).toLocaleString()}`
                                : item.displaySubtitle}
                            </div>
                          </div>
                        </div>

                        <div className="archive-row-right">
                          <span
                            className="inline-flex min-h-[28px] items-center justify-center rounded-full px-3 py-[5px] text-[10.5px] font-semibold uppercase tracking-[0.12em]"
                            style={archivedBadgeStyle}
                          >
                            Archived
                          </span>
                        </div>
                      </div>
                    </Link>
                  ) : (
                    <div className="archive-row-surface" style={rowCardStyle}>
                      <div className="archive-row-left">
                        <div
                          style={{
                            width: 42,
                            height: 42,
                            borderRadius: 14,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            background:
                              "linear-gradient(180deg, rgba(18,45,48,0.96) 0%, rgba(10,28,31,0.98) 100%)",
                            border: "1px solid rgba(79,112,107,0.18)",
                            color: "#e6f1ee",
                            fontSize: 13,
                            fontWeight: 800,
                            letterSpacing: "0.08em",
                            boxShadow:
                              "inset 0 1px 0 rgba(255,255,255,0.05), 0 10px 20px rgba(0,0,0,0.12)",
                            flexShrink: 0,
                          }}
                        >
                          EV
                        </div>

                        <div className="archive-row-copy">
                          <div className="archive-row-title">
                            {item.title || "Digital Evidence Record"}
                          </div>

                          <div className="archive-row-subtitle">{item.displaySubtitle}</div>
                        </div>
                      </div>

                      <div className="archive-row-right">
                        <span
                          className="inline-flex min-h-[28px] items-center justify-center rounded-full px-3 py-[5px] text-[10.5px] font-semibold uppercase tracking-[0.12em]"
                          style={archivedBadgeStyle}
                        >
                          Archived
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              </Card>
            ))
          )}
        </div>
      </div>
    </div>
  );
}