"use client";

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../../providers";
import { apiFetch } from "../../../../lib/api";
import { useToast, Skeleton, Card } from "../../../../components/ui";
import DashboardShell from "../../../../components/dashboard/DashboardShell";
import { dashboardStyles } from "../../../../components/dashboard/styles";

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

function safePercent(used: number, limit: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
}

export default function QuotasPage() {
  const { user } = useAuth();
  const { addToast } = useToast();

  const [quotas, setQuotas] = useState<Quotas | null>(null);
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void loadData();
  }, [user]);

  const loadData = async () => {
    try {
      setLoading(true);

      const [quotasData, statsData] = await Promise.all([
        apiFetch("/v1/quotas"),
        apiFetch("/v1/usage-stats"),
      ]);

      setQuotas(quotasData?.data ?? null);
      setStats(statsData?.data ?? null);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load usage and quota data";
      addToast(message, "error");
      setQuotas(null);
      setStats(null);
    } finally {
      setLoading(false);
    }
  };

  const quotaCards = useMemo(() => {
    if (!quotas) return [];

    return [
      { label: "Analysis Calls", value: `${quotas.analyses.used} / ${quotas.analyses.limit}`, sub: `${quotas.analyses.remaining} remaining`, color: "#bfe8df" },
      { label: "Batch Jobs", value: `${quotas.batchJobs.used} / ${quotas.batchJobs.limit}`, sub: `${quotas.batchJobs.remaining} remaining`, color: "#d8e0dd" },
      { label: "API Keys", value: `${quotas.apiKeys.used} / ${quotas.apiKeys.limit}`, sub: `${quotas.apiKeys.remaining} remaining`, color: "#dcc0a5" },
      { label: "Team Members", value: `${quotas.teamMembers.used} / ${quotas.teamMembers.limit}`, sub: `${quotas.teamMembers.remaining} remaining`, color: "#c3ebe2" },
    ];
  }, [quotas]);

  const usageCards = useMemo(() => {
    if (!stats) return [];

    return [
      { label: "Today", value: stats.dailyAnalyses.today, sub: "Analyses processed today", color: "#bfe8df" },
      { label: "This Week", value: stats.dailyAnalyses.thisWeek, sub: "Analyses processed this week", color: "#d8e0dd" },
      { label: "This Month", value: stats.dailyAnalyses.thisMonth, sub: "Analyses processed this month", color: "#dcc0a5" },
      { label: "Average Per Analysis", value: `$${stats.costBreakdown.averagePerAnalysis.toFixed(4)}`, sub: "Average AI analysis cost", color: "#c3ebe2" },
    ];
  }, [stats]);

  const renderQuotaBar = (
    label: string,
    used: number,
    limit: number,
    remaining: number
  ) => {
    const percent = safePercent(used, limit);

    const gradient =
      percent >= 90
        ? "linear-gradient(90deg, #8f2b2b 0%, #d46b6b 100%)"
        : percent >= 70
          ? "linear-gradient(90deg, #8a6b2f 0%, #d5b06f 100%)"
          : "linear-gradient(90deg, #3f6664 0%, #8dc7bc 100%)";

    return (
      <div style={{ display: "grid", gap: 8 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <span style={{ color: "#d8e0dd", fontWeight: 700, fontSize: 13 }}>{label}</span>
          <span style={{ color: "rgba(194,204,201,0.72)", fontSize: 12 }}>
            {used} / {limit} used · {remaining} remaining
          </span>
        </div>

        <div
          style={{
            width: "100%",
            height: 10,
            borderRadius: 999,
            background: "rgba(255,255,255,0.08)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${percent}%`,
              height: "100%",
              background: gradient,
              borderRadius: 999,
              transition: "width 220ms ease",
            }}
          />
        </div>

        <div style={{ color: "rgba(194,204,201,0.56)", fontSize: 12 }}>{percent}% used</div>
      </div>
    );
  };

  return (
    <DashboardShell
      eyebrow="Usage & Quotas"
      title="Monitor platform usage and"
      highlight="current limits."
      description={
        <>
          Review analysis activity, cost metrics, quota consumption, and active
          service usage from one dashboard.
        </>
      }
    >
      {loading ? (
        <Card
          className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
          style={dashboardStyles.outerCard}
        >
          <div className="relative z-10 p-6">
            <Skeleton width="100%" height="280px" />
          </div>
        </Card>
      ) : (
        <>
          {usageCards.length > 0 && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                gap: 16,
              }}
            >
              {usageCards.map((item) => (
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
          )}

          {quotaCards.length > 0 && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                gap: 16,
              }}
            >
              {quotaCards.map((item) => (
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
                    <div style={{ fontSize: 28, fontWeight: 800, marginTop: 8, color: item.color }}>
                      {item.value}
                    </div>
                    <div style={{ fontSize: 12, color: "rgba(194,204,201,0.56)", marginTop: 8 }}>
                      {item.sub}
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}

          {quotas && (
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
                  Current Quotas
                </div>

                <div style={{ display: "grid", gap: 22, marginTop: 18 }}>
                  {renderQuotaBar(
                    "Analysis API Calls",
                    quotas.analyses.used,
                    quotas.analyses.limit,
                    quotas.analyses.remaining
                  )}

                  {renderQuotaBar(
                    "Batch Jobs",
                    quotas.batchJobs.used,
                    quotas.batchJobs.limit,
                    quotas.batchJobs.remaining
                  )}

                  {renderQuotaBar(
                    "API Keys",
                    quotas.apiKeys.used,
                    quotas.apiKeys.limit,
                    quotas.apiKeys.remaining
                  )}

                  {renderQuotaBar(
                    "Team Members",
                    quotas.teamMembers.used,
                    quotas.teamMembers.limit,
                    quotas.teamMembers.remaining
                  )}

                  <div
                    style={{
                      paddingTop: 16,
                      borderTop: "1px solid rgba(255,255,255,0.08)",
                      fontSize: 13,
                      color: "rgba(194,204,201,0.72)",
                    }}
                  >
                    Quotas reset on{" "}
                    <strong style={{ color: "#d8e0dd" }}>
                      {new Date(quotas.analyses.resetDate).toLocaleDateString()}
                    </strong>
                  </div>
                </div>
              </div>
            </Card>
          )}

          {stats && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
                gap: 16,
              }}
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

                <div className="relative z-10 p-6 md:p-7">
                  <div className="text-[1.08rem] font-semibold tracking-[-0.02em] text-[#d8e0dd]">
                    Cost Overview
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gap: 14,
                      gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                      marginTop: 18,
                    }}
                  >
                    <div style={{ ...dashboardStyles.softCard, padding: 16, borderRadius: 18 }}>
                      <div style={{ fontSize: 12, color: "rgba(194,204,201,0.56)" }}>Total Cost</div>
                      <div style={{ fontSize: 30, fontWeight: 800, color: "#bfe8df", marginTop: 6 }}>
                        ${stats.costBreakdown.totalCost.toFixed(2)}
                      </div>
                    </div>

                    <div style={{ ...dashboardStyles.softCard, padding: 16, borderRadius: 18 }}>
                      <div style={{ fontSize: 12, color: "rgba(194,204,201,0.56)" }}>This Month</div>
                      <div style={{ fontSize: 30, fontWeight: 800, color: "#dcc0a5", marginTop: 6 }}>
                        ${stats.costBreakdown.thisMonth.toFixed(2)}
                      </div>
                    </div>
                  </div>
                </div>
              </Card>

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
                    Active Services
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gap: 14,
                      gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                      marginTop: 18,
                    }}
                  >
                    <div style={{ ...dashboardStyles.softCard, padding: 16, borderRadius: 18 }}>
                      <div style={{ fontSize: 12, color: "rgba(194,204,201,0.56)" }}>Active API Keys</div>
                      <div style={{ fontSize: 30, fontWeight: 800, color: "#d8e0dd", marginTop: 6 }}>
                        {stats.activeApiKeys}
                      </div>
                    </div>

                    <div style={{ ...dashboardStyles.softCard, padding: 16, borderRadius: 18 }}>
                      <div style={{ fontSize: 12, color: "rgba(194,204,201,0.56)" }}>Active Batch Jobs</div>
                      <div style={{ fontSize: 30, fontWeight: 800, color: "#d8e0dd", marginTop: 6 }}>
                        {stats.activeBatches}
                      </div>
                    </div>
                  </div>
                </div>
              </Card>
            </div>
          )}

          {stats && Object.keys(stats.topEvidenceTypes).length > 0 && (
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
                  Evidence Types Analyzed
                </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                    gap: 14,
                    marginTop: 18,
                  }}
                >
                  {Object.entries(stats.topEvidenceTypes).map(([type, count]) => (
                    <div
                      key={type}
                      style={{
                        ...dashboardStyles.softCard,
                        borderRadius: 18,
                        padding: 16,
                        textAlign: "center",
                      }}
                    >
                      <div style={{ fontSize: 30, fontWeight: 800, color: "#bfe8df" }}>{count}</div>
                      <div style={{ fontSize: 13, color: "rgba(194,204,201,0.68)", marginTop: 6 }}>
                        {type}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </Card>
          )}
        </>
      )}
    </DashboardShell>
  );
}