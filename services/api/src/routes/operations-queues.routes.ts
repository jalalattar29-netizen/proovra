/**
 * Phase P2.3 — Queue operations routes.
 *
 *   GET  /v1/operations/queues                          — inventory
 *   GET  /v1/operations/queues/workers                  — health
 *   GET  /v1/operations/queues/replay-safety            — matrix
 *   GET  /v1/operations/queues/:queueName/failed        — failed jobs
 *   POST /v1/operations/queues/:queueName/jobs/:jobId/retry   — retry
 *   POST /v1/operations/queues/:queueName/jobs/:jobId/replay  — step-up
 *   POST /v1/operations/queues/:queueName/jobs/:jobId/cancel  — cancel
 *
 * All endpoints are workspace-scoped (`teamId` query / body) and
 * require an active ops actor (same gate as other `/v1/ops/*` routes).
 * Replay routes additionally consult the bounded safety matrix and
 * route `requires_step_up` jobs through `QUEUE_JOB_REPLAY`.
 *
 * Notes:
 *   * The queues themselves are global (not per-workspace). The
 *     `teamId` is the AUDIT scope — operator actions are recorded
 *     against the workspace they're operating from. We do NOT filter
 *     jobs by team in the listing because failed jobs may originate
 *     from a different workspace than the one the operator is
 *     currently active in. This is documented in the operator
 *     runbook.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { prisma } from "../db.js";
import { getAuthUserId } from "../auth.js";
import { requireAuth } from "../middleware/auth.js";
import { evaluateMemberAccess } from "../services/identity/access-policy.service.js";
import { requireStepUpForSensitiveAction } from "../services/identity-security/step-up-middleware.js";
import { bump } from "../services/ops/metrics.service.js";
import {
  getQueueInventory,
  getWorkerHealth,
  listFailedJobs,
} from "../services/operations/queue-inventory.service.js";
import {
  getReplaySafetyMatrix,
  getJobReplayCategory,
  KNOWN_QUEUE_NAMES,
} from "../services/operations/queue-replay-safety.service.js";
import {
  cancelJob,
  replayFailedJob,
  retryFailedJob,
} from "../services/operations/queue-replay-action.service.js";
import { requirePlatformOpsActor } from "./require-platform-ops-actor.js";

/**
 * ADM-013 — the authority for this family lives in ONE place.
 *
 * This file used to carry its own local actor check, and so did the three
 * sibling families; three of the four copies were byte-identical and the
 * fourth differed only in name. All four authorized on
 * `identity.member.read`, which every authenticated user holds in their own
 * personal workspace — so every authenticated user could reach platform data
 * by passing their own `teamId`.
 *
 * See `require-platform-ops-actor.ts` for what was proven and why the check is
 * now platform authority AND workspace membership, in that order.
 */

const KnownQueueName = z.enum(KNOWN_QUEUE_NAMES as [string, ...string[]]);

