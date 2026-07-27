/**
 * Phase 2 — Enterprise activation & provisioning admin routes.
 *
 * Two platform-admin-only endpoints that activate an enterprise customer
 * without a manual DB edit. Both are gated by:
 *   1. requirePlatformAdmin (preHandler) — platform operator only.
 *   2. requireStepUpForSensitiveAction   — a fresh, single-use step-up
 *      approval via the `x-proovra-step-up-challenge-id` header. The
 *      challenge is scoped to the `teamId` the operator supplies (the
 *      workspace their step-up approval was minted against), mirroring
 *      the admin-identity.routes.ts pattern.
 *
 *   PATCH /v1/admin/orgs/:id/plan       — grant a plan to every workspace.
 *   POST  /v1/admin/enterprise/provision — provision a new customer.
 *
 * These are the ONLY admin paths that assign ENTERPRISE. The locked
 * billing checkout/webhook plan-assignment path is never touched here.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { requirePlatformAdmin } from "../middleware/require-platform-admin.js";
import { requireStepUpForSensitiveAction } from "../services/identity-security/step-up-middleware.js";
import {
  EnterpriseProvisioningError,
  grantEnterprisePlanToOrg,
  provisionEnterpriseCustomerIdempotent,
} from "../services/enterprise-provisioning.service.js";
// PHASE 4 §7.6 (2026-07-22) — org suspend/resume lifecycle.
import {
  resumeOrganization,
  suspendOrganization,
} from "../services/organization/org-lifecycle.service.js";

const UuidParam = z.string().uuid();

// Step-up challenges are bound to a team; the operator supplies the
// workspace their approval was minted against (same as admin-identity).
const StepUpTeamScope = z.object({
  teamId: z.string().uuid(),
});

const GrantPlanBody = StepUpTeamScope.extend({
  plan: z.literal("ENTERPRISE"),
  seats: z.number().int().min(1).max(100000).optional(),
});

const ProvisionBody = StepUpTeamScope.extend({
  organizationName: z.string().trim().min(1).max(180),
  ownerEmail: z.string().trim().toLowerCase().email().max(320),
  seats: z.number().int().min(1).max(100000).optional(),
  workspaceName: z.string().trim().min(1).max(120).optional(),
  // PHASE 4 §7.1 (2026-07-22) — REQUIRED immutable idempotency identity
  // (provisioning-request id / CRM contract reference). Names/emails are
  // never a duplicate-prevention identity.
  idempotencyKey: z.string().trim().min(8).max(120),
  externalContractRef: z.string().trim().min(1).max(200).optional(),
  region: z.string().trim().min(2).max(40).optional(),
});

function actorUserId(req: FastifyRequest): string {
  return req.user!.sub;
}

export async function adminProvisioningRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // PATCH /v1/admin/orgs/:id/plan
  //
  // Grant a billing plan (ENTERPRISE) to EVERY workspace of an org. Sets
  // billingPlan/includedSeats/billingStatus and recomputes overSeatLimit.
  // ---------------------------------------------------------------------------
  app.patch(
    "/v1/admin/orgs/:id/plan",
    { preHandler: requirePlatformAdmin },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const idParse = UuidParam.safeParse(
        (req.params as { id?: unknown }).id,
      );
      if (!idParse.success) {
        return reply.code(400).send({
          error: { code: "validation_error", detail: idParse.error.flatten() },
        });
      }
      const orgId = idParse.data;

      const bodyParse = GrantPlanBody.safeParse(req.body);
      if (!bodyParse.success) {
        return reply.code(400).send({
          error: {
            code: "validation_error",
            detail: bodyParse.error.flatten(),
          },
        });
      }
      const body = bodyParse.data;
      const userId = actorUserId(req);

      const gate = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: body.teamId,
        userId,
        purpose: "CAPABILITY_GRANT",
        resourceKind: "organization",
        resourceId: orgId,
      });
      if (gate.sent) return;

      try {
        const result = await grantEnterprisePlanToOrg({
          orgId,
          plan: body.plan,
          seats: body.seats,
          actorUserId: userId,
        });
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof EnterpriseProvisioningError) {
          return reply.code(404).send({
            error: { code: err.code, message: err.message },
          });
        }
        throw err;
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/admin/enterprise/provision
  //
  // Provision a new enterprise customer: create the Organization and either
  // an enterprise workspace (existing owner) or an ORG_OWNER invite (owner
  // does not exist yet).
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/admin/enterprise/provision",
    { preHandler: requirePlatformAdmin },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const bodyParse = ProvisionBody.safeParse(req.body);
      if (!bodyParse.success) {
        return reply.code(400).send({
          error: {
            code: "validation_error",
            detail: bodyParse.error.flatten(),
          },
        });
      }
      const body = bodyParse.data;
      const userId = actorUserId(req);

      const gate = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: body.teamId,
        userId,
        purpose: "CAPABILITY_GRANT",
        resourceKind: "enterprise_provision",
        resourceId: null,
      });
      if (gate.sent) return;

      // PHASE 4 §7.1 (2026-07-22) — idempotent provisioning: same key +
      // same payload replays the original result; same key + different
      // payload is a 409 conflict with zero mutation; concurrent same-key
      // requests collapse via the DB unique constraint.
      try {
        const outcome = await provisionEnterpriseCustomerIdempotent({
          organizationName: body.organizationName,
          ownerEmail: body.ownerEmail,
          seats: body.seats,
          workspaceName: body.workspaceName,
          actorUserId: userId,
          idempotencyKey: body.idempotencyKey,
          externalContractRef: body.externalContractRef ?? null,
          region: body.region ?? null,
        });
        return reply.code(outcome.idempotentReplay ? 200 : 201).send({
          ...outcome.result,
          idempotentReplay: outcome.idempotentReplay,
          possibleDuplicateOrganizationIds:
            outcome.possibleDuplicateOrganizationIds,
        });
      } catch (err) {
        if (err instanceof EnterpriseProvisioningError) {
          if (err.code === "IDEMPOTENCY_CONFLICT") {
            return reply
              .code(409)
              .send({ error: { code: err.code, message: err.message } });
          }
          if (err.code === "PROVISIONING_IN_PROGRESS") {
            return reply
              .code(409)
              .send({ error: { code: err.code, message: err.message } });
          }
        }
        throw err;
      }
    },
  );

  // ---------------------------------------------------------------------------
  // PHASE 4 §7.6 (2026-07-22) — organization suspend / resume.
  //
  // Platform-operator contract-enforcement actions (billing default,
  // abuse, contract lapse). Effects live in org-lifecycle.service.ts.
  // Same gate stack as provisioning: platform admin + fresh step-up.
  //
  //   POST /v1/admin/orgs/:id/suspend
  //   POST /v1/admin/orgs/:id/resume
  // ---------------------------------------------------------------------------
  const SuspendBody = StepUpTeamScope.extend({
    reason: z.string().trim().min(1).max(400).optional(),
  });

  for (const [leg, run] of [
    [
      "suspend",
      (orgId: string, userId: string, reason?: string | null) =>
        suspendOrganization({
          organizationId: orgId,
          actorUserId: userId,
          reason: reason ?? null,
        }),
    ],
    [
      "resume",
      (orgId: string, userId: string) =>
        resumeOrganization({ organizationId: orgId, actorUserId: userId }),
    ],
  ] as const) {
    app.post(
      `/v1/admin/orgs/:id/${leg}`,
      { preHandler: requirePlatformAdmin },
      async (req: FastifyRequest, reply: FastifyReply) => {
        const idParse = UuidParam.safeParse((req.params as { id?: unknown }).id);
        if (!idParse.success) {
          return reply.code(400).send({
            error: { code: "validation_error", detail: idParse.error.flatten() },
          });
        }
        const bodyParse = SuspendBody.safeParse(req.body);
        if (!bodyParse.success) {
          return reply.code(400).send({
            error: {
              code: "validation_error",
              detail: bodyParse.error.flatten(),
            },
          });
        }
        const userId = actorUserId(req);

        const gate = await requireStepUpForSensitiveAction({
          req,
          reply,
          teamId: bodyParse.data.teamId,
          userId,
          purpose: "CAPABILITY_GRANT",
          resourceKind: "organization",
          resourceId: idParse.data,
        });
        if (gate.sent) return;

        try {
          const result = await run(
            idParse.data,
            userId,
            bodyParse.data.reason ?? null,
          );
          return reply.code(200).send(result);
        } catch (err) {
          const e = err as Error & { statusCode?: number; code?: string };
          if (typeof e.statusCode === "number" && typeof e.code === "string") {
            return reply
              .code(e.statusCode)
              .send({ error: { code: e.code, message: e.message } });
          }
          throw err;
        }
      },
    );
  }
}
