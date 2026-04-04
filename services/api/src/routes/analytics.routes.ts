import type { FastifyInstance, FastifyRequest } from "fastify";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { requirePlatformAdmin } from "../middleware/require-platform-admin.js";
import { verifyJwt } from "../services/jwt.js";

type AnalyticsTrackBody = {
  eventType?: string;
  userId?: string | null;
  sessionId?: string;
  visitorId?: string;
  path?: string | null;
  referrer?: string | null;
  metadata?: Prisma.InputJsonValue | null;
};

type TrendBucket = {
  date: string;
  pageViews: number;
  sessions: number;
  eventType?: string | null;
};

type FunnelStep = {
  key: string;
  label: string;
  count: number;
  conversionFromPrevious: number | null;
  dropOffFromPrevious: number | null;
};

type AdminDateRangeKey = "24h" | "7d" | "30d";

type AdminEventFilter =
  | "all"
  | "page_view"
  | "login_completed"
  | "evidence_created"
  | "report_generated";

type RouteType = "public" | "app" | "admin" | "auth" | "api" | "unknown";

type AdminAnalyticsQuery = {
  start: Date;
  end: Date;
  dateRangeKey: AdminDateRangeKey;
  eventType: AdminEventFilter;
  routeType: RouteType | "all";
  path: string | null;
  countryCode: string | null;
  cityNormalized: string | null;
};

const ADMIN_PRE = { preHandler: requirePlatformAdmin };

function readHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | null {
  const value = headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function formatDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function resolveTrackUserId(
  request: FastifyRequest,
  bodyUserId: string | null | undefined
): string | null {
  const secret = process.env.AUTH_JWT_SECRET;
  if (secret) {
    const auth = request.headers.authorization ?? "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (bearer) {
      try {
        return verifyJwt(bearer, secret).sub;
      } catch {
        // anonymous / invalid token
      }
    }
  }
  return bodyUserId ?? null;
}

function parseDateRangeKey(raw: string | undefined): AdminDateRangeKey {
  if (raw === "24h" || raw === "7d" || raw === "30d") return raw;
  return "7d";
}

function rangeWindowMs(key: AdminDateRangeKey): number {
  if (key === "24h") return 24 * 60 * 60 * 1000;
  if (key === "7d") return 7 * 24 * 60 * 60 * 1000;
  return 30 * 24 * 60 * 60 * 1000;
}

function parseAdminEventFilter(raw: string | undefined): AdminEventFilter {
  const allowed: AdminEventFilter[] = [
    "all",
    "page_view",
    "login_completed",
    "evidence_created",
    "report_generated",
  ];
  if (raw && allowed.includes(raw as AdminEventFilter)) {
    return raw as AdminEventFilter;
  }
  return "all";
}

function parseRouteType(raw: string | undefined): RouteType | "all" {
  const allowed: Array<RouteType | "all"> = [
    "all",
    "public",
    "app",
    "admin",
    "auth",
    "api",
    "unknown",
  ];
  if (raw && allowed.includes(raw as RouteType | "all")) {
    return raw as RouteType | "all";
  }
  return "all";
}

function safeTrim(value: string | undefined): string | null {
  if (!value) return null;
  const t = value.trim();
  return t ? t : null;
}

function safeDecodeMojibake(value: string | null): string | null {
  if (!value) return null;
  try {
    if (/[ÃÂÐÑØÙÚÛÜÝÞß]/.test(value)) {
      return Buffer.from(value, "latin1").toString("utf8");
    }
  } catch {
    // noop
  }
  return value;
}

function normalizeCountryCode(value: string | null): string | null {
  if (!value) return null;
  const v = value.trim().toUpperCase();
  if (!v) return null;
  return v.slice(0, 8);
}

function normalizeCity(value: string | null): string | null {
  const decoded = safeDecodeMojibake(value);
  if (!decoded) return null;

  const normalized = decoded
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s'-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 160);

  return normalized || null;
}

function cleanDisplayCity(value: string | null): string | null {
  const decoded = safeDecodeMojibake(value);
  return decoded?.trim() ? decoded.trim() : null;
}

