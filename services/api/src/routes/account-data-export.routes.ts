/**
 * Lifecycle Phase 4 (2026-07-17) — personal account data export routes.
 *
 *   GET  /v1/identity/data-export           — the caller's request history
 *   POST /v1/identity/data-export           — request an export (step-up;
 *                                             one active request per user;
 *                                             rate-limited by that rule)
 *   GET  /v1/identity/data-export/:id/download
 *                                           — download a READY package
 *                                             (step-up; strictly
 *                                             user-bound; audited)
 *
 * Universal account capability — never plan- or workspace-gated. There is
 * NO public or signed URL: download is an authenticated route bound to
 * the requesting user, so a leaked link is worthless without the session
 * AND step-up proof.
 *
 * TENANT_SCOPE_EXCEPTION: account_tier_user_scoped
 * Every query is keyed by getAuthUserId(req); no workspace dimension.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { prisma } from "../db.js";
import { getAuthUserId } from "../auth.js";
import { AppError, ErrorCode } from "../errors.js";
import { requireAuth } from "../middleware/auth.js";
// PHASE 10 §13.2 — managed-identity personal-export guard.
import { assertPersonalExportAllowed } from "../services/identity/identity-mode.service.js";
import {
  verifyAccountStepUp,
  type AccountStepUpProof,
} from "../services/identity-security/account-step-up.service.js";
import { emitPlatformAudit } from "../services/audit/tenant-audit.service.js";

const RequestBody = z.object({
  stepUp: z
    .object({
      method: z.enum(["password", "mfa"]).optional(),
      currentPassword: z.string().optional(),
      code: z.string().optional(),
    })
    .optional(),
});

const IdParams = z.object({ id: z.string().uuid() });

export async function accountDataExportRoutes(app: FastifyInstance) {
  app.get(
    "/v1/identity/data-export",
    { preHandler: requireAuth },
    async (req: FastifyRequest) => {
      const userId = getAuthUserId(req);
      if (!userId) throw new AppError(ErrorCode.UNAUTHORIZED, "Sign in.");
      const requests = await prisma.accountDataExportRequest.findMany({
        where: { userId },
        select: {
          id: true,
          status: true,
          requestedAtUtc: true,
          completedAtUtc: true,
          expiresAtUtc: true,
          failureCode: true,
          packageSha256: true,
          downloadCount: true,
        },
        orderBy: { requestedAtUtc: "desc" },
        take: 10,
      });
      return { requests };
    },
  );

  app.post(
    "/v1/identity/data-export",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = getAuthUserId(req);
      if (!userId) throw new AppError(ErrorCode.UNAUTHORIZED, "Sign in.");
      const body = RequestBody.parse(req.body ?? {});

      // PHASE 10 §13.2 (2026-07-22) — a MANAGED_ENTERPRISE identity has NO
      // personal data export; the organization controls its data
      // lifecycle. Fail closed BEFORE step-up so a managed user cannot
      // even initiate a personal export. Dormant (all STANDARD) until the
      // identity_mode migration is applied.
      try {
        await assertPersonalExportAllowed(userId);
      } catch (err) {
        const e = err as { statusCode?: number; code?: string; message?: string };
        return reply.code(e.statusCode ?? 403).send({
          error: {
            code: e.code ?? "MANAGED_IDENTITY_NO_PERSONAL_EXPORT",
            message: e.message ?? "Personal data export is not available for managed identities.",
          },
        });
      }

      const stepUp = await verifyAccountStepUp({
        req,
        reply,
        userId,
        action: "data_export_request",
        proof: body.stepUp,
      });
      if (!stepUp.ok) {
        return reply.code(stepUp.denial.status).send(stepUp.denial.body);
      }

      // ONE active request per user — this is also the rate limit: a new
      // request is possible only after the previous one completes/expires.
      const active = await prisma.accountDataExportRequest.findFirst({
        where: { userId, status: { in: ["REQUESTED", "PROCESSING", "READY"] } },
        select: { id: true, status: true },
      });
      if (active) {
        return reply.code(409).send({
          error: {
            code: "export_request_active",
            message:
              "An export is already requested or ready. Download or wait for it to expire before requesting another.",
          },
        });
      }

      const created = await prisma.accountDataExportRequest.create({
        data: { userId, status: "REQUESTED" },
        select: { id: true, status: true, requestedAtUtc: true },
      });
      await emitPlatformAudit({
        action: "identity.data_export_requested",
        outcome: "success",
        sourceApp: "API",
        actorUserId: userId,
        resourceType: "account_data_export_request",
        resourceId: created.id,
        correlationId: req.id,
        metadata: {},
      }).catch(() => null);
      return reply.code(201).send({ request: created });
    },
  );

  // POST download — the step-up proof travels in the JSON body (a GET
  // cannot carry it safely and query params are forbidden for proof
  // material), and the package is returned as an attachment. Strictly
  // bound to the requesting user's own READY request.
  app.post<{ Params: { id: string } }>(
    "/v1/identity/data-export/:id/download",
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      if (!userId) throw new AppError(ErrorCode.UNAUTHORIZED, "Sign in.");
      const params = IdParams.parse(req.params);
      const body = (req.body ?? {}) as { stepUp?: AccountStepUpProof };

      const stepUp = await verifyAccountStepUp({
        req,
        reply,
        userId,
        action: "data_export_download",
        proof: body.stepUp,
      });
      if (!stepUp.ok) {
        return reply.code(stepUp.denial.status).send(stepUp.denial.body);
      }

      const row = await prisma.accountDataExportRequest.findFirst({
        where: { id: params.id, userId },
        select: {
          id: true,
          status: true,
          expiresAtUtc: true,
          packageJson: true,
          packageSha256: true,
        },
      });
      if (!row) {
        return reply.code(404).send({ error: { code: "export_not_found" } });
      }
      if (
        row.status !== "READY" ||
        !row.packageJson ||
        (row.expiresAtUtc && row.expiresAtUtc.getTime() < Date.now())
      ) {
        return reply.code(409).send({
          error: {
            code: "export_not_ready",
            message: "This export is not available for download.",
          },
        });
      }

      await prisma.accountDataExportRequest.update({
        where: { id: row.id },
        data: {
          downloadCount: { increment: 1 },
          lastDownloadedAtUtc: new Date(),
        },
      });
      await emitPlatformAudit({
        action: "identity.data_export_downloaded",
        outcome: "success",
        sourceApp: "API",
        actorUserId: userId,
        resourceType: "account_data_export_request",
        resourceId: row.id,
        correlationId: req.id,
        metadata: { sha256: row.packageSha256 },
      }).catch(() => null);

      reply.header("content-type", "application/json; charset=utf-8");
      reply.header(
        "content-disposition",
        `attachment; filename="proovra-account-export-${row.id}.json"`,
      );
      reply.header("x-package-sha256", row.packageSha256 ?? "");
      return reply.code(200).send(row.packageJson);
    },
  );
}
