/**
 * Phase A2 — Workspace AI policy API.
 *
 *   GET /v1/workspaces/ai-policy?teamId        — effective policy + capability
 *                                                disclosure + version (member).
 *   PUT /v1/workspaces/ai-policy               — upsert policy (OWNER/ADMIN),
 *                                                optimistic concurrency + audit.
 *
 * The evaluator (`evaluateWorkspaceAiPolicy`) is the enforcement path; this API
 * is the management surface. Disabling AI here immediately affects the next
 * provider call because the evaluator reads the same row.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { Permission } from "@proovra/shared";

import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { authorizeOrFail } from "../middleware/authorize.js";
import { emitTenantAudit } from "../services/audit/tenant-audit.service.js";
import { resolveAiCapabilityDisclosure } from "../services/ai/ai-capability-disclosure.service.js";
import { getWorkspaceAiUsageThisMonth } from "../services/billing-enforcement.service.js";
// §9.7 — scope via the canonical commercial envelope (explicit subjects).
import { resolveCommercialContext } from "../services/billing/commercial-context.service.js";
import {
  DEFAULT_WORKSPACE_AI_POLICY,
  WorkspaceAiPolicyVersionConflictError,
  getWorkspaceAiPolicyRow,
  resolveWorkspaceAiPolicy,
  upsertWorkspaceAiPolicy,
  type WorkspaceAiPolicyPatch,
} from "../services/ai/workspace-ai-policy.service.js";

/**
 * PHASE 1 AUTHORIZATION CLOSURE (2026-07-21) — canonical authorization.
 * Routes through authorizeOrFail (ACTIVE membership + org lifecycle +
 * operation-specific capability + fail-closed + anti-enumeration 404). Reads
 * use `intelligence.read`; the policy mutation uses `intelligence.policy.manage`
 * (held by OWNER + ADMIN only — the same set the former inline role check
 * enforced).
 */
async function requireMember(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
  permission: Permission,
): Promise<{ userId: string } | null> {
  const outcome = await authorizeOrFail(req, reply, {
    teamId,
    permission,
    antiEnumeration: true,
  });
  return outcome ? { userId: outcome.actorUserId } : null;
}

const PatchBody = z.object({
  teamId: z.string().uuid(),
  expectedVersion: z.number().int().min(1).nullable().optional(),
  reason: z.string().max(400).optional(),
  aiEnabled: z.boolean().optional(),
  supportChatEnabled: z.boolean().optional(),
  captureAssistanceEnabled: z.boolean().optional(),
  evidenceCategorizationEnabled: z.boolean().optional(),
  semanticSearchEnabled: z.boolean().optional(),
  contentIntelligenceEnabled: z.boolean().optional(),
  reviewerCopilotEnabled: z.boolean().optional(),
  caseCopilotEnabled: z.boolean().optional(),
  rawContentProcessingAllowed: z.boolean().optional(),
  ocrAllowed: z.boolean().optional(),
  transcriptionAllowed: z.boolean().optional(),
  embeddingsAllowed: z.boolean().optional(),
  allowedRoles: z.array(z.string().max(40)).max(20).nullable().optional(),
  dailyOperationLimit: z.number().int().min(0).max(1_000_000).nullable().optional(),
  monthlyOperationLimit: z.number().int().min(0).max(10_000_000).nullable().optional(),
  retentionDays: z.number().int().min(1).max(3650).nullable().optional(),
});

