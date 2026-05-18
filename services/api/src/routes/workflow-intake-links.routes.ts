/**
 * Phase 4 — Authenticated admin routes for workflow intake links.
 *
 *   POST  /v1/workflow/intake-links              — create
 *   GET   /v1/workflow/intake-links              — list
 *   GET   /v1/workflow/intake-links/:id          — get
 *   POST  /v1/workflow/intake-links/:id/revoke   — revoke
 *
 * All routes require authentication. Mutations additionally require role
 * >= ADMIN on the target workspace, matching the rule established by
 * Phase 2 workflow.routes.ts.
 *
 * Feature flag: every route returns 503 with
 *   { error: { code: "FEATURE_DISABLED", reason: "..." } }
 * when WORKFLOW_INTAKE_LINKS_ENABLED is not "true" or
 * WORKFLOW_INTAKE_TOKEN_SECRET is not configured.
 */

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";
import {
  WORKFLOW_INTAKE_LINK_STATUSES,
  WORKFLOW_INTAKE_MODES,
} from "@proovra/shared";

import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { hasRole } from "../services/rbac.js";
import {
  createWorkflowIntakeLink,
  getWorkflowIntakeLink,
  listWorkflowIntakeLinks,
  projectWorkflowIntakeLink,
  revokeWorkflowIntakeLink,
  sendIntakeLinkViaSms,
  WorkflowIntakeLinkError,
} from "../services/workflow-intake-link.service.js";
import {
  workflowIntakeFeatureDisabledReason,
} from "../services/workflow-intake-token.service.js";

// -----------------------------------------------------------------------------
// Zod schemas
// -----------------------------------------------------------------------------

const CreateBody = z.object({
  teamId: z.string().uuid(),
  workflowTemplateSlug: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$/, {
      message: "slug must be kebab-case",
    }),
  intakeMode: z.enum(WORKFLOW_INTAKE_MODES),
  caseId: z.string().uuid().nullable().optional(),
  recipientLabel: z.string().max(180).nullable().optional(),
  recipientEmail: z.string().email().nullable().optional(),
  recipientPhone: z.string().max(32).nullable().optional(),
  maxUses: z.number().int().min(1).max(10_000).optional(),
  maxFileCountPerSession: z.number().int().min(1).max(500).nullable().optional(),
  maxBytesPerSession: z
    .union([z.number().int().min(1), z.string().regex(/^\d{1,20}$/)])
    .nullable()
    .optional(),
  allowedAcceptedKinds: z
    .array(z.enum(["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"]))
    .max(4)
    .optional(),
  consentPolicyVersion: z.string().max(40).nullable().optional(),
  consentDisclosureText: z.string().max(4000).nullable().optional(),
  expiresAtUtc: z.string().datetime(),
  ipAllowlistCidrs: z.array(z.string().max(64)).max(32).optional(),
});

const ListQuery = z.object({
  teamId: z.string().uuid(),
  status: z.enum(WORKFLOW_INTAKE_LINK_STATUSES).optional(),
  workflowTemplateSlug: z.string().max(120).optional(),
  caseId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const RevokeBody = z
  .object({
    reason: z.string().max(400).nullable().optional(),
  })
  .optional();

const ParamsId = z.object({ id: z.string().uuid() });

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function sendFeatureDisabled(reply: FastifyReply): void {
  const reason = workflowIntakeFeatureDisabledReason() ?? "unknown";
  reply.code(503).send({
    error: {
      code: "FEATURE_DISABLED",
      reason,
      message: "Workflow intake links are not enabled on this deployment",
    },
  });
}

async function requireAdmin(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
): Promise<{ userId: string } | null> {
  const userId = getAuthUserId(req);
  const membership = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
  });
  if (!membership) {
    reply
      .code(403)
      .send({ message: "Not a member of the requested workspace" });
    return null;
  }
  if (!hasRole(membership.role, "ADMIN")) {
    reply
      .code(403)
      .send({ message: "Admin role required for intake link administration" });
    return null;
  }
  return { userId };
}

async function requireMember(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
): Promise<{ userId: string } | null> {
  const userId = getAuthUserId(req);
  const membership = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
  });
  if (!membership) {
    reply
      .code(403)
      .send({ message: "Not a member of the requested workspace" });
    return null;
  }
  return { userId };
}

function bigintFromOptional(
  value: number | string | null | undefined,
): bigint | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return BigInt(value);
  return BigInt(value);
}

// -----------------------------------------------------------------------------
// Route registration
// -----------------------------------------------------------------------------

