/**
 * Phase E3 — Operational Automation Foundation routes.
 *
 *   GET    /v1/automation/rules?teamId=                — list rules
 *   POST   /v1/automation/rules                        — create rule
 *   PATCH  /v1/automation/rules/:id                    — update rule
 *   POST   /v1/automation/rules/:id/enable             — enable
 *   POST   /v1/automation/rules/:id/disable            — disable
 *   GET    /v1/automation/runs?teamId=                 — list runs
 *   GET    /v1/automation/runs/:id                     — fetch one run
 *
 * Hard rules:
 *   - Every endpoint requires authentication + team membership.
 *   - VIEW endpoints require `AUTOMATION_VIEW` (team writers + admins).
 *   - MANAGE endpoints (create / update / enable / disable) require
 *     `AUTOMATION_MANAGE` (admin / owner only).
 *   - All inputs strictly validated against the bounded allowlist.
 *   - Audit-event emission is intentionally NOT wired in this routes
 *     file — the E3 service layer owns the canonical emission once
 *     the trigger dispatcher lands in E3.1 (DEF-021). For now, rule
 *     mutations are persisted; the corresponding security events
 *     remain in the SECURITY_EVENT_TYPES vocabulary ready for E3.1
 *     to consume.
 */

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";

import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { resolveCapabilities } from "../services/platform-context/capability-registry.js";
import { isPlatformAdmin } from "../services/platform-admin.service.js";
import {
  AUTOMATION_ACTION_TYPES,
  AUTOMATION_TRIGGER_TYPES,
  CreateAutomationRuleInput,
  UpdateAutomationRuleInput,
  validateActionConfig,
  validateCondition,
  type AutomationActionType,
  type AutomationTriggerType,
} from "../services/automation/automation.service.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ParamsId = z.object({ id: z.string().uuid() });
const TeamIdQuery = z.object({ teamId: z.string().uuid() });
const ListRunsQuery = z.object({
  teamId: z.string().uuid(),
  ruleId: z.string().uuid().optional(),
  status: z
    .enum(["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "SKIPPED"])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

type Capability = "AUTOMATION_VIEW" | "AUTOMATION_MANAGE";

/**
 * Resolve team membership + capability. Returns either the
 * authenticated userId (allowed) or null (already replied to client).
 */
async function requireTeamCapability(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
  capability: Capability,
): Promise<{ userId: string } | null> {
  const userId = getAuthUserId(req);
  const membership = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
  });
  if (!membership) {
    reply.code(403).send({ message: "Not a member of the workspace" });
    return null;
  }
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    select: {
      id: true,
      isPersonal: true,
      billingPlan: true,
      ownerUserId: true,
    },
  });
  if (!team) {
    reply.code(404).send({ message: "Workspace not found" });
    return null;
  }
  const platformAdmin = await isPlatformAdmin(userId);
  // The capability resolver uses scope = "PERSONAL" | "TEAM" (legacy
  // shape carried since CR0 baseline). Personal Space → "PERSONAL";
  // organisation workspace → "TEAM".
  const capabilities = resolveCapabilities({
    role: membership.role as never,
    scope: team.isPersonal ? "PERSONAL" : ("TEAM" as never),
    plan: team.billingPlan as never,
    isPlatformAdmin: platformAdmin,
  });
  if (!capabilities[capability]) {
    reply.code(403).send({
      message: `Capability ${capability} required`,
      error: { code: "permission_denied", capability },
    });
    return null;
  }
  return { userId };
}

function projectRule(row: {
  id: string;
  teamId: string;
  name: string;
  description: string | null;
  enabled: boolean;
  triggerType: string;
  conditionJson: unknown;
  actionType: string;
  actionConfigJson: unknown;
  version: number;
  createdByUserId: string;
  updatedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
  disabledAt: Date | null;
}): Record<string, unknown> {
  return {
    id: row.id,
    teamId: row.teamId,
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    triggerType: row.triggerType,
    conditionJson: row.conditionJson,
    actionType: row.actionType,
    actionConfigJson: row.actionConfigJson,
    version: row.version,
    createdByUserId: row.createdByUserId,
    updatedByUserId: row.updatedByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    disabledAt: row.disabledAt?.toISOString() ?? null,
  };
}

