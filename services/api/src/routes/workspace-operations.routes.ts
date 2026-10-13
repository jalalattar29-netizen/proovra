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
import {
  unresolvedIncidentWhere,
  untriagedIncidentWhere,
} from "../services/operations/incident-open-statuses.js";
import {
  latestWorkspaceOperationsRun,
  mayAssertOperationsClear,
} from "@proovra/shared-runtime";

const ALERTS_CAP = 100;

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

      // THE canonical unresolved predicate (OPS-04). Health used to count
      // OPEN only, so acknowledging or suppressing the one CRITICAL condition
      // turned the workspace HEALTHY while nothing had been fixed.
      const scoped = workspaceIncidentWhere(workspaceId);
      const now = new Date();
      const [unresolvedBySeverity, untriagedTotal, mostRecent, run] = await Promise.all([
        prisma.operationalIncident.groupBy({
          by: ["severity"],
          where: { ...scoped, ...unresolvedIncidentWhere() },
          _count: { _all: true },
        }),
        prisma.operationalIncident.count({
          where: { ...scoped, ...untriagedIncidentWhere() },
        }),
        prisma.operationalIncident.findFirst({
          where: scoped,
          orderBy: { lastSeenAtUtc: "desc" },
          select: { lastSeenAtUtc: true },
        }),
        // Discovery freshness. A workspace nothing has scanned, or whose last
        // scan failed or went stale, is UNKNOWN — never HEALTHY by default.
        latestWorkspaceOperationsRun(prisma as never, workspaceId, now).catch(() => null),
      ]);

      const severity = Object.fromEntries(
        unresolvedBySeverity.map((r) => [r.severity, r._count._all]),
      ) as Record<string, number>;
      const critical = severity.CRITICAL ?? 0;
      const high = severity.HIGH ?? 0;
      const unresolvedTotal = unresolvedBySeverity.reduce((n, r) => n + r._count._all, 0);
      const clear = mayAssertOperationsClear({
        run,
        incidentReadComplete: true,
        unresolvedCount: unresolvedTotal,
      });
      const state =
        critical > 0
          ? "CRITICAL"
          : high > 0
            ? "DEGRADED"
            : unresolvedTotal > 0
              ? "ATTENTION"
              : clear.clear
                ? "HEALTHY"
                : "UNKNOWN";

      return reply.code(200).send({
        scope: "WORKSPACE",
        workspaceId,
        state,
        // Why the state is UNKNOWN (null otherwise): the discovery gate's own
        // bounded reason, e.g. NEVER_RUN, STALE, FAILED, PARTIAL_SOURCES.
        unknownReason: state === "UNKNOWN" && !clear.clear ? clear.reason : null,
        readiness: run?.readiness ?? "NEVER_RUN",
        /**
         * Unresolved conditions (OPEN, ACKNOWLEDGED or SUPPRESSED) — the same
         * canonical set the Operations summary counts — by severity.
         */
        openIncidents: {
          total: unresolvedTotal,
          bySeverity: severity,
        },
        unresolvedIncidents: unresolvedTotal,
        /** OPEN only: unresolved and not yet acknowledged by anybody. */
        untriagedIncidents: untriagedTotal,
        lastIncidentActivityUtc: mostRecent?.lastSeenAtUtc ?? null,
        evaluatedAtUtc: now.toISOString(),
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

      const where = {
        ...workspaceIncidentWhere(workspaceId),
        ...unresolvedIncidentWhere(),
      };
      // CRITICAL first: the severity enum is declared INFO..CRITICAL, so
      // DESCENDING is most-severe-first. Ascending put INFO first and let a
      // backlog of informational rows push every CRITICAL one past the cap.
      const [rows, bySeverity] = await Promise.all([
        prisma.operationalIncident.findMany({
        where,
        orderBy: [{ severity: "desc" }, { lastSeenAtUtc: "desc" }, { id: "desc" }],
        take: ALERTS_CAP + 1,
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
          // The code and params the title/summary were rendered from, so a
          // client renders the alert in its reader's language.
          messageCode: true,
          messageParams: true,
        },
        }),
        prisma.operationalIncident.groupBy({
          by: ["severity"],
          where,
          _count: { _all: true },
        }),
      ]);
      const counted = Object.fromEntries(
        bySeverity.map((r) => [r.severity, r._count._all]),
      ) as Record<string, number>;

      return reply.code(200).send({
        scope: "WORKSPACE",
        workspaceId,
        items: rows.slice(0, ALERTS_CAP).map(({ messageCode, messageParams, ...row }) => ({
          ...row,
          message: {
            code: messageCode ?? null,
            params:
              messageParams && typeof messageParams === "object" && !Array.isArray(messageParams)
                ? messageParams
                : null,
            // This surface shows each row's own stored title.
            titleSource: "CONDITION" as const,
          },
        })),
        // Counts are over EVERY unresolved condition, not the capped rows.
        counts: {
          total: bySeverity.reduce((n, r) => n + r._count._all, 0),
          critical: counted.CRITICAL ?? 0,
          high: counted.HIGH ?? 0,
        },
        // The item list is capped; this says whether it is the whole set.
        complete: rows.length <= ALERTS_CAP,
        evaluatedAtUtc: new Date().toISOString(),
      });
    },
  );
}

export default workspaceOperationsRoutes;
