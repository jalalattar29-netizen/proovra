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
}

interface GeoItem {
  name: string | null;
  count: number;
  share?: number;
  countryCode?: string | null;
  normalized?: string | null;
}

interface GeographyResponse {
  total?: number;
  countries: GeoItem[];
  cities: GeoItem[];
}

interface TopPage {
  path: string | null;
  routeType?: string | null;
  views: number;
  share?: number;
}

interface RecentEvent {
  eventType: string;
  label?: string;
  eventClass?: string | null;
  routeType?: string | null;
  severity?: string | null;
  path: string | null;
  country: string | null;
  countryCode?: string | null;
  city: string | null;
  cityNormalized?: string | null;
  createdAt: string;
  sessionId?: string | null;
  userId?: string | null;
}

interface TrendPoint {
  date: string;
  pageViews: number;
  sessions: number;
  eventType?: string | null;
}

interface FunnelStep {
  key: string;
  label: string;
  count: number;
  conversionFromPrevious: number | null;
  dropOffFromPrevious: number | null;
}

interface StatCardProps {
  title: string;
  value: string | number;
  description: string;
  accent?: string;
}

interface AuditLogRow {
  id: string;
  userId: string | null;
  isPublic: boolean;
  action: string;
  category?: string | null;
  severity?: string | null;
  source?: string | null;
  outcome?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  requestId?: string | null;
  metadata: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  hash: string;
  prevHash: string | null;
  chainVersion?: number;
  createdAt: string;
  anchoredAt: string | null;
}

type DateRangeKey = "24h" | "7d" | "30d";

type EventTypeFilter =
  | "all"
  | "page_view"
  | "login_completed"
  | "evidence_created"
  | "report_generated";

type RouteTypeFilter =
  | "all"
  | "public"
  | "app"
  | "admin"
  | "auth"
  | "api"
  | "unknown";

const DATE_RANGE_OPTIONS: { key: DateRangeKey; label: string }[] = [
  { key: "24h", label: "Last 24 hours" },
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
];

const EVENT_TYPE_OPTIONS: { value: EventTypeFilter; label: string }[] = [
  { value: "all", label: "All events" },
  { value: "page_view", label: "Page View" },
  { value: "login_completed", label: "Login Completed" },
  { value: "evidence_created", label: "Evidence Created" },
  { value: "report_generated", label: "Report Generated" },
];

const ROUTE_TYPE_OPTIONS: { value: RouteTypeFilter; label: string }[] = [
  { value: "all", label: "All routes" },
  { value: "public", label: "Public" },
  { value: "app", label: "App" },
  { value: "admin", label: "Admin" },
  { value: "auth", label: "Auth" },
  { value: "api", label: "API" },
  { value: "unknown", label: "Unknown" },
];

