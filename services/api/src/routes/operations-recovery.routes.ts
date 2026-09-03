/**
 * Phase P2.5 — DR / Recovery operations routes.
 *
 *   GET  /v1/operations/recovery                       — last-N reports + readiness
 *   POST /v1/operations/recovery/validate-backup       — run backup validation
 *   POST /v1/operations/recovery/validate-restore      — run restore validation (step-up)
 *   GET  /v1/operations/recovery/reports               — paginated reports
 *   GET  /v1/operations/recovery/reports/:id           — single report
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { requireAuth } from "../middleware/auth.js";
import { requireStepUpForSensitiveAction } from "../services/identity-security/step-up-middleware.js";
import {
  validateBackup,
  validateRestore,
  listRecoveryReports,
  getRecoveryReport,
} from "../services/operations/recovery-validation.service.js";
import { getObjectLockStatus } from "../services/operations/object-lock-status.service.js";
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

export async function operationsRecoveryRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------
  // Readiness overview
  // -------------------------------------------------------------------
  app.get(
    "/v1/operations/recovery",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      const ctx = await requirePlatformOpsActor(req, reply, q.teamId);
      if (!ctx) return;
      // The overview deliberately shows only the most recent reports. The
      // number was a bare literal, so the page rendered "6 validation reports"
      // with no way to say whether a seventh existed.
      const REPORTS_CAP = 10;
      const reports = await listRecoveryReports({
        teamId: q.teamId,
        limit: REPORTS_CAP,
      });
      const objectLock = await getObjectLockStatus();
      const lastBackup = reports.find(
        (r) => r.kind === "backup_validation_report",
      );
      const lastRestore = reports.find(
        (r) => r.kind === "restore_validation_report",
      );
      return reply.code(200).send({
        readiness: {
          objectLockMode: objectLock.mode,
          lastBackupReport: lastBackup ?? null,
          lastRestoreReport: lastRestore ?? null,
          unsupportedDomains: [
            "infrastructure_database_backups",
            "infrastructure_s3_backups",
            "full_disaster_recovery_rehearsal",
            "cross_region_failover",
            "infrastructure_layer_restore_orchestration",
          ],
        },
        recentReports: reports,
        // The cap travels WITH the list. The page used to hardcode nothing at
        // all and present the length as the population.
        recentReportsCap: REPORTS_CAP,
      });
    },
  );

  // -------------------------------------------------------------------
  // Run backup validation
  // -------------------------------------------------------------------
  app.post(
    "/v1/operations/recovery/validate-backup",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = z
        .object({ teamId: z.string().uuid() })
        .parse(req.body ?? {});
      const ctx = await requirePlatformOpsActor(req, reply, body.teamId);
      if (!ctx) return;
      const report = await validateBackup({
        teamId: body.teamId,
        actorUserId: ctx.userId,
      });
      return reply.code(200).send({ report });
    },
  );

  // -------------------------------------------------------------------
  // Run restore validation (step-up gated)
  // -------------------------------------------------------------------
  app.post(
    "/v1/operations/recovery/validate-restore",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = z
        .object({ teamId: z.string().uuid() })
        .parse(req.body ?? {});
      const ctx = await requirePlatformOpsActor(req, reply, body.teamId);
      if (!ctx) return;
      const stepUp = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: body.teamId,
        userId: ctx.userId,
        purpose: "RESTORE_VALIDATION_EXECUTE",
        resourceKind: "recovery_validation",
        resourceId: "restore",
      });
      if (stepUp.sent) return;
      const report = await validateRestore({
        teamId: body.teamId,
        actorUserId: ctx.userId,
      });
      return reply.code(200).send({ report });
    },
  );

  // -------------------------------------------------------------------
  // List reports
  // -------------------------------------------------------------------
  app.get(
    "/v1/operations/recovery/reports",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({
          teamId: z.string().uuid(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(req.query ?? {});
      const ctx = await requirePlatformOpsActor(req, reply, q.teamId);
      if (!ctx) return;
      const reports = await listRecoveryReports({
        teamId: q.teamId,
        limit: q.limit,
      });
      return reply.code(200).send({ reports });
    },
  );

  // -------------------------------------------------------------------
  // Single report
  // -------------------------------------------------------------------
  app.get(
    "/v1/operations/recovery/reports/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = z
        .object({ id: z.string().min(1).max(120) })
        .parse(req.params);
      const q = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      const ctx = await requirePlatformOpsActor(req, reply, q.teamId);
      if (!ctx) return;
      const report = await getRecoveryReport({
        teamId: q.teamId,
        reportId: params.id,
      });
      if (!report) {
        return reply
          .code(404)
          .send({ error: { code: "not_found", message: "Report not found." } });
      }
      return reply.code(200).send({ report });
    },
  );
}
