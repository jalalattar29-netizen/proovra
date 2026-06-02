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

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";

import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { getAuthUserId } from "../auth.js";
import { evaluateMemberAccess } from "../services/identity/access-policy.service.js";
import {
  buildDashboard,
  listReviewerOpsQueue,
} from "../services/reviewer-ops/reviewer-operations-engine.service.js";
import { listEscalations } from "../services/reviewer-ops/escalation-engine.service.js";
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

async function ensureReviewerActor(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
): Promise<{ userId: string; isReviewerCapable: boolean } | null> {
  const userId = getAuthUserId(req);
  const member = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
    select: { id: true, status: true },
  });
  if (!member) {
    reply.code(404).send({ error: { code: "not_found" } });
    return null;
  }
  if (member.status !== "ACTIVE") {
    reply.code(403).send({
      error: { code: "REVIEW_ACTOR_BLOCKED", reason: "member_inactive" },
    });
    return null;
  }
  const reviewerCheck = await evaluateMemberAccess({
    teamId,
    userId,
    permission: "evidence_request.review",
  });
  return { userId, isReviewerCapable: reviewerCheck.allowed };
}

export async function reviewerConsoleRoutes(
  app: FastifyInstance,
  _options: object = {},
  prismaClient?: PrismaClient,
): Promise<void> {
  // Phase O Stage 3 (Sentry NODE-11 repair):
  //   - Fastify calls plugins as `(app, opts)` and never binds the
  //     third parameter, so the original `prismaClient: PrismaClient
  //     = prisma` default worked for production but BROKE for any
  //     caller (or wrapped registration) that explicitly passed
  //     `undefined` as the third argument — defaults only fill when
  //     the argument is undefined at call time, BUT some Fastify
  //     wrappers (and tests that wire plugins through a registration
  //     shim) pass the third arg explicitly. In that case
  //     `prismaClient` becomes `undefined`, every service call
  //     receives `undefined`, and the downstream `.groupBy of
  //     undefined` (or similar) crashes the request.
  //   - Re-anchor every service call to a local `client` constant
  //     that falls back to the module-level `prisma` whenever the
  //     third arg is missing OR explicitly `undefined`.
  const client: PrismaClient = prismaClient ?? prisma;

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
            // `ListEscalationsInput` accepts a single `status`
            // value or the literal "ALL". We pick `OPEN` here so
            // the top-of-tab matches the dashboard's primary
            // escalation count.
            listEscalations(
              {
                teamId,
                status: "OPEN",
                limit: SECTION_LIMIT,
              },
              client,
            ),
          [],
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
          rows: escalationSection.value,
          status: escalationSection.status,
          count: escalationSection.value.length,
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
