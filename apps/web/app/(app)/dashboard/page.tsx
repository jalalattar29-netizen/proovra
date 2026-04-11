"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Card, Button, Skeleton, useToast } from "../../../components/ui";
import DashboardShell from "../../../components/dashboard/DashboardShell";
import { dashboardStyles } from "../../../components/dashboard/styles";
import { apiFetch } from "../../../lib/api";

type QuotasResponse = {
  analyses: { limit: number; used: number; remaining: number; resetDate: string };
  batchJobs: { limit: number; used: number; remaining: number };
  apiKeys: { limit: number; used: number; remaining: number };
  teamMembers: { limit: number; used: number; remaining: number };
};

type UsageStatsResponse = {
  dailyAnalyses: { today: number; thisWeek: number; thisMonth: number };
  costBreakdown: { totalCost: number; thisMonth: number; averagePerAnalysis: number };
  topEvidenceTypes: Record<string, number>;
  activeApiKeys: number;
  activeBatches: number;
};

type InsightsResponse = {
  total_analyzed: number;
  total_evidence: number;
  api_usage: {
    total_calls: number;
    total_cost_usd: string;
    average_cost_per_call: string;
  };
};

export default function DashboardOverviewPage() {
  const { addToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [quotas, setQuotas] = useState<QuotasResponse | null>(null);
  const [usage, setUsage] = useState<UsageStatsResponse | null>(null);
  const [insights, setInsights] = useState<InsightsResponse | null>(null);

  useEffect(() => {
    const run = async () => {
      try {
        setLoading(true);
        const [quotasData, usageData, insightsData] = await Promise.all([
          apiFetch("/v1/quotas"),
          apiFetch("/v1/usage-stats"),
          apiFetch("/v1/insights"),
        ]);

        setQuotas(quotasData?.data ?? null);
        setUsage(usageData?.data ?? null);
        setInsights(insightsData?.data ?? null);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to load dashboard overview";
        addToast(message, "error");
      } finally {
        setLoading(false);
      }
    };

    void run();
  }, [addToast]);

  const cards = useMemo(() => {
    if (!usage || !insights || !quotas) return [];

    return [
      {
        label: "AI Calls Today",
        value: usage.dailyAnalyses.today,
        sub: "Analyses processed today",
        color: "#bfe8df",
      },
      {
        label: "Analyzed Evidence",
        value: insights.total_analyzed,
        sub: `${insights.total_evidence} total evidence items`,
        color: "#d8e0dd",
      },
      {
        label: "Active API Keys",
        value: usage.activeApiKeys,
        sub: `${quotas.apiKeys.used}/${quotas.apiKeys.limit} in use`,
        color: "#dcc0a5",
      },
      {
        label: "Active Batches",
        value: usage.activeBatches,
        sub: `${quotas.batchJobs.used}/${quotas.batchJobs.limit} in use`,
        color: "#c3ebe2",
      },
    ];
  }, [usage, insights, quotas]);

  const quickLinks = [
    { href: "/home", label: "Workspace Home" },
    { href: "/dashboard/insights", label: "AI Insights" },
    { href: "/dashboard/quotas", label: "Usage & Quotas" },
    { href: "/dashboard/api-keys", label: "API Keys" },
    { href: "/dashboard/batch-analysis", label: "Batch Analysis" },
  ];

  return (
    <DashboardShell
      eyebrow="Dashboard Overview"
      title="Operational visibility for"
      highlight="your workspace."
      description={
        <>
          Review AI usage, quota posture, active integrations, and batch-processing
          activity from one central dashboard surface.
        </>
      }
      action={
        <Link href="/home">
          <Button
            className="rounded-[999px] border px-6 py-3 text-[0.95rem] font-semibold"
            style={dashboardStyles.primaryButton}
          >
            Open Workspace
          </Button>
        </Link>
      }
    >
      {loading ? (
        <>
          <Card
            className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
            style={dashboardStyles.outerCard}
          >
            <div className="relative z-10 p-6">
              <Skeleton width="100%" height="180px" />
            </div>
          </Card>

          <Card
            className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
            style={dashboardStyles.outerCard}
          >
            <div className="relative z-10 p-6">
              <Skeleton width="100%" height="180px" />
            </div>
          </Card>
        </>
      ) : (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 16,
            }}
          >
            {cards.map((item) => (
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
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_14%,rgba(158,216,207,0.05),transparent_28%)]" />
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_86%_18%,rgba(214,184,157,0.04),transparent_24%)]" />

                <div className="relative z-10 p-6">
                  <div style={{ fontSize: 13, color: "rgba(194,204,201,0.64)" }}>
                    {item.label}
                  </div>
                  <div style={{ ...dashboardStyles.metricValue, color: item.color }}>
                    {item.value}
                  </div>
                  <div style={{ fontSize: 12, color: "rgba(194,204,201,0.56)", marginTop: 8 }}>
                    {item.sub}
                  </div>
                </div>
              </Card>
            ))}
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
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
                  Quick Access
                </div>

                <div className="mt-5 grid gap-3">
                  {quickLinks.map((item) => (
                    <Link key={item.href} href={item.href}>
                      <Button
                        variant="secondary"
                        className="flex w-full items-center justify-between rounded-[20px] border px-5 py-4 text-left text-[0.96rem] font-semibold"
                        style={dashboardStyles.secondaryButton}
                      >
                        <span>{item.label}</span>
                        <span className="ml-4 text-[1.05rem] text-[#d6b89d] opacity-90">›</span>
                      </Button>
                    </Link>
                  ))}
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
                  Quota Snapshot
                </div>

                <div style={{ display: "grid", gap: 16, marginTop: 18 }}>
                  {quotas ? (
                    <>
                      <div style={{ ...dashboardStyles.softCard, padding: 16, borderRadius: 18 }}>
                        <div style={{ fontSize: 12, color: "rgba(194,204,201,0.56)" }}>
                          AI Analysis Calls
                        </div>
                        <div style={{ fontSize: 24, fontWeight: 800, color: "#bfe8df", marginTop: 6 }}>
                          {quotas.analyses.used} / {quotas.analyses.limit}
                        </div>
                      </div>

                      <div style={{ ...dashboardStyles.softCard, padding: 16, borderRadius: 18 }}>
                        <div style={{ fontSize: 12, color: "rgba(194,204,201,0.56)" }}>
                          Reset Date
                        </div>
                        <div style={{ fontSize: 18, fontWeight: 700, color: "#d8e0dd", marginTop: 6 }}>
                          {new Date(quotas.analyses.resetDate).toLocaleDateString()}
                        </div>
                      </div>
                    </>
                  ) : (
                    <div style={{ color: "rgba(194,204,201,0.72)" }}>No quota data.</div>
                  )}
                </div>
              </div>
            </Card>
          </div>
        </>
      )}
    </DashboardShell>
  );
}