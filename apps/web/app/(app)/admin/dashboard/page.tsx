"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, Skeleton } from "../../../../components/ui";
import { apiFetch } from "../../../../lib/api";
import { useToast } from "../../../../components/ui";
import DashboardShell from "../../../../components/dashboard/DashboardShell";
import { dashboardStyles } from "../../../../components/dashboard/styles";

type AdminSummary = {
  totalUsers: number;
  registeredUsers: number;
  guestUsers: number;
  activeUsers: number;
  usersWithEvidence: number;
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
};

type GeoItem = {
  name: string | null;
  count: number;
  share?: number;
  countryCode?: string | null;
  normalized?: string | null;
};

type GeographyResponse = {
  total?: number;
  countries: GeoItem[];
  cities: GeoItem[];
};

type TopPage = {
  path: string | null;
  routeType?: string | null;
  views: number;
  share?: number;
};

type RecentEvent = {
  eventType: string;
  label?: string;
  routeType?: string | null;
  severity?: string | null;
  path: string | null;
  country: string | null;
  city: string | null;
  createdAt: string;
  sessionId?: string | null;
  userId?: string | null;
};

type TrendPoint = {
  date: string;
  pageViews: number;
  sessions: number;
};

type FunnelStep = {
  key: string;
  label: string;
  count: number;
  conversionFromPrevious: number | null;
  dropOffFromPrevious: number | null;
};

type AdminBundle = {
  summary: AdminSummary;
  geography: GeographyResponse;
  pages: TopPage[];
  recent: RecentEvent[];
  trends: TrendPoint[];
  funnel: FunnelStep[];
};

function formatTimestamp(value: string) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

