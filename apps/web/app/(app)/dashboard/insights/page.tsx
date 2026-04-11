"use client";

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../../providers";
import { apiFetch } from "../../../../lib/api";
import { useToast, Skeleton, EmptyState, Card, Button } from "../../../../components/ui";
import Link from "next/link";
import DashboardShell from "../../../../components/dashboard/DashboardShell";
import { dashboardStyles, getStatusPillStyle } from "../../../../components/dashboard/styles";

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

  const overviewCards = useMemo(() => {
    if (!insights) return [];

    return [
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
    ];
  }, [insights]);

  if (loading) {
    return (
      <DashboardShell
        eyebrow="AI Insights"
        title="AI analytics and"
        highlight="evidence trends."
        description={<>Loading AI-powered analytics and evidence trends...</>}
      >
        <Card className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none" style={dashboardStyles.outerCard}>
          <div className="relative z-10 p-6">
            <Skeleton width="100%" height="220px" />
          </div>
        </Card>
      </DashboardShell>
    );
  }

  if (error) {
    return (
      <DashboardShell
        eyebrow="AI Insights"
        title="Insights"
        highlight="could not load."
        description={<>We couldn’t load AI analytics right now.</>}
      >
        <Card
          className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
          style={{ ...dashboardStyles.outerCard, border: "1px solid rgba(220,120,120,0.22)" }}
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
            <EmptyState
              title="Error Loading Insights"
              subtitle={error}
              action={() => window.location.reload()}
              actionLabel="Retry"
            />
          </div>
        </Card>
      </DashboardShell>
    );
  }

  if (!insights) {
    return (
      <DashboardShell
        eyebrow="AI Insights"
        title="Start analyzing evidence to"
        highlight="unlock insights."
        description={<>No AI insight data is available yet.</>}
      >
        <Card
          className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
          style={dashboardStyles.outerCard}
        >
          <div className="absolute inset-0">
            <img
              src="/images/site-velvet-bg.webp.png"
              alt=""
              className="h-full w-full object-cover object-center scale-[1.12]"
            />
          </div>
          <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,20,24,0.82)_0%,rgba(7,18,22,0.88)_100%)]" />
          <div className="relative z-10 p-6">
            <EmptyState
              title="No Insights Yet"
              subtitle="Start analyzing your evidence to see AI-powered analytics."
              action={() => {
                window.location.assign("/dashboard");
              }}
              actionLabel="Go to Dashboard"
            />
          </div>
        </Card>
      </DashboardShell>
    );
  }

  return (
    <DashboardShell
      eyebrow="AI Insights"
      title="Analytics and insights"
      highlight="powered by AI."
      description={
        <>
          Review analysis coverage, safety patterns, dominant classifications, top tags,
          and recent AI activity across your evidence.
        </>
      }
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 16,
        }}
      >
        {overviewCards.map((item) => (
          <Card
            key={item.label}
            className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
            style={dashboardStyles.outerCard}
          >
            <div className="absolute inset-0">
              <img
                src="/images/site-velvet-bg.webp.png"
                alt=""
                className="h-full w-full object-cover object-center scale-[1.12]"
              />
            </div>
            <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,20,24,0.82)_0%,rgba(7,18,22,0.88)_100%)]" />
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
          style={dashboardStyles.outerCard}
        >
          <div className="absolute inset-0">
            <img
              src="/images/site-velvet-bg.webp.png"
              alt=""
              className="h-full w-full object-cover object-center scale-[1.12]"
            />
          </div>
          <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,20,24,0.82)_0%,rgba(7,18,22,0.88)_100%)]" />

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
          style={dashboardStyles.outerCard}
        >
          <div className="absolute inset-0">
            <img
              src="/images/site-velvet-bg.webp.png"
              alt=""
              className="h-full w-full object-cover object-center scale-[1.12]"
            />
          </div>
          <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,20,24,0.82)_0%,rgba(7,18,22,0.88)_100%)]" />

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
                .map(([risk, count]) => (
                  <div
                    key={risk}
                    style={{
                      ...dashboardStyles.softCard,
                      borderRadius: 18,
                      padding: 16,
                      textAlign: "center",
                    }}
                  >
                    <div style={{ fontSize: 30, fontWeight: 800, color: getStatusPillStyle(risk).color as string }}>
                      {count}
                    </div>
                    <div style={{ fontSize: 13, color: "rgba(194,204,201,0.68)", marginTop: 6 }}>
                      {risk.replace(/_/g, " ")}
                    </div>
                  </div>
                ))}
            </div>
          </div>
        </Card>
      )}

      {insights.top_tags.length > 0 && (
        <Card
          className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
          style={dashboardStyles.outerCard}
        >
          <div className="absolute inset-0">
            <img
              src="/images/site-velvet-bg.webp.png"
              alt=""
              className="h-full w-full object-cover object-center scale-[1.12]"
            />
          </div>
          <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,20,24,0.82)_0%,rgba(7,18,22,0.88)_100%)]" />

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
          style={dashboardStyles.outerCard}
        >
          <div className="absolute inset-0">
            <img
              src="/images/site-velvet-bg.webp.png"
              alt=""
              className="h-full w-full object-cover object-center scale-[1.12]"
            />
          </div>
          <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,20,24,0.82)_0%,rgba(7,18,22,0.88)_100%)]" />

          <div className="relative z-10 p-6 md:p-7">
            <div className="text-[1.08rem] font-semibold tracking-[-0.02em] text-[#d8e0dd]">
              Recent Analyses
            </div>

            <div style={{ display: "grid", gap: 10, marginTop: 18 }}>
              {insights.recent_analyses.map((analysis) => (
                <div
                  key={analysis.id}
                  style={{
                    ...dashboardStyles.softCard,
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
                        ...getStatusPillStyle(analysis.riskLevel),
                        padding: "7px 10px",
                        borderRadius: 999,
                        fontSize: 12,
                        fontWeight: 700,
                        textTransform: "capitalize",
                      }}
                    >
                      {analysis.riskLevel.replace(/_/g, " ")}
                    </span>

                    <Link href={`/evidence/${analysis.evidenceId}`}>
                      <Button
                        className="rounded-[999px] border px-4 py-2.5 text-[0.88rem] font-semibold"
                        style={dashboardStyles.primaryButton}
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
    </DashboardShell>
  );
}