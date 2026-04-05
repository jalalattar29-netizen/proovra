import type { FastifyInstance, FastifyRequest } from "fastify";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { requirePlatformAdmin } from "../middleware/require-platform-admin.js";
import { verifyJwt } from "../services/jwt.js";
import {
  cleanDisplayCity,
  normalizeCity,
  normalizeCountryCode,
  writeAnalyticsEvent,
} from "../services/analytics-event.service.js";
import { classifyRouteType } from "../lib/route-classification.js";

type AnalyticsTrackBody = {
  eventType?: string;
  userId?: string | null;
  sessionId?: string;
  visitorId?: string;
  path?: string | null;
  referrer?: string | null;
  entityType?: string | null;
  entityId?: string | null;
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

/**
 * IMPORTANT:
 * Summary is intentionally GLOBAL and does NOT apply dashboard filters.
 * This avoids the previous mixed behavior where some fields were filtered
 * and others were lifetime/global, which broke semantic consistency.
 */
async function getSummary() {
  const [totalUsers, totalEvidence, reportsGenerated, activeUserRows] =
    await Promise.all([
      prisma.user.count(),
      prisma.evidence.count(),
      prisma.report.count(),
      prisma.analyticsEvent.findMany({
        where: {
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
  const geoWhere = buildAnalyticsWhere(query);
  const totalGeoEvents = await prisma.analyticsEvent.count({ where: geoWhere });

  const countryRows = await prisma.analyticsEvent.findMany({
    where: {
      ...geoWhere,
      countryCode: { not: null },
    },
    select: {
      countryCode: true,
      country: true,
    },
  });

  const cityRows = await prisma.analyticsEvent.findMany({
    where: {
      ...geoWhere,
      cityNormalized: { not: null },
    },
    select: {
      city: true,
      cityNormalized: true,
    },
  });

  const countryMap = new Map<string, { count: number; display: string | null }>();

  for (const row of countryRows) {
    const key = row.countryCode ?? null;
    if (!key) continue;

    const existing = countryMap.get(key) ?? {
      count: 0,
      display: row.countryCode ?? row.country ?? null,
    };

    existing.count += 1;

    if (!existing.display) {
      existing.display = row.countryCode ?? row.country ?? null;
    }

    countryMap.set(key, existing);
  }

  const cityMap = new Map<string, { count: number; display: string | null }>();

  for (const row of cityRows) {
    const key = row.cityNormalized ?? null;
    if (!key) continue;

    const display = cleanDisplayCity(row.city) ?? row.cityNormalized;
    const existing = cityMap.get(key) ?? { count: 0, display };

    existing.count += 1;

    if (!existing.display && display) {
      existing.display = display;
    }

    cityMap.set(key, existing);
  }

  const countries = [...countryMap.entries()]
    .map(([countryCode, value]) => ({
      name: value.display,
      countryCode,
      count: value.count,
      share:
        totalGeoEvents > 0
          ? Number(((value.count / totalGeoEvents) * 100).toFixed(1))
          : 0,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const cities = [...cityMap.entries()]
    .map(([normalized, value]) => ({
      name: value.display,
      normalized,
      count: value.count,
      share:
        totalGeoEvents > 0
          ? Number(((value.count / totalGeoEvents) * 100).toFixed(1))
          : 0,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    total: totalGeoEvents,
    countries,
    cities,
  };
}

async function getPages(query: AdminAnalyticsQuery) {
  const pageRows = await prisma.analyticsEvent.findMany({
    where: buildAnalyticsWhere(query, {
      eventType: "page_view",
      path: { not: null },
    }),
    select: {
      path: true,
      routeType: true,
    },
  });

  const totalPageViews = pageRows.length;
  const pageMap = new Map<string, { views: number; routeType: string }>();

  for (const row of pageRows) {
    const path = row.path ?? null;
    if (!path) continue;

    const effectiveRouteType = row.routeType ?? classifyRouteType(path);
    const existing = pageMap.get(path) ?? {
      views: 0,
      routeType: effectiveRouteType,
    };

    existing.views += 1;

    if (existing.routeType === "unknown" && effectiveRouteType !== "unknown") {
      existing.routeType = effectiveRouteType;
    }

    pageMap.set(path, existing);
  }

  return [...pageMap.entries()]
    .map(([path, value]) => ({
      path,
      routeType: value.routeType,
      views: value.views,
      share:
        totalPageViews > 0
          ? Number(((value.views / totalPageViews) * 100).toFixed(1))
          : 0,
    }))
    .sort((a, b) => b.views - a.views)
    .slice(0, 10);
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
    label: e.displayLabel ?? e.eventType,
    eventClass: e.eventClass,
    routeType: e.routeType ?? classifyRouteType(e.path),
    severity: e.severity,
    path: e.path,
    country: e.countryCode ?? e.country,
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

      await writeAnalyticsEvent({
        eventType: body.eventType,
        userId: resolvedUserId,
        sessionId: body.sessionId,
        visitorId: body.visitorId,
        path: body.path ?? null,
        referrer: body.referrer ?? null,
        entityType: body.entityType ?? null,
        entityId: body.entityId ?? null,
        metadata: body.metadata ?? null,
        req: request,
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

  app.get(
    "/v1/admin/analytics/dashboard",
    ADMIN_PRE,
    async (request, reply) => {
      try {
        const query = readAdminAnalyticsQuery(request);

        const [summary, geography, pages, recent, trends, funnel] =
          await Promise.all([
            getSummary(),
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
    }
  );

  app.get("/v1/admin/analytics/summary", ADMIN_PRE, async (_request, reply) => {
    try {
      return reply.send(await getSummary());
    } catch (err: unknown) {
      app.log.error({ err }, "admin.analytics.summary.failed");
      return reply.code(500).send({
        error: "Failed to load admin analytics summary",
      });
    }
  });

  app.get(
    "/v1/admin/analytics/geography",
    ADMIN_PRE,
    async (request, reply) => {
      try {
        return reply.send(await getGeography(readAdminAnalyticsQuery(request)));
      } catch (err: unknown) {
        app.log.error({ err }, "analytics.geography.failed");
        return reply.code(500).send({ error: "Failed geography analytics" });
      }
    }
  );

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