function classifyRouteType(path: string | null | undefined): RouteType {
  if (!path) return "unknown";
  if (path.startsWith("/admin")) return "admin";
  if (path.startsWith("/auth")) return "auth";
  if (path.startsWith("/api")) return "api";
  if (path.startsWith("/app")) return "app";
  if (
    path === "/" ||
    path.startsWith("/pricing") ||
    path.startsWith("/about") ||
    path.startsWith("/verify")
  ) {
    return "public";
  }
  return "public";
}

function classifyEventClass(eventType: string): string {
  if (eventType === "page_view") return "navigation";
  if (eventType === "login_completed") return "auth";
  if (eventType === "evidence_created") return "evidence";
  if (eventType === "report_generated") return "report";
  return "custom";
}

function classifySeverity(_eventType: string): string {
  return "info";
}

function humanizeEventType(eventType: string): string {
  return eventType
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function readAdminAnalyticsQuery(request: FastifyRequest): AdminAnalyticsQuery {
  const q = request.query as Record<string, string | undefined>;
  const dateRangeKey = parseDateRangeKey(q.dateRange);
  const eventType = parseAdminEventFilter(q.eventType);
  const end = new Date();
  const start = new Date(end.getTime() - rangeWindowMs(dateRangeKey));

  return {
    start,
    end,
    dateRangeKey,
    eventType,
    routeType: parseRouteType(q.routeType),
    path: safeTrim(q.path),
    countryCode: normalizeCountryCode(q.countryCode ?? null),
    cityNormalized: normalizeCity(safeTrim(q.city)),
  };
}

function buildAnalyticsWhere(
  query: AdminAnalyticsQuery,
  overrides?: Prisma.AnalyticsEventWhereInput
): Prisma.AnalyticsEventWhereInput {
  const base: Prisma.AnalyticsEventWhereInput = {
    createdAt: { gte: query.start, lte: query.end },
    ...(query.eventType === "all" ? {} : { eventType: query.eventType }),
    ...(query.routeType === "all" ? {} : { routeType: query.routeType }),
    ...(query.path ? { path: query.path } : {}),
    ...(query.countryCode ? { countryCode: query.countryCode } : {}),
    ...(query.cityNormalized ? { cityNormalized: query.cityNormalized } : {}),
  };

  return {
    ...base,
    ...(overrides ?? {}),
  };
}

async function countDistinctSessions(
  where: Prisma.AnalyticsEventWhereInput
): Promise<number> {
  const rows = await prisma.analyticsEvent.findMany({
    where,
    select: { sessionId: true },
    distinct: ["sessionId"],
  });
  return rows.length;
}

async function getSummary(query: AdminAnalyticsQuery) {
  const analyticsWhere = buildAnalyticsWhere(query);

  const [totalUsers, totalEvidence, reportsGenerated, activeUserRows] =
    await Promise.all([
      prisma.user.count(),
      prisma.evidence.count(),
      prisma.report.count(),
      prisma.analyticsEvent.findMany({
        where: {
          ...analyticsWhere,
          userId: { not: null },
        },
        select: { userId: true },
        distinct: ["userId"],
      }),
    ]);

  const entitlements = await prisma.entitlement.groupBy({
    by: ["plan"],
    where: { active: true },
    _count: { plan: true },
  });

  const typeGroups = await prisma.evidence.groupBy({
    by: ["type"],
    _count: { type: true },
  });

  const subscriptionBreakdown = {
    free: 0,
    payg: 0,
    pro: 0,
    team: 0,
  };

  for (const row of entitlements) {
    if (row.plan === "FREE") subscriptionBreakdown.free = row._count.plan;
    if (row.plan === "PAYG") subscriptionBreakdown.payg = row._count.plan;
    if (row.plan === "PRO") subscriptionBreakdown.pro = row._count.plan;
    if (row.plan === "TEAM") subscriptionBreakdown.team = row._count.plan;
  }

  const evidenceByType = {
    photos: 0,
    videos: 0,
    documents: 0,
    other: 0,
  };

  for (const row of typeGroups) {
    const c = row._count.type;
    if (row.type === "PHOTO") evidenceByType.photos += c;
    else if (row.type === "VIDEO") evidenceByType.videos += c;
    else if (row.type === "DOCUMENT") evidenceByType.documents += c;
    else evidenceByType.other += c;
  }

  return {
    totalUsers,
    activeUsers: activeUserRows.length,
    totalEvidence,
    reportsGenerated,
    subscriptionBreakdown,
    evidenceByType,
  };
}

async function getGeography(query: AdminAnalyticsQuery) {
  const [countries, cities, totalGeoEvents] = await Promise.all([
    prisma.analyticsEvent.groupBy({
      by: ["country", "countryCode"],
      _count: { country: true },
      where: buildAnalyticsWhere(query, {
        country: { not: null },
      }),
      orderBy: { _count: { country: "desc" } },
      take: 10,
    }),
    prisma.analyticsEvent.groupBy({
      by: ["city", "cityNormalized"],
      _count: { city: true },
      where: buildAnalyticsWhere(query, {
        cityNormalized: { not: null },
      }),
      orderBy: { _count: { city: "desc" } },
      take: 10,
    }),
    prisma.analyticsEvent.count({
      where: buildAnalyticsWhere(query),
    }),
  ]);

  return {
    total: totalGeoEvents,
    countries: countries.map((c) => ({
      name: c.country,
      countryCode: c.countryCode,
      count: c._count.country,
      share:
        totalGeoEvents > 0
          ? Number(((c._count.country / totalGeoEvents) * 100).toFixed(1))
          : 0,
    })),
    cities: cities.map((c) => ({
      name: cleanDisplayCity(c.city),
      normalized: c.cityNormalized,
      count: c._count.city,
      share:
        totalGeoEvents > 0
          ? Number(((c._count.city / totalGeoEvents) * 100).toFixed(1))
          : 0,
    })),
  };
}

async function getPages(query: AdminAnalyticsQuery) {
  const [pages, totalPageViews] = await Promise.all([
    prisma.analyticsEvent.groupBy({
      by: ["path", "routeType"],
      _count: { path: true },
      where: buildAnalyticsWhere(query, {
        eventType: "page_view",
        path: { not: null },
      }),
      orderBy: { _count: { path: "desc" } },
      take: 10,
    }),
    prisma.analyticsEvent.count({
      where: buildAnalyticsWhere(query, {
        eventType: "page_view",
      }),
    }),
  ]);

  return pages.map((p) => ({
    path: p.path,
    routeType: p.routeType,
    views: p._count.path,
    share:
      totalPageViews > 0
        ? Number(((p._count.path / totalPageViews) * 100).toFixed(1))
        : 0,
  }));
}

async function getRecent(query: AdminAnalyticsQuery) {
  const events = await prisma.analyticsEvent.findMany({
    where: buildAnalyticsWhere(query),
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      eventType: true,
      displayLabel: true,
      eventClass: true,
      routeType: true,
      severity: true,
      path: true,
      country: true,
      countryCode: true,
      city: true,
      cityNormalized: true,
      userId: true,
      sessionId: true,
      createdAt: true,
    },
  });

  return events.map((e) => ({
    eventType: e.eventType,
    label: e.displayLabel ?? humanizeEventType(e.eventType),
    eventClass: e.eventClass,
    routeType: e.routeType,
    severity: e.severity,
    path: e.path,
    country: e.country,
    countryCode: e.countryCode,
    city: cleanDisplayCity(e.city),
    cityNormalized: e.cityNormalized,
    userId: e.userId,
    sessionId: e.sessionId,
    createdAt: e.createdAt.toISOString(),
  }));
}

