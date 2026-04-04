"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import Link from "next/link";
import { Button, Card, useToast, Skeleton } from "../../../components/ui";
import { useAuth } from "../../providers";
import { apiFetch, ApiError } from "../../../lib/api";

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
  userId?: string | null;
}

interface TrendPoint {
  date: string;
  pageViews: number;
  sessions: number;
  /** When API returns multi-series trends, filter client-side by event type */
  eventType?: string | null;
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

type DateRangeKey = "24h" | "7d" | "30d";

type EventTypeFilter =
  | "all"
  | "page_view"
  | "login_completed"
  | "evidence_created"
  | "report_generated";

const DATE_RANGE_OPTIONS: { key: DateRangeKey; label: string; ms: number }[] = [
  { key: "24h", label: "Last 24 hours", ms: 24 * 60 * 60 * 1000 },
  { key: "7d", label: "Last 7 days", ms: 7 * 24 * 60 * 60 * 1000 },
  { key: "30d", label: "Last 30 days", ms: 30 * 24 * 60 * 60 * 1000 },
];

const EVENT_TYPE_OPTIONS: { value: EventTypeFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "page_view", label: "page_view" },
  { value: "login_completed", label: "login_completed" },
  { value: "evidence_created", label: "evidence_created" },
  { value: "report_generated", label: "report_generated" },
];

const UI = {
  pageBg: "transparent",
  cardBg: "rgba(4, 17, 40, 0.72)",
  cardBgStrong: "rgba(5, 20, 48, 0.84)",
  innerPanelBg: "rgba(9, 28, 62, 0.82)",
  innerPanelSoft: "rgba(13, 36, 78, 0.74)",
  border: "rgba(96, 165, 250, 0.18)",
  borderStrong: "rgba(148, 163, 184, 0.22)",
  textPrimary: "#F8FAFC",
  textSecondary: "#CBD5E1",
  textMuted: "#94A3B8",
  textFaint: "#7C8CA5",
  heading: "#E2E8F0",
  toolbarBg: "rgba(15, 23, 42, 0.64)",
  toolbarActiveBg: "#E2E8F0",
  toolbarActiveText: "#0F172A",
  toolbarIdleText: "#CBD5E1",
  inputBg: "rgba(248, 250, 252, 0.96)",
  inputText: "#0F172A",
  success: "#34D399",
  successText: "#86EFAC",
  warning: "#F59E0B",
  dangerBg: "rgba(127, 29, 29, 0.22)",
  dangerBorder: "rgba(248, 113, 113, 0.42)",
  dangerText: "#FECACA",
  emptyText: "#AFC0D5",
};

function dateRangeLabel(range: DateRangeKey): string {
  const found = DATE_RANGE_OPTIONS.find((o) => o.key === range);
  return found?.label ?? "Selected range";
}

