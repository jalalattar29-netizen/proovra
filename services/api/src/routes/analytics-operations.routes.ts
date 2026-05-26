/**
 * Phase E4 — Bounded operational analytics endpoints.
 *
 *   GET /v1/analytics/operations?teamId=&window=
 *   GET /v1/analytics/reviewer?teamId=&window=
 *   GET /v1/analytics/governance?teamId=&window=
 *   GET /v1/analytics/automation?teamId=&window=
 *   GET /v1/analytics/artifacts?teamId=&window=
 *
 * Hard rules (pinned by `phase-e4-analytics.test.ts`):
 *
 *   - Authentication required on every endpoint.
 *   - Workspace membership required on every endpoint (no cross-team
 *     leakage). The teamId query MUST resolve to a team the caller
 *     belongs to OR the request is rejected 403.
 *   - `ANALYTICS_VIEW` capability required (resolveCapabilities).
 *   - `window` query is coerced to a number and clamped to
 *     `[ANALYTICS_MIN_WINDOW_DAYS, ANALYTICS_MAX_WINDOW_DAYS]` (default
 *     30, max 180). Invalid windows resolve to default rather than 400 —
 *     analytics is a read-only surface and must degrade gracefully.
 *   - On Prisma errors, the inner service returns `metric: null` with
 *     the source recorded in `degradedSources`. The HTTP response is
 *     still 200 — analytics is best-effort and must not block ops.
 *   - The response envelope always carries `sourceTrace` so callers can
 *     show "data from X table, filtered by Y" badges in the UI.
 *
 * No mutations. No new root nav items. No fake metrics.
 */

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";

import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { resolveCapabilities } from "../services/platform-context/capability-registry.js";
import { isPlatformAdmin } from "../services/platform-admin.service.js";
import {
  ANALYTICS_DEFAULT_WINDOW_DAYS,
  ANALYTICS_MAX_WINDOW_DAYS,
  ANALYTICS_MIN_WINDOW_DAYS,
  clampWindow,
  getArtifactReadinessAnalytics,
  getAutomationAnalytics,
  getGovernanceAnalytics,
  getOperationsOverview,
  getReviewerAnalytics,
  type AnalyticsInput,
  type AnalyticsScope,
} from "../services/analytics/analytics.service.js";

// ---------------------------------------------------------------------------
// Query parsing
// ---------------------------------------------------------------------------

const AnalyticsQuery = z.object({
  teamId: z.string().uuid(),
  // `window` is best-effort. We accept any positive integer and clamp it
  // server-side to keep analytics gracefully degrading rather than 400-ing.
  window: z.coerce.number().int().positive().optional(),
});

type AnalyticsQueryParsed = z.infer<typeof AnalyticsQuery>;

// ---------------------------------------------------------------------------
// Membership + capability gate
// ---------------------------------------------------------------------------

type GateResult =
  | { ok: true; scope: AnalyticsScope; userId: string }
  | { ok: false };

async function gateAnalyticsRead(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
): Promise<GateResult> {
  const userId = getAuthUserId(req);
  const membership = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
  });
  if (!membership) {
    reply.code(403).send({ message: "Not a member of the workspace" });
    return { ok: false };
  }
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    select: {
      id: true,
      isPersonal: true,
      billingPlan: true,
      ownerUserId: true,
    },
  });
  if (!team) {
    reply.code(404).send({ message: "Workspace not found" });
    return { ok: false };
  }
  const platformAdmin = await isPlatformAdmin(userId);
  const scope: AnalyticsScope = team.isPersonal ? "PERSONAL" : "TEAM";
  const capabilities = resolveCapabilities({
    role: membership.role as never,
    scope: scope as never,
    plan: team.billingPlan as never,
    isPlatformAdmin: platformAdmin,
  });
  if (!capabilities.ANALYTICS_VIEW) {
    reply.code(403).send({
      message: "Capability ANALYTICS_VIEW required",
      error: { code: "permission_denied", capability: "ANALYTICS_VIEW" },
    });
    return { ok: false };
  }
  return { ok: true, scope, userId };
}

function buildInput(parsed: AnalyticsQueryParsed, scope: AnalyticsScope): AnalyticsInput {
  return {
    teamId: parsed.teamId,
    scope,
    windowDays: parsed.window,
  };
}