export async function operationsQueuesRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------
  // Inventory
  // -------------------------------------------------------------------
  app.get(
    "/v1/operations/queues",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      const ctx = await requirePlatformOpsActor(req, reply, q.teamId);
      if (!ctx) return;
      const items = await getQueueInventory();
      // Aggregate counters for the dashboard summary card. Queues
      // marked "disabled" (no producer in this build) are excluded
      // from degradation totals — they are honestly off, not broken.
      let totalFailed = 0;
      let totalStalled = 0;
      let degradedCount = 0;
      for (const it of items) {
        totalFailed += it.counts.failed;
        totalStalled += it.stalledCount;
        if (it.health === "degraded" || it.health === "outage")
          degradedCount++;
      }
      if (totalStalled > 0) bump("worker_stalled_total");
      return reply.code(200).send({
        queues: items,
        summary: {
          queueCount: items.length,
          totalFailed,
          totalStalled,
          degradedCount,
        },
      });
    },
  );

  // -------------------------------------------------------------------
  // Worker health
  // -------------------------------------------------------------------
  app.get(
    "/v1/operations/queues/workers",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      const ctx = await requirePlatformOpsActor(req, reply, q.teamId);
      if (!ctx) return;
      const workers = await getWorkerHealth();
      const missingCount = workers.filter((w) => w.status === "missing").length;
      if (missingCount > 0) bump("worker_heartbeat_missing_total");
      return reply.code(200).send({ workers });
    },
  );

  // -------------------------------------------------------------------
  // Replay safety matrix
  // -------------------------------------------------------------------
  app.get(
    "/v1/operations/queues/replay-safety",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      const ctx = await requirePlatformOpsActor(req, reply, q.teamId);
      if (!ctx) return;
      return reply.code(200).send({ matrix: getReplaySafetyMatrix() });
    },
  );

  // -------------------------------------------------------------------
  // Failed jobs in a queue
  // -------------------------------------------------------------------
  app.get(
    "/v1/operations/queues/:queueName/failed",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = z
        .object({ queueName: KnownQueueName })
        .parse(req.params);
      const q = z
        .object({
          teamId: z.string().uuid(),
          limit: z.coerce.number().int().min(1).max(50).optional(),
        })
        .parse(req.query ?? {});
      const ctx = await requirePlatformOpsActor(req, reply, q.teamId);
      if (!ctx) return;
      const jobs = await listFailedJobs(params.queueName, q.limit);
      if (jobs.length > 0) bump("dlq_job_total");
      return reply.code(200).send({ jobs });
    },
  );

  // -------------------------------------------------------------------
  // Retry
  // -------------------------------------------------------------------
  app.post(
    "/v1/operations/queues/:queueName/jobs/:jobId/retry",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = z
        .object({ queueName: KnownQueueName, jobId: z.string().min(1).max(200) })
        .parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          reason: z.string().min(1).max(240),
        })
        .parse(req.body ?? {});
      const ctx = await requirePlatformOpsActor(req, reply, body.teamId);
      if (!ctx) return;
      // Retry is allowed for `safe` and `requires_step_up` jobs.
      // The category gate runs INSIDE the action service.
      const result = await retryFailedJob({
        queueName: params.queueName,
        jobId: params.jobId,
        actorUserId: ctx.userId,
        teamId: body.teamId,
        reason: body.reason,
      });
      if (!result.ok) {
        const status =
          result.code === "replay_forbidden"
            ? 403
            : result.code === "job_not_found"
              ? 404
              : 400;
        return reply
          .code(status)
          .send({ error: { code: result.code, message: result.message } });
      }
      return reply.code(200).send({ result });
    },
  );

  // -------------------------------------------------------------------
  // Replay (step-up gated when matrix says so)
  // -------------------------------------------------------------------
  app.post(
    "/v1/operations/queues/:queueName/jobs/:jobId/replay",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = z
        .object({ queueName: KnownQueueName, jobId: z.string().min(1).max(200) })
        .parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          reason: z.string().min(1).max(240),
          /** Caller-provided hint; we re-derive the category server-side. */
          expectedJobName: z.string().max(100).optional(),
        })
        .parse(req.body ?? {});
      const ctx = await requirePlatformOpsActor(req, reply, body.teamId);
      if (!ctx) return;

      // If the caller knows the job name, we can pre-gate without an
      // extra round-trip. Otherwise the action service does the gate
      // after pulling the job.
      if (body.expectedJobName) {
        const cat = getJobReplayCategory(params.queueName, body.expectedJobName);
        if (cat === "requires_step_up") {
          const stepUp = await requireStepUpForSensitiveAction({
            req,
            reply,
            teamId: body.teamId,
            userId: ctx.userId,
            purpose: "QUEUE_JOB_REPLAY",
            resourceKind: "queue_job",
            resourceId: `${params.queueName}:${params.jobId}`,
          });
          if (stepUp.sent) return;
        }
      }

      const result = await replayFailedJob({
        queueName: params.queueName,
        jobId: params.jobId,
        actorUserId: ctx.userId,
        teamId: body.teamId,
        reason: body.reason,
      });
      if (!result.ok) {
        const status =
          result.code === "replay_forbidden"
            ? 403
            : result.code === "job_not_found"
              ? 404
              : 400;
        return reply
          .code(status)
          .send({ error: { code: result.code, message: result.message } });
      }
      return reply.code(200).send({ result });
    },
  );

  // -------------------------------------------------------------------
  // Cancel
  // -------------------------------------------------------------------
  app.post(
    "/v1/operations/queues/:queueName/jobs/:jobId/cancel",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = z
        .object({ queueName: KnownQueueName, jobId: z.string().min(1).max(200) })
        .parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          reason: z.string().min(1).max(240),
        })
        .parse(req.body ?? {});
      const ctx = await requirePlatformOpsActor(req, reply, body.teamId);
      if (!ctx) return;
      const result = await cancelJob({
        queueName: params.queueName,
        jobId: params.jobId,
        actorUserId: ctx.userId,
        teamId: body.teamId,
        reason: body.reason,
      });
      if (!result.ok) {
        const status =
          result.code === "job_not_found"
            ? 404
            : 400;
        return reply
          .code(status)
          .send({ error: { code: result.code, message: result.message } });
      }
      return reply.code(200).send({ result });
    },
  );
}
