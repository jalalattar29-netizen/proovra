/**
 * WORKSPACE OPERATIONAL HEALTH — the tenant-safe projection.
 *
 * This is the replacement for the workspace half of `/v1/ops/metrics` and
 * `/v1/ops/alerts`. Those two authorized a workspace member and then handed
 * back the PROCESS-GLOBAL metric registry; this file answers the question a
 * workspace admin actually has — "is MY workspace healthy?" — from durable,
 * tenant-owned rows.
 *
 * THE CANONICAL PREFIX IS /v1/teams, NOT /v1/workspaces.
 *
 * `/v1/workspaces` is not a free namespace: `buildServer` installs
 * `rewriteUrl: rewriteWorkspaceAliasUrl`, which rewrites EVERY `/v1/workspaces/*`
 * request to `/v1/teams/*` before routing. A route registered at the alias path
 * therefore appears in `printRoutes()` and can never be reached — the inbound
 * URL is rewritten to a path that does not exist and Fastify answers its global
 * 404 without entering the handler.
 *
 * Registering canonically means BOTH URLs work: `/v1/teams/:id/operations/health`
 * directly, and `/v1/workspaces/:id/operations/health` through the alias.
 *
 * THE STRUCTURAL GUARANTEE
 * ---------------------------------------------------------------------------
 * Nothing here imports `snapshotMetrics`, `evaluateAlerts`, `setGauge` or
 * `bump`. That is not an oversight to be corrected later: the process registry
 * is per-instance and platform-wide, and there is no filter that makes it
 * tenant-safe, so the only sound boundary is that this module cannot reach it.
 * `phase-workspace-operations-scope.test.ts` asserts the absence of those
 * imports, so a future edit that reintroduces one fails a test rather than
 * quietly restoring the leak.
 *
 * A tenant may legitimately need to know the PLATFORM is degraded — their
 * uploads queue behind it. That is a service-status question and it is NOT
 * answered here: it needs a bounded, non-disclosing projection (one state
 * word, never counts, never metric names, never another tenant) and that is
 * deliberately left to the status surface rather than smuggled into a
 * workspace route, which is how the leak happened the first time.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { getAuthUserId } from "../auth.js";
import { authorizeOrFail } from "../middleware/authorize.js";
import { workspaceIncidentWhere } from "../services/observability/incident-scope.js";

const WorkspaceParam = z.object({ workspaceId: z.string().uuid() });

/**
 * Prove ACTIVE membership before anything is read.
 *
 * A non-member gets 404, never 403: a 403 confirms the workspace exists, which
 * turns this route into a workspace-id oracle. This mirrors `requireOpsActor`,
 * which already had this right.
 */
async function requireWorkspaceMember(
  req: FastifyRequest,
  reply: FastifyReply,
  workspaceId: string,
): Promise<{ actorUserId: string } | null> {
  const userId = getAuthUserId(req);
  const membership = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId: workspaceId, userId } },
    select: { status: true },
  });
  if (!membership) {
    await reply.code(404).send({ error: { code: "not_found" } });
    return null;
  }
  if (membership.status !== "ACTIVE") {
    await reply.code(403).send({ error: { code: "member_inactive" } });
    return null;
  }
  const auth = await authorizeOrFail(req, reply, {
    teamId: workspaceId,
    permission: "identity.member.read",
  });
  if (!auth) return null;
  return { actorUserId: userId };
}

