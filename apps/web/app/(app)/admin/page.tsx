"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button, Card, useToast, Skeleton } from "../../../components/ui";
import { useAuth } from "../../providers";
import { apiFetch } from "../../../lib/api";

interface AdminStats {
  totalUsers: number;
  activeUsers: number;
  totalEvidence: number;
  reportsGenerated: number;
  subscriptionBreakdown: {
    free: number;
    payg: number;
    pro: number;
    team: number;
  };
  evidenceByType: {
    photos: number;
    videos: number;
    documents: number;
    other: number;
  };
}

interface GeoItem {
  name: string | null;
  count: number;
}

interface GeographyResponse {
  countries: GeoItem[];
  cities: GeoItem[];
}

interface TopPage {
  path: string | null;
  views: number;
}

interface RecentEvent {
  eventType: string;
  path: string | null;
  country: string | null;
  city: string | null;
  createdAt: string;
}

interface TrendPoint {
  date: string;
  pageViews: number;
  sessions: number;
}

interface FunnelStep {
  key: string;
  label: string;
  count: number;
}

interface StatCardProps {
  title: string;
  value: string | number;
  description: string;
  accent?: string;
}


const MOCK_STATS: AdminStats = {
  totalUsers: 12345,
  activeUsers: 2345,
  totalEvidence: 45678,
  reportsGenerated: 8234,
  subscriptionBreakdown: {
    free: 8234,
    payg: 2456,
    pro: 1234,
    team: 234
  },
  evidenceByType: {
    photos: 32456,
    videos: 8234,
    documents: 3456,
    other: 1234
  }
};

// Professional StatCard Component
function StatCard({ title, value, description, accent = "#0B7BE5" }: StatCardProps) {
  return (
    <Card>
      <div style={{ padding: 20 }}>
        <div style={{ marginBottom: 12 }}>
          <div style={{
            fontSize: 12,
            fontWeight: 600,
            color: "#64748B",
            textTransform: "uppercase",
            letterSpacing: "0.5px"
          }}>
            {title}
          </div>
        </div>
        <div style={{ marginBottom: 12 }}>
          <div style={{
            fontSize: 32,
            fontWeight: 700,
            color: "#0F172A",
            lineHeight: 1
          }}>
            {value}
          </div>
        </div>
        <div style={{
          fontSize: 13,
          color: "#64748B",
          lineHeight: 1.5
        }}>
          {description}
        </div>
        <div style={{
          marginTop: 12,
          height: 3,
          width: 40,
          backgroundColor: accent,
          borderRadius: 999
        }} />
      </div>
    </Card>
  );
}

// Loading Skeleton
function StatSkeleton() {
  return (
    <Card>
      <div style={{ padding: 20 }}>
        <div style={{ marginBottom: 12 }}>
          <Skeleton width="60%" height="14px" />
        </div>
        <div style={{ marginBottom: 12 }}>
          <Skeleton width="70%" height="32px" />
        </div>
        <Skeleton width="100%" height="13px" />
      </div>
    </Card>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function isValidAdminStats(value: unknown): value is AdminStats {
  if (!isRecord(value)) return false;

  const subscriptionBreakdown = isRecord(value.subscriptionBreakdown)
    ? value.subscriptionBreakdown
    : undefined;

  const evidenceByType = isRecord(value.evidenceByType)
    ? value.evidenceByType
    : undefined;

  return (
    typeof value.totalUsers === "number" &&
    typeof value.activeUsers === "number" &&
    typeof value.totalEvidence === "number" &&
    typeof value.reportsGenerated === "number" &&
    !!subscriptionBreakdown &&
    typeof subscriptionBreakdown.free === "number" &&
    typeof subscriptionBreakdown.payg === "number" &&
    typeof subscriptionBreakdown.pro === "number" &&
    typeof subscriptionBreakdown.team === "number" &&
    !!evidenceByType &&
    typeof evidenceByType.photos === "number" &&
    typeof evidenceByType.videos === "number" &&
    typeof evidenceByType.documents === "number" &&
    typeof evidenceByType.other === "number"
  );
}


function isGeoItem(value: unknown): value is GeoItem {
  return (
    isRecord(value) &&
    (typeof value.name === "string" || value.name === null) &&
    typeof value.count === "number"
  );
}

function isValidGeographyResponse(value: unknown): value is GeographyResponse {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.countries) || !Array.isArray(value.cities)) return false;

  return value.countries.every(isGeoItem) && value.cities.every(isGeoItem);
}