export async function workflowIntakeLinksRoutes(app: FastifyInstance) {
  // -- Create -----------------------------------------------------------

  app.post(
    "/v1/workflow/intake-links",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (workflowIntakeFeatureDisabledReason()) {
        return sendFeatureDisabled(reply);
      }

      const body = CreateBody.parse(req.body ?? {});
      const ok = await requireAdmin(req, reply, body.teamId);
      if (!ok) return;

      // Phase 9 — governance gate. Workspace policy can restrict
      // external / anonymous intake. Additive: workspaces without a
      // policy row continue to allow both.
      {
        const { canCreateIntakeLink, loadWorkspaceGovernancePolicy } =
          await import("../services/governance.service.js");
        const policy = await loadWorkspaceGovernancePolicy(body.teamId);
        const membership = await prisma.teamMember.findUnique({
          where: { teamId_userId: { teamId: body.teamId, userId: ok.userId } },
        });
        const decision = canCreateIntakeLink({
          role: membership?.role,
          intakeMode: body.intakeMode,
          policy,
        });
        if (!decision.allowed) {
          return reply.code(403).send({
            error: { code: decision.reason },
          });
        }
      }

      try {
        const result = await createWorkflowIntakeLink(
          {
            teamId: body.teamId,
            workflowTemplateSlug: body.workflowTemplateSlug,
            intakeMode: body.intakeMode,
            caseId: body.caseId ?? null,
            recipientLabel: body.recipientLabel ?? null,
            recipientEmail: body.recipientEmail ?? null,
            recipientPhone: body.recipientPhone ?? null,
            maxUses: body.maxUses,
            maxFileCountPerSession: body.maxFileCountPerSession ?? null,
            maxBytesPerSession: bigintFromOptional(body.maxBytesPerSession),
            allowedAcceptedKinds: body.allowedAcceptedKinds,
            consentPolicyVersion: body.consentPolicyVersion ?? null,
            consentDisclosureText: body.consentDisclosureText ?? null,
            expiresAtUtc: new Date(body.expiresAtUtc),
            ipAllowlistCidrs: body.ipAllowlistCidrs,
          },
          { actorUserId: ok.userId },
        );

        return reply.code(201).send({
          link: projectWorkflowIntakeLink(result.link),
          rawToken: result.rawToken,
          warning:
            "The raw token is shown exactly once. Capture it now — it is not retrievable later.",
        });
      } catch (err) {
        if (err instanceof WorkflowIntakeLinkError) {
          const status = err.code === "feature_disabled" ? 503 : 400;
          return reply.code(status).send({
            error: { code: err.code, message: err.message },
          });
        }
        const message =
          err instanceof Error ? err.message : "Failed to create intake link";
        return reply.code(400).send({ message });
      }
    },
  );

  // -- List -------------------------------------------------------------

  app.get(
    "/v1/workflow/intake-links",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (workflowIntakeFeatureDisabledReason()) {
        return sendFeatureDisabled(reply);
      }

      const query = ListQuery.parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId);
      if (!ok) return;

      const rows = await listWorkflowIntakeLinks({
        teamId: query.teamId,
        status: query.status,
        workflowTemplateSlug: query.workflowTemplateSlug,
        caseId: query.caseId,
        limit: query.limit,
      });

      return reply.code(200).send({
        links: rows.map(projectWorkflowIntakeLink),
      });
    },
  );

  // -- Get --------------------------------------------------------------

  app.get(
    "/v1/workflow/intake-links/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (workflowIntakeFeatureDisabledReason()) {
        return sendFeatureDisabled(reply);
      }

      const { id } = ParamsId.parse(req.params);
      const link = await getWorkflowIntakeLink(id);
      if (!link) {
        return reply.code(404).send({ message: "Intake link not found" });
      }

      const ok = await requireMember(req, reply, link.teamId);
      if (!ok) return;

      return reply
        .code(200)
        .send({ link: projectWorkflowIntakeLink(link) });
    },
  );

  // -- Revoke -----------------------------------------------------------

  app.post(
    "/v1/workflow/intake-links/:id/revoke",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (workflowIntakeFeatureDisabledReason()) {
        return sendFeatureDisabled(reply);
      }

      const { id } = ParamsId.parse(req.params);
      const body = (RevokeBody.parse(req.body ?? {}) ?? {}) as {
        reason?: string | null;
      };

      const existing = await getWorkflowIntakeLink(id);
      if (!existing) {
        return reply.code(404).send({ message: "Intake link not found" });
      }

      const ok = await requireAdmin(req, reply, existing.teamId);
      if (!ok) return;

      const updated = await revokeWorkflowIntakeLink({
        id,
        teamId: existing.teamId,
        actorUserId: ok.userId,
        reason: body.reason ?? null,
      });
      if (!updated) {
        return reply.code(404).send({ message: "Intake link not found" });
      }

      return reply
        .code(200)
        .send({ link: projectWorkflowIntakeLink(updated) });
    },
  );

  // -- Phase 18: send via SMS / WhatsApp -------------------------------
  //
  // Operator-initiated delivery. Requires the rawToken from the initial
  // create call (we never persist it) and the public intakeUrl. The
  // service refuses to send for revoked/expired links and surfaces the
  // CommunicationMessage id on success.
  app.post(
    "/v1/workflow/intake-links/:id/send",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (workflowIntakeFeatureDisabledReason()) {
        return sendFeatureDisabled(reply);
      }
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({
          channel: z.enum(["SMS", "WHATSAPP"]).default("SMS"),
          rawToken: z.string().min(8).max(512),
          intakeUrl: z.string().url().max(1000),
        })
        .parse(req.body ?? {});
      const existing = await getWorkflowIntakeLink(id);
      if (!existing) {
        return reply.code(404).send({ message: "Intake link not found" });
      }
      const ok = await requireAdmin(req, reply, existing.teamId);
      if (!ok) return;
      const team = await prisma.team.findUnique({
        where: { id: existing.teamId },
        select: { name: true, evidenceWorkspaceLabel: true },
      });
      const workspaceName =
        team?.evidenceWorkspaceLabel ?? team?.name ?? "Your workspace";
      const result = await sendIntakeLinkViaSms({
        teamId: existing.teamId,
        intakeLinkId: id,
        rawToken: body.rawToken,
        intakeUrl: body.intakeUrl,
        channel: body.channel,
        actorUserId: ok.userId,
        workspaceName,
      });
      if (!result.ok) {
        const status =
          result.reason === "link_not_found"
            ? 404
            : result.reason === "link_revoked" ||
                result.reason === "link_expired"
              ? 409
              : result.reason === "link_missing_phone"
                ? 400
                : 502;
        return reply.code(status).send({ error: { code: result.reason } });
      }
      return reply
        .code(200)
        .send({ communicationMessageId: result.communicationMessageId });
    },
  );
}