const UI = {
  pageBg: "transparent",
  cardBgStrong: "rgba(5, 20, 48, 0.84)",
  innerPanelBg: "rgba(9, 28, 62, 0.82)",
  border: "rgba(96, 165, 250, 0.18)",
  borderStrong: "rgba(148, 163, 184, 0.22)",
  textPrimary: "#F8FAFC",
  textSecondary: "#CBD5E1",
  textMuted: "#94A3B8",
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
  return DATE_RANGE_OPTIONS.find((o) => o.key === range)?.label ?? "Selected range";
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

function humanizeKey(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function shortId(value: string | null | undefined): string {
  if (!value) return "—";
  if (value.length <= 12) return value;
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function escapeCsvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function buildAnalyticsCsv(rows: RecentEvent[]): string {
  const header = [
    "eventLabel",
    "eventType",
    "routeType",
    "createdAt",
    "userId",
    "country",
    "city",
    "path",
  ];

  const lines = [
    header.join(","),
    ...rows.map((row) =>
      [
        escapeCsvCell(row.label ?? humanizeKey(row.eventType)),
        escapeCsvCell(row.eventType),
        escapeCsvCell(row.routeType ?? ""),
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

function exportFilenameForToday(prefix: string): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${prefix}_${y}-${m}-${d}.csv`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function httpStatusFromUnknownError(err: unknown): number | undefined {
  if (err instanceof ApiError) return err.statusCode;
  if (isRecord(err) && typeof err.statusCode === "number") return err.statusCode;
  return undefined;
}

function buildAnalyticsQuery(params: {
  dateRange: DateRangeKey;
  eventType: EventTypeFilter;
  routeType: RouteTypeFilter;
  path: string | null;
  countryCode: string | null;
  city: string | null;
}): string {
  const qs = new URLSearchParams();
  qs.set("dateRange", params.dateRange);
  if (params.eventType !== "all") qs.set("eventType", params.eventType);
  if (params.routeType !== "all") qs.set("routeType", params.routeType);
  if (params.path) qs.set("path", params.path);
  if (params.countryCode) qs.set("countryCode", params.countryCode);
  if (params.city) qs.set("city", params.city);
  const value = qs.toString();
  return value ? `?${value}` : "";
}

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

function formatAuditActor(userId: string | null, isPublic: boolean): string {
  if (isPublic || userId === null) return "Public / system";
  return shortId(userId);
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

function badgeStyle(color: string, bg: string): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 8px",
    fontSize: 11,
    fontWeight: 700,
    borderRadius: 999,
    color,
    background: bg,
    whiteSpace: "nowrap",
  };
}

function routeTypeBadge(routeType: string | null | undefined): JSX.Element {
  const value = routeType ?? "unknown";
  const styles: Record<string, CSSProperties> = {
    public: badgeStyle("#93C5FD", "rgba(59,130,246,0.16)"),
    app: badgeStyle("#6EE7B7", "rgba(16,185,129,0.16)"),
    admin: badgeStyle("#FCD34D", "rgba(245,158,11,0.18)"),
    auth: badgeStyle("#C4B5FD", "rgba(139,92,246,0.18)"),
    api: badgeStyle("#F9A8D4", "rgba(236,72,153,0.18)"),
    unknown: badgeStyle("#CBD5E1", "rgba(148,163,184,0.18)"),
  };
  return <span style={styles[value] ?? styles.unknown}>{humanizeKey(value)}</span>;
}

function severityBadge(severity: string | null | undefined): JSX.Element {
  const value = severity ?? "info";
  const styles: Record<string, CSSProperties> = {
    info: badgeStyle("#93C5FD", "rgba(59,130,246,0.16)"),
    warning: badgeStyle("#FCD34D", "rgba(245,158,11,0.18)"),
    critical: badgeStyle("#FCA5A5", "rgba(239,68,68,0.18)"),
  };
  return <span style={styles[value] ?? styles.info}>{humanizeKey(value)}</span>;
}

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

function renderMiniBar(value: number, maxValue: number, color: string): JSX.Element {
  return <ProgressBar value={value} maxValue={maxValue} color={color} height={8} />;
}

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
    typeof value.registeredUsers === "number" &&
    typeof value.guestUsers === "number" &&
    typeof value.activeUsers === "number" &&
    typeof value.usersWithEvidence === "number" &&
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
  return (
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
  if (!isRecord(value)) return false;
  return (
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
  return Math.max(1, ...points.flatMap((point) => [point.pageViews, point.sessions]));
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
  const [auditCursor, setAuditCursor] = useState<string | null>(null);
  const [chainVerify, setChainVerify] = useState<
    | { valid: true; partial?: boolean; verifiedCount?: number }
    | { valid: false; brokenAt: string }
    | null
  >(null);

  const [dateRange, setDateRange] = useState<DateRangeKey>("7d");
  const [eventTypeFilter, setEventTypeFilter] = useState<EventTypeFilter>("all");
  const [routeTypeFilter, setRouteTypeFilter] = useState<RouteTypeFilter>("all");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedCountryCode, setSelectedCountryCode] = useState<string | null>(null);
  const [selectedCity, setSelectedCity] = useState<string | null>(null);

  const [auditAction, setAuditAction] = useState("");
  const [auditCategory, setAuditCategory] = useState("");
  const [auditSeverity, setAuditSeverity] = useState("");
  const [auditOutcome, setAuditOutcome] = useState("");
  const [auditSearch, setAuditSearch] = useState("");

  const isAdminRole = user?.role === "admin";
  const lastAuditedFilters = useRef<{
    dateRange: DateRangeKey;
    eventType: EventTypeFilter;
    routeType: RouteTypeFilter;
  } | null>(null);
  const refreshAuditLogsRef = useRef<
    ((cursor?: string | null) => Promise<void>) | null
  >(null);
  const hasMountedAuditFiltersRef = useRef(false);

  const trendMax = useMemo(() => maxTrendValue(trends), [trends]);

const primaryInsight = useMemo(() => {
  if (!stats) return null;
  return {
    activeRate: safeRatioPercent(stats.activeUsers, stats.registeredUsers),
    reportRate: safeRatioPercent(stats.reportsGenerated, stats.totalEvidence),
  };
}, [stats]);

  const funnelInsight = useMemo(() => {
    const second = funnel[1];
    const third = funnel[2];
    const fourth = funnel[3];
    return {
      pageToLogin: second?.conversionFromPrevious ?? null,
      loginToEvidence: third?.conversionFromPrevious ?? null,
      evidenceToReport: fourth?.conversionFromPrevious ?? null,
    };
  }, [funnel]);

  const currentAnalyticsQuery = useMemo(
    () =>
      buildAnalyticsQuery({
        dateRange,
        eventType: eventTypeFilter,
        routeType: routeTypeFilter,
        path: selectedPath,
        countryCode: selectedCountryCode,
        city: selectedCity,
      }),
    [dateRange, eventTypeFilter, routeTypeFilter, selectedPath, selectedCountryCode, selectedCity]
  );

  const refreshAuditLogs = useCallback(
    async (cursor?: string | null) => {
      setAuditLogsLoading(true);
      try {
        const qs = new URLSearchParams();
        qs.set("limit", "20");
        if (cursor) qs.set("cursor", cursor);
        if (auditAction.trim()) qs.set("action", auditAction.trim());
        if (auditCategory.trim()) qs.set("category", auditCategory.trim());
        if (auditSeverity.trim()) qs.set("severity", auditSeverity.trim());
        if (auditOutcome.trim()) qs.set("outcome", auditOutcome.trim());
        if (auditSearch.trim()) qs.set("search", auditSearch.trim());

        const data = await apiFetch(`/v1/admin/audit-log?${qs.toString()}`, {
          method: "GET",
        });

        if (isRecord(data) && Array.isArray(data.items)) {
          const items = data.items as AuditLogRow[];

          setAuditLogItems((prev) => {
            if (!cursor) return items;

            const existingIds = new Set(prev.map((item) => item.id));
            const merged = [...prev];

            for (const item of items) {
              if (!existingIds.has(item.id)) {
                merged.push(item);
              }
            }

            return merged;
          });

          setAuditCursor(items.length ? items[items.length - 1]?.id ?? null : null);
        } else {
          if (!cursor) {
            setAuditLogItems([]);
          }
          setAuditCursor(null);
        }
      } catch {
        if (!cursor) {
          setAuditLogItems([]);
        }
        setAuditCursor(null);
      } finally {
        setAuditLogsLoading(false);
      }
    },
    [auditAction, auditCategory, auditSeverity, auditOutcome, auditSearch]
  );

  useEffect(() => {
    refreshAuditLogsRef.current = refreshAuditLogs;
  }, [refreshAuditLogs]);

  const refreshChainVerify = useCallback(async () => {
    try {
      const data = await apiFetch("/v1/admin/audit-log/verify?limit=1000", { method: "GET" });
      if (isRecord(data) && data.valid === true) {
        setChainVerify({
          valid: true,
          partial: typeof data.partial === "boolean" ? data.partial : undefined,
          verifiedCount:
            typeof data.verifiedCount === "number" ? data.verifiedCount : undefined,
        });
      } else if (isRecord(data) && data.valid === false) {
        const brokenAt = typeof data.brokenAt === "string" ? data.brokenAt : "unknown";
        setChainVerify({ valid: false, brokenAt });
      } else {
        setChainVerify(null);
      }
    } catch {
      setChainVerify(null);
    }
  }, []);

  const sendAuditLog = useCallback(
    async (
      action: string,
      metadata: Record<string, unknown>,
      extra?: {
        category?: string;
        severity?: "info" | "warning" | "critical";
        source?: string;
        outcome?: "success" | "failure" | "blocked";
        resourceType?: string;
        resourceId?: string;
      }
    ) => {
      if (!user?.id) return;
      try {
        await apiFetch("/v1/admin/audit-log", {
          method: "POST",
          body: JSON.stringify({
            action,
            category: extra?.category ?? "analytics",
            severity: extra?.severity ?? "info",
            source: extra?.source ?? "admin_console",
            outcome: extra?.outcome ?? "success",
            resourceType: extra?.resourceType ?? "analytics_dashboard",
            resourceId: extra?.resourceId,
            metadata,
          }),
        });
      } catch {
        /* do not block UI */
      }
    },
    [user?.id]
  );

  const handleExportCsv = () => {
    void sendAuditLog("admin.analytics.export_csv", {
      exportType: "analytics_csv",
      dateRange,
      eventType: eventTypeFilter,
      routeType: routeTypeFilter,
      path: selectedPath,
      countryCode: selectedCountryCode,
      city: selectedCity,
      rowCount: recent.length,
    });

    const csv = buildAnalyticsCsv(recent);
    triggerCsvDownload(csv, exportFilenameForToday("analytics_export"));
    addToast("Exported filtered analytics to CSV", "success");
  };

  const handleExportAuditCsv = async () => {
    try {
      const qs = new URLSearchParams();
      if (auditAction.trim()) qs.set("action", auditAction.trim());
      if (auditCategory.trim()) qs.set("category", auditCategory.trim());
      if (auditSeverity.trim()) qs.set("severity", auditSeverity.trim());
      if (auditOutcome.trim()) qs.set("outcome", auditOutcome.trim());
      if (auditSearch.trim()) qs.set("search", auditSearch.trim());

      const response = await fetch(`/api/proxy/v1/admin/audit-log/export?${qs.toString()}`);
      if (!response.ok) throw new Error("export_failed");
      const text = await response.text();
      triggerCsvDownload(text, exportFilenameForToday("admin_audit_export"));
      void sendAuditLog(
        "admin.audit.export_csv",
        {
          action: auditAction || null,
          category: auditCategory || null,
          severity: auditSeverity || null,
          outcome: auditOutcome || null,
          search: auditSearch || null,
        },
        { category: "audit", resourceType: "admin_audit" }
      );
      addToast("Exported audit log CSV", "success");
    } catch {
      addToast("Audit CSV export failed", "error");
    }
  };

  useEffect(() => {
    if (!authReady || !isAdminRole) return;
    void sendAuditLog(
      "admin.analytics.page_access",
      { surface: "admin_dashboard" },
      { category: "access", resourceType: "admin_dashboard" }
    );
  }, [authReady, isAdminRole, sendAuditLog]);

  useEffect(() => {
    if (!authReady) return;
    if (!isAdminRole) {
      lastAuditedFilters.current = null;
      return;
    }
    const prev = lastAuditedFilters.current;
    lastAuditedFilters.current = {
      dateRange,
      eventType: eventTypeFilter,
      routeType: routeTypeFilter,
    };
    if (!prev) return;
    if (
      prev.dateRange === dateRange &&
      prev.eventType === eventTypeFilter &&
      prev.routeType === routeTypeFilter
    ) {
      return;
    }
    void sendAuditLog(
      "admin.analytics.filter_change",
      {
        dateRange,
        eventType: eventTypeFilter,
        routeType: routeTypeFilter,
        previousDateRange: prev.dateRange,
        previousEventType: prev.eventType,
        previousRouteType: prev.routeType,
      },
      { category: "analytics", resourceType: "analytics_dashboard" }
    );
  }, [authReady, isAdminRole, dateRange, eventTypeFilter, routeTypeFilter, sendAuditLog]);

  useEffect(() => {
    if (!authReady || !isAdminRole) return;
    void refreshAuditLogsRef.current?.(null);
    void refreshChainVerify();
  }, [authReady, isAdminRole, refreshChainVerify]);

  useEffect(() => {
    if (!authReady || !isAdminRole) return;

    if (!hasMountedAuditFiltersRef.current) {
      hasMountedAuditFiltersRef.current = true;
      return;
    }

    void refreshAuditLogs(null);
  }, [
    authReady,
    isAdminRole,
    auditAction,
    auditCategory,
    auditSeverity,
    auditOutcome,
    auditSearch,
    refreshAuditLogs,
  ]);

  useEffect(() => {
    if (!authReady) return;
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
      setGeo(
        isValidGeographyResponse(geographyResponse)
          ? geographyResponse
          : { countries: [], cities: [] }
      );
      setPages(isValidTopPages(pagesResponse) ? pagesResponse : []);
      setRecent(isValidRecentEvents(recentResponse) ? recentResponse : []);
      setTrends(isValidTrendPoints(trendsResponse) ? trendsResponse : []);
      setFunnel(isValidFunnel(funnelResponse) ? funnelResponse : []);

      return true;
    };

    const loadStats = async () => {
      setLoading(true);
      setError(null);

      try {
        const bundle = await tryFetchAdminDashboardBundle(currentAnalyticsQuery);
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
            apiFetchAdminAnalyticsGET("/v1/admin/analytics/summary", currentAnalyticsQuery),
            apiFetchAdminAnalyticsGET("/v1/admin/analytics/geography", currentAnalyticsQuery),
            apiFetchAdminAnalyticsGET("/v1/admin/analytics/pages", currentAnalyticsQuery),
            apiFetchAdminAnalyticsGET("/v1/admin/analytics/recent", currentAnalyticsQuery),
            apiFetchAdminAnalyticsGET("/v1/admin/analytics/trends", currentAnalyticsQuery),
            apiFetchAdminAnalyticsGET("/v1/admin/analytics/funnel", currentAnalyticsQuery),
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
          setError("Could not load analytics. Check your connection and admin permissions, then retry.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void loadStats();

    return () => {
      cancelled = true;
    };
  }, [authReady, isAdminRole, currentAnalyticsQuery, addToast]);

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
      <div className="app-hero app-hero-full" style={{ borderBottom: `1px solid ${UI.borderStrong}` }}>
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
                Analytics & Admin Audit
              </h1>
              <p
                className="page-subtitle pricing-subtitle"
                style={{
                  marginTop: 6,
                  fontSize: 15,
                  color: UI.textSecondary,
                }}
              >
                Operational analytics, funnel performance, and tamper-evident admin audit visibility
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="app-body app-body-full" style={{ paddingTop: 32, paddingBottom: 48 }}>
        <div className="container">
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
                        onChange={(e) => setEventTypeFilter(e.target.value as EventTypeFilter)}
                        style={{
                          minWidth: 190,
                          padding: "8px 12px",
                          fontSize: 13,
                          color: UI.inputText,
                          backgroundColor: UI.inputBg,
                          border: "1px solid rgba(226, 232, 240, 0.65)",
                          borderRadius: 8,
                          cursor: "pointer",
                          outline: "none",
                        }}
                      >
                        {EVENT_TYPE_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <label
                        htmlFor="admin-route-type-filter"
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          color: UI.textMuted,
                          textTransform: "uppercase",
                          letterSpacing: "0.08em",
                        }}
                      >
                        Route type
                      </label>
                      <select
                        id="admin-route-type-filter"
                        value={routeTypeFilter}
                        onChange={(e) => setRouteTypeFilter(e.target.value as RouteTypeFilter)}
                        style={{
                          minWidth: 160,
                          padding: "8px 12px",
                          fontSize: 13,
                          color: UI.inputText,
                          backgroundColor: UI.inputBg,
                          border: "1px solid rgba(226, 232, 240, 0.65)",
                          borderRadius: 8,
                          cursor: "pointer",
                          outline: "none",
                        }}
                      >
                        {ROUTE_TYPE_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedPath(null);
                        setSelectedCountryCode(null);
                        setSelectedCity(null);
                      }}
                      style={{
                        padding: "8px 14px",
                        fontSize: 13,
                        fontWeight: 600,
                        color: UI.inputText,
                        backgroundColor: UI.inputBg,
                        border: "1px solid rgba(226, 232, 240, 0.65)",
                        borderRadius: 8,
                        cursor: "pointer",
                      }}
                    >
                      Clear drilldown
                    </button>
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
                      }}
                    >
                      Export CSV
                    </button>
                  </div>
                </div>
              </Card>
            </div>
          ) : null}

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
              <div style={{ marginBottom: 18, display: "flex", flexWrap: "wrap", gap: 8 }}>
                {selectedPath ? (
                  <span style={badgeStyle("#F8FAFC", "rgba(148,163,184,0.18)")}>
                    Path drilldown: {selectedPath}
                  </span>
                ) : null}
                {selectedCountryCode ? (
                  <span style={badgeStyle("#F8FAFC", "rgba(148,163,184,0.18)")}>
                    Country: {selectedCountryCode}
                  </span>
                ) : null}
                {selectedCity ? (
                  <span style={badgeStyle("#F8FAFC", "rgba(148,163,184,0.18)")}>
                    City: {selectedCity}
                  </span>
                ) : null}
              </div>

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
    description={`${stats.registeredUsers.toLocaleString()} registered + ${stats.guestUsers.toLocaleString()} guest`}
    accent="#3B82F6"
  />

  <StatCard
    title="Registered Users"
    value={stats.registeredUsers.toLocaleString()}
    description={`${stats.activeUsers.toLocaleString()} active (${primaryInsight?.activeRate ?? "0.0"}% activity rate)`}
    accent="#06B6D4"
  />

  <StatCard
    title="Guest Users"
    value={stats.guestUsers.toLocaleString()}
    description="Anonymous / guest identities created in the system"
    accent="#64748B"
  />

  <StatCard
    title="Users With Evidence"
    value={stats.usersWithEvidence.toLocaleString()}
    description="Distinct owners with at least one non-deleted evidence item"
    accent="#A855F7"
  />

  <StatCard
    title="Total Evidence"
    value={stats.totalEvidence.toLocaleString()}
    description={`${stats.reportsGenerated.toLocaleString()} reports generated`}
    accent="#10B981"
  />

  <StatCard
    title="Avg Evidence / Registered User"
    value={safeDivideDisplay(stats.totalEvidence, stats.registeredUsers, 1)}
    description="Average evidence items per registered user"
    accent="#F59E0B"
  />

  <StatCard
    title="Report Rate"
    value={`${primaryInsight?.reportRate ?? "0.0"}%`}
    description="Share of evidence that reached report generation"
    accent="#8B5CF6"
  />
</div>
              </div>

              <div style={{ marginBottom: 40 }}>
                <h2 style={sectionTitleStyle()}>Activity</h2>

                <Card style={{ marginBottom: 16 }}>
                  <div style={subCardStyle()}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "flex-start",
                        gap: 16,
                        marginBottom: 20,
                      }}
                    >
                      <div>
                        <h3 style={{ margin: "0 0 8px 0", fontSize: 15, fontWeight: 700, color: UI.textPrimary }}>
                          Trends ({dateRangeLabel(dateRange)})
                        </h3>
                        <div style={{ color: UI.textSecondary, fontSize: 13 }}>
                          Session volume versus primary event count over time
                        </div>
                      </div>
                    </div>

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
                              <div style={{ fontSize: 12, color: UI.textSecondary, marginBottom: 6, fontWeight: 600 }}>
                                {eventTypeFilter === "all" ? "Page views" : humanizeKey(eventTypeFilter)}
                              </div>
                              <div style={{ fontSize: 18, fontWeight: 800, color: "#93C5FD", marginBottom: 8 }}>
                                {point.pageViews.toLocaleString()}
                              </div>
                              {renderMiniBar(point.pageViews, trendMax, "#3B82F6")}
                            </div>

                            <div style={{ marginTop: 12 }}>
                              <div style={{ fontSize: 12, color: UI.textSecondary, marginBottom: 6, fontWeight: 600 }}>
                                Sessions
                              </div>
                              <div style={{ fontSize: 18, fontWeight: 800, color: "#6EE7B7", marginBottom: 8 }}>
                                {point.sessions.toLocaleString()}
                              </div>
                              {renderMiniBar(point.sessions, trendMax, "#10B981")}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div style={{ padding: 24, textAlign: "center", color: UI.emptyText }}>
                        <p style={{ margin: 0 }}>No trend data yet.</p>
                      </div>
                    )}
                  </div>
                </Card>

                <Card>
                  <div style={subCardStyle()}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "flex-start",
                        gap: 16,
                        marginBottom: 20,
                      }}
                    >
                      <div>
                        <h3 style={{ margin: "0 0 8px 0", fontSize: 15, fontWeight: 700, color: UI.textPrimary }}>
                          Top Pages
                        </h3>
                        <div style={{ color: UI.textSecondary, fontSize: 13 }}>
                          Share of total page views, with route-type drilldown
                        </div>
                      </div>
                    </div>

                    {pages.length ? (
                      <div style={{ display: "grid", gap: 12 }}>
                        {pages.slice(0, 10).map((item, idx) => (
                          <button
                            key={`page-${item.path ?? "unknown"}-${item.routeType ?? "unknown"}-${idx}`}
                            type="button"
                            onClick={() => {
                              const nextPath = item.path ?? null;
                              setSelectedPath((prev) => (prev === nextPath ? null : nextPath));
                            }}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 12,
                              paddingBottom: 12,
                              paddingTop: 4,
                              border: "none",
                              background: "transparent",
                              borderBottom: idx < pages.length - 1 ? `1px solid ${UI.border}` : "none",
                              cursor: "pointer",
                              textAlign: "left",
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
                                flexShrink: 0,
                              }}
                            >
                              {idx + 1}
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 4 }}>
                                <div
                                  style={{
                                    fontSize: 13,
                                    fontWeight: 600,
                                    color: UI.textPrimary,
                                    wordBreak: "break-word",
                                  }}
                                >
                                  {item.path ?? "Unknown"}
                                </div>
                                {routeTypeBadge(item.routeType)}
                              </div>
                              <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                                <div style={{ fontSize: 12, color: UI.textSecondary }}>
                                  {item.views.toLocaleString()} views
                                </div>
                                <div style={{ fontSize: 12, color: UI.textMuted }}>
                                  {item.share?.toFixed(1) ?? "0.0"}% share
                                </div>
                              </div>
                              <div style={{ marginTop: 8 }}>
                                <ProgressBar
                                  value={item.share ?? 0}
                                  maxValue={100}
                                  color="#3B82F6"
                                  height={6}
                                />
                              </div>
                            </div>
                            <div style={{ fontSize: 14, fontWeight: 700, color: UI.textPrimary, whiteSpace: "nowrap" }}>
                              {item.share?.toFixed(1) ?? "0.0"}%
                            </div>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div style={{ padding: 24, textAlign: "center", color: UI.emptyText }}>
                        <p style={{ margin: 0 }}>No page analytics yet.</p>
                      </div>
                    )}
                  </div>
                </Card>
              </div>

              <div style={{ marginBottom: 40 }}>
                <h2 style={sectionTitleStyle()}>Funnel</h2>
                <Card>
                  <div style={subCardStyle()}>
                    <div style={{ marginBottom: 20 }}>
                      <h3 style={{ margin: "0 0 8px 0", fontSize: 15, fontWeight: 700, color: UI.textPrimary }}>
                        Product Funnel
                      </h3>
                      <div style={{ color: UI.textSecondary, fontSize: 13 }}>
                        Page → login {funnelInsight.pageToLogin ?? 0}% · login → evidence {funnelInsight.loginToEvidence ?? 0}% · evidence → report {funnelInsight.evidenceToReport ?? 0}%
                      </div>
                    </div>

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
                                gap: 12,
                              }}
                            >
                              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
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
                                  <div style={{ fontSize: 13, fontWeight: 600, color: UI.textPrimary }}>
                                    {step.label}
                                  </div>
                                  {idx > 0 ? (
                                    <div style={{ fontSize: 11, color: UI.textSecondary }}>
                                      Conversion {step.conversionFromPrevious?.toFixed(1) ?? "0.0"}% · Drop-off {step.dropOffFromPrevious?.toFixed(1) ?? "0.0"}%
                                    </div>
                                  ) : (
                                    <div style={{ fontSize: 11, color: UI.textSecondary }}>
                                      Entry step
                                    </div>
                                  )}
                                </div>
                              </div>
                              <div style={{ fontSize: 13, fontWeight: 700, color: UI.textPrimary }}>
                                {step.count.toLocaleString()}
                              </div>
                            </div>
                            {renderMiniBar(step.count, Math.max(1, funnel[0]?.count ?? 1), "#F59E0B")}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div style={{ padding: 24, textAlign: "center", color: UI.emptyText }}>
                        <p style={{ margin: 0 }}>No funnel data yet.</p>
                      </div>
                    )}
                  </div>
                </Card>
              </div>

              <div style={{ marginBottom: 40 }}>
                <h2 style={sectionTitleStyle()}>Geography</h2>
                <div
                  style={{
                    display: "grid",
                    gap: 16,
                    gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
                  }}
                >
                  <Card>
                    <div style={subCardStyle()}>
                      <h3 style={{ margin: "0 0 20px 0", fontSize: 14, fontWeight: 700, color: UI.textPrimary }}>
                        Top Countries
                      </h3>

                      {geo?.countries?.length ? (
                        <div style={{ display: "grid", gap: 10 }}>
                          {geo.countries.slice(0, 8).map((item, idx) => (
                            <button
                              key={`country-${item.name ?? "unknown"}`}
                              type="button"
                              onClick={() => {
                                const nextCountryCode = item.countryCode ?? null;
                                setSelectedCountryCode((prev) =>
                                  prev === nextCountryCode ? null : nextCountryCode
                                );
                              }}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 12,
                                paddingBottom: 10,
                                borderBottom:
                                  idx < Math.min(geo.countries.length, 8) - 1 ? `1px solid ${UI.border}` : "none",
                                borderTop: "none",
                                borderLeft: "none",
                                borderRight: "none",
                                background: "transparent",
                                cursor: "pointer",
                                textAlign: "left",
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
                                  flexShrink: 0,
                                }}
                              >
                                {idx + 1}
                              </div>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: 13, fontWeight: 600, color: UI.textPrimary }}>
                                  {item.name ?? "Unknown"}
                                </div>
                                <div style={{ fontSize: 11, color: UI.textSecondary }}>
                                  {item.countryCode ?? "—"} · {item.share?.toFixed(1) ?? "0.0"}% share
                                </div>
                                <div style={{ marginTop: 8 }}>
                                  <ProgressBar value={item.share ?? 0} maxValue={100} color="#0EA5E9" height={6} />
                                </div>
                              </div>
                              <div style={{ fontSize: 12, fontWeight: 700, color: UI.textSecondary, whiteSpace: "nowrap" }}>
                                {item.count.toLocaleString()}
                              </div>
                            </button>
                          ))}
                        </div>
                      ) : (
                        <div style={{ padding: 24, textAlign: "center", color: UI.emptyText, fontSize: 13 }}>
                          No country data yet.
                        </div>
                      )}
                    </div>
                  </Card>

                  <Card>
                    <div style={subCardStyle()}>
                      <h3 style={{ margin: "0 0 20px 0", fontSize: 14, fontWeight: 700, color: UI.textPrimary }}>
                        Top Cities
                      </h3>

                      {geo?.cities?.length ? (
                        <div style={{ display: "grid", gap: 10 }}>
                          {geo.cities.slice(0, 8).map((item, idx) => (
                            <button
                              key={`city-${item.name ?? "unknown"}`}
                              type="button"
                              onClick={() => {
                                const nextCity = item.normalized ?? item.name ?? null;
                                setSelectedCity((prev) => (prev === nextCity ? null : nextCity));
                              }}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 12,
                                paddingBottom: 10,
                                borderBottom:
                                  idx < Math.min(geo.cities.length, 8) - 1 ? `1px solid ${UI.border}` : "none",
                                borderTop: "none",
                                borderLeft: "none",
                                borderRight: "none",
                                background: "transparent",
                                cursor: "pointer",
                                textAlign: "left",
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
                                  flexShrink: 0,
                                }}
                              >
                                {idx + 1}
                              </div>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: 13, fontWeight: 600, color: UI.textPrimary }}>
                                  {item.name ?? "Unknown"}
                                </div>
                                <div style={{ fontSize: 11, color: UI.textSecondary }}>
                                  {item.share?.toFixed(1) ?? "0.0"}% share
                                </div>
                                <div style={{ marginTop: 8 }}>
                                  <ProgressBar value={item.share ?? 0} maxValue={100} color="#3B82F6" height={6} />
                                </div>
                              </div>
                              <div style={{ fontSize: 12, fontWeight: 700, color: UI.textSecondary, whiteSpace: "nowrap" }}>
                                {item.count.toLocaleString()}
                              </div>
                            </button>
                          ))}
                        </div>
                      ) : (
                        <div style={{ padding: 24, textAlign: "center", color: UI.emptyText, fontSize: 13 }}>
                          No city data yet.
                        </div>
                      )}
                    </div>
                  </Card>
                </div>
              </div>

              <div style={{ marginBottom: 40 }}>
                <h2 style={sectionTitleStyle()}>Recent Activity</h2>
                <Card>
                  <div style={subCardStyle()}>
                    <h3 style={{ margin: "0 0 20px 0", fontSize: 15, fontWeight: 700, color: UI.textPrimary }}>
                      Latest Events
                    </h3>

                    {recent.length ? (
                      <div style={{ display: "grid", gap: 1 }}>
                        {recent.slice(0, 20).map((item, index, arr) => (
                          <div
                            key={`${item.eventType}-${item.createdAt}-${index}`}
                            style={{
                              display: "grid",
                              gridTemplateColumns: "180px 1fr auto",
                              gap: 16,
                              alignItems: "start",
                              padding: "12px 0",
                              borderBottom: index < arr.length - 1 ? `1px solid ${UI.border}` : "none",
                            }}
                          >
                            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                              <div style={{ fontSize: 12, fontWeight: 700, color: "#93C5FD" }}>
                                {item.label ?? humanizeKey(item.eventType)}
                              </div>
                              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                {routeTypeBadge(item.routeType)}
                                {severityBadge(item.severity)}
                              </div>
                            </div>

                            <div style={{ minWidth: 0 }}>
                              <div
                                style={{
                                  fontSize: 12,
                                  color: UI.textPrimary,
                                  fontWeight: 600,
                                  wordBreak: "break-word",
                                  marginBottom: 4,
                                }}
                              >
                                {item.path ?? "No route path"}
                              </div>
                              <div style={{ fontSize: 11, color: UI.textSecondary, marginBottom: 4 }}>
                                Actor {shortId(item.userId)} · Session {shortId(item.sessionId)}
                              </div>
                              <div style={{ fontSize: 11, color: UI.textMuted }}>
                                {item.city ?? item.country ?? "Location unavailable"}
                              </div>
                            </div>

                            <div style={{ fontSize: 11, color: UI.textSecondary, whiteSpace: "nowrap" }}>
                              {formatDisplayTimestamp(item.createdAt)}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div style={{ padding: 24, textAlign: "center", color: UI.emptyText }}>
                        <p style={{ margin: 0 }}>No recent activity yet.</p>
                      </div>
                    )}
                  </div>
                </Card>
              </div>

              <div style={{ marginBottom: 40 }}>
                <h2 style={sectionTitleStyle()}>Breakdown</h2>
                <div
                  style={{
                    display: "grid",
                    gap: 16,
                    gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
                  }}
                >
                  <Card>
                    <div style={subCardStyle()}>
                      <h3 style={{ margin: "0 0 20px 0", fontSize: 14, fontWeight: 700, color: UI.textPrimary }}>
                        Subscription Plans
                      </h3>
                      <div style={{ display: "grid", gap: 14 }}>
                        {[
                          { label: "Free Plan", value: stats.subscriptionBreakdown.free, textColor: "#38BDF8" },
                          { label: "Pay-Per-Evidence", value: stats.subscriptionBreakdown.payg, textColor: "#22C55E" },
                          { label: "Pro Plan", value: stats.subscriptionBreakdown.pro, textColor: "#F59E0B" },
                          { label: "Team Plan", value: stats.subscriptionBreakdown.team, textColor: "#EF4444" },
                        ].map((plan) => (
                          <div key={plan.label}>
                            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                              <div style={{ fontSize: 12, fontWeight: 600, color: UI.textPrimary }}>
                                {plan.label}
                              </div>
                              <div style={{ fontSize: 12, fontWeight: 700, color: UI.textPrimary }}>
                                {safeRatioPercent(plan.value, stats.totalUsers)}%
                              </div>
                            </div>
                            <ProgressBar value={plan.value} maxValue={stats.totalUsers} color={plan.textColor} height={6} />
                            <div style={{ fontSize: 11, color: UI.textSecondary, marginTop: 4 }}>
                              {plan.value.toLocaleString()} users
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </Card>

                  <Card>
                    <div style={subCardStyle()}>
                      <h3 style={{ margin: "0 0 20px 0", fontSize: 14, fontWeight: 700, color: UI.textPrimary }}>
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
                            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                              <div style={{ fontSize: 12, fontWeight: 600, color: UI.textPrimary }}>
                                {type.label}
                              </div>
                              <div style={{ fontSize: 12, fontWeight: 700, color: UI.textPrimary }}>
                                {safeRatioPercent(type.value, stats.totalEvidence)}%
                              </div>
                            </div>
                            <ProgressBar value={type.value} maxValue={stats.totalEvidence} color={type.color} height={6} />
                            <div style={{ fontSize: 11, color: UI.textSecondary, marginTop: 4 }}>
                              {type.value.toLocaleString()} items
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </Card>
                </div>
              </div>

              <div style={{ marginBottom: 40 }}>
                <h2 style={sectionTitleStyle()}>Admin Audit</h2>

                <Card style={{ marginBottom: 16 }}>
                  <div style={subCardStyle()}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
                      <div>
                        <h3 style={{ margin: "0 0 12px 0", fontSize: 15, fontWeight: 700, color: UI.textPrimary }}>
                          Audit Integrity Status
                        </h3>
                        {chainVerify === null ? (
                          <div style={{ fontSize: 13, color: UI.textSecondary }}>Verification not available yet.</div>
                        ) : chainVerify.valid ? (
                          <div>
                            <div style={{ fontSize: 14, fontWeight: 700, color: UI.successText }}>
                              ✅ Valid chain
                            </div>
                            <div style={{ marginTop: 6, fontSize: 12, color: UI.textSecondary }}>
                              {chainVerify.partial ? "Tail verification" : "Full verification"}
                              {typeof chainVerify.verifiedCount === "number"
                                ? ` · ${chainVerify.verifiedCount.toLocaleString()} rows checked`
                                : ""}
                            </div>
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

                      <div style={{ display: "flex", alignItems: "flex-end", gap: 10 }}>
                        <button
                          type="button"
                          onClick={handleExportAuditCsv}
                          style={{
                            padding: "8px 14px",
                            fontSize: 13,
                            fontWeight: 600,
                            color: UI.inputText,
                            backgroundColor: UI.inputBg,
                            border: "1px solid rgba(226, 232, 240, 0.65)",
                            borderRadius: 8,
                            cursor: "pointer",
                          }}
                        >
                          Export Audit CSV
                        </button>
                      </div>
                    </div>
                  </div>
                </Card>

                <Card>
                  <div style={subCardStyle()}>
                    <div style={{ marginBottom: 20 }}>
                      <h3 style={{ margin: "0 0 12px 0", fontSize: 15, fontWeight: 700, color: UI.textPrimary }}>
                        Recent Admin Actions
                      </h3>

                      <div
                        style={{
                          display: "grid",
                          gap: 12,
                          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                          marginBottom: 16,
                        }}
                      >
                        <input
                          value={auditAction}
                          onChange={(e) => setAuditAction(e.target.value)}
                          placeholder="Action"
                          style={{
                            padding: "8px 12px",
                            fontSize: 13,
                            color: UI.inputText,
                            backgroundColor: UI.inputBg,
                            border: "1px solid rgba(226, 232, 240, 0.65)",
                            borderRadius: 8,
                            outline: "none",
                          }}
                        />
                        <input
                          value={auditCategory}
                          onChange={(e) => setAuditCategory(e.target.value)}
                          placeholder="Category"
                          style={{
                            padding: "8px 12px",
                            fontSize: 13,
                            color: UI.inputText,
                            backgroundColor: UI.inputBg,
                            border: "1px solid rgba(226, 232, 240, 0.65)",
                            borderRadius: 8,
                            outline: "none",
                          }}
                        />
                        <input
                          value={auditSeverity}
                          onChange={(e) => setAuditSeverity(e.target.value)}
                          placeholder="Severity"
                          style={{
                            padding: "8px 12px",
                            fontSize: 13,
                            color: UI.inputText,
                            backgroundColor: UI.inputBg,
                            border: "1px solid rgba(226, 232, 240, 0.65)",
                            borderRadius: 8,
                            outline: "none",
                          }}
                        />
                        <input
                          value={auditOutcome}
                          onChange={(e) => setAuditOutcome(e.target.value)}
                          placeholder="Outcome"
                          style={{
                            padding: "8px 12px",
                            fontSize: 13,
                            color: UI.inputText,
                            backgroundColor: UI.inputBg,
                            border: "1px solid rgba(226, 232, 240, 0.65)",
                            borderRadius: 8,
                            outline: "none",
                          }}
                        />
                        <input
                          value={auditSearch}
                          onChange={(e) => setAuditSearch(e.target.value)}
                          placeholder="Search"
                          style={{
                            padding: "8px 12px",
                            fontSize: 13,
                            color: UI.inputText,
                            backgroundColor: UI.inputBg,
                            border: "1px solid rgba(226, 232, 240, 0.65)",
                            borderRadius: 8,
                            outline: "none",
                          }}
                        />
                      </div>

                      <div style={{ display: "flex", gap: 10 }}>
                        <button
                          type="button"
                          onClick={() => void refreshAuditLogs(null)}
                          style={{
                            padding: "8px 14px",
                            fontSize: 13,
                            fontWeight: 600,
                            color: UI.inputText,
                            backgroundColor: UI.inputBg,
                            border: "1px solid rgba(226, 232, 240, 0.65)",
                            borderRadius: 8,
                            cursor: "pointer",
                          }}
                        >
                          Apply filters
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setAuditAction("");
                            setAuditCategory("");
                            setAuditSeverity("");
                            setAuditOutcome("");
                            setAuditSearch("");

                            setTimeout(() => {
                              void refreshAuditLogs(null);
                            }, 0);
                          }}
                          style={{
                            padding: "8px 14px",
                            fontSize: 13,
                            fontWeight: 600,
                            color: UI.inputText,
                            backgroundColor: UI.inputBg,
                            border: "1px solid rgba(226, 232, 240, 0.65)",
                            borderRadius: 8,
                            cursor: "pointer",
                          }}
                        >
                          Clear
                        </button>
                      </div>
                    </div>

                    {auditLogsLoading ? (
                      <div style={{ padding: 12, textAlign: "center", color: UI.emptyText, fontSize: 13 }}>
                        Loading audit log…
                      </div>
                    ) : auditLogItems.length ? (
                      <>
                        <div style={{ display: "grid", gap: 1 }}>
                          {auditLogItems.map((entry, index, arr) => (
                            <div
                              key={entry.id}
                              style={{
                                display: "grid",
                                gridTemplateColumns: "1fr minmax(150px, auto)",
                                gap: 12,
                                alignItems: "start",
                                padding: "14px 0",
                                borderBottom: index < arr.length - 1 ? `1px solid ${UI.border}` : "none",
                              }}
                            >
                              <div style={{ minWidth: 0 }}>
                                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 6 }}>
                                  <div style={{ fontSize: 12, fontWeight: 700, color: UI.textPrimary, wordBreak: "break-word" }}>
                                    {humanizeKey(entry.action)}
                                  </div>
                                  {entry.category ? (
                                    <span style={badgeStyle("#C4B5FD", "rgba(139,92,246,0.18)")}>
                                      {humanizeKey(entry.category)}
                                    </span>
                                  ) : null}
                                  {severityBadge(entry.severity)}
                                  {entry.outcome ? (
                                    <span style={badgeStyle("#CBD5E1", "rgba(148,163,184,0.18)")}>
                                      {humanizeKey(entry.outcome)}
                                    </span>
                                  ) : null}
                                </div>

                                <div style={{ fontSize: 10, color: UI.textMuted, marginBottom: 6 }}>
                                  actor: {formatAuditActor(entry.userId, entry.isPublic)}
                                  {entry.resourceType ? ` · ${entry.resourceType}` : ""}
                                  {entry.resourceId ? ` · ${shortId(entry.resourceId)}` : ""}
                                  {entry.requestId ? ` · req ${shortId(entry.requestId)}` : ""}
                                </div>

                                <div style={{ display: "grid", gap: 6 }}>
                                  <div style={{ fontSize: 11, color: UI.textSecondary }}>
                                    IP: {entry.ipAddress ?? "—"} · Chain v{entry.chainVersion ?? 1}
                                    {entry.anchoredAt ? ` · anchored ${formatDisplayTimestamp(entry.anchoredAt)}` : ""}
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
                              </div>

                              <div style={{ fontSize: 11, color: UI.textSecondary, whiteSpace: "nowrap", textAlign: "right" }}>
                                {formatDisplayTimestamp(entry.createdAt)}
                              </div>
                            </div>
                          ))}
                        </div>

                        <div style={{ marginTop: 16, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                          <div style={{ fontSize: 12, color: UI.textSecondary }}>
                            Showing {auditLogItems.length} entries
                          </div>
                          <button
                            type="button"
                            disabled={!auditCursor}
                            onClick={() => void refreshAuditLogs(auditCursor)}
                            style={{
                              padding: "8px 14px",
                              fontSize: 13,
                              fontWeight: 600,
                              color: UI.inputText,
                              backgroundColor: UI.inputBg,
                              border: "1px solid rgba(226, 232, 240, 0.65)",
                              borderRadius: 8,
                              cursor: auditCursor ? "pointer" : "not-allowed",
                              opacity: auditCursor ? 1 : 0.5,
                            }}
                          >
                            Load more
                          </button>
                        </div>
                      </>
                    ) : (
                      <div style={{ padding: 12, textAlign: "center", color: UI.emptyText, fontSize: 13 }}>
                        No audit log entries yet.
                      </div>
                    )}
                  </div>
                </Card>
              </div>

              <div>
                <Card>
                  <div style={subCardStyle()}>
                    <h3 style={{ margin: "0 0 16px 0", fontSize: 15, fontWeight: 700, color: UI.textPrimary }}>
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
                        <div style={{ fontSize: 12, color: UI.textMuted, marginBottom: 6 }}>API Version</div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: UI.textPrimary }}>v1</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 12, color: UI.textMuted, marginBottom: 6 }}>Dashboard source</div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: UI.textPrimary }}>PostgreSQL analytics aggregates</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 12, color: UI.textMuted, marginBottom: 6 }}>Audit integrity</div>
                        <div
                          style={{
                            fontSize: 13,
                            fontWeight: 700,
                            color:
                              chainVerify === null
                                ? "#FCD34D"
                                : chainVerify.valid
                                ? UI.success
                                : "#FCA5A5",
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
                              backgroundColor:
                                chainVerify === null
                                  ? "#F59E0B"
                                  : chainVerify.valid
                                  ? UI.success
                                  : "#EF4444",
                              boxShadow:
                                chainVerify === null
                                  ? "0 0 12px rgba(245, 158, 11, 0.7)"
                                  : chainVerify.valid
                                  ? "0 0 12px rgba(52, 211, 153, 0.7)"
                                  : "0 0 12px rgba(239, 68, 68, 0.7)",
                            }}
                          />
                          {chainVerify === null
                            ? "Unavailable"
                            : chainVerify.valid
                            ? "Verified"
                            : "Needs review"}
                        </div>
                      </div>
                      <div>
                        <div style={{ fontSize: 12, color: UI.textMuted, marginBottom: 6 }}>Last updated</div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: UI.textPrimary }}>
                          {lastSuccessfulFetchAt ? formatDisplayTimestamp(lastSuccessfulFetchAt) : "—"}
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