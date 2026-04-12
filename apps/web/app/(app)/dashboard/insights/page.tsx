"use client";

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../../providers";
import { apiFetch } from "../../../../lib/api";
import {
  useToast,
  Skeleton,
  EmptyState,
  Card,
  Button,
} from "../../../../components/ui";
import Link from "next/link";
import DashboardShell from "../../../../components/dashboard/DashboardShell";
import {
  dashboardStyles,
  getStatusPillStyle,
} from "../../../../components/dashboard/styles";

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
        const message =
          err instanceof Error ? err.message : "Failed to load insights";
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
            ? `${(
                (insights.total_analyzed / insights.total_evidence) *
                100
              ).toFixed(0)}% of total`
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
        <Card
          className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
          style={dashboardStyles.outerCard}
        >
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
          style={{
            ...dashboardStyles.outerCard,
            border: "1px solid rgba(220,120,120,0.22)",
          }}
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
          Review analysis coverage, safety patterns, dominant classifications,
          top tags, and recent AI activity across your evidence.
        </>
      }
    >
      <style jsx global>{`
        .dashboard-insights-page {
          display: grid;
          gap: 16px;
        }

        .dashboard-insights-page .dashboard-insights-metrics-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
          gap: 16px;
        }

        .dashboard-insights-page .dashboard-insights-safety-grid,
        .dashboard-insights-page .dashboard-insights-recent-grid {
          display: grid;
          gap: 10px;
        }

        .dashboard-insights-page .dashboard-insights-card-title {
          font-size: 1.08rem;
          font-weight: 600;
          letter-spacing: -0.02em;
          color: #d8e0dd;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .dashboard-insights-page .dashboard-insights-metric-label {
          font-size: 13px;
          color: rgba(194, 204, 201, 0.64);
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .dashboard-insights-page .dashboard-insights-metric-value {
          font-size: 34px;
          font-weight: 800;
          margin-top: 8px;
          line-height: 1;
          letter-spacing: -0.04em;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .dashboard-insights-page .dashboard-insights-metric-sub {
          font-size: 12px;
          color: rgba(194, 204, 201, 0.56);
          margin-top: 8px;
          line-height: 1.5;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .dashboard-insights-page .dashboard-insights-bar-row {
          display: grid;
          gap: 6px;
          min-width: 0;
        }

        .dashboard-insights-page .dashboard-insights-bar-top {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          align-items: center;
          flex-wrap: wrap;
        }

        .dashboard-insights-page .dashboard-insights-bar-label,
        .dashboard-insights-page .dashboard-insights-bar-count {
          font-size: 13px;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .dashboard-insights-page .dashboard-insights-bar-label {
          color: #d8e0dd;
        }

        .dashboard-insights-page .dashboard-insights-bar-count {
          font-weight: 700;
          color: rgba(194, 204, 201, 0.72);
        }

        .dashboard-insights-page .dashboard-insights-tags {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
          margin-top: 18px;
        }

        .dashboard-insights-page .dashboard-insights-tag {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 9px 12px;
          border-radius: 999px;
          background: rgba(158, 216, 207, 0.1);
          border: 1px solid rgba(158, 216, 207, 0.16);
          color: #dff4ef;
          font-size: 13px;
          font-weight: 600;
          line-height: 1.35;
          max-width: 100%;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .dashboard-insights-page .dashboard-insights-tag-count {
          min-width: 22px;
          height: 22px;
          border-radius: 999px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          background: rgba(214, 184, 157, 0.18);
          color: #e6c9ae;
          font-size: 11px;
          font-weight: 800;
          flex-shrink: 0;
        }

        .dashboard-insights-page .dashboard-insights-recent-item {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          padding: 14px;
          border-radius: 16px;
          flex-wrap: wrap;
        }

        .dashboard-insights-page .dashboard-insights-recent-main {
          min-width: 0;
          flex: 1 1 280px;
        }

        .dashboard-insights-page .dashboard-insights-recent-title {
          font-size: 14px;
          font-weight: 700;
          color: #d8e0dd;
          overflow-wrap: anywhere;
          word-break: break-word;
          line-height: 1.4;
        }

        .dashboard-insights-page .dashboard-insights-recent-date {
          font-size: 12px;
          color: rgba(194, 204, 201, 0.56);
          margin-top: 4px;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .dashboard-insights-page .dashboard-insights-recent-actions {
          display: flex;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
        }

        .dashboard-insights-page .dashboard-insights-pill {
          max-width: 100%;
          white-space: normal;
          text-align: center;
          line-height: 1.35;
        }

        @media (max-width: 760px) {
          .dashboard-insights-page .dashboard-insights-recent-item {
            flex-direction: column;
            align-items: stretch;
          }

          .dashboard-insights-page .dashboard-insights-recent-actions {
            width: 100%;
            flex-direction: column;
            align-items: stretch;
          }

          .dashboard-insights-page .dashboard-insights-recent-actions > * {
            width: 100%;
          }
        }
      `}</style>

      <div className="dashboard-insights-page">
        <div className="dashboard-insights-metrics-grid">
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
                <div className="dashboard-insights-metric-label">{item.label}</div>
                <div
                  className="dashboard-insights-metric-value"
                  style={{ color: item.color }}
                >
                  {item.value}
                </div>
                <div className="dashboard-insights-metric-sub">{item.sub}</div>
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
              <div className="dashboard-insights-card-title">
                Classification Distribution
              </div>

              <div style={{ display: "grid", gap: 14, marginTop: 18 }}>
                {Object.entries(insights.classification_distribution)
                  .sort(([, a], [, b]) => b - a)
                  .map(([category, count]) => (
                    <div key={category} className="dashboard-insights-bar-row">
                      <div className="dashboard-insights-bar-top">
                        <div className="dashboard-insights-bar-label">
                          {category}
                        </div>
                        <div className="dashboard-insights-bar-count">{count}</div>
                      </div>

                      <div
                        style={{
                          width: "100%",
                          height: 8,
                          background: "rgba(255,255,255,0.08)",
                          borderRadius: 999,
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            width: `${
                              insights.total_analyzed > 0
                                ? (count / insights.total_analyzed) * 100
                                : 0
                            }%`,
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
              <div className="dashboard-insights-card-title">
                Content Safety Distribution
              </div>

              <div
                className="dashboard-insights-safety-grid"
                style={{
                  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
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
                      <div
                        style={{
                          fontSize: 30,
                          fontWeight: 800,
                          color: getStatusPillStyle(risk).color as string,
                          overflowWrap: "anywhere",
                          wordBreak: "break-word",
                        }}
                      >
                        {count}
                      </div>
                      <div
                        style={{
                          fontSize: 13,
                          color: "rgba(194,204,201,0.68)",
                          marginTop: 6,
                          overflowWrap: "anywhere",
                          wordBreak: "break-word",
                        }}
                      >
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
              <div className="dashboard-insights-card-title">Top Tags</div>

              <div className="dashboard-insights-tags">
                {insights.top_tags.map(({ tag, count }) => (
                  <div key={tag} className="dashboard-insights-tag">
                    <span>{tag}</span>
                    <span className="dashboard-insights-tag-count">{count}</span>
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
              <div className="dashboard-insights-card-title">Recent Analyses</div>

              <div
                className="dashboard-insights-recent-grid"
                style={{ marginTop: 18 }}
              >
                {insights.recent_analyses.map((analysis) => (
                  <div
                    key={analysis.id}
                    className="dashboard-insights-recent-item"
                    style={dashboardStyles.softCard}
                  >
                    <div className="dashboard-insights-recent-main">
                      <div className="dashboard-insights-recent-title">
                        {analysis.classification}
                      </div>
                      <div className="dashboard-insights-recent-date">
                        {new Date(analysis.createdAt).toLocaleDateString()}
                      </div>
                    </div>

                    <div className="dashboard-insights-recent-actions">
                      <span
                        className="dashboard-insights-pill"
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
      </div>
    </DashboardShell>
  );
}