function projectRun(row: {
  id: string;
  teamId: string;
  ruleId: string;
  triggerType: string;
  targetType: string;
  targetId: string;
  idempotencyKey: string;
  status: string;
  reason: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}): Record<string, unknown> {
  return {
    id: row.id,
    teamId: row.teamId,
    ruleId: row.ruleId,
    triggerType: row.triggerType,
    targetType: row.targetType,
    targetId: row.targetId,
    idempotencyKey: row.idempotencyKey,
    status: row.status,
    reason: row.reason,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Route registrar
// ---------------------------------------------------------------------------

export async function automationRoutes(
  app: FastifyInstance,
): Promise<void> {
  // -----------------------------------------------------------------
  // GET /v1/automation/rules?teamId=
  // -----------------------------------------------------------------
  app.get(
    "/v1/automation/rules",
    { preHandler: requireAuth },
    async (req, reply) => {
      const q = TeamIdQuery.safeParse(req.query);
      if (!q.success) {
        return reply
          .code(400)
          .send({ message: "Invalid query", issues: q.error.issues });
      }
      const member = await requireTeamCapability(
        req,
        reply,
        q.data.teamId,
        "AUTOMATION_VIEW",
      );
      if (!member) return;
      const rows = await prisma.automationRule.findMany({
        where: { teamId: q.data.teamId },
        orderBy: [{ enabled: "desc" }, { updatedAt: "desc" }],
      });
      reply.send({
        rules: rows.map(projectRule),
        allowlist: {
          triggerTypes: AUTOMATION_TRIGGER_TYPES,
          actionTypes: AUTOMATION_ACTION_TYPES,
        },
      });
    },
  );

  // -----------------------------------------------------------------
  // POST /v1/automation/rules
  // -----------------------------------------------------------------
  app.post(
    "/v1/automation/rules",
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = CreateAutomationRuleInput.safeParse(req.body);
      if (!body.success) {
        return reply
          .code(400)
          .send({ message: "Invalid body", issues: body.error.issues });
      }
      const member = await requireTeamCapability(
        req,
        reply,
        body.data.teamId,
        "AUTOMATION_MANAGE",
      );
      if (!member) return;

      // Validate the action config against the per-action-type strict
      // schema. The trigger and action types are already enum-validated
      // by Zod above.
      const actionType = body.data.actionType as AutomationActionType;
      const actionResult = validateActionConfig(
        actionType,
        body.data.actionConfigJson,
      );
      if (!actionResult.ok) {
        return reply.code(400).send({
          message: "Invalid action config",
          errors: actionResult.errors,
        });
      }
      const conditionResult = validateCondition(body.data.conditionJson);
      if (!conditionResult.ok) {
        return reply.code(400).send({
          message: "Invalid condition",
          errors: conditionResult.errors,
        });
      }

      const created = await prisma.automationRule.create({
        data: {
          teamId: body.data.teamId,
          name: body.data.name,
          description: body.data.description ?? null,
          enabled: false, // E3 — rules ALWAYS created disabled; explicit enable required.
          triggerType: body.data.triggerType,
          conditionJson:
            (conditionResult.condition as object | null) ?? {},
          actionType,
          actionConfigJson: actionResult.config as object,
          createdByUserId: member.userId,
          updatedByUserId: member.userId,
        },
      });
      reply.code(201).send(projectRule(created));
    },
  );

  // -----------------------------------------------------------------
  // PATCH /v1/automation/rules/:id
  // -----------------------------------------------------------------
  app.patch(
    "/v1/automation/rules/:id",
    { preHandler: requireAuth },
    async (req, reply) => {
      const params = ParamsId.safeParse(req.params);
      const body = UpdateAutomationRuleInput.safeParse(req.body);
      if (!params.success) {
        return reply.code(400).send({ message: "Invalid id" });
      }
      if (!body.success) {
        return reply
          .code(400)
          .send({ message: "Invalid body", issues: body.error.issues });
      }
      const existing = await prisma.automationRule.findUnique({
        where: { id: params.data.id },
      });
      if (!existing) {
        return reply.code(404).send({ message: "Rule not found" });
      }
      const member = await requireTeamCapability(
        req,
        reply,
        existing.teamId,
        "AUTOMATION_MANAGE",
      );
      if (!member) return;

      const data: Record<string, unknown> = {
        updatedByUserId: member.userId,
        version: { increment: 1 },
      };

      if (body.data.name !== undefined) data.name = body.data.name;
      if (body.data.description !== undefined) {
        data.description = body.data.description ?? null;
      }
      if (body.data.conditionJson !== undefined) {
        const r = validateCondition(body.data.conditionJson);
        if (!r.ok) {
          return reply
            .code(400)
            .send({ message: "Invalid condition", errors: r.errors });
        }
        data.conditionJson = (r.condition as object | null) ?? {};
      }
      if (body.data.actionConfigJson !== undefined) {
        const r = validateActionConfig(
          existing.actionType as AutomationActionType,
          body.data.actionConfigJson,
        );
        if (!r.ok) {
          return reply
            .code(400)
            .send({ message: "Invalid action config", errors: r.errors });
        }
        data.actionConfigJson = r.config as object;
      }

      const updated = await prisma.automationRule.update({
        where: { id: existing.id },
        data,
      });
      reply.send(projectRule(updated));
    },
  );

  // -----------------------------------------------------------------
  // POST /v1/automation/rules/:id/enable
  // POST /v1/automation/rules/:id/disable
  // -----------------------------------------------------------------
  const transitionEnabled = async (
    req: FastifyRequest,
    reply: FastifyReply,
    enabled: boolean,
  ): Promise<void> => {
    const params = ParamsId.safeParse(req.params);
    if (!params.success) {
      reply.code(400).send({ message: "Invalid id" });
      return;
    }
    const existing = await prisma.automationRule.findUnique({
      where: { id: params.data.id },
    });
    if (!existing) {
      reply.code(404).send({ message: "Rule not found" });
      return;
    }
    const member = await requireTeamCapability(
      req,
      reply,
      existing.teamId,
      "AUTOMATION_MANAGE",
    );
    if (!member) return;
    const updated = await prisma.automationRule.update({
      where: { id: existing.id },
      data: {
        enabled,
        disabledAt: enabled ? null : new Date(),
        updatedByUserId: member.userId,
        version: { increment: 1 },
      },
    });
    reply.send(projectRule(updated));
  };

  app.post(
    "/v1/automation/rules/:id/enable",
    { preHandler: requireAuth },
    (req, reply) => transitionEnabled(req, reply, true),
  );

  app.post(
    "/v1/automation/rules/:id/disable",
    { preHandler: requireAuth },
    (req, reply) => transitionEnabled(req, reply, false),
  );

  // -----------------------------------------------------------------
  // GET /v1/automation/runs?teamId=
  // -----------------------------------------------------------------
  app.get(
    "/v1/automation/runs",
    { preHandler: requireAuth },
    async (req, reply) => {
      const q = ListRunsQuery.safeParse(req.query);
      if (!q.success) {
        return reply
          .code(400)
          .send({ message: "Invalid query", issues: q.error.issues });
      }
      const member = await requireTeamCapability(
        req,
        reply,
        q.data.teamId,
        "AUTOMATION_VIEW",
      );
      if (!member) return;
      const rows = await prisma.automationRun.findMany({
        where: {
          teamId: q.data.teamId,
          ...(q.data.ruleId ? { ruleId: q.data.ruleId } : {}),
          ...(q.data.status ? { status: q.data.status } : {}),
        },
        orderBy: [{ createdAt: "desc" }],
        take: q.data.limit,
      });
      reply.send({ runs: rows.map(projectRun) });
    },
  );

  // -----------------------------------------------------------------
  // GET /v1/automation/runs/:id
  // -----------------------------------------------------------------
  app.get(
    "/v1/automation/runs/:id",
    { preHandler: requireAuth },
    async (req, reply) => {
      const params = ParamsId.safeParse(req.params);
      if (!params.success) {
        return reply.code(400).send({ message: "Invalid id" });
      }
      const row = await prisma.automationRun.findUnique({
        where: { id: params.data.id },
      });
      if (!row) {
        return reply.code(404).send({ message: "Run not found" });
      }
      const member = await requireTeamCapability(
        req,
        reply,
        row.teamId,
        "AUTOMATION_VIEW",
      );
      if (!member) return;
      reply.send(projectRun(row));
    },
  );
}
