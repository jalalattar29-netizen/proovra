"use client";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../../providers";
import { apiFetch } from "../../../../lib/api";
import { formatUserDate } from "../../../../lib/date";
import { useToast, Skeleton } from "../../../../components/ui";
import { Card } from "../../../../components/ui/Card";
import DashboardShell from "../../../../components/dashboard/DashboardShell";
import { dashboardStyles } from "../../../../components/dashboard/styles";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";

/** A null limit is no enforced limit: the page shows the count alone. */
interface Quotas {
  analyses: { limit: number | null; used: number; remaining: number | null; resetDate: string };
  batchJobs: { limit: number | null; used: number; remaining: number | null };
  apiKeys: { limit: number | null; used: number; remaining: number | null };
  /** Null limit: nothing bounds the workspace as a whole. */
  teamMembers: { limit: number | null; used: number; remaining: number | null };
}

interface UsageStats {
  dailyAnalyses: { today: number; thisWeek: number; thisMonth: number };
  costBreakdown: {
    totalCost: number;
    thisMonth: number;
    averagePerAnalysis: number;
  };
  topEvidenceTypes: Record<string, number>;
  activeApiKeys: number;
  activeBatches: number;
}

function quotaCard(q: { limit: number | null; used: number; remaining: number | null }) {
  return q.limit === null
    ? { value: String(q.used), sub: "No enforced limit" }
    : { value: `${q.used} / ${q.limit}`, sub: `${q.remaining ?? 0} remaining` };
}

function safePercent(used: number, limit: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
}

// Phase 38.14 — wrap in canonical PageRouteGate.
export default function QuotasPage() {
  return (
    <PageRouteGate routeId="dashboard.quotas">
      <QuotasPageInner />
    </PageRouteGate>
  );
}

