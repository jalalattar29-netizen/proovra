"use client";

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../../providers";
import { apiFetch } from "../../../../lib/api";
import { useToast, Skeleton, Card } from "../../../../components/ui";

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
                Usage & Quotas
              </div>

              <h1 className="mt-5 max-w-[760px] text-[1.72rem] font-medium leading-[1.02] tracking-[-0.045em] text-[#d9e2df] md:text-[2.22rem] lg:text-[2.72rem]">
                Account usage and <span className="text-[#c3ebe2]">quota visibility</span>.
              </h1>

              <p className="mt-5 max-w-[720px] text-[0.95rem] leading-[1.8] tracking-[-0.006em] text-[#aab5b2]">
                Loading usage, activity, and current quota limits...
              </p>
            </div>
          </div>
        </div>

        <div className="app-body app-body-full">
          <div className="container" style={{ display: "grid", gap: 16, paddingBottom: 72 }}>
            <div style={{ ...softCardStyle, padding: 22 }}>
              <Skeleton width="100%" height="220px" />
            </div>
            <div style={{ ...softCardStyle, padding: 22 }}>
              <Skeleton width="100%" height="220px" />
            </div>
            <div style={{ ...softCardStyle, padding: 22 }}>
              <Skeleton width="100%" height="220px" />
            </div>
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
              Usage & Quotas
            </div>

            <h1 className="mt-5 max-w-[760px] text-[1.72rem] font-medium leading-[1.02] tracking-[-0.045em] text-[#d9e2df] md:text-[2.22rem] lg:text-[2.72rem]">
              Monitor platform usage and <span className="text-[#c3ebe2]">current limits</span>.
            </h1>

            <p className="mt-5 max-w-[720px] text-[0.95rem] leading-[1.8] tracking-[-0.006em] text-[#aab5b2]">
              Review analysis activity, cost metrics, quota consumption, and active service usage
              from one dashboard.
            </p>
          </div>
        </div>
      </div>

      <div className="app-body app-body-full">
        <div className="container" style={{ display: "grid", gap: 16, paddingBottom: 72 }}>
          {stats && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                gap: 16,
              }}
            >
              {[
                {
                  label: "Today",
                  value: stats.dailyAnalyses.today,
                  sub: "Analyses processed today",
                  color: "#bfe8df",
                },
                {
                  label: "This Week",
                  value: stats.dailyAnalyses.thisWeek,
                  sub: "Analyses processed this week",
                  color: "#d8e0dd",
                },
                {
                  label: "This Month",
                  value: stats.dailyAnalyses.thisMonth,
                  sub: "Analyses processed this month",
                  color: "#dcc0a5",
                },
                {
                  label: "Average Per Analysis",
                  value: `$${stats.costBreakdown.averagePerAnalysis.toFixed(4)}`,
                  sub: "Average AI analysis cost",
                  color: "#c3ebe2",
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
                    <div style={{ ...softCardStyle, padding: 16, borderRadius: 18 }}>
                      <div style={{ fontSize: 12, color: "rgba(194,204,201,0.56)" }}>Total Cost</div>
                      <div style={{ fontSize: 30, fontWeight: 800, color: "#bfe8df", marginTop: 6 }}>
                        ${stats.costBreakdown.totalCost.toFixed(2)}
                      </div>
                    </div>

                    <div style={{ ...softCardStyle, padding: 16, borderRadius: 18 }}>
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
                    <div style={{ ...softCardStyle, padding: 16, borderRadius: 18 }}>
                      <div style={{ fontSize: 12, color: "rgba(194,204,201,0.56)" }}>Active API Keys</div>
                      <div style={{ fontSize: 30, fontWeight: 800, color: "#d8e0dd", marginTop: 6 }}>
                        {stats.activeApiKeys}
                      </div>
                    </div>

                    <div style={{ ...softCardStyle, padding: 16, borderRadius: 18 }}>
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

          {quotas && (
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

          {stats && Object.keys(stats.topEvidenceTypes).length > 0 && (
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
                        ...softCardStyle,
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
                Pricing Reference
              </div>
              <ul
                style={{
                  margin: "18px 0 0",
                  paddingLeft: 18,
                  display: "grid",
                  gap: 10,
                  color: "rgba(194,204,201,0.78)",
                }}
              >
                <li>Each AI analysis: $0.10</li>
                <li>Monthly quota: 10,000 analyses per month</li>
                <li>Batch processing: Included in standard quota</li>
                <li>API keys: Unlimited</li>
                <li>Team members: Up to 10 per account</li>
              </ul>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}