/**
 * Phase C0 — Reviewer Console aggregator.
 *
 * GET /v1/reviewer-ops/console
 *
 * Composes the existing Phase 25 reviewer-ops services into ONE
 * bounded envelope so the new `/review` page can render its five
 * sub-tabs (Queue · Mine · Escalations · SLA · Workload) without
 * waterfalling five sequential network requests. Every section
 * runs in parallel, each is wrapped in its own try/catch so a
 * single sub-query failure degrades only its section, and every
 * payload carries a hard count cap.
 *
 * Hard rules:
 *
 *   1. Side-effect free. No audit emission. No analytics writes.
 *      Reviewer action endpoints continue to live in
 *      `reviewer-ops.routes.ts` and `review-operations.routes.ts`
 *      — this aggregator is a pure read.
 *
 *   2. Bounded payloads. Every section cap is documented inline.
 *      Pagination for deeper drill-down still happens via the
 *      existing per-domain endpoints.
 *
 *   3. Tenancy-safe. `requireReviewerActor` validates membership;
 *      404 on non-member, 403 on inactive member, same anti-
 *      enumeration shape as the rest of `reviewer-ops.routes`.
 *
 *   4. Partial-failure tolerant. Any sub-query that throws yields
 *      `{ status: "degraded", rows: [], ... }` for its section.
 *      The envelope's `diagnostics.sectionStatus` records the
 *      outcome of each section for the frontend.
 *
 *   5. No new schema. Composes already-existing services:
 *        * listReviewerOpsQueue (queue rows)
 *        * buildDashboard       (SLA + workload + escalation counts)
 *        * listEscalations      (open escalation rows)
 *        * listLatestWorkloadSnapshots (workload rows)
 *        * listReviewerOpsSavedViews   (reviewer's saved views)
 */

