"use client";

import { useEffect, useState } from "react";
import { useAuth } from "../../../providers";
import { apiFetch } from "../../../../lib/api";
import { Skeleton, Card } from "../../../../components/ui";

interface Quotas {
  analyses: { limit: number; used: number; remaining: number; resetDate: string };
  batchJobs: { limit: number; used: number; remaining: number };
  apiKeys: { limit: number; used: number; remaining: number };
  teamMembers: { limit: number; used: number; remaining: number };
}

interface UsageStats {
  dailyAnalyses: { today: number; thisWeek: number; thisMonth: number };
  costBreakdown: { totalCost: number; thisMonth: number; averagePerAnalysis: number };
  topEvidenceTypes: Record<string, number>;
  activeApiKeys: number;
  activeBatches: number;
}

export default function QuotasPage() {
  const { user } = useAuth();
  const [quotas, setQuotas] = useState<Quotas | null>(null);
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, [user]);

  const loadData = async () => {
    try {
      const [quotasData, statsData] = await Promise.all([
        apiFetch("/v1/quotas"),
        apiFetch("/v1/usage-stats"),
      ]);
      setQuotas(quotasData.data);
      setStats(statsData.data);
    } catch (err) {
      console.error("Failed to load quota data", err);
    } finally {
      setLoading(false);
    }
  };

  const getUsagePercent = (used: number, limit: number) => {
    return Math.round((used / limit) * 100);
  };

  const QuotaBar = ({
    label,
    used,
    limit,
  }: {
    label: string;
    used: number;
    limit: number;
  }) => {
    const percent = getUsagePercent(used, limit);
    const barColor =
      percent >= 90
        ? "linear-gradient(90deg,#b91c1c,#ef4444)"
        : percent >= 70
          ? "linear-gradient(90deg,#b45309,#f59e0b)"
          : "linear-gradient(90deg,#2f686d,#78bfc1)";

    return (
      <div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            marginBottom: 8,
            fontSize: 13,
          }}
        >
          <span style={{ color: "rgba(246,252,255,0.92)", fontWeight: 600 }}>{label}</span>
          <span style={{ color: "rgba(219,235,248,0.72)" }}>
            {used} / {limit}
          </span>
        </div>

        <div
          style={{
            width: "100%",
            height: 9,
            borderRadius: 999,
            background: "rgba(255,255,255,0.08)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${percent}%`,
              borderRadius: 999,
              background: barColor,
              transition: "width 220ms ease",
            }}
          />
        </div>

        <div style={{ marginTop: 6, fontSize: 12, color: "rgba(219,235,248,0.62)" }}>
          {percent}% used
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="section app-section">
        <div className="app-hero app-hero-full">
          <div className="container">
            <h1 className="hero-title pricing-hero-title" style={{ margin: 0 }}>
              Usage & Quotas
            </h1>
            <p className="page-subtitle pricing-subtitle" style={{ marginTop: 6 }}>
              Loading usage and quota data...
            </p>
          </div>
        </div>

        <div className="app-body app-body-full">
          <div className="container" style={{ display: "grid", gap: 16 }}>
            <Skeleton width="100%" height="300px" />
            <Skeleton width="100%" height="300px" />
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
            Usage & Quotas
          </h1>
          <p className="page-subtitle pricing-subtitle" style={{ marginTop: 6 }}>
            Monitor your API usage, batch activity, and quota limits.
          </p>
        </div>
      </div>

      <div className="app-body app-body-full">
        <div className="container" style={{ display: "grid", gap: 16 }}>
          {stats && (
            <div className="grid-2">
              <Card className="app-card">
                <div className="app-card-title">Daily Usage</div>
                <div style={{ display: "grid", gap: 16 }}>
                  <div>
                    <div style={{ fontSize: 12, color: "rgba(219,235,248,0.64)" }}>Today</div>
                    <div style={{ fontSize: 34, fontWeight: 800, color: "#bfe8df", marginTop: 4 }}>
                      {stats.dailyAnalyses.today}
                    </div>
                  </div>

                  <div>
                    <div style={{ fontSize: 12, color: "rgba(219,235,248,0.64)" }}>This Week</div>
                    <div style={{ fontSize: 30, fontWeight: 800, color: "rgba(246,252,255,0.96)", marginTop: 4 }}>
                      {stats.dailyAnalyses.thisWeek}
                    </div>
                  </div>

                  <div>
                    <div style={{ fontSize: 12, color: "rgba(219,235,248,0.64)" }}>This Month</div>
                    <div style={{ fontSize: 30, fontWeight: 800, color: "#e6c9ae", marginTop: 4 }}>
                      {stats.dailyAnalyses.thisMonth}
                    </div>
                  </div>
                </div>
              </Card>

              <Card className="app-card">
                <div className="app-card-title">Cost</div>
                <div style={{ display: "grid", gap: 16 }}>
                  <div>
                    <div style={{ fontSize: 12, color: "rgba(219,235,248,0.64)" }}>Total Cost</div>
                    <div style={{ fontSize: 34, fontWeight: 800, color: "#bfe8df", marginTop: 4 }}>
                      ${stats.costBreakdown.totalCost.toFixed(2)}
                    </div>
                  </div>

                  <div>
                    <div style={{ fontSize: 12, color: "rgba(219,235,248,0.64)" }}>This Month</div>
                    <div style={{ fontSize: 28, fontWeight: 800, color: "rgba(246,252,255,0.96)", marginTop: 4 }}>
                      ${stats.costBreakdown.thisMonth.toFixed(2)}
                    </div>
                  </div>

                  <div>
                    <div style={{ fontSize: 12, color: "rgba(219,235,248,0.64)" }}>Avg per Analysis</div>
                    <div style={{ fontSize: 28, fontWeight: 800, color: "#e6c9ae", marginTop: 4 }}>
                      ${stats.costBreakdown.averagePerAnalysis.toFixed(4)}
                    </div>
                  </div>
                </div>
              </Card>
            </div>
          )}

          {quotas && (
            <Card className="app-card">
              <div className="app-card-title">Current Quotas</div>
              <div style={{ display: "grid", gap: 22 }}>
                <QuotaBar
                  label="Analysis API Calls"
                  used={quotas.analyses.used}
                  limit={quotas.analyses.limit}
                />
                <QuotaBar
                  label="Batch Jobs"
                  used={quotas.batchJobs.used}
                  limit={quotas.batchJobs.limit}
                />
                <QuotaBar
                  label="API Keys"
                  used={quotas.apiKeys.used}
                  limit={quotas.apiKeys.limit}
                />
                <QuotaBar
                  label="Team Members"
                  used={quotas.teamMembers.used}
                  limit={quotas.teamMembers.limit}
                />

                <div
                  style={{
                    paddingTop: 16,
                    borderTop: "1px solid rgba(255,255,255,0.08)",
                    fontSize: 13,
                    color: "rgba(219,235,248,0.72)",
                  }}
                >
                  Quotas reset on{" "}
                  <strong style={{ color: "rgba(246,252,255,0.96)" }}>
                    {new Date(quotas.analyses.resetDate).toLocaleDateString()}
                  </strong>
                </div>
              </div>
            </Card>
          )}

          {stats && (
            <Card className="app-card">
              <div className="app-card-title">Evidence Types Analyzed</div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                  gap: 14,
                }}
              >
                {Object.entries(stats.topEvidenceTypes).map(([type, count]) => (
                  <div
                    key={type}
                    style={{
                      borderRadius: 16,
                      border: "1px solid rgba(255,255,255,0.08)",
                      background: "rgba(255,255,255,0.04)",
                      padding: 16,
                      textAlign: "center",
                    }}
                  >
                    <div style={{ fontSize: 30, fontWeight: 800, color: "#bfe8df" }}>{count}</div>
                    <div style={{ fontSize: 13, color: "rgba(219,235,248,0.68)", marginTop: 6 }}>
                      {type}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {stats && (
            <Card
              className="app-card"
              style={{
                border: "1px solid rgba(158,216,207,0.16)",
                background:
                  "linear-gradient(135deg, rgba(158,216,207,0.10), rgba(214,184,157,0.08))",
              }}
            >
              <div className="app-card-title">Active Services</div>
              <div className="grid-2">
                <div>
                  <div style={{ fontSize: 32, fontWeight: 800, color: "rgba(246,252,255,0.96)" }}>
                    {stats.activeApiKeys}
                  </div>
                  <div style={{ fontSize: 13, color: "rgba(219,235,248,0.68)" }}>Active API Keys</div>
                </div>
                <div>
                  <div style={{ fontSize: 32, fontWeight: 800, color: "rgba(246,252,255,0.96)" }}>
                    {stats.activeBatches}
                  </div>
                  <div style={{ fontSize: 13, color: "rgba(219,235,248,0.68)" }}>Active Batch Jobs</div>
                </div>
              </div>
            </Card>
          )}

          <Card
            className="app-card"
            style={{
              border: "1px solid rgba(214,184,157,0.16)",
              background:
                "linear-gradient(135deg, rgba(214,184,157,0.10), rgba(255,255,255,0.03))",
            }}
          >
            <div className="app-card-title">Pricing</div>
            <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 10, color: "rgba(219,235,248,0.78)" }}>
              <li>Each AI analysis: $0.10</li>
              <li>Monthly quota: 10,000 analyses per month</li>
              <li>Batch processing: Included in standard quota</li>
              <li>API keys: Unlimited</li>
              <li>Team members: Up to 10 per account</li>
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}