function QuotasPageInner() {
  const { user } = useAuth();
  const { addToast } = useToast();

  const [quotas, setQuotas] = useState<Quotas | null>(null);
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(true);

  // Both endpoints are scoped to the authenticated user server-side, so the
  // identity IS the query key: a signed-in identity change must refetch, and
  // the previous identity's response must never land in the new one's view.
  const userId = user?.id ?? null;
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        setLoading(true);

        const [quotasData, statsData] = await Promise.all([
          apiFetch("/v1/quotas"),
          apiFetch("/v1/usage-stats"),
        ]);

        if (cancelled) return;
        setQuotas(quotasData?.data ?? null);
        setStats(statsData?.data ?? null);
      } catch (err) {
        if (cancelled) return;
        const message =
          toSafeUserError(err, { message: "Failed to load usage and quota data" }).message;
        addToast(message, "error");
        setQuotas(null);
        setStats(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, addToast]);

  const quotaCards = useMemo(() => {
    if (!quotas) return [];

    return [
      {
        label: "Analysis Calls",
        ...quotaCard(quotas.analyses),
        color: "var(--app-ink-heading)",
      },
      {
        label: "Batch Jobs",
        ...quotaCard(quotas.batchJobs),
        color: "var(--app-ink-heading)",
      },
      {
        label: "API Keys",
        ...quotaCard(quotas.apiKeys),
        color: "var(--app-ink-heading)",
      },
      {
        label: "Team Members",
        value:
          quotas.teamMembers.limit === null
            ? String(quotas.teamMembers.used)
            : `${quotas.teamMembers.used} / ${quotas.teamMembers.limit}`,
        sub:
          quotas.teamMembers.limit === null
            ? "No workspace-wide limit"
            : `${quotas.teamMembers.remaining} remaining`,
        color: "var(--app-ink-heading)",
      },
    ];
  }, [quotas]);

  const usageCards = useMemo(() => {
    if (!stats) return [];

    return [
      {
        label: "Today",
        value: stats.dailyAnalyses.today,
        sub: "Analyses processed today",
        color: "var(--app-ink-heading)",
      },
      {
        label: "This Week",
        value: stats.dailyAnalyses.thisWeek,
        sub: "Analyses processed this week",
        color: "var(--app-ink-heading)",
      },
      {
        label: "This Month",
        value: stats.dailyAnalyses.thisMonth,
        sub: "Analyses processed this month",
        color: "var(--app-ink-heading)",
      },
      {
        label: "Estimated Per Analysis",
        value: `$${stats.costBreakdown.averagePerAnalysis.toFixed(4)}`,
        sub: "A fixed list rate, not a measured cost",
        color: "var(--app-ink-heading)",
      },
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
        ? "var(--error)"
        : percent >= 70
        ? "var(--warning)"
        : "var(--accent-500)";

    return (
      <div className="dashboard-quotas-bar-row">
        <div className="dashboard-quotas-bar-top">
          <span className="dashboard-quotas-bar-label">{label}</span>
          <span className="dashboard-quotas-bar-meta">
            {used} / {limit} used · {remaining} remaining
          </span>
        </div>

        <div
          style={{
            width: "100%",
            height: 10,
            borderRadius: 999,
            background: "var(--surface-muted)",
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

        <div className="dashboard-quotas-bar-percent">{percent}% used</div>
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
      <style jsx global>{`
        .dashboard-quotas-page {
          display: grid;
          gap: 16px;
        }

        .dashboard-quotas-page .dashboard-quotas-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
          gap: 16px;
        }

        .dashboard-quotas-page .dashboard-quotas-grid-wide {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
          gap: 16px;
        }

        .dashboard-quotas-page .dashboard-quotas-metric-label {
          font-size: 13px;
          color: var(--app-ink-secondary);
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .dashboard-quotas-page .dashboard-quotas-metric-value-lg {
          font-size: 34px;
          font-weight: 800;
          margin-top: 8px;
          line-height: 1;
          letter-spacing: -0.04em;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .dashboard-quotas-page .dashboard-quotas-metric-value-md {
          font-size: 28px;
          font-weight: 800;
          margin-top: 8px;
          line-height: 1.15;
          letter-spacing: -0.04em;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .dashboard-quotas-page .dashboard-quotas-metric-sub {
          font-size: 12px;
          color: var(--app-ink-secondary);
          margin-top: 8px;
          line-height: 1.5;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .dashboard-quotas-page .dashboard-quotas-card-title {
          font-size: 1.08rem;
          font-weight: 600;
          letter-spacing: -0.02em;
          color: var(--app-ink-heading);
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .dashboard-quotas-page .dashboard-quotas-soft-grid {
          display: grid;
          gap: 14px;
          grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
          margin-top: 18px;
        }

        .dashboard-quotas-page .dashboard-quotas-bar-stack {
          display: grid;
          gap: 22px;
          margin-top: 18px;
        }

        .dashboard-quotas-page .dashboard-quotas-bar-row {
          display: grid;
          gap: 8px;
          min-width: 0;
        }

        .dashboard-quotas-page .dashboard-quotas-bar-top {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          align-items: center;
          flex-wrap: wrap;
        }

        .dashboard-quotas-page .dashboard-quotas-bar-label {
          color: var(--app-ink-heading);
          font-weight: 700;
          font-size: 13px;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .dashboard-quotas-page .dashboard-quotas-bar-meta,
        .dashboard-quotas-page .dashboard-quotas-bar-percent {
          font-size: 12px;
          color: var(--app-ink-secondary);
          line-height: 1.5;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .dashboard-quotas-page .dashboard-quotas-reset-row {
          padding-top: 16px;
          border-top: 1px solid var(--border-default);
          font-size: 13px;
          color: var(--app-ink-secondary);
          line-height: 1.6;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        @media (max-width: 760px) {
          .dashboard-quotas-page .dashboard-quotas-soft-grid {
            grid-template-columns: 1fr;
          }
        }
      `}</style>

      <div className="dashboard-quotas-page">
        {loading ? (
          <Card
            padding="none"
          >
            <div className="p-6">
              <Skeleton width="100%" height="280px" />
            </div>
          </Card>
        ) : (
          <>
            {usageCards.length > 0 && (
              <div className="dashboard-quotas-grid">
                {usageCards.map((item) => (
                  <Card
                    key={item.label}
                    padding="none"
                  >
                    <div className="p-6">
                      <div className="dashboard-quotas-metric-label">
                        {item.label}
                      </div>
                      <div
                        className="dashboard-quotas-metric-value-lg"
                        style={{ color: item.color }}
                      >
                        {item.value}
                      </div>
                      <div className="dashboard-quotas-metric-sub">{item.sub}</div>
                    </div>
                  </Card>
                ))}
              </div>
            )}

            {quotaCards.length > 0 && (
              <div className="dashboard-quotas-grid">
                {quotaCards.map((item) => (
                  <Card
                    key={item.label}
                    padding="none"
                  >
                    <div className="p-6">
                      <div className="dashboard-quotas-metric-label">
                        {item.label}
                      </div>
                      <div
                        className="dashboard-quotas-metric-value-md"
                        style={{ color: item.color }}
                      >
                        {item.value}
                      </div>
                      <div className="dashboard-quotas-metric-sub">{item.sub}</div>
                    </div>
                  </Card>
                ))}
              </div>
            )}

            {quotas && (
              <Card
                padding="none"
              >
                <div className="p-6 md:p-7">
                  <div className="dashboard-quotas-card-title">Current Quotas</div>
                  <p style={{ fontSize: 13, opacity: 0.8, marginTop: 4 }} data-testid="quotas-indicative-note">
                    Team members follow your plan or contract. The other figures
                    are indicative: Billing shows what your plan includes.
                  </p>

                  <div className="dashboard-quotas-bar-stack">
                    {quotas.analyses.limit === null ? null : renderQuotaBar(
                      "Analysis API Calls",
                      quotas.analyses.used,
                      quotas.analyses.limit,
                      quotas.analyses.remaining ?? 0
                    )}

                    {quotas.batchJobs.limit === null ? null : renderQuotaBar(
                      "Batch Jobs",
                      quotas.batchJobs.used,
                      quotas.batchJobs.limit,
                      quotas.batchJobs.remaining ?? 0
                    )}

                    {quotas.apiKeys.limit === null ? null : renderQuotaBar(
                      "API Keys",
                      quotas.apiKeys.used,
                      quotas.apiKeys.limit,
                      quotas.apiKeys.remaining ?? 0
                    )}

                    {quotas.teamMembers.limit === null ? null : renderQuotaBar(
                      "Team Members",
                      quotas.teamMembers.used,
                      quotas.teamMembers.limit,
                      quotas.teamMembers.remaining ?? 0
                    )}

                    <div className="dashboard-quotas-reset-row">
                      Quotas reset on{" "}
                      <strong style={{ color: "var(--app-ink-heading)" }}>
                        {formatUserDate(quotas.analyses.resetDate)}
                      </strong>
                    </div>
                  </div>
                </div>
              </Card>
            )}

            {stats && (
              <div className="dashboard-quotas-grid-wide">
                <Card
                  padding="none"
                >
                  <div className="p-6 md:p-7">
                    <div className="dashboard-quotas-card-title">Cost Overview</div>

                    <div className="dashboard-quotas-soft-grid">
                      <div
                        style={{
                          ...dashboardStyles.softCard,
                          padding: 16,
                          borderRadius: 18,
                        }}
                      >
                        <div
                          style={{ fontSize: 12, color: "var(--app-ink-secondary)" }}
                        >
                          Total Cost
                        </div>
                        <div
                          className="dashboard-quotas-metric-value-lg"
                          style={{ color: "var(--app-ink-heading)", marginTop: 6, fontSize: 30 }}
                        >
                          ${stats.costBreakdown.totalCost.toFixed(2)}
                        </div>
                      </div>

                      <div
                        style={{
                          ...dashboardStyles.softCard,
                          padding: 16,
                          borderRadius: 18,
                        }}
                      >
                        <div
                          style={{ fontSize: 12, color: "var(--app-ink-secondary)" }}
                        >
                          This Month
                        </div>
                        <div
                          className="dashboard-quotas-metric-value-lg"
                          style={{ color: "var(--app-ink-heading)", marginTop: 6, fontSize: 30 }}
                        >
                          ${stats.costBreakdown.thisMonth.toFixed(2)}
                        </div>
                      </div>
                    </div>
                  </div>
                </Card>

                <Card
                  padding="none"
                >
                  <div className="p-6 md:p-7">
                    <div className="dashboard-quotas-card-title">Active Services</div>

                    <div className="dashboard-quotas-soft-grid">
                      <div
                        style={{
                          ...dashboardStyles.softCard,
                          padding: 16,
                          borderRadius: 18,
                        }}
                      >
                        <div
                          style={{ fontSize: 12, color: "var(--app-ink-secondary)" }}
                        >
                          Active API Keys
                        </div>
                        <div
                          className="dashboard-quotas-metric-value-lg"
                          style={{ color: "var(--app-ink-heading)", marginTop: 6, fontSize: 30 }}
                        >
                          {stats.activeApiKeys}
                        </div>
                      </div>

                      <div
                        style={{
                          ...dashboardStyles.softCard,
                          padding: 16,
                          borderRadius: 18,
                        }}
                      >
                        <div
                          style={{ fontSize: 12, color: "var(--app-ink-secondary)" }}
                        >
                          Active Batch Jobs
                        </div>
                        <div
                          className="dashboard-quotas-metric-value-lg"
                          style={{ color: "var(--app-ink-heading)", marginTop: 6, fontSize: 30 }}
                        >
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
                padding="none"
              >
                <div className="p-6 md:p-7">
                  <div className="dashboard-quotas-card-title">
                    Evidence Types Analyzed
                  </div>

                  <div
                    className="dashboard-quotas-soft-grid"
                    style={{ marginTop: 18 }}
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
                        <div
                          className="dashboard-quotas-metric-value-lg"
                          style={{ fontSize: 30, color: "var(--app-ink-heading)" }}
                        >
                          {count}
                        </div>
                        <div
                          style={{
                            fontSize: 13,
                            color: "var(--app-ink-secondary)",
                            marginTop: 6,
                            overflowWrap: "anywhere",
                            wordBreak: "break-word",
                          }}
                        >
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
      </div>
    </DashboardShell>
  );
}