function isTopPage(value: unknown): value is TopPage {
  return (
    isRecord(value) &&
    (typeof value.path === "string" || value.path === null) &&
    typeof value.views === "number"
  );
}

function isValidTopPages(value: unknown): value is TopPage[] {
  return Array.isArray(value) && value.every(isTopPage);
}

function isRecentEvent(value: unknown): value is RecentEvent {
  return (
    isRecord(value) &&
    typeof value.eventType === "string" &&
    (typeof value.path === "string" || value.path === null) &&
    (typeof value.country === "string" || value.country === null) &&
    (typeof value.city === "string" || value.city === null) &&
    typeof value.createdAt === "string"
  );
}

function isValidRecentEvents(value: unknown): value is RecentEvent[] {
  return Array.isArray(value) && value.every(isRecentEvent);
}

function isTrendPoint(value: unknown): value is TrendPoint {
  return (
    isRecord(value) &&
    typeof value.date === "string" &&
    typeof value.pageViews === "number" &&
    typeof value.sessions === "number"
  );
}

function isValidTrendPoints(value: unknown): value is TrendPoint[] {
  return Array.isArray(value) && value.every(isTrendPoint);
}

function isFunnelStep(value: unknown): value is FunnelStep {
  return (
    isRecord(value) &&
    typeof value.key === "string" &&
    typeof value.label === "string" &&
    typeof value.count === "number"
  );
}

function isValidFunnel(value: unknown): value is FunnelStep[] {
  return Array.isArray(value) && value.every(isFunnelStep);
}

function maxTrendValue(points: TrendPoint[]): number {
  if (!points.length) return 1;
  return Math.max(
    1,
    ...points.flatMap((point) => [point.pageViews, point.sessions])
  );
}

// Enhanced Progress Bar Component
function ProgressBar(props: {
  value: number;
  maxValue: number;
  color: string;
  height?: number;
}): JSX.Element {
  const { value, maxValue, color, height = 6 } = props;
  const percentage = maxValue <= 0 ? 0 : Math.max(4, Math.round((value / maxValue) * 100));

  return (
    <div style={{
      width: "100%",
      height: height,
      backgroundColor: "#E2E8F0",
      borderRadius: 999,
      overflow: "hidden",
    }}>
      <div style={{
        width: `${percentage}%`,
        height: "100%",
        backgroundColor: color,
        borderRadius: 999,
      }} />
    </div>
  );
}

// Enhanced Mini Bar for Trends
function renderMiniBar(value: number, maxValue: number, color: string): JSX.Element {
  return <ProgressBar value={value} maxValue={maxValue} color={color} height={8} />;
}