function formatDisplayTimestamp(isoOrDate: string): string {
  const d = new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return isoOrDate;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day} ${h}:${min}`;
}

function escapeCsvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function buildAnalyticsCsv(rows: RecentEvent[]): string {
  const header = ["eventType", "createdAt", "userId", "country", "city", "path"];
  const lines = [
    header.join(","),
    ...rows.map((row) =>
      [
        escapeCsvCell(row.eventType),
        escapeCsvCell(formatDisplayTimestamp(row.createdAt)),
        escapeCsvCell(row.userId ?? ""),
        escapeCsvCell(row.country ?? ""),
        escapeCsvCell(row.city ?? ""),
        escapeCsvCell(row.path ?? ""),
      ].join(",")
    ),
  ];
  return lines.join("\r\n");
}

function triggerCsvDownload(content: string, filename: string): void {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportFilenameForToday(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `analytics_export_${y}-${m}-${d}.csv`;
}

function buildAnalyticsQuery(
  dateRange: DateRangeKey,
  eventType: EventTypeFilter
): string {
  const params = new URLSearchParams();
  params.set("dateRange", dateRange);
  if (eventType !== "all") {
    params.set("eventType", eventType);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function httpStatusFromUnknownError(err: unknown): number | undefined {
  if (err instanceof ApiError) return err.statusCode;
  if (isRecord(err) && typeof err.statusCode === "number") return err.statusCode;
  return undefined;
}

/**
 * GET with dateRange/eventType query params; retries the same path without query
 * when the server rejects unknown params (400/422).
 */
async function apiFetchAdminAnalyticsGET(
  path: string,
  querySuffix: string
): Promise<unknown> {
  const init: RequestInit = { method: "GET" };
  const withQuery = querySuffix ? `${path}${querySuffix}` : path;
  try {
    return await apiFetch(withQuery, init);
  } catch (err: unknown) {
    const status = httpStatusFromUnknownError(err);
    if (querySuffix && (status === 400 || status === 422)) {
      return apiFetch(path, init);
    }
    throw err;
  }
}

interface AuditLogRow {
  id: string;
  userId: string | null;
  isPublic: boolean;
  action: string;
  metadata: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  hash: string;
  prevHash: string | null;
  createdAt: string;
  anchoredAt: string | null;
}

function formatAuditActor(userId: string | null, isPublic: boolean): string {
  if (isPublic || userId === null) return "public";
  if (userId.length <= 10) return userId;
  return `${userId.slice(0, 8)}…`;
}

function prettyMetadataJson(metadata: unknown): string {
  try {
    return JSON.stringify(metadata, null, 2);
  } catch {
    return String(metadata);
  }
}

type AdminAnalyticsBundle = {
  summary: unknown;
  geography: unknown;
  pages: unknown;
  recent: unknown;
  trends: unknown;
  funnel: unknown;
};

function isAdminDashboardBundle(value: unknown): value is AdminAnalyticsBundle {
  if (!isRecord(value)) return false;
  return (
    "summary" in value &&
    "geography" in value &&
    "pages" in value &&
    "recent" in value &&
    "trends" in value &&
    "funnel" in value
  );
}

async function tryFetchAdminDashboardBundle(
  querySuffix: string
): Promise<AdminAnalyticsBundle | null> {
  try {
    const raw = await apiFetchAdminAnalyticsGET(
      "/v1/admin/analytics/dashboard",
      querySuffix
    );
    return isAdminDashboardBundle(raw) ? raw : null;
  } catch {
    return null;
  }
}

function safeRatioPercent(numerator: number, denominator: number): string {
  if (denominator <= 0 || !Number.isFinite(numerator) || !Number.isFinite(denominator)) {
    return "0.0";
  }
  return ((numerator / denominator) * 100).toFixed(1);
}

function safeDivideDisplay(
  numerator: number,
  denominator: number,
  decimals: number
): string {
  if (denominator <= 0 || !Number.isFinite(numerator) || !Number.isFinite(denominator)) {
    return (0).toFixed(decimals);
  }
  return (numerator / denominator).toFixed(decimals);
}

function sectionTitleStyle(): CSSProperties {
  return {
    fontSize: 16,
    fontWeight: 700,
    color: UI.heading,
    marginBottom: 16,
    textTransform: "uppercase",
    letterSpacing: "0.5px",
  };
}

function subCardStyle(extra?: CSSProperties): CSSProperties {
  return {
    padding: 24,
    background: UI.cardBgStrong,
    border: `1px solid ${UI.border}`,
    borderRadius: 20,
    boxShadow: "0 14px 40px rgba(2, 8, 23, 0.16)",
    ...extra,
  };
}

// Professional StatCard Component
function StatCard({ title, value, description, accent = "#0B7BE5" }: StatCardProps) {
  return (
    <Card>
      <div
        style={{
          padding: 20,
          background: UI.cardBgStrong,
          border: `1px solid ${UI.border}`,
          borderRadius: 20,
          minHeight: 172,
          boxShadow: "0 14px 40px rgba(2, 8, 23, 0.14)",
        }}
      >
        <div style={{ marginBottom: 12 }}>
          <div
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: UI.textMuted,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            {title}
          </div>
        </div>
        <div style={{ marginBottom: 12 }}>
          <div
            style={{
              fontSize: 32,
              fontWeight: 800,
              color: UI.textPrimary,
              lineHeight: 1,
              textShadow: "0 1px 0 rgba(2, 6, 23, 0.35)",
            }}
          >
            {value}
          </div>
        </div>
        <div
          style={{
            fontSize: 13,
            color: UI.textSecondary,
            lineHeight: 1.5,
          }}
        >
          {description}
        </div>
        <div
          style={{
            marginTop: 12,
            height: 3,
            width: 40,
            backgroundColor: accent,
            borderRadius: 999,
            boxShadow: `0 0 16px ${accent}55`,
          }}
        />
      </div>
    </Card>
  );
}

// Loading Skeleton
function StatSkeleton() {
  return (
    <Card>
      <div
        style={{
          padding: 20,
          background: UI.cardBgStrong,
          border: `1px solid ${UI.border}`,
          borderRadius: 20,
        }}
      >
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
  if (!isRecord(value)) return false;
  const userIdOk =
    !("userId" in value) ||
    value.userId === null ||
    typeof value.userId === "string";
  return (
    typeof value.eventType === "string" &&
    (typeof value.path === "string" || value.path === null) &&
    (typeof value.country === "string" || value.country === null) &&
    (typeof value.city === "string" || value.city === null) &&
    typeof value.createdAt === "string" &&
    userIdOk
  );
}

function isValidRecentEvents(value: unknown): value is RecentEvent[] {
  return Array.isArray(value) && value.every(isRecentEvent);
}

function isTrendPoint(value: unknown): value is TrendPoint {
  if (!isRecord(value)) return false;
  const eventTypeOk =
    !("eventType" in value) ||
    value.eventType === null ||
    typeof value.eventType === "string";
  return (
    typeof value.date === "string" &&
    typeof value.pageViews === "number" &&
    typeof value.sessions === "number" &&
    eventTypeOk
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
    <div
      style={{
        width: "100%",
        height,
        backgroundColor: "rgba(226, 232, 240, 0.9)",
        borderRadius: 999,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: `${percentage}%`,
          height: "100%",
          backgroundColor: color,
          borderRadius: 999,
          boxShadow: `0 0 14px ${color}55`,
        }}
      />
    </div>
  );
}

// Enhanced Mini Bar for Trends
function renderMiniBar(value: number, maxValue: number, color: string): JSX.Element {
  return <ProgressBar value={value} maxValue={maxValue} color={color} height={8} />;
}

export default function AdminPage() {
  const { addToast } = useToast();
  const { user, authReady } = useAuth();

  const [stats, setStats] = useState<AdminStats | null>(null);
  const [geo, setGeo] = useState<GeographyResponse | null>(null);
  const [pages, setPages] = useState<TopPage[]>([]);
  const [recent, setRecent] = useState<RecentEvent[]>([]);
  const [trends, setTrends] = useState<TrendPoint[]>([]);
  const [funnel, setFunnel] = useState<FunnelStep[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastSuccessfulFetchAt, setLastSuccessfulFetchAt] = useState<string | null>(null);
  const [auditLogItems, setAuditLogItems] = useState<AuditLogRow[]>([]);
  const [auditLogsLoading, setAuditLogsLoading] = useState(false);
  const [chainVerify, setChainVerify] = useState<
    | { valid: true }
    | { valid: false; brokenAt: string }
    | null
  >(null);

  const [dateRange, setDateRange] = useState<DateRangeKey>("7d");
  const [eventTypeFilter, setEventTypeFilter] = useState<EventTypeFilter>("all");

  const isAdminRole = user?.role === "admin";
  const lastAuditedFilters = useRef<{ dateRange: DateRangeKey; eventType: EventTypeFilter } | null>(null);

  const refreshAuditLogs = useCallback(async () => {
    setAuditLogsLoading(true);
    try {
      const data = await apiFetch("/v1/admin/audit-log?limit=100", { method: "GET" });
      if (isRecord(data) && Array.isArray(data.items)) {
        setAuditLogItems(data.items as AuditLogRow[]);
      } else {
        setAuditLogItems([]);
      }
    } catch {
      setAuditLogItems([]);
    } finally {
      setAuditLogsLoading(false);
    }
  }, []);

  const refreshChainVerify = useCallback(async () => {
    try {
      const data = await apiFetch("/v1/admin/audit-log/verify", { method: "GET" });
      if (isRecord(data) && data.valid === true) {
        setChainVerify({ valid: true });
      } else if (isRecord(data) && data.valid === false) {
        const brokenAt =
          typeof data.brokenAt === "string" ? data.brokenAt : "unknown";
        setChainVerify({ valid: false, brokenAt });
      } else {
        setChainVerify(null);
      }
    } catch {
      setChainVerify(null);
    }
  }, []);

  const sendAuditLog = useCallback(
    async (action: string, metadata: Record<string, unknown>) => {
      if (!user?.id) return;
      try {
        await apiFetch("/v1/admin/audit-log", {
          method: "POST",
          body: JSON.stringify({
            action,
            metadata,
          }),
        });
        await refreshAuditLogs();
        await refreshChainVerify();
      } catch {
        /* Audit delivery failure must not disrupt admin operations */
      }
    },
    [user?.id, refreshAuditLogs, refreshChainVerify]
  );

  const trendMax = useMemo(() => maxTrendValue(trends), [trends]);

  const trendPrimaryMetricLabel =
    eventTypeFilter === "all" ? "Page views" : `${eventTypeFilter} (count)`;

  const funnelMax = useMemo(
    () => (funnel.length ? Math.max(1, ...funnel.map((step) => step.count)) : 1),
    [funnel]
  );

  const handleExportCsv = () => {
    void sendAuditLog("admin.analytics.export_csv", {
      exportType: "analytics_csv",
      dateRange,
      eventType: eventTypeFilter,
      rowCount: recent.length,
    });
    const csv = buildAnalyticsCsv(recent);
    triggerCsvDownload(csv, exportFilenameForToday());
    addToast("Exported filtered analytics to CSV", "success");
  };

  useEffect(() => {
    if (!authReady || !isAdminRole) return;
    void sendAuditLog("admin.analytics.page_access", {
      surface: "admin_dashboard",
    });
  }, [authReady, isAdminRole, sendAuditLog]);

  useEffect(() => {
    if (!authReady) return;
    if (!isAdminRole) {
      lastAuditedFilters.current = null;
      return;
    }
    const prev = lastAuditedFilters.current;
    lastAuditedFilters.current = { dateRange, eventType: eventTypeFilter };
    if (!prev) return;
    if (prev.dateRange === dateRange && prev.eventType === eventTypeFilter) return;
    void sendAuditLog("admin.analytics.filter_change", {
      dateRange,
      eventType: eventTypeFilter,
      previousDateRange: prev.dateRange,
      previousEventType: prev.eventType,
    });
  }, [authReady, isAdminRole, dateRange, eventTypeFilter, sendAuditLog]);

  useEffect(() => {
    if (!authReady || !isAdminRole) return;
    void refreshAuditLogs();
    void refreshChainVerify();
  }, [authReady, isAdminRole, refreshAuditLogs, refreshChainVerify]);

  useEffect(() => {
    if (!authReady) {
      return;
    }
    if (!isAdminRole) {
      setLoading(false);
      setError("Access denied - admin only");
      addToast("You don't have access to this page", "error");
      return;
    }

    let cancelled = false;

    const applyAnalyticsPayload = (
      summaryResponse: unknown,
      geographyResponse: unknown,
      pagesResponse: unknown,
      recentResponse: unknown,
      trendsResponse: unknown,
      funnelResponse: unknown
    ): boolean => {
      if (!isValidAdminStats(summaryResponse)) {
        setStats(null);
        setGeo(null);
        setPages([]);
        setRecent([]);
        setTrends([]);
        setFunnel([]);
        setError("Analytics summary response was invalid or incomplete.");
        return false;
      }

      setStats(summaryResponse);

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
      return true;
    };

    const loadStats = async () => {
      setLoading(true);
      setError(null);
      addToast("Loading admin dashboard...", "info");

      const querySuffix = buildAnalyticsQuery(dateRange, eventTypeFilter);

      try {
        const bundle = await tryFetchAdminDashboardBundle(querySuffix);
        let summaryResponse: unknown;
        let geographyResponse: unknown;
        let pagesResponse: unknown;
        let recentResponse: unknown;
        let trendsResponse: unknown;
        let funnelResponse: unknown;

        if (bundle) {
          summaryResponse = bundle.summary;
          geographyResponse = bundle.geography;
          pagesResponse = bundle.pages;
          recentResponse = bundle.recent;
          trendsResponse = bundle.trends;
          funnelResponse = bundle.funnel;
        } else {
          [
            summaryResponse,
            geographyResponse,
            pagesResponse,
            recentResponse,
            trendsResponse,
            funnelResponse,
          ] = await Promise.all([
            apiFetchAdminAnalyticsGET("/v1/admin/analytics/summary", querySuffix),
            apiFetchAdminAnalyticsGET("/v1/admin/analytics/geography", querySuffix),
            apiFetchAdminAnalyticsGET("/v1/admin/analytics/pages", querySuffix),
            apiFetchAdminAnalyticsGET("/v1/admin/analytics/recent", querySuffix),
            apiFetchAdminAnalyticsGET("/v1/admin/analytics/trends", querySuffix),
            apiFetchAdminAnalyticsGET("/v1/admin/analytics/funnel", querySuffix),
          ]);
        }

        if (!cancelled) {
          const ok = applyAnalyticsPayload(
            summaryResponse,
            geographyResponse,
            pagesResponse,
            recentResponse,
            trendsResponse,
            funnelResponse
          );
          if (ok) {
            setLastSuccessfulFetchAt(new Date().toISOString());
            addToast("Admin dashboard loaded", "success");
          } else {
            addToast("Analytics data could not be loaded", "error");
          }
        }
      } catch {
        if (!cancelled) {
          setStats(null);
          setGeo(null);
          setPages([]);
          setRecent([]);
          setTrends([]);
          setFunnel([]);
          setError(
            "Could not load analytics. Check your connection and admin permissions, then retry."
          );
          addToast("Analytics request failed", "error");
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
  }, [authReady, isAdminRole, addToast, dateRange, eventTypeFilter]);

  if (!authReady) {
    return (
      <div className="section app-section">
        <div className="container" style={{ paddingTop: 40 }}>
          <div
            style={{
              display: "grid",
              gap: 16,
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              marginBottom: 24,
            }}
          >
            <StatSkeleton />
            <StatSkeleton />
            <StatSkeleton />
            <StatSkeleton />
          </div>
        </div>
      </div>
    );
  }

  if (!isAdminRole) {
    return (
      <div className="section app-section">
        <div className="container" style={{ paddingTop: 40 }}>
          <Card>
            <div
              style={{
                padding: 32,
                textAlign: "center",
                background: UI.dangerBg,
                borderRadius: 16,
                color: UI.dangerText,
                border: `1px solid ${UI.dangerBorder}`,
              }}
            >
              <h2 style={{ margin: 0, marginBottom: 12, fontSize: 20, fontWeight: 600 }}>
                Access Denied
              </h2>
              <p style={{ margin: 0, fontSize: 14, marginBottom: 24, color: UI.textSecondary }}>
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

  const toolbarSegmentStyle = (active: boolean): CSSProperties => ({
    padding: "6px 14px",
    fontSize: 13,
    fontWeight: 600,
    border: "none",
    borderRadius: 6,
    cursor: "pointer",
    backgroundColor: active ? UI.toolbarActiveBg : "transparent",
    color: active ? UI.toolbarActiveText : UI.toolbarIdleText,
    boxShadow: active ? "0 1px 2px rgba(15, 23, 42, 0.16)" : "none",
    transition: "background-color 0.15s ease, color 0.15s ease, box-shadow 0.15s ease",
  });

  return (
    <div className="section app-section" style={{ backgroundColor: UI.pageBg }}>
      {/* Hero Section */}
      <div
        className="app-hero app-hero-full"
        style={{ borderBottom: `1px solid ${UI.borderStrong}` }}
      >
        <div className="container">
          <div className="page-title" style={{ marginBottom: 0 }}>
            <div>
              <h1
                className="hero-title pricing-hero-title"
                style={{
                  margin: 0,
                  fontSize: 32,
                  fontWeight: 800,
                  color: UI.textPrimary,
                  textShadow: "0 2px 18px rgba(15, 23, 42, 0.28)",
                }}
              >
                Analytics Dashboard
              </h1>
              <p
                className="page-subtitle pricing-subtitle"
                style={{
                  marginTop: 6,
                  fontSize: 15,
                  color: UI.textSecondary,
                }}
              >
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
                <div
                  style={{
                    padding: 16,
                    background: UI.dangerBg,
                    borderRadius: 14,
                    color: UI.dangerText,
                    fontSize: 13,
                    borderLeft: "4px solid #F87171",
                    border: `1px solid ${UI.dangerBorder}`,
                  }}
                >
                  {error}
                </div>
              </Card>
            </div>
          )}

          {/* Analytics toolbar: filters + export */}
          {!loading ? (
            <div style={{ marginBottom: 24 }}>
              <Card>
                <div
                  style={{
                    padding: "14px 18px",
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "center",
                    gap: 16,
                    justifyContent: "space-between",
                    background: UI.cardBgStrong,
                    border: `1px solid ${UI.border}`,
                    borderRadius: 20,
                    boxShadow: "0 14px 40px rgba(2, 8, 23, 0.14)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      alignItems: "center",
                      gap: 20,
                      rowGap: 12,
                    }}
                  >
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          color: UI.textMuted,
                          textTransform: "uppercase",
                          letterSpacing: "0.08em",
                        }}
                      >
                        Date range
                      </span>
                      <div
                        role="group"
                        aria-label="Date range"
                        style={{
                          display: "inline-flex",
                          padding: 3,
                          backgroundColor: UI.toolbarBg,
                          borderRadius: 8,
                          border: `1px solid ${UI.borderStrong}`,
                          gap: 2,
                        }}
                      >
                        {DATE_RANGE_OPTIONS.map((opt) => (
                          <button
                            key={opt.key}
                            type="button"
                            aria-pressed={dateRange === opt.key}
                            onClick={() => setDateRange(opt.key)}
                            style={toolbarSegmentStyle(dateRange === opt.key)}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <label
                        htmlFor="admin-event-type-filter"
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          color: UI.textMuted,
                          textTransform: "uppercase",
                          letterSpacing: "0.08em",
                        }}
                      >
                        Event type
                      </label>
                      <select
                        id="admin-event-type-filter"
                        value={eventTypeFilter}
                        onChange={(e) =>
                          setEventTypeFilter(e.target.value as EventTypeFilter)
                        }
                        style={{
                          minWidth: 200,
                          padding: "8px 12px",
                          fontSize: 13,
                          color: UI.inputText,
                          backgroundColor: UI.inputBg,
                          border: "1px solid rgba(226, 232, 240, 0.65)",
                          borderRadius: 8,
                          cursor: "pointer",
                          outline: "none",
                          boxShadow: "0 1px 2px rgba(2, 8, 23, 0.08)",
                        }}
                      >
                        {EVENT_TYPE_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div style={{ display: "flex", alignItems: "flex-end" }}>
                    <button
                      type="button"
                      onClick={handleExportCsv}
                      style={{
                        padding: "8px 14px",
                        fontSize: 13,
                        fontWeight: 600,
                        color: UI.inputText,
                        backgroundColor: UI.inputBg,
                        border: "1px solid rgba(226, 232, 240, 0.65)",
                        borderRadius: 8,
                        cursor: "pointer",
                        transition:
                          "background-color 0.15s ease, border-color 0.15s ease, opacity 0.15s ease",
                        boxShadow: "0 1px 2px rgba(2, 8, 23, 0.08)",
                      }}
                      onMouseDown={(e) => {
                        e.currentTarget.style.backgroundColor = "#E2E8F0";
                      }}
                      onMouseUp={(e) => {
                        e.currentTarget.style.backgroundColor = "#F8FAFC";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = "#F8FAFC";
                      }}
                    >
                      Export CSV
                    </button>
                  </div>
                </div>
              </Card>
            </div>
          ) : null}

          {/* OVERVIEW SECTION */}
          {loading ? (
            <div
              style={{
                display: "grid",
                gap: 16,
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                marginBottom: 32,
              }}
            >
              <StatSkeleton />
              <StatSkeleton />
              <StatSkeleton />
              <StatSkeleton />
            </div>
          ) : stats ? (
            <>
              <div style={{ marginBottom: 40 }}>
                <h2 style={sectionTitleStyle()}>Overview</h2>
                <div
                  style={{
                    display: "grid",
                    gap: 16,
                    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                  }}
                >
                  <StatCard
                    title="Total Users"
                    value={stats.totalUsers.toLocaleString()}
                    description={`${stats.activeUsers.toLocaleString()} with analytics activity (${dateRangeLabel(dateRange)})`}
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
                    value={safeDivideDisplay(stats.totalEvidence, stats.totalUsers, 1)}
                    description="Per registered user"
                    accent="#F59E0B"
                  />
                  <StatCard
                    title="Report Rate"
                    value={`${safeRatioPercent(stats.reportsGenerated, stats.totalEvidence)}%`}
                    description="Of evidence has reports"
                    accent="#8B5CF6"
                  />
                </div>
              </div>

              {/* ACTIVITY SECTION */}
              <div style={{ marginBottom: 40 }}>
                <h2 style={sectionTitleStyle()}>Activity</h2>

                {/* Trends */}
                <Card style={{ marginBottom: 16 }}>
                  <div style={subCardStyle()}>
                    <h3
                      style={{
                        margin: "0 0 20px 0",
                        fontSize: 15,
                        fontWeight: 700,
                        color: UI.textPrimary,
                      }}
                    >
                      Trends ({dateRangeLabel(dateRange)})
                    </h3>

                    {trends.length ? (
                      <div
                        style={{
                          display: "grid",
                          gap: 16,
                          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                        }}
                      >
                        {trends.map((point) => (
                          <div
                            key={point.date}
                            style={{
                              border: `1px solid ${UI.borderStrong}`,
                              borderRadius: 16,
                              padding: 16,
                              backgroundColor: UI.innerPanelBg,
                              transition: "all 0.2s",
                              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.02)",
                            }}
                          >
                            <div
                              style={{
                                fontSize: 12,
                                color: UI.textMuted,
                                fontWeight: 700,
                                marginBottom: 12,
                              }}
                            >
                              {formatDisplayTimestamp(
                                point.date.length <= 10 && !point.date.includes("T")
                                  ? `${point.date}T12:00:00`
                                  : point.date
                              )}
                            </div>

                            <div style={{ marginBottom: 10 }}>
                              <div
                                style={{
                                  fontSize: 12,
                                  color: UI.textSecondary,
                                  marginBottom: 6,
                                  fontWeight: 600,
                                }}
                              >
                                {trendPrimaryMetricLabel}
                              </div>
                              <div
                                style={{
                                  fontSize: 18,
                                  fontWeight: 800,
                                  color: "#93C5FD",
                                  marginBottom: 8,
                                }}
                              >
                                {point.pageViews.toLocaleString()}
                              </div>
                              {renderMiniBar(point.pageViews, trendMax, "#3B82F6")}
                            </div>

                            <div style={{ marginTop: 12 }}>
                              <div
                                style={{
                                  fontSize: 12,
                                  color: UI.textSecondary,
                                  marginBottom: 6,
                                  fontWeight: 600,
                                }}
                              >
                                Sessions
                              </div>
                              <div
                                style={{
                                  fontSize: 18,
                                  fontWeight: 800,
                                  color: "#6EE7B7",
                                  marginBottom: 8,
                                }}
                              >
                                {point.sessions.toLocaleString()}
                              </div>
                              {renderMiniBar(point.sessions, trendMax, "#10B981")}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div
                        style={{
                          padding: 24,
                          textAlign: "center",
                          color: UI.emptyText,
                        }}
                      >
                        <p style={{ margin: 0 }}>No trend data yet.</p>
                      </div>
                    )}
                  </div>
                </Card>

                {/* Top Pages */}
                <Card>
                  <div style={subCardStyle()}>
                    <h3
                      style={{
                        margin: "0 0 20px 0",
                        fontSize: 15,
                        fontWeight: 700,
                        color: UI.textPrimary,
                      }}
                    >
                      Top Pages
                    </h3>

                    {pages.length ? (
                      <div style={{ display: "grid", gap: 12 }}>
                        {pages.slice(0, 10).map((item, idx) => (
                          <div
                            key={`page-${item.path ?? "unknown"}`}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 12,
                              paddingBottom: 12,
                              borderBottom:
                                idx < pages.length - 1 ? `1px solid ${UI.border}` : "none",
                            }}
                          >
                            <div
                              style={{
                                width: 28,
                                height: 28,
                                borderRadius: 6,
                                backgroundColor: "rgba(59, 130, 246, 0.16)",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                fontSize: 12,
                                fontWeight: 700,
                                color: "#93C5FD",
                              }}
                            >
                              {idx + 1}
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div
                                style={{
                                  fontSize: 13,
                                  fontWeight: 600,
                                  color: UI.textPrimary,
                                  wordBreak: "break-word",
                                  marginBottom: 2,
                                }}
                              >
                                {item.path ?? "Unknown"}
                              </div>
                              <div
                                style={{
                                  fontSize: 12,
                                  color: UI.textSecondary,
                                }}
                              >
                                {item.views.toLocaleString()} views
                              </div>
                            </div>
                            <div
                              style={{
                                fontSize: 14,
                                fontWeight: 700,
                                color: UI.textPrimary,
                                whiteSpace: "nowrap",
                              }}
                            >
                              {item.views.toLocaleString()}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div
                        style={{
                          padding: 24,
                          textAlign: "center",
                          color: UI.emptyText,
                        }}
                      >
                        <p style={{ margin: 0 }}>No page analytics yet.</p>
                      </div>
                    )}
                  </div>
                </Card>
              </div>

              {/* FUNNEL SECTION */}
              <div style={{ marginBottom: 40 }}>
                <h2 style={sectionTitleStyle()}>Funnel</h2>
                <Card>
                  <div style={subCardStyle()}>
                    <h3
                      style={{
                        margin: "0 0 20px 0",
                        fontSize: 15,
                        fontWeight: 700,
                        color: UI.textPrimary,
                      }}
                    >
                      Product Funnel
                    </h3>

                    {funnel.length ? (
                      <div style={{ display: "grid", gap: 16 }}>
                        {funnel.map((step, idx) => (
                          <div key={step.key}>
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                marginBottom: 8,
                              }}
                            >
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 10,
                                }}
                              >
                                <div
                                  style={{
                                    width: 32,
                                    height: 32,
                                    borderRadius: 8,
                                    backgroundColor: "rgba(245, 158, 11, 0.18)",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    fontSize: 13,
                                    fontWeight: 700,
                                    color: "#FCD34D",
                                  }}
                                >
                                  {idx + 1}
                                </div>
                                <div>
                                  <div
                                    style={{
                                      fontSize: 13,
                                      fontWeight: 600,
                                      color: UI.textPrimary,
                                    }}
                                  >
                                    {step.label}
                                  </div>
                                </div>
                              </div>
                              <div
                                style={{
                                  fontSize: 13,
                                  fontWeight: 700,
                                  color: UI.textPrimary,
                                }}
                              >
                                {step.count.toLocaleString()}
                              </div>
                            </div>
                            {renderMiniBar(step.count, funnelMax, "#F59E0B")}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div
                        style={{
                          padding: 24,
                          textAlign: "center",
                          color: UI.emptyText,
                        }}
                      >
                        <p style={{ margin: 0 }}>No funnel data yet.</p>
                      </div>
                    )}
                  </div>
                </Card>
              </div>

              {/* GEOGRAPHY SECTION */}
              <div style={{ marginBottom: 40 }}>
                <h2 style={sectionTitleStyle()}>Geography</h2>
                <div
                  style={{
                    display: "grid",
                    gap: 16,
                    gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
                  }}
                >
                  {/* Countries */}
                  <Card>
                    <div style={subCardStyle()}>
                      <h3
                        style={{
                          margin: "0 0 20px 0",
                          fontSize: 14,
                          fontWeight: 700,
                          color: UI.textPrimary,
                        }}
                      >
                        Top Countries
                      </h3>

                      {geo?.countries?.length ? (
                        <div style={{ display: "grid", gap: 10 }}>
                          {geo.countries.slice(0, 8).map((item, idx) => (
                            <div
                              key={`country-${item.name ?? "unknown"}`}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 12,
                                paddingBottom: 10,
                                borderBottom:
                                  idx < Math.min(geo.countries.length, 8) - 1
                                    ? `1px solid ${UI.border}`
                                    : "none",
                              }}
                            >
                              <div
                                style={{
                                  width: 28,
                                  height: 28,
                                  borderRadius: 6,
                                  backgroundColor: "rgba(14, 165, 233, 0.16)",
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  fontSize: 11,
                                  fontWeight: 700,
                                  color: "#7DD3FC",
                                }}
                              >
                                {idx + 1}
                              </div>
                              <div style={{ flex: 1 }}>
                                <div
                                  style={{
                                    fontSize: 13,
                                    fontWeight: 600,
                                    color: UI.textPrimary,
                                  }}
                                >
                                  {item.name ?? "Unknown"}
                                </div>
                              </div>
                              <div
                                style={{
                                  fontSize: 12,
                                  fontWeight: 700,
                                  color: UI.textSecondary,
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {item.count.toLocaleString()}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div
                          style={{
                            padding: 24,
                            textAlign: "center",
                            color: UI.emptyText,
                            fontSize: 13,
                          }}
                        >
                          No country data yet.
                        </div>
                      )}
                    </div>
                  </Card>

                  {/* Cities */}
                  <Card>
                    <div style={subCardStyle()}>
                      <h3
                        style={{
                          margin: "0 0 20px 0",
                          fontSize: 14,
                          fontWeight: 700,
                          color: UI.textPrimary,
                        }}
                      >
                        Top Cities
                      </h3>

                      {geo?.cities?.length ? (
                        <div style={{ display: "grid", gap: 10 }}>
                          {geo.cities.slice(0, 8).map((item, idx) => (
                            <div
                              key={`city-${item.name ?? "unknown"}`}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 12,
                                paddingBottom: 10,
                                borderBottom:
                                  idx < Math.min(geo.cities.length, 8) - 1
                                    ? `1px solid ${UI.border}`
                                    : "none",
                              }}
                            >
                              <div
                                style={{
                                  width: 28,
                                  height: 28,
                                  borderRadius: 6,
                                  backgroundColor: "rgba(96, 165, 250, 0.16)",
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  fontSize: 11,
                                  fontWeight: 700,
                                  color: "#93C5FD",
                                }}
                              >
                                {idx + 1}
                              </div>
                              <div style={{ flex: 1 }}>
                                <div
                                  style={{
                                    fontSize: 13,
                                    fontWeight: 600,
                                    color: UI.textPrimary,
                                  }}
                                >
                                  {item.name ?? "Unknown"}
                                </div>
                              </div>
                              <div
                                style={{
                                  fontSize: 12,
                                  fontWeight: 700,
                                  color: UI.textSecondary,
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {item.count.toLocaleString()}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div
                          style={{
                            padding: 24,
                            textAlign: "center",
                            color: UI.emptyText,
                            fontSize: 13,
                          }}
                        >
                          No city data yet.
                        </div>
                      )}
                    </div>
                  </Card>
                </div>
              </div>

              {/* RECENT EVENTS SECTION */}
              <div style={{ marginBottom: 40 }}>
                <h2 style={sectionTitleStyle()}>Recent Activity</h2>
                <Card>
                  <div style={subCardStyle()}>
                    <h3
                      style={{
                        margin: "0 0 20px 0",
                        fontSize: 15,
                        fontWeight: 700,
                        color: UI.textPrimary,
                      }}
                    >
                      Latest Events
                    </h3>

                    {recent.length ? (
                      <div style={{ display: "grid", gap: 1 }}>
                        {recent.slice(0, 20).map((item, index, arr) => (
                          <div
                            key={`${item.eventType}-${item.createdAt}-${index}`}
                            style={{
                              display: "grid",
                              gridTemplateColumns: "120px 1fr auto",
                              gap: 16,
                              alignItems: "center",
                              padding: "12px 0",
                              borderBottom:
                                index < arr.length - 1 ? `1px solid ${UI.border}` : "none",
                            }}
                          >
                            <div
                              style={{
                                fontSize: 12,
                                fontWeight: 700,
                                color: "#93C5FD",
                                textTransform: "capitalize",
                                wordBreak: "break-word",
                              }}
                            >
                              {item.eventType}
                            </div>
                            <div style={{ minWidth: 0 }}>
                              <div
                                style={{
                                  fontSize: 12,
                                  color: UI.textPrimary,
                                  fontWeight: 600,
                                  wordBreak: "break-word",
                                  marginBottom: 2,
                                }}
                              >
                                {item.path ?? "No path"}
                              </div>
                              <div
                                style={{
                                  fontSize: 11,
                                  color: UI.textSecondary,
                                  marginBottom: 2,
                                }}
                              >
                                user: {item.userId ?? "—"}
                              </div>
                              <div
                                style={{
                                  fontSize: 11,
                                  color: UI.textMuted,
                                }}
                              >
                                {item.city ?? item.country ?? "Unknown location"}
                              </div>
                            </div>
                            <div
                              style={{
                                fontSize: 11,
                                color: UI.textSecondary,
                                whiteSpace: "nowrap",
                              }}
                            >
                              {formatDisplayTimestamp(item.createdAt)}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div
                        style={{
                          padding: 24,
                          textAlign: "center",
                          color: UI.emptyText,
                        }}
                      >
                        <p style={{ margin: 0 }}>No recent activity yet.</p>
                      </div>
                    )}
                  </div>
                </Card>
              </div>

              {/* SUBSCRIPTION & EVIDENCE BREAKDOWN */}
              <div style={{ marginBottom: 40 }}>
                <h2 style={sectionTitleStyle()}>Breakdown</h2>
                <div
                  style={{
                    display: "grid",
                    gap: 16,
                    gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
                  }}
                >
                  {/* Subscription */}
                  <Card>
                    <div style={subCardStyle()}>
                      <h3
                        style={{
                          margin: "0 0 20px 0",
                          fontSize: 14,
                          fontWeight: 700,
                          color: UI.textPrimary,
                        }}
                      >
                        Subscription Plans
                      </h3>
                      <div style={{ display: "grid", gap: 14 }}>
                        {[
                          {
                            label: "Free Plan",
                            value: stats.subscriptionBreakdown.free,
                            textColor: "#38BDF8",
                          },
                          {
                            label: "Pay-Per-Evidence",
                            value: stats.subscriptionBreakdown.payg,
                            textColor: "#22C55E",
                          },
                          {
                            label: "Pro Plan",
                            value: stats.subscriptionBreakdown.pro,
                            textColor: "#F59E0B",
                          },
                          {
                            label: "Team Plan",
                            value: stats.subscriptionBreakdown.team,
                            textColor: "#EF4444",
                          },
                        ].map((plan) => (
                          <div key={plan.label}>
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                marginBottom: 6,
                              }}
                            >
                              <div
                                style={{
                                  fontSize: 12,
                                  fontWeight: 600,
                                  color: UI.textPrimary,
                                }}
                              >
                                {plan.label}
                              </div>
                              <div
                                style={{
                                  fontSize: 12,
                                  fontWeight: 700,
                                  color: UI.textPrimary,
                                }}
                              >
                                {safeRatioPercent(plan.value, stats.totalUsers)}%
                              </div>
                            </div>
                            <ProgressBar
                              value={plan.value}
                              maxValue={stats.totalUsers}
                              color={plan.textColor}
                              height={6}
                            />
                            <div
                              style={{
                                fontSize: 11,
                                color: UI.textSecondary,
                                marginTop: 4,
                              }}
                            >
                              {plan.value.toLocaleString()} users
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </Card>

                  {/* Evidence Type */}
                  <Card>
                    <div style={subCardStyle()}>
                      <h3
                        style={{
                          margin: "0 0 20px 0",
                          fontSize: 14,
                          fontWeight: 700,
                          color: UI.textPrimary,
                        }}
                      >
                        Evidence by Type
                      </h3>
                      <div style={{ display: "grid", gap: 14 }}>
                        {[
                          { label: "Photos", value: stats.evidenceByType.photos, color: "#3B82F6" },
                          { label: "Videos", value: stats.evidenceByType.videos, color: "#10B981" },
                          { label: "Documents", value: stats.evidenceByType.documents, color: "#F59E0B" },
                          { label: "Other", value: stats.evidenceByType.other, color: "#8B5CF6" },
                        ].map((type) => (
                          <div key={type.label}>
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                marginBottom: 6,
                              }}
                            >
                              <div
                                style={{
                                  fontSize: 12,
                                  fontWeight: 600,
                                  color: UI.textPrimary,
                                }}
                              >
                                {type.label}
                              </div>
                              <div
                                style={{
                                  fontSize: 12,
                                  fontWeight: 700,
                                  color: UI.textPrimary,
                                }}
                              >
                                {safeRatioPercent(type.value, stats.totalEvidence)}%
                              </div>
                            </div>
                            <ProgressBar
                              value={type.value}
                              maxValue={stats.totalEvidence}
                              color={type.color}
                              height={6}
                            />
                            <div
                              style={{
                                fontSize: 11,
                                color: UI.textSecondary,
                                marginTop: 4,
                              }}
                            >
                              {type.value.toLocaleString()} items
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </Card>
                </div>
              </div>

              {/* Admin audit trail + integrity */}
              <div style={{ marginBottom: 40 }}>
                <h2 style={sectionTitleStyle()}>Admin Audit</h2>
                <Card style={{ marginBottom: 16 }}>
                  <div style={subCardStyle()}>
                    <h3
                      style={{
                        margin: "0 0 12px 0",
                        fontSize: 15,
                        fontWeight: 700,
                        color: UI.textPrimary,
                      }}
                    >
                      Audit Integrity Status
                    </h3>
                    {chainVerify === null ? (
                      <div style={{ fontSize: 13, color: UI.textSecondary }}>
                        Verification not available yet.
                      </div>
                    ) : chainVerify.valid ? (
                      <div style={{ fontSize: 14, fontWeight: 700, color: UI.successText }}>
                        ✅ Valid chain
                      </div>
                    ) : (
                      <div style={{ fontSize: 14, fontWeight: 700, color: "#FCA5A5" }}>
                        ❌ Tampering detected
                        <div
                          style={{
                            marginTop: 8,
                            fontSize: 12,
                            fontWeight: 500,
                            color: UI.textSecondary,
                            fontFamily: "ui-monospace, monospace",
                            wordBreak: "break-word",
                          }}
                        >
                          brokenAt: {chainVerify.brokenAt}
                        </div>
                      </div>
                    )}
                  </div>
                </Card>
                <Card>
                  <div style={subCardStyle()}>
                    <h3
                      style={{
                        margin: "0 0 20px 0",
                        fontSize: 15,
                        fontWeight: 700,
                        color: UI.textPrimary,
                      }}
                    >
                      Recent Admin Actions
                    </h3>

                    {auditLogsLoading ? (
                      <div
                        style={{
                          padding: 12,
                          textAlign: "center",
                          color: UI.emptyText,
                          fontSize: 13,
                        }}
                      >
                        Loading audit log…
                      </div>
                    ) : auditLogItems.length ? (
                      <div style={{ display: "grid", gap: 1 }}>
                        {auditLogItems.slice(0, 10).map((entry, index, arr) => (
                          <div
                            key={entry.id}
                            style={{
                              display: "grid",
                              gridTemplateColumns: "1fr minmax(120px, auto)",
                              gap: 12,
                              alignItems: "start",
                              padding: "12px 0",
                              borderBottom:
                                index < arr.length - 1 ? `1px solid ${UI.border}` : "none",
                            }}
                          >
                            <div style={{ minWidth: 0 }}>
                              <div
                                style={{
                                  fontSize: 12,
                                  fontWeight: 700,
                                  color: UI.textPrimary,
                                  wordBreak: "break-word",
                                  marginBottom: 4,
                                }}
                              >
                                {entry.action}
                              </div>
                              <div
                                style={{
                                  fontSize: 10,
                                  color: UI.textMuted,
                                  marginBottom: 6,
                                }}
                              >
                                user: {formatAuditActor(entry.userId, entry.isPublic)}
                              </div>
                              <pre
                                style={{
                                  fontSize: 11,
                                  color: UI.textSecondary,
                                  fontFamily: "ui-monospace, monospace",
                                  wordBreak: "break-word",
                                  lineHeight: 1.4,
                                  margin: 0,
                                  whiteSpace: "pre-wrap",
                                }}
                              >
                                {prettyMetadataJson(entry.metadata)}
                              </pre>
                            </div>
                            <div
                              style={{
                                fontSize: 11,
                                color: UI.textSecondary,
                                whiteSpace: "nowrap",
                                textAlign: "right",
                              }}
                            >
                              {formatDisplayTimestamp(entry.createdAt)}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div
                        style={{
                          padding: 12,
                          textAlign: "center",
                          color: UI.emptyText,
                          fontSize: 13,
                        }}
                      >
                        No audit log entries yet.
                      </div>
                    )}
                  </div>
                </Card>
              </div>

              {/* System Status */}
              <div>
                <Card>
                  <div style={subCardStyle()}>
                    <h3
                      style={{
                        margin: "0 0 16px 0",
                        fontSize: 15,
                        fontWeight: 700,
                        color: UI.textPrimary,
                      }}
                    >
                      System Status
                    </h3>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                        gap: 16,
                      }}
                    >
                      <div>
                        <div style={{ fontSize: 12, color: UI.textMuted, marginBottom: 6 }}>
                          API Version
                        </div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: UI.textPrimary }}>
                          v1
                        </div>
                      </div>
                      <div>
                        <div style={{ fontSize: 12, color: UI.textMuted, marginBottom: 6 }}>
                          Database
                        </div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: UI.textPrimary }}>
                          PostgreSQL
                        </div>
                      </div>
                      <div>
                        <div style={{ fontSize: 12, color: UI.textMuted, marginBottom: 6 }}>
                          Status
                        </div>
                        <div
                          style={{
                            fontSize: 13,
                            fontWeight: 700,
                            color: UI.success,
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                          }}
                        >
                          <span
                            style={{
                              width: 8,
                              height: 8,
                              borderRadius: 999,
                              backgroundColor: UI.success,
                              boxShadow: "0 0 12px rgba(52, 211, 153, 0.7)",
                            }}
                          />
                          Healthy
                        </div>
                      </div>
                      <div>
                        <div style={{ fontSize: 12, color: UI.textMuted, marginBottom: 6 }}>
                          Last Updated
                        </div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: UI.textPrimary }}>
                          {lastSuccessfulFetchAt
                            ? formatDisplayTimestamp(lastSuccessfulFetchAt)
                            : "—"}
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