async function getTrends(query: AdminAnalyticsQuery) {
  const bucketCount =
    query.dateRangeKey === "24h" ? 1 : query.dateRangeKey === "7d" ? 7 : 30;

  const windowMs = query.end.getTime() - query.start.getTime();
  const bucketWidth = windowMs / bucketCount;
  const pageEvent = query.eventType === "all" ? "page_view" : query.eventType;

  const buckets: TrendBucket[] = [];

  for (let i = 0; i < bucketCount; i++) {
    const bStart = new Date(query.start.getTime() + i * bucketWidth);
    const bEnd = new Date(query.start.getTime() + (i + 1) * bucketWidth);

    const pageWhere: Prisma.AnalyticsEventWhereInput = {
      ...buildAnalyticsWhere(query),
      createdAt: { gte: bStart, lt: bEnd },
      eventType: pageEvent,
    };

    const sessionWhere: Prisma.AnalyticsEventWhereInput = {
      ...buildAnalyticsWhere(query),
      createdAt: { gte: bStart, lt: bEnd },
      ...(query.eventType === "all" ? {} : { eventType: query.eventType }),
    };

    const [pageViews, sessions] = await Promise.all([
      prisma.analyticsEvent.count({ where: pageWhere }),
      countDistinctSessions(sessionWhere),
    ]);

    buckets.push({
      date: formatDayKey(bStart),
      pageViews,
      sessions,
      ...(query.eventType === "all" ? {} : { eventType: query.eventType }),
    });
  }

  return buckets;
}

