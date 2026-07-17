/**
 * Lifecycle Phase 5 (2026-07-17) — personal account closure routes.
 *
 *   GET  /v1/identity/account-closure            — latest request + live
 *                                                  preflight blockers
 *   POST /v1/identity/account-closure            — request closure
 *                                                  (step-up + typed
 *                                                  confirmation phrase;
 *                                                  one open request)
 *   POST /v1/identity/account-closure/:id/cancel — cancel during the
 *                                                  cooling-off window
 *
 * Universal account capability — never plan- or workspace-gated. The
 * confirmation is a TYPED PHRASE validated server-side (a frontend
 * boolean is never trusted); step-up proof is verified in the same
 * request. Execution is asynchronous: the row enters COOLING_OFF and the
 * closure worker (digest cron) re-checks preflight before PROCESSING.
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
import { verifyAccountStepUp } from "../services/identity-security/account-step-up.service.js";
import {
  ACTIVE_CLOSURE_STATUSES,
  CANCELLABLE_CLOSURE_STATUSES,
  COOLING_OFF_MS,
} from "../services/identity/account-closure.service.js";
import { evaluateAccountClosurePreflight } from "../services/identity/account-lifecycle-preflight.service.js";
import { appendPlatformAuditLog } from "../services/platform-audit-log.service.js";

/** The exact phrase the user must type. Compared case-insensitively. */
export const CLOSURE_CONFIRMATION_PHRASE = "close my account";

const RequestBody = z.object({
  confirmation: z.string().max(120),
  reason: z.string().max(500).optional(),
  stepUp: z
    .object({
      method: z.enum(["password", "mfa"]).optional(),
      currentPassword: z.string().optional(),
      code: z.string().optional(),
    })
    .optional(),
});

const IdParams = z.object({ id: z.string().uuid() });

const REQUEST_SELECT = {
  id: true,
  status: true,
  reason: true,
  blockersJson: true,
  requestedAtUtc: true,
  coolingOffEndsAtUtc: true,
  cancelledAtUtc: true,
  completedAtUtc: true,
  failureCode: true,
} as const;

export async function accountClosureRoutes(app: FastifyInstance) {
  app.get(
    "/v1/identity/account-closure",
    { preHandler: requireAuth },
    async (req: FastifyRequest) => {
      const userId = getAuthUserId(req);
      if (!userId) throw new AppError(ErrorCode.UNAUTHORIZED, "Sign in.");
      const [latest, preflight] = await Promise.all([
        prisma.accountClosureRequest.findFirst({
          where: { userId },
          select: REQUEST_SELECT,
          orderBy: { requestedAtUtc: "desc" },
        }),
        evaluateAccountClosurePreflight(userId),
      ]);
      return {
        request: latest,
        blockers: preflight.blockers,
        confirmationPhrase: CLOSURE_CONFIRMATION_PHRASE,
        coolingOffDays: Math.round(COOLING_OFF_MS / 86_400_000),
      };
    },
  );

  app.post(
    "/v1/identity/account-closure",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = getAuthUserId(req);
      if (!userId) throw new AppError(ErrorCode.UNAUTHORIZED, "Sign in.");
      const body = RequestBody.parse(req.body ?? {});

      // Typed confirmation phrase — validated SERVER-SIDE. A frontend
      // boolean or a missing/incorrect phrase never passes.
      const typed = body.confirmation.trim().toLowerCase();
      if (typed !== CLOSURE_CONFIRMATION_PHRASE) {
        return reply.code(400).send({
          error: {
            code: "confirmation_mismatch",
            message: `Type "${CLOSURE_CONFIRMATION_PHRASE}" to confirm.`,
          },
        });
      }

      const stepUp = await verifyAccountStepUp({
        req,
        reply,
        userId,
        action: "account_closure_request",
        proof: body.stepUp,
      });
      if (!stepUp.ok) {
        return reply.code(stepUp.denial.status).send(stepUp.denial.body);
      }

      const open = await prisma.accountClosureRequest.findFirst({
        where: { userId, status: { in: [...ACTIVE_CLOSURE_STATUSES] } },
        select: { id: true, status: true },
      });
      if (open) {
        return reply.code(409).send({
          error: {
            code: "closure_request_active",
            message: "An account closure request is already open.",
          },
        });
      }

      const { blockers } = await evaluateAccountClosurePreflight(userId);
      if (blockers.length > 0) {
        // Record the blocked attempt (audit trail) and surface the
        // stable blocker codes; the user can re-request after resolving.
        const blocked = await prisma.accountClosureRequest.create({
          data: {
            userId,
            status: "BLOCKED",
            reason: body.reason ?? null,
            blockersJson: JSON.stringify(blockers),
          },
          select: { id: true },
        });
        await appendPlatformAuditLog({
          userId,
          action: "identity.account_closure_blocked",
          category: "identity.lifecycle",
          severity: "warning",
          source: "api_account_closure",
          outcome: "denied",
          resourceType: "account_closure_request",
          resourceId: blocked.id,
          requestId: req.id,
          metadata: { blockers: blockers.map((b) => b.code) },
          ipAddress: null,
          userAgent: null,
        }).catch(() => null);
        return reply
          .code(409)
          .send({ error: { code: "closure_blocked" }, blockers });
      }

      const coolingOffEndsAtUtc = new Date(Date.now() + COOLING_OFF_MS);
      const created = await prisma.accountClosureRequest.create({
        data: {
          userId,
          status: "COOLING_OFF",
          reason: body.reason ?? null,
          coolingOffEndsAtUtc,
        },
        select: REQUEST_SELECT,
      });
      await appendPlatformAuditLog({
        userId,
        action: "identity.account_closure_requested",
        category: "identity.lifecycle",
        severity: "warning",
        source: "api_account_closure",
        outcome: "success",
        resourceType: "account_closure_request",
        resourceId: created.id,
        requestId: req.id,
        metadata: { coolingOffEndsAtUtc: coolingOffEndsAtUtc.toISOString() },
        ipAddress: null,
        userAgent: null,
      }).catch(() => null);
      return reply.code(201).send({ request: created });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/v1/identity/account-closure/:id/cancel",
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      if (!userId) throw new AppError(ErrorCode.UNAUTHORIZED, "Sign in.");
      const params = IdParams.parse(req.params);

      // Guarded update — cancellable statuses only, strictly own row.
      const cancelled = await prisma.accountClosureRequest.updateMany({
        where: {
          id: params.id,
          userId,
          status: { in: [...CANCELLABLE_CLOSURE_STATUSES] },
        },
        data: { status: "CANCELLED", cancelledAtUtc: new Date() },
      });
      if (cancelled.count === 0) {
        const exists = await prisma.accountClosureRequest.findFirst({
          where: { id: params.id, userId },
          select: { id: true },
        });
        if (!exists) {
          return reply.code(404).send({ error: { code: "closure_not_found" } });
        }
        return reply.code(409).send({
          error: {
            code: "closure_not_cancellable",
            message: "This request can no longer be cancelled.",
          },
        });
      }

      await appendPlatformAuditLog({
        userId,
        action: "identity.account_closure_cancelled",
        category: "identity.lifecycle",
        severity: "info",
        source: "api_account_closure",
        outcome: "success",
        resourceType: "account_closure_request",
        resourceId: params.id,
        requestId: req.id,
        metadata: {},
        ipAddress: null,
        userAgent: null,
      }).catch(() => null);

      const row = await prisma.accountClosureRequest.findFirst({
        where: { id: params.id, userId },
        select: REQUEST_SELECT,
      });
      return reply.code(200).send({ request: row });
    },
  );
}
