"use client";

import { useEffect, useState } from "react";
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
        setInsights(data.data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to load insights";
        setError(message);
        addToast(message, "error");
      } finally {
        setLoading(false);
      }
    };

    if (user) {
      fetchInsights();
    }
  }, [user, addToast]);

  if (loading) {
    return (
      <div className="section app-section">
        <div className="app-hero app-hero-full">
          <div className="container">
            <h1 className="hero-title pricing-hero-title" style={{ margin: 0 }}>
              AI Insights
            </h1>
            <p className="page-subtitle pricing-subtitle" style={{ marginTop: 6 }}>
              Loading AI-powered analytics and evidence trends...
            </p>
          </div>
        </div>

        <div className="app-body app-body-full">
          <div className="container" style={{ display: "grid", gap: 16 }}>
            <Skeleton width="100%" height="200px" />
            <Skeleton width="100%" height="200px" />
            <Skeleton width="100%" height="200px" />
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
            <h1 className="hero-title pricing-hero-title" style={{ margin: 0 }}>
              AI Insights
            </h1>
            <p className="page-subtitle pricing-subtitle" style={{ marginTop: 6 }}>
              Insights could not be loaded.
            </p>
          </div>
        </div>

        <div className="app-body app-body-full">
          <div className="container">
            <EmptyState
              title="Error Loading Insights"
              subtitle={error}
              action={() => window.location.reload()}
            />
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
            <h1 className="hero-title pricing-hero-title" style={{ margin: 0 }}>
              AI Insights
            </h1>
            <p className="page-subtitle pricing-subtitle" style={{ marginTop: 6 }}>
              Start analyzing evidence to unlock insights.
            </p>
          </div>
        </div>

        <div className="app-body app-body-full">
          <div className="container">
            <EmptyState
              title="No Insights Yet"
              subtitle="Start analyzing your evidence to see insights and AI-powered analytics."
              action={() => (
                <Link href="/dashboard">
                  <Button>Go to Dashboard</Button>
                </Link>
              )}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="section app-section">
      <div className="app-hero app-hero-full">
        <div className="container">
          <h1 className="hero-title pricing-hero-title" style={{ margin: 0 }}>
            AI Insights
          </h1>
          <p className="page-subtitle pricing-subtitle" style={{ marginTop: 6 }}>
            Analytics and insights powered by AI analysis.
          </p>
        </div>
      </div>

      <div className="app-body app-body-full">
        <div className="container" style={{ display: "grid", gap: 16 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 16,
            }}
          >
            <Card className="app-card">
              <div style={{ fontSize: 13, color: "rgba(219,235,248,0.64)" }}>Analyzed Evidence</div>
              <div style={{ fontSize: 34, fontWeight: 800, marginTop: 8, color: "#bfe8df" }}>
                {insights.total_analyzed}
              </div>
              <div style={{ fontSize: 12, color: "rgba(219,235,248,0.56)", marginTop: 8 }}>
                {insights.total_evidence > 0
                  ? ((insights.total_analyzed / insights.total_evidence) * 100).toFixed(0)
                  : 0}
                % of total
              </div>
            </Card>

            <Card className="app-card">
              <div style={{ fontSize: 13, color: "rgba(219,235,248,0.64)" }}>Total Evidence</div>
              <div style={{ fontSize: 34, fontWeight: 800, marginTop: 8, color: "rgba(246,252,255,0.96)" }}>
                {insights.total_evidence}
              </div>
              <div style={{ fontSize: 12, color: "rgba(219,235,248,0.56)", marginTop: 8 }}>
                Items stored
              </div>
            </Card>

            <Card className="app-card">
              <div style={{ fontSize: 13, color: "rgba(219,235,248,0.64)" }}>API Calls</div>
              <div style={{ fontSize: 34, fontWeight: 800, marginTop: 8, color: "#bfe8df" }}>
                {insights.api_usage.total_calls}
              </div>
              <div style={{ fontSize: 12, color: "rgba(219,235,248,0.56)", marginTop: 8 }}>
                Total analyses
              </div>
            </Card>

            <Card className="app-card">
              <div style={{ fontSize: 13, color: "rgba(219,235,248,0.64)" }}>AI Cost</div>
              <div style={{ fontSize: 34, fontWeight: 800, marginTop: 8, color: "#e6c9ae" }}>
                ${insights.api_usage.total_cost_usd}
              </div>
              <div style={{ fontSize: 12, color: "rgba(219,235,248,0.56)", marginTop: 8 }}>
                Avg: ${insights.api_usage.average_cost_per_call}/call
              </div>
            </Card>
          </div>

          {Object.keys(insights.classification_distribution).length > 0 && (
            <Card className="app-card">
              <div className="app-card-title">Classification Distribution</div>
              <div style={{ display: "grid", gap: 14 }}>
                {Object.entries(insights.classification_distribution)
                  .sort(([, a], [, b]) => b - a)
                  .map(([category, count]) => (
                    <div key={category}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                        <div style={{ fontSize: 13, color: "rgba(246,252,255,0.92)" }}>{category}</div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "rgba(219,235,248,0.72)" }}>{count}</div>
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
                            width: `${(count / insights.total_analyzed) * 100}%`,
                            height: "100%",
                            background: "linear-gradient(90deg,#2f686d,#78bfc1)",
                            borderRadius: 999,
                          }}
                        />
                      </div>
                    </div>
                  ))}
              </div>
            </Card>
          )}

          {Object.keys(insights.moderation_distribution).length > 0 && (
            <Card className="app-card">
              <div className="app-card-title">Content Safety Distribution</div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                  gap: 14,
                }}
              >
                {Object.entries(insights.moderation_distribution)
                  .sort(([, a], [, b]) => b - a)
                  .map(([risk, count]) => {
                    const color =
                      risk === "safe"
                        ? "#86efac"
                        : risk === "low_risk"
                          ? "#fde68a"
                          : risk === "medium_risk"
                            ? "#fdba74"
                            : "#fca5a5";

                    return (
                      <div
                        key={risk}
                        style={{
                          borderRadius: 16,
                          border: "1px solid rgba(255,255,255,0.08)",
                          background: "rgba(255,255,255,0.04)",
                          padding: 16,
                          textAlign: "center",
                        }}
                      >
                        <div style={{ fontSize: 30, fontWeight: 800, color }}>{count}</div>
                        <div style={{ fontSize: 13, color: "rgba(219,235,248,0.68)", marginTop: 6 }}>
                          {risk.replace(/_/g, " ")}
                        </div>
                      </div>
                    );
                  })}
              </div>
            </Card>
          )}

          {insights.top_tags.length > 0 && (
            <Card className="app-card">
              <div className="app-card-title">Top Tags</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
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
            </Card>
          )}

          {insights.recent_analyses.length > 0 && (
            <Card className="app-card">
              <div className="app-card-title">Recent Analyses</div>
              <div style={{ display: "grid", gap: 10 }}>
                {insights.recent_analyses.map((analysis) => (
                  <div
                    key={analysis.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 16,
                      padding: 14,
                      borderRadius: 14,
                      background: "rgba(255,255,255,0.04)",
                      border: "1px solid rgba(255,255,255,0.06)",
                      flexWrap: "wrap",
                    }}
                  >
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: "rgba(246,252,255,0.96)" }}>
                        {analysis.classification}
                      </div>
                      <div style={{ fontSize: 12, color: "rgba(219,235,248,0.56)", marginTop: 4 }}>
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
                              ? "rgba(34,197,94,0.14)"
                              : analysis.riskLevel === "low_risk"
                                ? "rgba(245,158,11,0.14)"
                                : "rgba(239,68,68,0.14)",
                          color:
                            analysis.riskLevel === "safe"
                              ? "#86efac"
                              : analysis.riskLevel === "low_risk"
                                ? "#fde68a"
                                : "#fca5a5",
                          border: "1px solid rgba(255,255,255,0.08)",
                        }}
                      >
                        {analysis.riskLevel.replace(/_/g, " ")}
                      </span>

                      <Link href={`/dashboard/evidence/${analysis.evidenceId}`}>
                        <Button className="navy-btn">View</Button>
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}