export async function workspaceOperationsRoutes(
  app: FastifyInstance,
): Promise<void> {
  /**
   * GET /v1/workspaces/:workspaceId/operations/health
   *
   * Durable, tenant-owned operational state. Every number below is a row count
   * inside this workspace — none is a process counter.
   */
  app.get(
    "/v1/teams/:workspaceId/operations/health",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // Route-matching marker. Set FIRST, before validation, so a test can
      // separate "the handler refused" from "Fastify never matched the route" —
      // both of which are 404 and are otherwise indistinguishable.
      reply.header("x-proovra-handler", "workspace-operations-health");
      const parsed = WorkspaceParam.safeParse(req.params);
      if (!parsed.success) {
        return reply.code(400).send({
          error: { code: "INVALID_WORKSPACE_ID", requestId: req.id },
        });
      }
      const { workspaceId } = parsed.data;
      const actor = await requireWorkspaceMember(req, reply, workspaceId);
      if (!actor) return;

      const scoped = workspaceIncidentWhere(workspaceId);
      const [openBySeverity, unresolvedTotal, mostRecent] = await Promise.all([
        prisma.operationalIncident.groupBy({
          by: ["severity"],
          where: { ...scoped, status: "OPEN" },
          _count: { _all: true },
        }),
        prisma.operationalIncident.count({
          where: { ...scoped, status: { in: ["OPEN", "ACKNOWLEDGED"] } },
        }),
        prisma.operationalIncident.findFirst({
          where: scoped,
          orderBy: { lastSeenAtUtc: "desc" },
          select: { lastSeenAtUtc: true },
        }),
      ]);

      const severity = Object.fromEntries(
        openBySeverity.map((r) => [r.severity, r._count._all]),
      ) as Record<string, number>;
      const critical = severity.CRITICAL ?? 0;
      const high = severity.HIGH ?? 0;

      return reply.code(200).send({
        scope: "WORKSPACE",
        workspaceId,
        state: critical > 0 ? "CRITICAL" : high > 0 ? "DEGRADED" : "HEALTHY",
        openIncidents: {
          total: openBySeverity.reduce((n, r) => n + r._count._all, 0),
          bySeverity: severity,
        },
        unresolvedIncidents: unresolvedTotal,
        lastIncidentActivityUtc: mostRecent?.lastSeenAtUtc ?? null,
        evaluatedAtUtc: new Date().toISOString(),
      });
    },
  );

  /**
   * GET /v1/workspaces/:workspaceId/operations/alerts
   *
   * The workspace's own open incidents, projected as actionable rows. These are
   * NOT the platform alert evaluation — that runs over the global registry and
   * lives behind the platform-admin gate.
   */
  app.get(
    "/v1/teams/:workspaceId/operations/alerts",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // Route-matching marker. Set FIRST, before validation, so a test can
      // separate "the handler refused" from "Fastify never matched the route" —
      // both of which are 404 and are otherwise indistinguishable.
      reply.header("x-proovra-handler", "workspace-operations-health");
      const parsed = WorkspaceParam.safeParse(req.params);
      if (!parsed.success) {
        return reply.code(400).send({
          error: { code: "INVALID_WORKSPACE_ID", requestId: req.id },
        });
      }
      const { workspaceId } = parsed.data;
      const actor = await requireWorkspaceMember(req, reply, workspaceId);
      if (!actor) return;

      const rows = await prisma.operationalIncident.findMany({
        where: {
          ...workspaceIncidentWhere(workspaceId),
          status: { in: ["OPEN", "ACKNOWLEDGED"] },
        },
        orderBy: [{ severity: "asc" }, { lastSeenAtUtc: "desc" }],
        take: 100,
        // An explicit allow-list. `fingerprint` is deliberately absent: it is
        // an internal dedup identity and can name platform subsystems.
        select: {
          id: true,
          category: true,
          severity: true,
          status: true,
          title: true,
          safeSummary: true,
          firstSeenAtUtc: true,
          lastSeenAtUtc: true,
          occurrenceCount: true,
          runbookSlug: true,
        },
      });

      return reply.code(200).send({
        scope: "WORKSPACE",
        workspaceId,
        items: rows,
        counts: {
          total: rows.length,
          critical: rows.filter((r) => r.severity === "CRITICAL").length,
          high: rows.filter((r) => r.severity === "HIGH").length,
        },
        evaluatedAtUtc: new Date().toISOString(),
      });
    },
  );
}

export default workspaceOperationsRoutes;