export async function workspaceAiPolicyRoutes(app: FastifyInstance) {
  // GET effective policy + capability disclosure (member read).
  app.get(
    "/v1/workspaces/ai-policy",
    { preHandler: requireAuth },
    async (req, reply) => {
      const query = z.object({ teamId: z.string().uuid() }).parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId, "intelligence.read");
      if (!ok) return;

      const resolved = await resolveWorkspaceAiPolicy(query.teamId);
      const row = await getWorkspaceAiPolicyRow(query.teamId);
      const capabilities = await resolveAiCapabilityDisclosure(query.teamId);
      return reply.code(200).send({
        policy: resolved,
        version: row?.policyVersion ?? DEFAULT_WORKSPACE_AI_POLICY.policyVersion,
        hasExplicitPolicy: Boolean(row),
        lastModifiedByUserId: row?.updatedByUserId ?? null,
        lastModifiedAtUtc: row?.updatedAt ?? null,
        capabilities,
      });
    },
  );

  // Phase C8 — workspace AI usage & governance summary (member read).
  app.get(
    "/v1/workspaces/ai-usage",
    { preHandler: requireAuth },
    async (req, reply) => {
      const query = z.object({ teamId: z.string().uuid() }).parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId, "intelligence.read");
      if (!ok) return;
      const now = new Date();
      const day = now.toISOString().slice(0, 10);
      const month = now.toISOString().slice(0, 7);

      // Plan allowance (2026-07-17 Settings remediation) — resolved from
      // the SAME scope model the AI cost guard enforces: a personal
      // workspace carries the account entitlement plan; a team/org
      // workspace carries its billing plan. `consumed` comes from the
      // enforcement ledger (EntitlementUsage), so what the user sees is
      // exactly what the guard counts.
      let allowance: {
        plan: string;
        monthlyOperations: number | null;
        consumed: number;
        remaining: number | null;
      } | null = null;
      try {
        const team = await prisma.team.findUnique({
          where: { id: query.teamId },
          select: { isPersonal: true, ownerUserId: true },
        });
        if (team) {
          // §9.7 — explicit subjects: the persisted isPersonal marker names the
          // personal-space subject; otherwise the WORKSPACE aggregate by id.
          const scope = team.isPersonal
            ? (await resolveCommercialContext({ type: "PERSONAL_ACCOUNT", userId: team.ownerUserId })).scope
            : (await resolveCommercialContext({ type: "WORKSPACE", teamId: query.teamId, requesterUserId: team.ownerUserId })).scope;
          const { consumed, cap } = await getWorkspaceAiUsageThisMonth(scope);
          allowance = {
            plan: String(scope.plan),
            monthlyOperations: cap,
            consumed,
            remaining: cap === null ? null : Math.max(0, cap - consumed),
          };
        }
      } catch {
        // Allowance is display-only; enforcement stays on the guard.
      }

      try {
        const [daily, monthly, recentRuns, blockedRuns] = await Promise.all([
          prisma.aiUsageDaily.findUnique({ where: { workspaceId_dayUtc: { workspaceId: query.teamId, dayUtc: day } } }),
          prisma.aiUsageMonthly.findUnique({ where: { workspaceId_monthUtc: { workspaceId: query.teamId, monthUtc: month } } }),
          prisma.aiCopilotRun.count({ where: { workspaceId: query.teamId } }),
          prisma.aiCopilotRun.count({ where: { workspaceId: query.teamId, status: "blocked_prohibited_claim" } }),
        ]);
        return reply.code(200).send({
          dayUtc: day,
          monthUtc: month,
          allowance,
          daily: { operations: daily?.operations ?? 0, costUsdMicros: String(daily?.costUsdMicros ?? 0n) },
          monthly: { operations: monthly?.operations ?? 0, costUsdMicros: String(monthly?.costUsdMicros ?? 0n) },
          copilotRuns: recentRuns,
          blockedProhibitedClaims: blockedRuns,
        });
      } catch {
        // Ledger tables not applied on this environment — honest empty state.
        return reply.code(200).send({
          dayUtc: day, monthUtc: month,
          allowance,
          daily: { operations: 0, costUsdMicros: "0" },
          monthly: { operations: 0, costUsdMicros: "0" },
          copilotRuns: 0, blockedProhibitedClaims: 0,
          ledgerAvailable: false,
        });
      }
    },
  );

  // PUT upsert (OWNER / ADMIN only) — optimistic concurrency + audit.
  app.put(
    "/v1/workspaces/ai-policy",
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = PatchBody.parse(req.body ?? {});
      // intelligence.policy.manage is held by OWNER + ADMIN only.
      const ok = await requireMember(req, reply, body.teamId, "intelligence.policy.manage");
      if (!ok) return;

      const { teamId, expectedVersion, reason, ...rest } = body;
      const patch: WorkspaceAiPolicyPatch = rest;
      const before = await getWorkspaceAiPolicyRow(teamId);

      let result;
      try {
        result = await upsertWorkspaceAiPolicy({
          teamId,
          actorUserId: ok.userId,
          patch,
          expectedVersion: expectedVersion ?? undefined,
        });
      } catch (err) {
        if (err instanceof WorkspaceAiPolicyVersionConflictError) {
          // PHASE 12B B1 — the concurrency LOSER. `upsertWorkspaceAiPolicy`
          // guarantees zero mutation on this path, and returning here means no
          // `ai.workspace_policy_updated` success audit is emitted for a write
          // that did not happen. `message` is present so the canonical client
          // normalizer treats the body as a structured error rather than
          // re-coding it from the status bucket.
          return reply.code(409).send({
            error: {
              code: err.code,
              message: err.message,
              reason: err.message,
              details: { currentVersion: err.currentVersion },
              currentVersion: err.currentVersion,
            },
          });
        }
        throw err;
      }

      // Bounded before/after audit — booleans + version only, no secrets.
      await emitTenantAudit({
        action: "ai.workspace_policy_updated",
        outcome: "success",
        sourceApp: "API",
        actorUserId: ok.userId,
        workspaceId: teamId,
        resourceType: "workspace_ai_policy",
        resourceId: teamId,
        correlationId: req.id ?? null,
        metadata: {
          reason: reason ?? null,
          previousVersion: before?.policyVersion ?? null,
          newVersion: result.row.policyVersion,
          changed: Object.keys(patch),
          aiEnabledBefore: before?.aiEnabled ?? null,
          aiEnabledAfter: result.row.aiEnabled,
        },
      });

      const resolved = await resolveWorkspaceAiPolicy(teamId);
      return reply.code(200).send({
        policy: resolved,
        version: result.row.policyVersion,
        hasExplicitPolicy: true,
      });
    },
  );
}
