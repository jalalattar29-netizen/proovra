import { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import type { Prisma } from "@prisma/client";

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
};

type FunnelStep = {
  key: string;
  label: string;
  count: number;
};

function readHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | null {
  const value = headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function startOfDay(date: Date): Date {
  const value = new Date(date);
  value.setHours(0, 0, 0, 0);
  return value;
}

function endOfDay(date: Date): Date {
  const value = new Date(date);
  value.setHours(23, 59, 59, 999);
  return value;
}

function formatDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function countDistinctSessionsBetween(start: Date, end: Date): Promise<number> {
  const rows = await prisma.analyticsEvent.findMany({
    where: {
      createdAt: {
        gte: start,
        lte: end,
      },
    },
    select: {
      sessionId: true,
    },
    distinct: ["sessionId"],
  });

  return rows.length;
}

export default async function analyticsRoutes(app: FastifyInstance) {
  // =========================
  // TRACK EVENT
  // =========================
  app.post("/v1/analytics/track", async (request, reply) => {
    try {
      const body = (request.body ?? {}) as AnalyticsTrackBody;

      if (!body.eventType || !body.sessionId || !body.visitorId) {
        return reply.code(400).send({
          success: false,
          error: "Missing required analytics fields",
        });
      }

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
          userId: body.userId ?? undefined,
          lastSeenAt: new Date(),
          country: country ?? undefined,
          city: city ?? undefined,
          device: userAgent ?? undefined,
          browser: userAgent ?? undefined,
        },
        create: {
          id: body.sessionId,
          visitorId: body.visitorId,
          userId: body.userId ?? null,
          country,
          city,
          device: userAgent,
          browser: userAgent,
        },
      });

      await prisma.analyticsEvent.create({
        data: {
          eventType: body.eventType,
          userId: body.userId ?? null,
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

  // =========================
  // SUMMARY
  // =========================
  app.get("/v1/admin/analytics/summary", async (_request, reply) => {
    try {
      const activeSince = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      const [totalUsers, totalEvidence, reportsGenerated, activeUsers] =
        await Promise.all([
          prisma.user.count(),
          prisma.evidence.count(),
          prisma.report.count(),
          prisma.analyticsEvent.findMany({
            where: {
              userId: { not: null },
              createdAt: {
                gte: activeSince,
              },
            },
            select: { userId: true },
            distinct: ["userId"],
          }),
        ]);

      const subscriptions = await prisma.subscription.groupBy({
        by: ["plan"],
        _count: { plan: true },
      });

      const evidenceRows = await prisma.evidence.findMany({
        select: { type: true },
      });

      const subscriptionBreakdown = {
        free: 0,
        payg: 0,
        pro: 0,
        team: 0,
      };

      for (const row of subscriptions) {
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

      for (const row of evidenceRows) {
        if (row.type === "PHOTO") evidenceByType.photos += 1;
        else if (row.type === "VIDEO") evidenceByType.videos += 1;
        else if (row.type === "DOCUMENT") evidenceByType.documents += 1;
        else evidenceByType.other += 1;
      }

      return reply.send({
        totalUsers,
        activeUsers: activeUsers.length,
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

  // =========================
  // GEOGRAPHY
  // =========================
  app.get("/v1/admin/analytics/geography", async (_request, reply) => {
    try {
      const [countries, cities] = await Promise.all([
        prisma.analyticsEvent.groupBy({
          by: ["country"],
          _count: { country: true },
          where: { country: { not: null } },
          orderBy: { _count: { country: "desc" } },
          take: 10,
        }),
        prisma.analyticsEvent.groupBy({
          by: ["city"],
          _count: { city: true },
          where: { city: { not: null } },
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

  // =========================
  // PAGES
  // =========================
  app.get("/v1/admin/analytics/pages", async (_req, reply) => {
    try {
      const pages = await prisma.analyticsEvent.groupBy({
        by: ["path"],
        _count: { path: true },
        where: {
          path: { not: null },
          eventType: "page_view",
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

  // =========================
  // RECENT
  // =========================
  app.get("/v1/admin/analytics/recent", async (_req, reply) => {
    try {
      const events = await prisma.analyticsEvent.findMany({
        orderBy: { createdAt: "desc" },
        take: 20,
        select: {
          eventType: true,
          path: true,
          country: true,
          city: true,
          createdAt: true,
        },
      });

      return reply.send(events);
    } catch (err: unknown) {
      app.log.error({ err }, "analytics.recent.failed");
      return reply.code(500).send({ error: "Failed recent analytics" });
    }
  });

  // =========================
  // TRENDS
  // =========================
  app.get("/v1/admin/analytics/trends", async (_req, reply) => {
    try {
      const now = new Date();
      const buckets: TrendBucket[] = [];

      for (let offset = 6; offset >= 0; offset -= 1) {
        const day = new Date(now);
        day.setDate(now.getDate() - offset);

        const dayStart = startOfDay(day);
        const dayEnd = endOfDay(day);

        const [pageViews, sessions] = await Promise.all([
          prisma.analyticsEvent.count({
            where: {
              eventType: "page_view",
              createdAt: {
                gte: dayStart,
                lte: dayEnd,
              },
            },
          }),
          countDistinctSessionsBetween(dayStart, dayEnd),
        ]);

        buckets.push({
          date: formatDayKey(dayStart),
          pageViews,
          sessions,
        });
      }

      return reply.send(buckets);
    } catch (err: unknown) {
      app.log.error({ err }, "analytics.trends.failed");
      return reply.code(500).send({ error: "Failed trends analytics" });
    }
  });

  // =========================
  // FUNNEL
  // =========================
  app.get("/v1/admin/analytics/funnel", async (_req, reply) => {
    try {
      const stepsConfig: Array<{ key: string; label: string; eventType: string }> = [
        { key: "page_view", label: "Page Views", eventType: "page_view" },
        { key: "login_completed", label: "Logins", eventType: "login_completed" },
        { key: "evidence_created", label: "Evidence Created", eventType: "evidence_created" },
        { key: "report_generated", label: "Reports Generated", eventType: "report_generated" },
      ];

      const counts = await Promise.all(
        stepsConfig.map((step) =>
          prisma.analyticsEvent.count({
            where: {
              eventType: step.eventType,
            },
          })
        )
      );

      const steps: FunnelStep[] = stepsConfig.map((step, index) => ({
        key: step.key,
        label: step.label,
        count: counts[index] ?? 0,
      }));

      return reply.send(steps);
    } catch (err: unknown) {
      app.log.error({ err }, "analytics.funnel.failed");
      return reply.code(500).send({ error: "Failed funnel analytics" });
    }
  });
}