export default function AdminDashboardPage() {
  const { addToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [bundle, setBundle] = useState<AdminBundle | null>(null);

  useEffect(() => {
    const run = async () => {
      try {
        setLoading(true);
        const data = await apiFetch("/v1/admin/analytics/dashboard?dateRange=7d");
        setBundle(data ?? null);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to load admin dashboard";
        addToast(message, "error");
      } finally {
        setLoading(false);
      }
    };

    void run();
  }, [addToast]);

  const overviewCards = useMemo(() => {
    if (!bundle) return [];

    return [
      {
        label: "Total Users",
        value: bundle.summary.totalUsers,
        sub: `${bundle.summary.registeredUsers} registered`,
        color: "#d8e0dd",
      },
      {
        label: "Active Users",
        value: bundle.summary.activeUsers,
        sub: "Analytics active registered users",
        color: "#bfe8df",
      },
      {
        label: "Total Evidence",
        value: bundle.summary.totalEvidence,
        sub: `${bundle.summary.usersWithEvidence} owners with evidence`,
        color: "#c3ebe2",
      },
      {
        label: "Reports Generated",
        value: bundle.summary.reportsGenerated,
        sub: "Generated verification reports",
        color: "#dcc0a5",
      },
    ];
  }, [bundle]);

  return (
    <DashboardShell
      eyebrow="Admin Dashboard"
      title="Executive analytics and"
      highlight="platform visibility."
      description={
        <>
          Review global product activity, funnel performance, geography, top routes,
          and recent platform events from one admin dashboard.
        </>
      }
    >
      {loading ? (
        <>
          <Card className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none" style={dashboardStyles.outerCard}>
            <div className="relative z-10 p-6">
              <Skeleton width="100%" height="220px" />
            </div>
          </Card>
          <Card className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none" style={dashboardStyles.outerCard}>
            <div className="relative z-10 p-6">
              <Skeleton width="100%" height="220px" />
            </div>
          </Card>
        </>
      ) : !bundle ? (
        <Card className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none" style={dashboardStyles.outerCard}>
          <div className="relative z-10 p-6 text-[#d8e0dd]">No admin analytics data available.</div>
        </Card>
      ) : (
        <>
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
              gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
              gap: 16,
            }}
          >
            <Card className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none" style={dashboardStyles.outerCard}>
              <div className="absolute inset-0">
                <img src="/images/site-velvet-bg.webp.png" alt="" className="h-full w-full object-cover object-center scale-[1.12]" />
              </div>
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,20,24,0.82)_0%,rgba(7,18,22,0.88)_100%)]" />
              <div className="relative z-10 p-6 md:p-7">
                <div className="text-[1.08rem] font-semibold tracking-[-0.02em] text-[#d8e0dd]">
                  Funnel
                </div>

                <div style={{ display: "grid", gap: 14, marginTop: 18 }}>
                  {bundle.funnel.map((step, idx) => (
                    <div key={step.key} style={{ ...dashboardStyles.softCard, padding: 16, borderRadius: 18 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 700, color: "#d8e0dd" }}>
                            {idx + 1}. {step.label}
                          </div>
                          <div style={{ fontSize: 12, color: "rgba(194,204,201,0.56)", marginTop: 4 }}>
                            {idx === 0
                              ? "Entry step"
                              : `Conversion ${step.conversionFromPrevious ?? 0}% · Drop-off ${step.dropOffFromPrevious ?? 0}%`}
                          </div>
                        </div>
                        <div style={{ fontSize: 20, fontWeight: 800, color: "#bfe8df" }}>
                          {step.count}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </Card>

            <Card className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none" style={dashboardStyles.outerCard}>
              <div className="absolute inset-0">
                <img src="/images/site-velvet-bg.webp.png" alt="" className="h-full w-full object-cover object-center scale-[1.12]" />
              </div>
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,20,24,0.82)_0%,rgba(7,18,22,0.88)_100%)]" />
              <div className="relative z-10 p-6 md:p-7">
                <div className="text-[1.08rem] font-semibold tracking-[-0.02em] text-[#d8e0dd]">
                  Top Pages
                </div>

                <div style={{ display: "grid", gap: 12, marginTop: 18 }}>
                  {bundle.pages.slice(0, 8).map((page, idx) => (
                    <div key={`${page.path}-${idx}`} style={{ ...dashboardStyles.softCard, padding: 16, borderRadius: 18 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 700, color: "#d8e0dd" }}>
                            {page.path ?? "Unknown"}
                          </div>
                          <div style={{ fontSize: 12, color: "rgba(194,204,201,0.56)", marginTop: 4 }}>
                            {page.routeType ?? "unknown"} · {page.share?.toFixed(1) ?? "0.0"}% share
                          </div>
                        </div>
                        <div style={{ fontSize: 18, fontWeight: 800, color: "#c3ebe2" }}>
                          {page.views}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </Card>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
              gap: 16,
            }}
          >
            <Card className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none" style={dashboardStyles.outerCard}>
              <div className="absolute inset-0">
                <img src="/images/site-velvet-bg.webp.png" alt="" className="h-full w-full object-cover object-center scale-[1.12]" />
              </div>
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,20,24,0.82)_0%,rgba(7,18,22,0.88)_100%)]" />
              <div className="relative z-10 p-6 md:p-7">
                <div className="text-[1.08rem] font-semibold tracking-[-0.02em] text-[#d8e0dd]">
                  Geography
                </div>

                <div style={{ display: "grid", gap: 12, marginTop: 18 }}>
                  {bundle.geography.countries.slice(0, 5).map((country, idx) => (
                    <div key={`${country.countryCode}-${idx}`} style={{ ...dashboardStyles.softCard, padding: 16, borderRadius: 18 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 700, color: "#d8e0dd" }}>
                            {country.name ?? "Unknown"}
                          </div>
                          <div style={{ fontSize: 12, color: "rgba(194,204,201,0.56)", marginTop: 4 }}>
                            {country.countryCode ?? "—"} · {country.share?.toFixed(1) ?? "0.0"}% share
                          </div>
                        </div>
                        <div style={{ fontSize: 18, fontWeight: 800, color: "#bfe8df" }}>
                          {country.count}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </Card>

            <Card className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none" style={dashboardStyles.outerCard}>
              <div className="absolute inset-0">
                <img src="/images/site-velvet-bg.webp.png" alt="" className="h-full w-full object-cover object-center scale-[1.12]" />
              </div>
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,20,24,0.82)_0%,rgba(7,18,22,0.88)_100%)]" />
              <div className="relative z-10 p-6 md:p-7">
                <div className="text-[1.08rem] font-semibold tracking-[-0.02em] text-[#d8e0dd]">
                  Recent Platform Activity
                </div>

                <div style={{ display: "grid", gap: 12, marginTop: 18 }}>
                  {bundle.recent.slice(0, 8).map((event, idx) => (
                    <div key={`${event.eventType}-${event.createdAt}-${idx}`} style={{ ...dashboardStyles.softCard, padding: 16, borderRadius: 18 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "#d8e0dd" }}>
                        {event.label ?? event.eventType}
                      </div>
                      <div style={{ fontSize: 12, color: "rgba(194,204,201,0.56)", marginTop: 6 }}>
                        {event.path ?? "No path"} · {event.city ?? event.country ?? "No location"}
                      </div>
                      <div style={{ fontSize: 12, color: "rgba(194,204,201,0.56)", marginTop: 6 }}>
                        {formatTimestamp(event.createdAt)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </Card>
          </div>
        </>
      )}
    </DashboardShell>
  );
}