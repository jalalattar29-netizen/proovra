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

import { authorizeOrFail } from "../middleware/authorize.js";
import type { Permission } from "@proovra/shared";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import {
  AUTOMATION_ACTION_TYPES,
  AUTOMATION_TRIGGER_TYPES,
  CreateAutomationRuleInput,
  UpdateAutomationRuleInput,
  validateActionConfig,
  validateCondition,
  type AutomationActionType,
} from "../services/automation/automation.service.js";
// ARCH-005 (2026-08-07) — the sweep entry points. The route SCHEDULES; the
// services below own claim, execution, retry, dead-lettering and reconciliation.
import { runAutomationDispatchSweep } from "../services/automation/automation-dispatch-runtime.service.js";
import { sweepDueDeliveries } from "../services/automation/automation-delivery-runtime.service.js";
import { detectTimeBasedAutomationTriggers } from "../services/automation/automation-triggers.js";
import { requireIntegrationCronSecret } from "../middleware/cron-secret.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ParamsId = z.object({ id: z.string().uuid() });
const TeamIdQuery = z.object({ teamId: z.string().uuid() });
const ListRunsQuery = z.object({
  teamId: z.string().uuid(),
  ruleId: z.string().uuid().optional(),
  // ARCH-005 (2026-08-07) — RETRY_SCHEDULED and DEAD_LETTERED are real states
  // now; an operator filtering the run list must be able to name them.
  status: z
    .enum([
      "PENDING",
      "RUNNING",
      "RETRY_SCHEDULED",
      "SUCCEEDED",
      "FAILED",
      "SKIPPED",
      "DEAD_LETTERED",
    ])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

type Capability = "AUTOMATION_VIEW" | "AUTOMATION_MANAGE";

// PHASE 1 AUTHORIZATION CLOSURE (2026-07-21) — automation rules are an
// integration/config surface; both viewing and managing them map to the
// canonical `integration.webhook.manage` capability (held by OWNER + ADMIN).
const CAPABILITY_TO_PERMISSION: Record<Capability, Permission> = {
  AUTOMATION_VIEW: "integration.webhook.manage",
  AUTOMATION_MANAGE: "integration.webhook.manage",
};

/**
 * PHASE 1 AUTHORIZATION CLOSURE (2026-07-21) — canonical authorization.
 * Routes through authorizeOrFail (ACTIVE membership + org lifecycle +
 * capability + fail-closed + anti-enumeration 404). This REPLACES the former
 * `resolveCapabilities({ isPlatformAdmin })` path, which let a platform admin
 * satisfy the gate WITHOUT ACTIVE customer-workspace membership — an implicit
 * platform-admin bypass. A platform admin now has NO special standing here;
 * they must be an ACTIVE member holding the capability like anyone else.
 */
async function requireTeamCapability(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
  capability: Capability,
): Promise<{ userId: string } | null> {
  const outcome = await authorizeOrFail(req, reply, {
    teamId,
    permission: CAPABILITY_TO_PERMISSION[capability],
    antiEnumeration: true,
  });
  return outcome ? { userId: outcome.actorUserId } : null;
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
  // ARCH-005 (2026-08-07) — the durable lifecycle. Optional in the parameter
  // type so a caller selecting the narrow shape still type-checks; the routes
  // below select the whole row.
  attemptCount?: number;
  claimGeneration?: number;
  failureCode?: string | null;
  nextAttemptAtUtc?: Date | null;
  leaseExpiresAtUtc?: Date | null;
  failedAtUtc?: Date | null;
  deadLetteredAtUtc?: Date | null;
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
    // ARCH-005 — the operator surface must show the SAME state the database
    // holds. Before this, a run that had been retried twice and dead-lettered
    // rendered as a bare "FAILED" with no attempt count and no reason the
    // operator could act on, which is how a durable state machine ends up
    // being debugged with `psql`.
    attemptCount: row.attemptCount ?? 0,
    claimGeneration: row.claimGeneration ?? 0,
    failureCode: row.failureCode ?? null,
    nextAttemptAtUtc: row.nextAttemptAtUtc?.toISOString() ?? null,
    leaseExpiresAtUtc: row.leaseExpiresAtUtc?.toISOString() ?? null,
    failedAtUtc: row.failedAtUtc?.toISOString() ?? null,
    deadLetteredAtUtc: row.deadLetteredAtUtc?.toISOString() ?? null,
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
      /**
       * ONE where object, used by the page query and the count.
       *
       * Building the count from a separately-written predicate is how a
       * summary and its drill-down come to disagree; sharing the object makes
       * that impossible.
       */
      const where = {
        teamId: q.data.teamId,
        ...(q.data.ruleId ? { ruleId: q.data.ruleId } : {}),
        ...(q.data.status ? { status: q.data.status } : {}),
      };

      const [rows, total] = await Promise.all([
        prisma.automationRun.findMany({
          where,
          orderBy: [{ createdAt: "desc" }],
          take: q.data.limit,
        }),
        // Scoped to one team on an indexed column, so this is a lookup and not
        // a scan. Without it the client can only report how many rows it
        // received, and "50 runs" then means "the newest 50".
        prisma.automationRun.count({ where }),
      ]);
      reply.send({ runs: rows.map(projectRun), total, limit: q.data.limit });
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

  // -------------------------------------------------------------------------
  // POST /v1/automation/runs/process   (ARCH-005, 2026-08-07 — INTERNAL)
  //
  // The machine entry point for `AutomationDispatchSweep`. Cron-secret guarded,
  // never reachable by a session, and it takes NO tenant: the sweep's scope is
  // "every due run", and each run carries its own already-authorized tenant on
  // the durable row. A `teamId` parameter here would be a caller-supplied
  // authority claim, which is the shape this programme keeps removing.
  //
  // The worker only SCHEDULES this — the same worker→API pattern as
  // `/v1/org-invite-deliveries/process`, and for the same reason: the seven
  // bounded action handlers reach notification, reviewer-assignment and comment
  // authorities that live API-side, and a worker-side copy of them would be a
  // second authority for every one.
  // -------------------------------------------------------------------------
  app.post("/v1/automation/runs/process", async (req, reply) => {
    const ok = await requireIntegrationCronSecret(req, reply);
    if (!ok) return;
    const body = z
      .object({
        batchSize: z.number().int().min(1).max(100).optional(),
        deliveryBatchSize: z.number().int().min(1).max(100).optional(),
      })
      .parse(req.body ?? {});

    // ORDER MATTERS, and each step is here for a stated reason.
    //
    //  1. DETECT the four time-based conditions. They have no event to hook,
    //     so if nothing looks for them nothing ever fires — which is precisely
    //     what "configurable and inert" meant for four of the eleven triggers.
    //  2. Claim and execute due runs, including the ones step 1 just wrote, so
    //     a detected condition acts in this tick rather than the next.
    //  3. Sweep deliveries, including any a WEBHOOK action just enqueued.
    const detected = await detectTimeBasedAutomationTriggers({});
    const runs = await runAutomationDispatchSweep({ limit: body.batchSize });
    const deliveries = await sweepDueDeliveries({ limit: body.deliveryBatchSize });
    return reply.code(200).send({ summary: { detected, runs, deliveries } });
  });
}