// ---------------------------------------------------------------------------
// Route registrar
// ---------------------------------------------------------------------------

export async function analyticsOperationsRoutes(
  app: FastifyInstance,
): Promise<void> {
  // -----------------------------------------------------------------
  // GET /v1/analytics/operations
  // -----------------------------------------------------------------
  app.get(
    "/v1/analytics/operations",
    { preHandler: requireAuth },
    async (req, reply) => {
      const q = AnalyticsQuery.safeParse(req.query);
      if (!q.success) {
        return reply
          .code(400)
          .send({ message: "Invalid query", issues: q.error.issues });
      }
      const gate = await gateAnalyticsRead(req, reply, q.data.teamId);
      if (!gate.ok) return;
      const envelope = await getOperationsOverview(buildInput(q.data, gate.scope));
      reply.send(envelope);
    },
  );

  // -----------------------------------------------------------------
  // GET /v1/analytics/reviewer
  // -----------------------------------------------------------------
  app.get(
    "/v1/analytics/reviewer",
    { preHandler: requireAuth },
    async (req, reply) => {
      const q = AnalyticsQuery.safeParse(req.query);
      if (!q.success) {
        return reply
          .code(400)
          .send({ message: "Invalid query", issues: q.error.issues });
      }
      const gate = await gateAnalyticsRead(req, reply, q.data.teamId);
      if (!gate.ok) return;
      const envelope = await getReviewerAnalytics(buildInput(q.data, gate.scope));
      reply.send(envelope);
    },
  );

  // -----------------------------------------------------------------
  // GET /v1/analytics/governance
  // -----------------------------------------------------------------
  app.get(
    "/v1/analytics/governance",
    { preHandler: requireAuth },
    async (req, reply) => {
      const q = AnalyticsQuery.safeParse(req.query);
      if (!q.success) {
        return reply
          .code(400)
          .send({ message: "Invalid query", issues: q.error.issues });
      }
      const gate = await gateAnalyticsRead(req, reply, q.data.teamId);
      if (!gate.ok) return;
      const envelope = await getGovernanceAnalytics(buildInput(q.data, gate.scope));
      reply.send(envelope);
    },
  );

  // -----------------------------------------------------------------
  // GET /v1/analytics/automation
  // -----------------------------------------------------------------
  app.get(
    "/v1/analytics/automation",
    { preHandler: requireAuth },
    async (req, reply) => {
      const q = AnalyticsQuery.safeParse(req.query);
      if (!q.success) {
        return reply
          .code(400)
          .send({ message: "Invalid query", issues: q.error.issues });
      }
      const gate = await gateAnalyticsRead(req, reply, q.data.teamId);
      if (!gate.ok) return;
      const envelope = await getAutomationAnalytics(buildInput(q.data, gate.scope));
      reply.send(envelope);
    },
  );

  // -----------------------------------------------------------------
  // GET /v1/analytics/artifacts
  // -----------------------------------------------------------------
  app.get(
    "/v1/analytics/artifacts",
    { preHandler: requireAuth },
    async (req, reply) => {
      const q = AnalyticsQuery.safeParse(req.query);
      if (!q.success) {
        return reply
          .code(400)
          .send({ message: "Invalid query", issues: q.error.issues });
      }
      const gate = await gateAnalyticsRead(req, reply, q.data.teamId);
      if (!gate.ok) return;
      const envelope = await getArtifactReadinessAnalytics(
        buildInput(q.data, gate.scope),
      );
      reply.send(envelope);
    },
  );

  // -----------------------------------------------------------------
  // GET /v1/analytics/_window — exposes the bounded window contract
  // so the frontend can render an honest selector. Read-only metadata.
  // -----------------------------------------------------------------
  app.get(
    "/v1/analytics/_window",
    { preHandler: requireAuth },
    async (_req, reply) => {
      reply.send({
        minDays: ANALYTICS_MIN_WINDOW_DAYS,
        maxDays: ANALYTICS_MAX_WINDOW_DAYS,
        defaultDays: ANALYTICS_DEFAULT_WINDOW_DAYS,
        clamp: {
          example: {
            input: -7,
            clamped: clampWindow(-7),
          },
        },
      });
    },
  );
}