function pct(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Number(((numerator / denominator) * 100).toFixed(1));
}

async function getFunnel(query: AdminAnalyticsQuery) {
  const stepsConfig: Array<{ key: string; label: string; eventType: string }> = [
    { key: "page_view", label: "Page Views", eventType: "page_view" },
    { key: "login_completed", label: "Logins", eventType: "login_completed" },
    {
      key: "evidence_created",
      label: "Evidence Created",
      eventType: "evidence_created",
    },
    {
      key: "report_generated",
      label: "Reports Generated",
      eventType: "report_generated",
    },
  ];

  const counts = await Promise.all(
    stepsConfig.map((step) =>
      prisma.analyticsEvent.count({
        where: buildAnalyticsWhere(query, {
          eventType: step.eventType,
        }),
      })
    )
  );

  const steps: FunnelStep[] = stepsConfig.map((step, index) => {
    const count = counts[index] ?? 0;
    const prev = index > 0 ? (counts[index - 1] ?? 0) : 0;
    const conversion = index === 0 ? null : pct(count, prev);
    const dropOff =
      index === 0 || conversion === null
        ? null
        : Number((100 - conversion).toFixed(1));

    return {
      key: step.key,
      label: step.label,
      count,
      conversionFromPrevious: conversion,
      dropOffFromPrevious: dropOff,
    };
  });

  return steps;
}