import type {
  FastifyInstance,
  FastifyPluginOptions,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";

import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { contextHasCapability, evaluateAuthorizedWorkspace } from "../middleware/authorize.js";
import { workspaceIncludesReviewCapability } from "../services/billing-enforcement.service.js";
import {
  buildDashboard,
  listReviewerOpsQueue,
} from "../services/reviewer-ops/reviewer-operations-engine.service.js";
import { countEscalations, listEscalations } from "../services/reviewer-ops/escalation-engine.service.js";
import { listLatestWorkloadSnapshots } from "../services/reviewer-ops/workload.service.js";
import { listReviewerOpsSavedViews } from "../services/reviewer-ops/saved-queue-views.service.js";

// Per-section cap. Deliberately tight — operators drill down via
// the existing per-domain endpoints. The console envelope is for
// "at-a-glance + first-25" reviewer triage, not bulk export.
const SECTION_LIMIT = 25;

const ConsoleQuery = z.object({
  teamId: z.string().uuid(),
});

type SectionStatus = "ok" | "degraded";

async function safeSection<T>(
  fn: () => Promise<T>,
  empty: T,
  request: FastifyRequest,
  surface: string,
): Promise<{ status: SectionStatus; value: T }> {
  try {
    const value = await fn();
    return { status: "ok", value };
  } catch (err) {
    request.log.warn(
      {
        surface,
        err: err instanceof Error ? err.message.slice(0, 200) : "unknown",
      },
      "reviewer_console.section_failed",
    );
    return { status: "degraded", value: empty };
  }
}

/**
 * A2-03 — the reviewer-ops admission (`requireReviewerActor` in
 * reviewer-ops.routes.ts), applied to the console that composes the same
 * queue, escalation, SLA and workload data. The canonical chain decides
 * membership, access expiry and Organization lifecycle; the commercial gate is
 * the one review-capability ladder at REVIEW_TASKS_AND_QUEUES, the capability
 * the per-domain reviewer-ops routes require for this data. Deny shapes are
 * unchanged: 404 for a non-member, 403 REVIEW_ACTOR_BLOCKED for a blocked one.
 */
async function ensureReviewerActor(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
): Promise<{ userId: string; isReviewerCapable: boolean } | null> {
  const outcome = await evaluateAuthorizedWorkspace(req, {
    workspaceId: teamId,
    permission: "evidence.read",
    antiEnumeration: false,
  });
  if (!outcome.allowed) {
    if (outcome.reasonCode === "no_actor" || outcome.reasonCode === "missing_team_id") {
      reply.code(404).send({ error: { code: "not_found" } });
      return null;
    }
    if (outcome.reasonCode === "missing_actor") {
      reply.code(401).send({ error: { code: "unauthenticated" } });
      return null;
    }
    reply.code(outcome.httpStatus === 503 ? 503 : 403).send({
      error: {
        code: "REVIEW_ACTOR_BLOCKED",
        reason: outcome.reasonCode === "member_not_active" ? "member_inactive" : outcome.reasonCode,
      },
    });
    return null;
  }
  const authorized = outcome.context;
  // After admission, so a non-member learns nothing about the plan.
  if (!(await workspaceIncludesReviewCapability(authorized.workspaceId, "REVIEW_TASKS_AND_QUEUES"))) {
    reply.code(403).send({
      error: {
        code: "ENTITLEMENT_REQUIRED",
        reason: "reviewer_operations_not_included",
        entitlement: "REVIEW_TASKS_AND_QUEUES",
        requestId: req.id,
      },
    });
    return null;
  }
  return {
    userId: authorized.userId,
    isReviewerCapable: contextHasCapability(authorized, "evidence_request.review"),
  };
}

export async function reviewerConsoleRoutes(
  app: FastifyInstance,
  opts: FastifyPluginOptions & { prismaClient?: PrismaClient } = {},
): Promise<void> {
  // Fastify calls plugins as `(app, opts)`. The injected Prisma client
  // therefore has to travel INSIDE `opts` — a bare second positional
  // parameter would be bound to Fastify's own options object on every
  // real registration, and `client` would silently become `{}` rather
  // than a Prisma client. Every service call below is anchored to this
  // one constant, which falls back to the module-level `prisma` when no
  // client is injected.
  const client: PrismaClient = opts.prismaClient ?? prisma;

  app.get(
    "/v1/reviewer-ops/console",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // Use safeParse so a bad query never throws an uncaught
      // ZodError — the central error handler currently maps that to
      // 500 and Sentry captures it. A bounded 400 is the right shape.
      const parsedQuery = ConsoleQuery.safeParse(req.query ?? {});
      if (!parsedQuery.success) {
        return reply.code(400).send({
          error: {
            code: "INVALID_QUERY",
            message: "Workspace id is required and must be a UUID.",
            requestId: req.id,
          },
        });
      }
      const { teamId } = parsedQuery.data;
      const ctx = await ensureReviewerActor(req, reply, teamId);
      if (!ctx) return;

      const generatedAt = new Date().toISOString();

      // Compose the five sections + saved views + dashboard
      // rollup in parallel. Each is wrapped so one degraded query
      // never collapses the envelope.
      const [
        queueSection,
        mineSection,
        escalationSection,
        dashboardSection,
        workloadSection,
        savedViewsSection,
      ] = await Promise.all([
        safeSection(
          () =>
            listReviewerOpsQueue(
              {
                teamId,
                meUserId: ctx.userId,
                queue: "UNASSIGNED",
                limit: SECTION_LIMIT,
              },
              client,
            ),
          // Empty shape mirrors `listReviewerOpsQueue`'s return:
          // `{ rows, nextCursor }`. `nextCursor` is null in the
          // empty case.
          { rows: [] as ReadonlyArray<unknown>, nextCursor: null as string | null },
          req,
          "queue",
        ),
        safeSection(
          () =>
            listReviewerOpsQueue(
              {
                teamId,
                meUserId: ctx.userId,
                // The "assigned-to-me" slice is the
                // `MY_REVIEWS` queue per the shared
                // `REVIEWER_OPS_QUEUE_TYPES` vocabulary.
                queue: "MY_REVIEWS",
                limit: SECTION_LIMIT,
              },
              client,
            ),
          { rows: [] as ReadonlyArray<unknown>, nextCursor: null as string | null },
          req,
          "mine",
        ),
        safeSection(
          () =>
            // ACTIVE = OPEN ∪ ACKNOWLEDGED ∪ REASSIGNED — the same set the
            // dashboard's open-escalation count reads (TEAM-SPEC §2.7); an
            // acknowledged escalation is still open work. `total` is the
            // count under the same filter, unbounded by the section limit.
            activeEscalationsWithTotal(teamId, ctx.userId, client),
          { rows: [] as Awaited<ReturnType<typeof listEscalations>>, total: 0 },
          req,
          "escalations",
        ),
        safeSection(
          () =>
            buildDashboard(
              { teamId, meUserId: ctx.userId },
              client,
            ),
          null,
          req,
          "dashboard",
        ),
        safeSection(
          () =>
            listLatestWorkloadSnapshots(
              { teamId, limit: SECTION_LIMIT },
              client,
            ),
          [],
          req,
          "workload",
        ),
        safeSection(
          () =>
            listReviewerOpsSavedViews({ teamId, userId: ctx.userId }),
          [],
          req,
          "savedViews",
        ),
      ]);

      // SLA section reuses the dashboard's `counts` rollup —
      // bounded by construction. We surface it as its own section
      // for the frontend tab even though the data shares a query
      // with the workload card.
      //
      // Phase O Stage 3 (Sentry NODE-11 repair): wrap the
      // composition in a try/catch and use optional chaining so a
      // partially-shaped `dashboardSection.value` (e.g. a service
      // returning a stub object that lacks `counts`) degrades the
      // section honestly instead of throwing "Cannot read 'X' of
      // undefined" up to the central error handler.
      let slaSnapshot: {
        unassigned: number;
        overdue: number;
        dueSoon: number;
        openEscalations: number;
        criticalEscalationsOpen: number;
      } | null = null;
      let slaStatus: SectionStatus = dashboardSection.status;
      try {
        const dv = dashboardSection.value as
          | {
              counts?: {
                unassigned?: number;
                overdue?: number;
                dueSoon?: number;
              };
              openEscalations?: number;
              criticalEscalationsOpen?: number;
            }
          | null;
        if (dv && dv.counts) {
          slaSnapshot = {
            unassigned: dv.counts.unassigned ?? 0,
            overdue: dv.counts.overdue ?? 0,
            dueSoon: dv.counts.dueSoon ?? 0,
            openEscalations: dv.openEscalations ?? 0,
            criticalEscalationsOpen: dv.criticalEscalationsOpen ?? 0,
          };
        }
      } catch (err) {
        req.log.warn(
          {
            surface: "sla",
            err: err instanceof Error ? err.message.slice(0, 200) : "unknown",
          },
          "reviewer_console.section_failed",
        );
        slaStatus = "degraded";
        slaSnapshot = null;
      }

      return reply.code(200).send({
        generatedAt,
        teamId,
        reviewer: {
          userId: ctx.userId,
          isReviewerCapable: ctx.isReviewerCapable,
        },
        // Tab 1 — UNASSIGNED queue (top 25).
        queue: {
          rows: queueSection.value.rows,
          status: queueSection.status,
          count: queueSection.value.rows.length,
        },
        // Tab 2 — MINE (assigned to me, top 25).
        mine: {
          rows: mineSection.value.rows,
          status: mineSection.status,
          count: mineSection.value.rows.length,
        },
        // Tab 3 — Escalations (open, ack, reassigned).
        escalations: {
          rows: escalationSection.value.rows,
          status: escalationSection.status,
          count: escalationSection.value.total,
        },
        // Tab 4 — SLA rollup.
        sla: {
          snapshot: slaSnapshot,
          status: slaStatus,
        },
        // Tab 5 — Workload (latest snapshots, top 25 reviewers).
        workload: {
          rows: workloadSection.value,
          status: workloadSection.status,
          count: workloadSection.value.length,
        },
        // Reviewer ergonomics — saved queue views the reviewer
        // can switch into with a single click / keystroke.
        savedViews: {
          rows: savedViewsSection.value,
          status: savedViewsSection.status,
          count: savedViewsSection.value.length,
        },
        // Section status surface — frontend uses this to render a
        // bounded "degraded" badge per tab rather than throwing.
        diagnostics: {
          sectionStatus: {
            queue: queueSection.status,
            mine: mineSection.status,
            escalations: escalationSection.status,
            sla: slaStatus,
            workload: workloadSection.status,
            savedViews: savedViewsSection.status,
          },
          // Bounded — used by frontend to render the
          // section-limit badge ("Showing first 25").
          sectionLimit: SECTION_LIMIT,
        },
      });
    },
  );
}

/**
 * TEAM-SPEC §2.7 — the console's Escalations section: ACTIVE escalations
 * (OPEN ∪ ACKNOWLEDGED ∪ REASSIGNED) up to the section limit, and `total`, the
 * count under the same filter.
 */
async function activeEscalationsWithTotal(
  teamId: string,
  viewerUserId: string,
  client: Parameters<typeof listEscalations>[1],
): Promise<{ rows: Awaited<ReturnType<typeof listEscalations>>; total: number }> {
  const [rows, total] = await Promise.all([
    listEscalations({ teamId, status: "ACTIVE", limit: SECTION_LIMIT, viewerUserId }, client),
    countEscalations({ teamId, status: "ACTIVE", viewerUserId }, client),
  ]);
  return { rows, total };
}
