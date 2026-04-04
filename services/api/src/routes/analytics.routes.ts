import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Prisma } from "@prisma/client";
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
};

type AdminDateRangeKey = "24h" | "7d" | "30d";

type AdminEventFilter =
  | "all"
  | "page_view"
  | "login_completed"
  | "evidence_created"
  | "report_generated";

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
        /* anonymous / invalid token */
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
  if (raw && (allowed as string[]).includes(raw)) {
    return raw as AdminEventFilter;
  }
  return "all";
}

function readAdminAnalyticsQuery(request: FastifyRequest): {
  start: Date;
  end: Date;
  dateRangeKey: AdminDateRangeKey;
  eventType: AdminEventFilter;
} {
  const q = request.query as Record<string, string | undefined>;
  const dateRangeKey = parseDateRangeKey(q.dateRange);
  const eventType = parseAdminEventFilter(q.eventType);
  const end = new Date();
  const start = new Date(end.getTime() - rangeWindowMs(dateRangeKey));
  return { start, end, dateRangeKey, eventType };
}

function eventTypeWhere(
  eventType: AdminEventFilter
): Pick<Prisma.AnalyticsEventWhereInput, "eventType"> | Record<string, never> {
  if (eventType === "all") return {};
  return { eventType };
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

      const city =
        readHeader(request.headers, "cf-ipcity") ??
        readHeader(request.headers, "x-vercel-ip-city");

      const region =
        readHeader(request.headers, "cf-region") ??
        readHeader(request.headers, "cf-region-code") ??
        readHeader(request.headers, "x-vercel-ip-country-region");

      const userAgent = readHeader(request.headers, "user-agent");

      await prisma.analyticsSession.upsert({
        where: {
          id: body.sessionId,
        },
        update: {
          userId: resolvedUserId ?? undefined,
          lastSeenAt: new Date(),
          country: country ?? undefined,
          city: city ?? undefined,
          device: userAgent ?? undefined,
          browser: userAgent ?? undefined,
        },
        create: {
          id: body.sessionId,
          visitorId: body.visitorId,
          userId: resolvedUserId,
          country,
          city,
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
          path: body.path ?? null,
          referrer: body.referrer ?? null,
          country,
          city,
          region,
          device: userAgent,
          browser: userAgent,
          metadata:
            (body.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
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

  app.get("/v1/admin/analytics/summary", ADMIN_PRE, async (request, reply) => {
    try {
      const { start, end, eventType } = readAdminAnalyticsQuery(request);

      const [totalUsers, totalEvidence, reportsGenerated, activeUserRows] =
        await Promise.all([
          prisma.user.count(),
          prisma.evidence.count(),
          prisma.report.count(),
          prisma.analyticsEvent.findMany({
            where: {
              userId: { not: null },
              createdAt: { gte: start, lte: end },
              ...eventTypeWhere(eventType),
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

      return reply.send({
        totalUsers,
        activeUsers: activeUserRows.length,
        totalEvidence,
        reportsGenerated,
        subscriptionBreakdown,
        evidenceByType,
      });
    } catch (err: unknown) {
      app.log.error({ err }, "admin.analytics.summary.failed");
      return reply.code(500).send({
        error: "Failed to load admin analytics summary",
      });
    }
  });

  app.get("/v1/admin/analytics/geography", ADMIN_PRE, async (request, reply) => {
    try {
      const { start, end, eventType } = readAdminAnalyticsQuery(request);
      const ev = eventTypeWhere(eventType);

      const [countries, cities] = await Promise.all([
        prisma.analyticsEvent.groupBy({
          by: ["country"],
          _count: { country: true },
          where: {
            country: { not: null },
            createdAt: { gte: start, lte: end },
            ...ev,
          },
          orderBy: { _count: { country: "desc" } },
          take: 10,
        }),
        prisma.analyticsEvent.groupBy({
          by: ["city"],
          _count: { city: true },
          where: {
            city: { not: null },
            createdAt: { gte: start, lte: end },
            ...ev,
          },
          orderBy: { _count: { city: "desc" } },
          take: 10,
        }),
      ]);

      return reply.send({
        countries: countries.map((c) => ({
          name: c.country,
          count: c._count.country,
        })),
        cities: cities.map((c) => ({
          name: c.city,
          count: c._count.city,
        })),
      });
    } catch (err: unknown) {
      app.log.error({ err }, "analytics.geography.failed");
      return reply.code(500).send({ error: "Failed geography analytics" });
    }
  });

  app.get("/v1/admin/analytics/pages", ADMIN_PRE, async (request, reply) => {
    try {
      const { start, end, eventType } = readAdminAnalyticsQuery(request);

      // Top paths are only defined for page_view; other filters have no path dimension.
      if (eventType !== "all" && eventType !== "page_view") {
        return reply.send([]);
      }

      const pages = await prisma.analyticsEvent.groupBy({
        by: ["path"],
        _count: { path: true },
        where: {
          path: { not: null },
          eventType: "page_view",
          createdAt: { gte: start, lte: end },
        },
        orderBy: { _count: { path: "desc" } },
        take: 10,
      });

      return reply.send(
        pages.map((p) => ({
          path: p.path,
          views: p._count.path,
        }))
      );
    } catch (err: unknown) {
      app.log.error({ err }, "analytics.pages.failed");
      return reply.code(500).send({ error: "Failed pages analytics" });
    }
  });

  app.get("/v1/admin/analytics/recent", ADMIN_PRE, async (request, reply) => {
    try {
      const { start, end, eventType } = readAdminAnalyticsQuery(request);

      const events = await prisma.analyticsEvent.findMany({
        where: {
          createdAt: { gte: start, lte: end },
          ...eventTypeWhere(eventType),
        },
        orderBy: { createdAt: "desc" },
        take: 100,
        select: {
          eventType: true,
          path: true,
          country: true,
          city: true,
          userId: true,
          createdAt: true,
        },
      });

      return reply.send(
        events.map((e) => ({
          eventType: e.eventType,
          path: e.path,
          country: e.country,
          city: e.city,
          userId: e.userId,
          createdAt: e.createdAt.toISOString(),
        }))
      );
    } catch (err: unknown) {
      app.log.error({ err }, "analytics.recent.failed");
      return reply.code(500).send({ error: "Failed recent analytics" });
    }
  });

  app.get("/v1/admin/analytics/trends", ADMIN_PRE, async (request, reply) => {
    try {
      const { start, end, dateRangeKey, eventType } = readAdminAnalyticsQuery(
        request
      );

      const bucketCount = dateRangeKey === "24h" ? 1 : dateRangeKey === "7d" ? 7 : 30;
      const windowMs = end.getTime() - start.getTime();
      const bucketWidth = windowMs / bucketCount;

      const pageEvent =
        eventType === "all" ? "page_view" : eventType;
      const sessionEventFilter: AdminEventFilter | "all" =
        eventType === "all" ? "all" : eventType;

      const buckets: TrendBucket[] = [];

      for (let i = 0; i < bucketCount; i++) {
        const bStart = new Date(start.getTime() + i * bucketWidth);
        const bEnd = new Date(start.getTime() + (i + 1) * bucketWidth);

        const pageWhere: Prisma.AnalyticsEventWhereInput = {
          createdAt: { gte: bStart, lt: bEnd },
          eventType: pageEvent,
        };

        const sessionWhere: Prisma.AnalyticsEventWhereInput =
          sessionEventFilter === "all"
            ? { createdAt: { gte: bStart, lt: bEnd } }
            : {
                createdAt: { gte: bStart, lt: bEnd },
                eventType: sessionEventFilter,
              };

        const [pageViews, sessions] = await Promise.all([
          prisma.analyticsEvent.count({ where: pageWhere }),
          countDistinctSessions(sessionWhere),
        ]);

        buckets.push({
          date: formatDayKey(bStart),
          pageViews,
          sessions,
          ...(eventType === "all" ? {} : { eventType }),
        });
      }

      return reply.send(buckets);
    } catch (err: unknown) {
      app.log.error({ err }, "analytics.trends.failed");
      return reply.code(500).send({ error: "Failed trends analytics" });
    }
  });

  app.get("/v1/admin/analytics/funnel", ADMIN_PRE, async (request, reply) => {
    try {
      const { start, end, eventType } = readAdminAnalyticsQuery(request);

      const stepsConfig: Array<{ key: string; label: string; eventType: string }> =
        [
          { key: "page_view", label: "Page Views", eventType: "page_view" },
          {
            key: "login_completed",
            label: "Logins",
            eventType: "login_completed",
          },
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
            where: {
              eventType: step.eventType,
              createdAt: { gte: start, lte: end },
            },
          })
        )
      );

      const steps: FunnelStep[] = stepsConfig.map((step, index) => {
        const raw = counts[index] ?? 0;
        const count =
          eventType === "all" || eventType === step.eventType ? raw : 0;
        return {
          key: step.key,
          label: step.label,
          count,
        };
      });

      return reply.send(steps);
    } catch (err: unknown) {
      app.log.error({ err }, "analytics.funnel.failed");
      return reply.code(500).send({ error: "Failed funnel analytics" });
    }
  });
}