export default function AdminPage() {
  const { addToast } = useToast();
  const { user } = useAuth();

  const [stats, setStats] = useState<AdminStats | null>(null);
  const [geo, setGeo] = useState<GeographyResponse | null>(null);
  const [pages, setPages] = useState<TopPage[]>([]);
  const [recent, setRecent] = useState<RecentEvent[]>([]);
  const [trends, setTrends] = useState<TrendPoint[]>([]);
  const [funnel, setFunnel] = useState<FunnelStep[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isAdmin = user?.id === "admin" || user?.email?.includes("admin");
  const trendMax = maxTrendValue(trends);
  const funnelMax = funnel.length ? Math.max(1, ...funnel.map((step) => step.count)) : 1;

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false);
      setError("Access denied - admin only");
      addToast("You don't have access to this page", "error");
      return;
    }

    let cancelled = false;

    const loadStats = async () => {
      setLoading(true);
      setError(null);
      addToast("Loading admin dashboard...", "info");

      try {
        const [
          summaryResponse,
          geographyResponse,
          pagesResponse,
          recentResponse,
          trendsResponse,
          funnelResponse,
        ] = await Promise.all([
          apiFetch("/v1/admin/analytics/summary", { method: "GET" }),
          apiFetch("/v1/admin/analytics/geography", { method: "GET" }),
          apiFetch("/v1/admin/analytics/pages", { method: "GET" }),
          apiFetch("/v1/admin/analytics/recent", { method: "GET" }),
          apiFetch("/v1/admin/analytics/trends", { method: "GET" }),
          apiFetch("/v1/admin/analytics/funnel", { method: "GET" }),
        ]);

        if (!cancelled) {
          if (isValidAdminStats(summaryResponse)) {
            setStats(summaryResponse);
          } else {
            setStats(MOCK_STATS);
            setError("Live summary data is not ready yet. Showing fallback data.");
          }

          if (isValidGeographyResponse(geographyResponse)) {
            setGeo(geographyResponse);
          } else {
            setGeo({ countries: [], cities: [] });
          }

          if (isValidTopPages(pagesResponse)) {
            setPages(pagesResponse);
          } else {
            setPages([]);
          }

          if (isValidRecentEvents(recentResponse)) {
            setRecent(recentResponse);
          } else {
            setRecent([]);
          }

          if (isValidTrendPoints(trendsResponse)) {
            setTrends(trendsResponse);
          } else {
            setTrends([]);
          }

          if (isValidFunnel(funnelResponse)) {
            setFunnel(funnelResponse);
          } else {
            setFunnel([]);
          }

          addToast("Admin dashboard loaded", "success");
        }
      } catch {
        if (!cancelled) {
          setStats(MOCK_STATS);
          setGeo({ countries: [], cities: [] });
          setPages([]);
          setRecent([]);
          setTrends([]);
          setFunnel([]);
          setError("Live analytics endpoints are unavailable. Showing fallback dashboard data.");
          addToast("Live analytics unavailable. Using fallback data.", "info");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadStats();

    return () => {
      cancelled = true;
    };
  }, [isAdmin, addToast]);

  if (!isAdmin) {
    return (
      <div className="section app-section">
        <div className="container" style={{ paddingTop: 40 }}>
          <Card>
            <div style={{
              padding: 32,
              textAlign: "center",
              background: "#FEE2E2",
              borderRadius: 8,
              color: "#991B1B"
            }}>
              <h2 style={{ margin: 0, marginBottom: 12, fontSize: 20, fontWeight: 600 }}>
                Access Denied
              </h2>
              <p style={{ margin: 0, fontSize: 14, marginBottom: 24 }}>
                This page is only accessible to administrators.
              </p>
              <Link href="/">
                <Button>Go Home</Button>
              </Link>
            </div>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="section app-section" style={{ backgroundColor: "#F8FAFC" }}>
      {/* Hero Section */}
      <div className="app-hero app-hero-full" style={{ borderBottom: "1px solid #E2E8F0" }}>
        <div className="container">
          <div className="page-title" style={{ marginBottom: 0 }}>
            <div>
              <h1 className="hero-title pricing-hero-title" style={{
                margin: 0,
                fontSize: 32,
                fontWeight: 700,
                color: "#0F172A"
              }}>
                Analytics Dashboard
              </h1>
              <p className="page-subtitle pricing-subtitle" style={{
                marginTop: 6,
                fontSize: 15,
                color: "#64748B"
              }}>
                Platform overview, user metrics, and system insights
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="app-body app-body-full" style={{ paddingTop: 32, paddingBottom: 48 }}>
        <div className="container">
          {/* Error Message */}
          {error && (
            <div style={{ marginBottom: 24 }}>
              <Card>
                <div style={{
                  padding: 16,
                  background: "#FEE2E2",
                  borderRadius: 8,
                  color: "#991B1B",
                  fontSize: 13,
                  borderLeft: "4px solid #DC2626"
                }}>
                  {error}
                </div>
              </Card>
            </div>
          )}

          {/* OVERVIEW SECTION */}
          {loading ? (
            <div style={{
              display: "grid",
              gap: 16,
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              marginBottom: 32
            }}>
              <StatSkeleton />
              <StatSkeleton />
              <StatSkeleton />
              <StatSkeleton />
            </div>
          ) : stats ? (
            <>
              <div style={{ marginBottom: 40 }}>
                <h2 style={{
                  fontSize: 16,
                  fontWeight: 700,
                  color: "#64748B",
                  marginBottom: 16,
                  textTransform: "uppercase",
                  letterSpacing: "0.5px"
                }}>
                  Overview
                </h2>
                <div style={{
                  display: "grid",
                  gap: 16,
                  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))"
                }}>
                  <StatCard
                    title="Total Users"
                    value={stats.totalUsers.toLocaleString()}
                    description={`${stats.activeUsers.toLocaleString()} active in last 30 days`}
                    accent="#3B82F6"
                  />
                  <StatCard
                    title="Total Evidence"
                    value={stats.totalEvidence.toLocaleString()}
                    description={`${stats.reportsGenerated.toLocaleString()} reports generated`}
                    accent="#10B981"
                  />
                  <StatCard
                    title="Avg Evidence/User"
                    value={(stats.totalEvidence / stats.totalUsers).toFixed(1)}
                    description="Per registered user"
                    accent="#F59E0B"
                  />
                  <StatCard
                    title="Report Rate"
                    value={`${(stats.reportsGenerated / stats.totalEvidence * 100).toFixed(1)}%`}
                    description="Of evidence has reports"
                    accent="#8B5CF6"
                  />
                </div>
              </div>

              {/* ACTIVITY SECTION */}
              <div style={{ marginBottom: 40 }}>
                <h2 style={{
                  fontSize: 16,
                  fontWeight: 700,
                  color: "#64748B",
                  marginBottom: 16,
                  textTransform: "uppercase",
                  letterSpacing: "0.5px"
                }}>
                  Activity
                </h2>
                
                {/* Trends */}
                <Card style={{ marginBottom: 16 }}>
                  <div style={{ padding: 24 }}>
                    <h3 style={{
                      margin: "0 0 20px 0",
                      fontSize: 15,
                      fontWeight: 600,
                      color: "#0F172A"
                    }}>
                      7-Day Trends
                    </h3>

                    {trends.length ? (
                      <div style={{
                        display: "grid",
                        gap: 16,
                        gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))"
                      }}>
                        {trends.map((point) => (
                          <div key={point.date} style={{
                            border: "1px solid #E2E8F0",
                            borderRadius: 12,
                            padding: 16,
                            backgroundColor: "#F8FAFC",
                            transition: "all 0.2s"
                          }}>
                            <div style={{
                              fontSize: 12,
                              color: "#64748B",
                              fontWeight: 600,
                              marginBottom: 12
                            }}>
                              {point.date}
                            </div>

                            <div style={{ marginBottom: 10 }}>
                              <div style={{
                                fontSize: 12,
                                color: "#0F172A",
                                marginBottom: 6,
                                fontWeight: 500
                              }}>
                                Page Views
                              </div>
                              <div style={{
                                fontSize: 18,
                                fontWeight: 700,
                                color: "#3B82F6",
                                marginBottom: 8
                              }}>
                                {point.pageViews.toLocaleString()}
                              </div>
                              {renderMiniBar(point.pageViews, trendMax, "#3B82F6")}
                            </div>

                            <div style={{ marginTop: 12 }}>
                              <div style={{
                                fontSize: 12,
                                color: "#0F172A",
                                marginBottom: 6,
                                fontWeight: 500
                              }}>
                                Sessions
                              </div>
                              <div style={{
                                fontSize: 18,
                                fontWeight: 700,
                                color: "#10B981",
                                marginBottom: 8
                              }}>
                                {point.sessions.toLocaleString()}
                              </div>
                              {renderMiniBar(point.sessions, trendMax, "#10B981")}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div style={{
                        padding: 24,
                        textAlign: "center",
                        color: "#94A3B8"
                      }}>
                        <p style={{ margin: 0 }}>No trend data yet.</p>
                      </div>
                    )}
                  </div>
                </Card>

                {/* Top Pages */}
                <Card>
                  <div style={{ padding: 24 }}>
                    <h3 style={{
                      margin: "0 0 20px 0",
                      fontSize: 15,
                      fontWeight: 600,
                      color: "#0F172A"
                    }}>
                      Top Pages
                    </h3>

                    {pages.length ? (
                      <div style={{ display: "grid", gap: 12 }}>
                        {pages.slice(0, 10).map((item, idx) => (
                          <div key={`page-${item.path ?? "unknown"}`} style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 12,
                            paddingBottom: 12,
                            borderBottom: idx < pages.length - 1 ? "1px solid #E2E8F0" : "none"
                          }}>
                            <div style={{
                              width: 28,
                              height: 28,
                              borderRadius: 6,
                              backgroundColor: "#EFF6FF",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              fontSize: 12,
                              fontWeight: 600,
                              color: "#3B82F6"
                            }}>
                              {idx + 1}
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{
                                fontSize: 13,
                                fontWeight: 500,
                                color: "#0F172A",
                                wordBreak: "break-word",
                                marginBottom: 2
                              }}>
                                {item.path ?? "Unknown"}
                              </div>
                              <div style={{
                                fontSize: 12,
                                color: "#64748B"
                              }}>
                                {item.views.toLocaleString()} views
                              </div>
                            </div>
                            <div style={{
                              fontSize: 14,
                              fontWeight: 600,
                              color: "#0F172A",
                              whiteSpace: "nowrap"
                            }}>
                              {item.views.toLocaleString()}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div style={{
                        padding: 24,
                        textAlign: "center",
                        color: "#94A3B8"
                      }}>
                        <p style={{ margin: 0 }}>No page analytics yet.</p>
                      </div>
                    )}
                  </div>
                </Card>
              </div>

              {/* FUNNEL SECTION */}
              <div style={{ marginBottom: 40 }}>
                <h2 style={{
                  fontSize: 16,
                  fontWeight: 700,
                  color: "#64748B",
                  marginBottom: 16,
                  textTransform: "uppercase",
                  letterSpacing: "0.5px"
                }}>
                  Funnel
                </h2>
                <Card>
                  <div style={{ padding: 24 }}>
                    <h3 style={{
                      margin: "0 0 20px 0",
                      fontSize: 15,
                      fontWeight: 600,
                      color: "#0F172A"
                    }}>
                      Product Funnel
                    </h3>

                    {funnel.length ? (
                      <div style={{ display: "grid", gap: 16 }}>
                        {funnel.map((step, idx) => (
                          <div key={step.key}>
                            <div style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                              marginBottom: 8
                            }}>
                              <div style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 10
                              }}>
                                <div style={{
                                  width: 32,
                                  height: 32,
                                  borderRadius: 6,
                                  backgroundColor: "#FEF3C7",
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  fontSize: 13,
                                  fontWeight: 600,
                                  color: "#92400E"
                                }}>
                                  {idx + 1}
                                </div>
                                <div>
                                  <div style={{
                                    fontSize: 13,
                                    fontWeight: 500,
                                    color: "#0F172A"
                                  }}>
                                    {step.label}
                                  </div>
                                </div>
                              </div>
                              <div style={{
                                fontSize: 13,
                                fontWeight: 600,
                                color: "#0F172A"
                              }}>
                                {step.count.toLocaleString()}
                              </div>
                            </div>
                            {renderMiniBar(step.count, funnelMax, "#F59E0B")}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div style={{
                        padding: 24,
                        textAlign: "center",
                        color: "#94A3B8"
                      }}>
                        <p style={{ margin: 0 }}>No funnel data yet.</p>
                      </div>
                    )}
                  </div>
                </Card>
              </div>

              {/* GEOGRAPHY SECTION */}
              <div style={{ marginBottom: 40 }}>
                <h2 style={{
                  fontSize: 16,
                  fontWeight: 700,
                  color: "#64748B",
                  marginBottom: 16,
                  textTransform: "uppercase",
                  letterSpacing: "0.5px"
                }}>
                  Geography
                </h2>
                <div style={{
                  display: "grid",
                  gap: 16,
                  gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))"
                }}>
                  {/* Countries */}
                  <Card>
                    <div style={{ padding: 24 }}>
                      <h3 style={{
                        margin: "0 0 20px 0",
                        fontSize: 14,
                        fontWeight: 600,
                        color: "#0F172A"
                      }}>
                        Top Countries
                      </h3>

                      {geo?.countries?.length ? (
                        <div style={{ display: "grid", gap: 10 }}>
                          {geo.countries.slice(0, 8).map((item, idx) => (
                            <div key={`country-${item.name ?? "unknown"}`} style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 12,
                              paddingBottom: 10,
                              borderBottom: idx < Math.min(geo.countries.length, 8) - 1 ? "1px solid #E2E8F0" : "none"
                            }}>
                              <div style={{
                                width: 28,
                                height: 28,
                                borderRadius: 4,
                                backgroundColor: "#E0F2FE",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                fontSize: 11,
                                fontWeight: 700,
                                color: "#0369A1"
                              }}>
                                {idx + 1}
                              </div>
                              <div style={{ flex: 1 }}>
                                <div style={{
                                  fontSize: 13,
                                  fontWeight: 500,
                                  color: "#0F172A"
                                }}>
                                  {item.name ?? "Unknown"}
                                </div>
                              </div>
                              <div style={{
                                fontSize: 12,
                                fontWeight: 600,
                                color: "#64748B",
                                whiteSpace: "nowrap"
                              }}>
                                {item.count.toLocaleString()}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div style={{
                          padding: 24,
                          textAlign: "center",
                          color: "#94A3B8",
                          fontSize: 13
                        }}>
                          No country data yet.
                        </div>
                      )}
                    </div>
                  </Card>

                  {/* Cities */}
                  <Card>
                    <div style={{ padding: 24 }}>
                      <h3 style={{
                        margin: "0 0 20px 0",
                        fontSize: 14,
                        fontWeight: 600,
                        color: "#0F172A"
                      }}>
                        Top Cities
                      </h3>

                      {geo?.cities?.length ? (
                        <div style={{ display: "grid", gap: 10 }}>
                          {geo.cities.slice(0, 8).map((item, idx) => (
                            <div key={`city-${item.name ?? "unknown"}`} style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 12,
                              paddingBottom: 10,
                              borderBottom: idx < Math.min(geo.cities.length, 8) - 1 ? "1px solid #E2E8F0" : "none"
                            }}>
                              <div style={{
                                width: 28,
                                height: 28,
                                borderRadius: 4,
                                backgroundColor: "#DBEAFE",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                fontSize: 11,
                                fontWeight: 700,
                                color: "#0284C7"
                              }}>
                                {idx + 1}
                              </div>
                              <div style={{ flex: 1 }}>
                                <div style={{
                                  fontSize: 13,
                                  fontWeight: 500,
                                  color: "#0F172A"
                                }}>
                                  {item.name ?? "Unknown"}
                                </div>
                              </div>
                              <div style={{
                                fontSize: 12,
                                fontWeight: 600,
                                color: "#64748B",
                                whiteSpace: "nowrap"
                              }}>
                                {item.count.toLocaleString()}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div style={{
                          padding: 24,
                          textAlign: "center",
                          color: "#94A3B8",
                          fontSize: 13
                        }}>
                          No city data yet.
                        </div>
                      )}
                    </div>
                  </Card>
                </div>
              </div>

              {/* RECENT EVENTS SECTION */}
              <div style={{ marginBottom: 40 }}>
                <h2 style={{
                  fontSize: 16,
                  fontWeight: 700,
                  color: "#64748B",
                  marginBottom: 16,
                  textTransform: "uppercase",
                  letterSpacing: "0.5px"
                }}>
                  Recent Activity
                </h2>
                <Card>
                  <div style={{ padding: 24 }}>
                    <h3 style={{
                      margin: "0 0 20px 0",
                      fontSize: 15,
                      fontWeight: 600,
                      color: "#0F172A"
                    }}>
                      Latest Events
                    </h3>

                    {recent.length ? (
                      <div style={{ display: "grid", gap: 1 }}>
                        {recent.slice(0, 20).map((item, index) => (
                          <div key={`${item.eventType}-${item.createdAt}-${index}`} style={{
                            display: "grid",
                            gridTemplateColumns: "120px 1fr auto",
                            gap: 16,
                            alignItems: "center",
                            padding: "12px 0",
                            borderBottom: index < recent.length - 1 ? "1px solid #E2E8F0" : "none"
                          }}>
                            <div style={{
                              fontSize: 12,
                              fontWeight: 600,
                              color: "#3B82F6",
                              textTransform: "capitalize",
                              wordBreak: "break-word"
                            }}>
                              {item.eventType}
                            </div>
                            <div style={{ minWidth: 0 }}>
                              <div style={{
                                fontSize: 12,
                                color: "#0F172A",
                                fontWeight: 500,
                                wordBreak: "break-word",
                                marginBottom: 2
                              }}>
                                {item.path ?? "No path"}
                              </div>
                              <div style={{
                                fontSize: 11,
                                color: "#64748B"
                              }}>
                                {item.city ?? item.country ?? "Unknown location"}
                              </div>
                            </div>
                            <div style={{
                              fontSize: 11,
                              color: "#64748B",
                              whiteSpace: "nowrap"
                            }}>
                              {new Date(item.createdAt).toLocaleDateString("en-US", {
                                month: "short",
                                day: "numeric",
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div style={{
                        padding: 24,
                        textAlign: "center",
                        color: "#94A3B8"
                      }}>
                        <p style={{ margin: 0 }}>No recent activity yet.</p>
                      </div>
                    )}
                  </div>
                </Card>
              </div>

              {/* SUBSCRIPTION & EVIDENCE BREAKDOWN */}
              <div style={{ marginBottom: 40 }}>
                <h2 style={{
                  fontSize: 16,
                  fontWeight: 700,
                  color: "#64748B",
                  marginBottom: 16,
                  textTransform: "uppercase",
                  letterSpacing: "0.5px"
                }}>
                  Breakdown
                </h2>
                <div style={{
                  display: "grid",
                  gap: 16,
                  gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))"
                }}>
                  {/* Subscription */}
                  <Card>
                    <div style={{ padding: 24 }}>
                      <h3 style={{
                        margin: "0 0 20px 0",
                        fontSize: 14,
                        fontWeight: 600,
                        color: "#0F172A"
                      }}>
                        Subscription Plans
                      </h3>
                      <div style={{ display: "grid", gap: 14 }}>
                        {[
                          { label: "Free Plan", value: stats.subscriptionBreakdown.free, color: "#EFF6FF", textColor: "#0369A1" },
                          { label: "Pay-Per-Evidence", value: stats.subscriptionBreakdown.payg, color: "#F0FDF4", textColor: "#16A34A" },
                          { label: "Pro Plan", value: stats.subscriptionBreakdown.pro, color: "#FFFBEB", textColor: "#D97706" },
                          { label: "Team Plan", value: stats.subscriptionBreakdown.team, color: "#FEF2F2", textColor: "#DC2626" }
                        ].map((plan) => (
                          <div key={plan.label}>
                            <div style={{
                              display: "flex",
                              justifyContent: "space-between",
                              marginBottom: 6
                            }}>
                              <div style={{
                                fontSize: 12,
                                fontWeight: 500,
                                color: "#0F172A"
                              }}>
                                {plan.label}
                              </div>
                              <div style={{
                                fontSize: 12,
                                fontWeight: 600,
                                color: "#0F172A"
                              }}>
                                {((plan.value / stats.totalUsers) * 100).toFixed(1)}%
                              </div>
                            </div>
                            <ProgressBar
                              value={plan.value}
                              maxValue={stats.totalUsers}
                              color={plan.textColor}
                              height={6}
                            />
                            <div style={{
                              fontSize: 11,
                              color: "#64748B",
                              marginTop: 4
                            }}>
                              {plan.value.toLocaleString()} users
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </Card>

                  {/* Evidence Type */}
                  <Card>
                    <div style={{ padding: 24 }}>
                      <h3 style={{
                        margin: "0 0 20px 0",
                        fontSize: 14,
                        fontWeight: 600,
                        color: "#0F172A"
                      }}>
                        Evidence by Type
                      </h3>
                      <div style={{ display: "grid", gap: 14 }}>
                        {[
                          { label: "Photos", value: stats.evidenceByType.photos, color: "#3B82F6" },
                          { label: "Videos", value: stats.evidenceByType.videos, color: "#10B981" },
                          { label: "Documents", value: stats.evidenceByType.documents, color: "#F59E0B" },
                          { label: "Other", value: stats.evidenceByType.other, color: "#8B5CF6" }
                        ].map((type) => (
                          <div key={type.label}>
                            <div style={{
                              display: "flex",
                              justifyContent: "space-between",
                              marginBottom: 6
                            }}>
                              <div style={{
                                fontSize: 12,
                                fontWeight: 500,
                                color: "#0F172A"
                              }}>
                                {type.label}
                              </div>
                              <div style={{
                                fontSize: 12,
                                fontWeight: 600,
                                color: "#0F172A"
                              }}>
                                {((type.value / stats.totalEvidence) * 100).toFixed(1)}%
                              </div>
                            </div>
                            <ProgressBar
                              value={type.value}
                              maxValue={stats.totalEvidence}
                              color={type.color}
                              height={6}
                            />
                            <div style={{
                              fontSize: 11,
                              color: "#64748B",
                              marginTop: 4
                            }}>
                              {type.value.toLocaleString()} items
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </Card>
                </div>
              </div>

              {/* System Status */}
              <div>
                <Card>
                  <div style={{ padding: 24 }}>
                    <h3 style={{
                      margin: "0 0 16px 0",
                      fontSize: 15,
                      fontWeight: 600,
                      color: "#0F172A"
                    }}>
                      System Status
                    </h3>
                    <div style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                      gap: 16
                    }}>
                      <div>
                        <div style={{ fontSize: 12, color: "#64748B", marginBottom: 6 }}>
                          API Version
                        </div>
                        <div style={{ fontSize: 14, fontWeight: 600, color: "#0F172A" }}>
                          v1
                        </div>
                      </div>
                      <div>
                        <div style={{ fontSize: 12, color: "#64748B", marginBottom: 6 }}>
                          Database
                        </div>
                        <div style={{ fontSize: 14, fontWeight: 600, color: "#0F172A" }}>
                          PostgreSQL
                        </div>
                      </div>
                      <div>
                        <div style={{ fontSize: 12, color: "#64748B", marginBottom: 6 }}>
                          Status
                        </div>
                        <div style={{
                          fontSize: 13,
                          fontWeight: 600,
                          color: "#10B981",
                          display: "flex",
                          alignItems: "center",
                          gap: 6
                        }}>
                          <span style={{
                            width: 8,
                            height: 8,
                            borderRadius: 999,
                            backgroundColor: "#10B981"
                          }} />
                          Healthy
                        </div>
                      </div>
                      <div>
                        <div style={{ fontSize: 12, color: "#64748B", marginBottom: 6 }}>
                          Last Updated
                        </div>
                        <div style={{ fontSize: 13, fontWeight: 500, color: "#0F172A" }}>
                          {new Date().toLocaleTimeString()}
                        </div>
                      </div>
                    </div>
                  </div>
                </Card>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
