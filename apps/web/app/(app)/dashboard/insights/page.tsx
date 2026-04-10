"use client";

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../../providers";
import { apiFetch } from "../../../../lib/api";
import { useToast, Skeleton, EmptyState, Card, Button } from "../../../../components/ui";
import Link from "next/link";

interface Insights {
  total_analyzed: number;
  total_evidence: number;
  classification_distribution: Record<string, number>;
  moderation_distribution: Record<string, number>;
  top_tags: Array<{ tag: string; count: number }>;
  api_usage: {
    total_calls: number;
    total_cost_usd: string;
    average_cost_per_call: string;
  };
  recent_analyses: Array<{
    id: string;
    evidenceId: string;
    classification: string;
    riskLevel: string;
    createdAt: string;
  }>;
}

export default function InsightsPage() {
  const { user } = useAuth();
  const { addToast } = useToast();

  const [insights, setInsights] = useState<Insights | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchInsights = async () => {
      try {
        setLoading(true);
        setError(null);
        const data = await apiFetch("/v1/insights");
        setInsights(data?.data ?? null);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to load insights";
        setError(message);
        addToast(message, "error");
      } finally {
        setLoading(false);
      }
    };

    if (user) {
      void fetchInsights();
    }
  }, [user, addToast]);

  const outerCardStyle = useMemo(
    () =>
      ({
        border: "1px solid rgba(183,157,132,0.18)",
        boxShadow:
          "0 22px 42px rgba(0,0,0,0.16), inset 0 1px 0 rgba(255,255,255,0.03)",
      }) as const,
    []
  );

  const softCardStyle = useMemo(
    () =>
      ({
        border: "1px solid rgba(158,216,207,0.14)",
        background:
          "linear-gradient(180deg, rgba(62,98,96,0.22) 0%, rgba(14,30,34,0.34) 100%)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.04), 0 14px 28px rgba(0,0,0,0.08)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
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
      }) as const,
    []
  );

  if (loading) {
    return (
      <div className="section app-section">
        <div className="app-hero app-hero-full">
          <div className="container">
            <div style={{ maxWidth: 780 }}>
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
                AI Insights
              </div>

              <h1 className="mt-5 max-w-[760px] text-[1.72rem] font-medium leading-[1.02] tracking-[-0.045em] text-[#d9e2df] md:text-[2.22rem] lg:text-[2.72rem]">
                AI analytics and <span className="text-[#c3ebe2]">evidence trends</span>.
              </h1>

              <p className="mt-5 max-w-[720px] text-[0.95rem] leading-[1.8] tracking-[-0.006em] text-[#aab5b2]">
                Loading AI-powered analytics and evidence trends...
              </p>
            </div>
          </div>
        </div>

        <div className="app-body app-body-full">
          <div className="container" style={{ display: "grid", gap: 16, paddingBottom: 72 }}>
            <div style={{ ...softCardStyle, padding: 22 }}>
              <Skeleton width="100%" height="200px" />
            </div>
            <div style={{ ...softCardStyle, padding: 22 }}>
              <Skeleton width="100%" height="200px" />
            </div>
            <div style={{ ...softCardStyle, padding: 22 }}>
              <Skeleton width="100%" height="200px" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="section app-section">
        <div className="app-hero app-hero-full">
          <div className="container">
            <div style={{ maxWidth: 760 }}>
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
                AI Insights
              </div>

              <h1 className="mt-5 max-w-[760px] text-[1.72rem] font-medium leading-[1.02] tracking-[-0.045em] text-[#d9e2df] md:text-[2.22rem] lg:text-[2.72rem]">
                Insights <span className="text-[#c3ebe2]">could not load</span>.
              </h1>
            </div>
          </div>
        </div>

        <div className="app-body app-body-full">
          <div className="container" style={{ paddingBottom: 72 }}>
            <Card
              className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
              style={{ ...outerCardStyle, border: "1px solid rgba(220,120,120,0.22)" }}
            >
              <div className="absolute inset-0">
                <img
                  src="/images/site-velvet-bg.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center scale-[1.12]"
                />
              </div>
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(70,20,20,0.24)_0%,rgba(20,10,10,0.58)_100%)]" />
              <div className="relative z-10 p-6">
                <EmptyState title="Error Loading Insights" subtitle={error} action={() => window.location.reload()} />
              </div>
            </Card>
          </div>
        </div>
      </div>
    );
  }

  if (!insights) {
    return (
      <div className="section app-section">
        <div className="app-hero app-hero-full">
          <div className="container">
            <div style={{ maxWidth: 760 }}>
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
                AI Insights
              </div>

              <h1 className="mt-5 max-w-[760px] text-[1.72rem] font-medium leading-[1.02] tracking-[-0.045em] text-[#d9e2df] md:text-[2.22rem] lg:text-[2.72rem]">
                Start analyzing evidence to <span className="text-[#c3ebe2]">unlock insights</span>.
              </h1>
            </div>
          </div>
        </div>

        <div className="app-body app-body-full">
          <div className="container" style={{ paddingBottom: 72 }}>
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
              <div className="relative z-10 p-6">
                <EmptyState
                  title="No Insights Yet"
                  subtitle="Start analyzing your evidence to see insights and AI-powered analytics."
                  action={() => (
                    <Link href="/dashboard">
                      <Button
                        className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                        style={primaryButtonStyle}
                      >
                        Go to Dashboard
                      </Button>
                    </Link>
                  )}
                />
              </div>
            </Card>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="section app-section">
      <div className="app-hero app-hero-full">
        <div className="container">
          <div style={{ maxWidth: 820 }}>
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
              AI Insights
            </div>

            <h1 className="mt-5 max-w-[760px] text-[1.72rem] font-medium leading-[1.02] tracking-[-0.045em] text-[#d9e2df] md:text-[2.22rem] lg:text-[2.72rem]">
              Analytics and insights <span className="text-[#c3ebe2]">powered by AI</span>.
            </h1>

            <p className="mt-5 max-w-[720px] text-[0.95rem] leading-[1.8] tracking-[-0.006em] text-[#aab5b2]">
              Review analysis coverage, safety patterns, dominant classifications, top tags, and
              recent AI activity across your evidence.
            </p>
          </div>
        </div>
      </div>

      <div className="app-body app-body-full">
        <div className="container" style={{ display: "grid", gap: 16, paddingBottom: 72 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 16,
            }}
          >
            {[
              {
                label: "Analyzed Evidence",
                value: insights.total_analyzed,
                sub:
                  insights.total_evidence > 0
                    ? `${((insights.total_analyzed / insights.total_evidence) * 100).toFixed(0)}% of total`
                    : "0% of total",
                color: "#bfe8df",
              },
              {
                label: "Total Evidence",
                value: insights.total_evidence,
                sub: "Items stored",
                color: "#d8e0dd",
              },
              {
                label: "API Calls",
                value: insights.api_usage.total_calls,
                sub: "Total analyses",
                color: "#bfe8df",
              },
              {
                label: "AI Cost",
                value: `$${insights.api_usage.total_cost_usd}`,
                sub: `Avg: $${insights.api_usage.average_cost_per_call}/call`,
                color: "#dcc0a5",
              },
            ].map((item) => (
              <Card
                key={item.label}
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

                <div className="relative z-10 p-6">
                  <div style={{ fontSize: 13, color: "rgba(194,204,201,0.64)" }}>{item.label}</div>
                  <div style={{ fontSize: 34, fontWeight: 800, marginTop: 8, color: item.color }}>
                    {item.value}
                  </div>
                  <div style={{ fontSize: 12, color: "rgba(194,204,201,0.56)", marginTop: 8 }}>
                    {item.sub}
                  </div>
                </div>
              </Card>
            ))}
          </div>

          {Object.keys(insights.classification_distribution).length > 0 && (
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

              <div className="relative z-10 p-6 md:p-7">
                <div className="text-[1.08rem] font-semibold tracking-[-0.02em] text-[#d8e0dd]">
                  Classification Distribution
                </div>

                <div style={{ display: "grid", gap: 14, marginTop: 18 }}>
                  {Object.entries(insights.classification_distribution)
                    .sort(([, a], [, b]) => b - a)
                    .map(([category, count]) => (
                      <div key={category}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                          <div style={{ fontSize: 13, color: "#d8e0dd" }}>{category}</div>
                          <div style={{ fontSize: 13, fontWeight: 700, color: "rgba(194,204,201,0.72)" }}>
                            {count}
                          </div>
                        </div>
                        <div
                          style={{
                            width: "100%",
                            height: 8,
                            background: "rgba(255,255,255,0.08)",
                            borderRadius: 999,
                            marginTop: 6,
                            overflow: "hidden",
                          }}
                        >
                          <div
                            style={{
                              width: `${insights.total_analyzed > 0 ? (count / insights.total_analyzed) * 100 : 0}%`,
                              height: "100%",
                              background: "linear-gradient(90deg,#3f6664,#8dc7bc)",
                              borderRadius: 999,
                            }}
                          />
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            </Card>
          )}

          {Object.keys(insights.moderation_distribution).length > 0 && (
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

              <div className="relative z-10 p-6 md:p-7">
                <div className="text-[1.08rem] font-semibold tracking-[-0.02em] text-[#d8e0dd]">
                  Content Safety Distribution
                </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                    gap: 14,
                    marginTop: 18,
                  }}
                >
                  {Object.entries(insights.moderation_distribution)
                    .sort(([, a], [, b]) => b - a)
                    .map(([risk, count]) => {
                      const color =
                        risk === "safe"
                          ? "#9fdfb2"
                          : risk === "low_risk"
                            ? "#e8d18f"
                            : risk === "medium_risk"
                              ? "#e7b58a"
                              : "#e4a3a3";

                      return (
                        <div
                          key={risk}
                          style={{
                            ...softCardStyle,
                            borderRadius: 18,
                            padding: 16,
                            textAlign: "center",
                          }}
                        >
                          <div style={{ fontSize: 30, fontWeight: 800, color }}>{count}</div>
                          <div style={{ fontSize: 13, color: "rgba(194,204,201,0.68)", marginTop: 6 }}>
                            {risk.replace(/_/g, " ")}
                          </div>
                        </div>
                      );
                    })}
                </div>
              </div>
            </Card>
          )}

          {insights.top_tags.length > 0 && (
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

              <div className="relative z-10 p-6 md:p-7">
                <div className="text-[1.08rem] font-semibold tracking-[-0.02em] text-[#d8e0dd]">
                  Top Tags
                </div>

                <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 18 }}>
                  {insights.top_tags.map(({ tag, count }) => (
                    <div
                      key={tag}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "9px 12px",
                        borderRadius: 999,
                        background: "rgba(158,216,207,0.10)",
                        border: "1px solid rgba(158,216,207,0.16)",
                        color: "#dff4ef",
                        fontSize: 13,
                        fontWeight: 600,
                      }}
                    >
                      <span>{tag}</span>
                      <span
                        style={{
                          minWidth: 22,
                          height: 22,
                          borderRadius: 999,
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          background: "rgba(214,184,157,0.18)",
                          color: "#e6c9ae",
                          fontSize: 11,
                          fontWeight: 800,
                        }}
                      >
                        {count}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </Card>
          )}

          {insights.recent_analyses.length > 0 && (
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

              <div className="relative z-10 p-6 md:p-7">
                <div className="text-[1.08rem] font-semibold tracking-[-0.02em] text-[#d8e0dd]">
                  Recent Analyses
                </div>

                <div style={{ display: "grid", gap: 10, marginTop: 18 }}>
                  {insights.recent_analyses.map((analysis) => (
                    <div
                      key={analysis.id}
                      style={{
                        ...softCardStyle,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 16,
                        padding: 14,
                        borderRadius: 16,
                        flexWrap: "wrap",
                      }}
                    >
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: "#d8e0dd" }}>
                          {analysis.classification}
                        </div>
                        <div style={{ fontSize: 12, color: "rgba(194,204,201,0.56)", marginTop: 4 }}>
                          {new Date(analysis.createdAt).toLocaleDateString()}
                        </div>
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                        <span
                          style={{
                            padding: "7px 10px",
                            borderRadius: 999,
                            fontSize: 12,
                            fontWeight: 700,
                            background:
                              analysis.riskLevel === "safe"
                                ? "rgba(95,170,110,0.14)"
                                : analysis.riskLevel === "low_risk"
                                  ? "rgba(184,146,73,0.14)"
                                  : "rgba(157,80,80,0.14)",
                            color:
                              analysis.riskLevel === "safe"
                                ? "#9fdfb2"
                                : analysis.riskLevel === "low_risk"
                                  ? "#e8d18f"
                                  : "#e4a3a3",
                            border: "1px solid rgba(255,255,255,0.08)",
                            textTransform: "capitalize",
                          }}
                        >
                          {analysis.riskLevel.replace(/_/g, " ")}
                        </span>

                        <Link href={`/dashboard/evidence/${analysis.evidenceId}`}>
                          <Button
                            className="rounded-[999px] border px-4 py-2.5 text-[0.88rem] font-semibold"
                            style={primaryButtonStyle}
                          >
                            View
                          </Button>
                        </Link>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}