export default async function analyticsRoutes(app: FastifyInstance) {
  app.post("/v1/analytics/track", async (request, reply) => {
    try {
      const body = (request.body ?? {}) as AnalyticsTrackBody;

      if (!body.eventType || !body.sessionId || !body.visitorId) {
        return reply.code(400).send({
          success: false,
          error: "Missing required analytics fields",
        });
      }

      const resolvedUserId = resolveTrackUserId(request, body.userId ?? null);

      const country =
        readHeader(request.headers, "cf-ipcountry") ??
        readHeader(request.headers, "x-vercel-ip-country");

      const cityRaw =
        readHeader(request.headers, "cf-ipcity") ??
        readHeader(request.headers, "x-vercel-ip-city");

      const region =
        readHeader(request.headers, "cf-region") ??
        readHeader(request.headers, "cf-region-code") ??
        readHeader(request.headers, "x-vercel-ip-country-region");

      const userAgent = readHeader(request.headers, "user-agent");
      const path = body.path ?? null;
      const routeType = classifyRouteType(path);
      const displayCity = cleanDisplayCity(cityRaw);
      const cityNormalized = normalizeCity(cityRaw);
      const countryCode = normalizeCountryCode(country);

      await prisma.analyticsSession.upsert({
        where: {
          id: body.sessionId,
        },
        update: {
          userId: resolvedUserId ?? undefined,
          lastSeenAt: new Date(),
          country: country ?? undefined,
          countryCode: countryCode ?? undefined,
          city: displayCity ?? undefined,
          cityNormalized: cityNormalized ?? undefined,
          routeType,
          landingPath: path ?? undefined,
          device: userAgent ?? undefined,
          browser: userAgent ?? undefined,
        },
        create: {
          id: body.sessionId,
          visitorId: body.visitorId,
          userId: resolvedUserId,
          country,
          countryCode,
          city: displayCity,
          cityNormalized,
          routeType,
          landingPath: path,
          device: userAgent,
          browser: userAgent,
        },
      });

      await prisma.analyticsEvent.create({
        data: {
          eventType: body.eventType,
          userId: resolvedUserId,
          sessionId: body.sessionId,
          visitorId: body.visitorId,
          path,
          referrer: body.referrer ?? null,
          country,
          countryCode,
          city: displayCity,
          cityNormalized,
          region,
          routeType,
          eventClass: classifyEventClass(body.eventType),
          displayLabel: humanizeEventType(body.eventType),
          severity: classifySeverity(body.eventType),
          device: userAgent,
          browser: userAgent,
          metadata:
            body.metadata != null
              ? (body.metadata as Prisma.InputJsonValue)
              : Prisma.JsonNull,
        },
      });

      return reply.code(200).send({ success: true });
    } catch (err: unknown) {
      request.log.error({ err }, "analytics.track.failed");
      return reply.code(500).send({
        success: false,
        error: "Analytics tracking failed",
      });
    }
  });

  app.get("/v1/admin/analytics/dashboard", ADMIN_PRE, async (request, reply) => {
    try {
      const query = readAdminAnalyticsQuery(request);

      const [summary, geography, pages, recent, trends, funnel] =
        await Promise.all([
          getSummary(query),
          getGeography(query),
          getPages(query),
          getRecent(query),
          getTrends(query),
          getFunnel(query),
        ]);

      return reply.send({
        summary,
        geography,
        pages,
        recent,
        trends,
        funnel,
      });
    } catch (err: unknown) {
      app.log.error({ err }, "admin.analytics.dashboard.failed");
      return reply.code(500).send({
        error: "Failed to load admin analytics dashboard",
      });
    }
  });

  app.get("/v1/admin/analytics/summary", ADMIN_PRE, async (request, reply) => {
    try {
      return reply.send(await getSummary(readAdminAnalyticsQuery(request)));
    } catch (err: unknown) {
      app.log.error({ err }, "admin.analytics.summary.failed");
      return reply.code(500).send({
        error: "Failed to load admin analytics summary",
      });
    }
  });

  app.get("/v1/admin/analytics/geography", ADMIN_PRE, async (request, reply) => {
    try {
      return reply.send(await getGeography(readAdminAnalyticsQuery(request)));
    } catch (err: unknown) {
      app.log.error({ err }, "analytics.geography.failed");
      return reply.code(500).send({ error: "Failed geography analytics" });
    }
  });

  app.get("/v1/admin/analytics/pages", ADMIN_PRE, async (request, reply) => {
    try {
      return reply.send(await getPages(readAdminAnalyticsQuery(request)));
    } catch (err: unknown) {
      app.log.error({ err }, "analytics.pages.failed");
      return reply.code(500).send({ error: "Failed pages analytics" });
    }
  });

  app.get("/v1/admin/analytics/recent", ADMIN_PRE, async (request, reply) => {
    try {
      return reply.send(await getRecent(readAdminAnalyticsQuery(request)));
    } catch (err: unknown) {
      app.log.error({ err }, "analytics.recent.failed");
      return reply.code(500).send({ error: "Failed recent analytics" });
    }
  });

  app.get("/v1/admin/analytics/trends", ADMIN_PRE, async (request, reply) => {
    try {
      return reply.send(await getTrends(readAdminAnalyticsQuery(request)));
    } catch (err: unknown) {
      app.log.error({ err }, "analytics.trends.failed");
      return reply.code(500).send({ error: "Failed trends analytics" });
    }
  });

  app.get("/v1/admin/analytics/funnel", ADMIN_PRE, async (request, reply) => {
    try {
      return reply.send(await getFunnel(readAdminAnalyticsQuery(request)));
    } catch (err: unknown) {
      app.log.error({ err }, "analytics.funnel.failed");
      return reply.code(500).send({ error: "Failed funnel analytics" });
    }
  });
}
