/**
 * Phase 9 — Governance routes.
 *
 *   GET   /v1/governance/policy?teamId                — read policy
 *   PUT   /v1/governance/policy                       — upsert policy (ADMIN+)
 *   GET   /v1/governance/legal-holds?teamId&status    — list workspace holds
 *   POST  /v1/governance/legal-holds                  — place hold (ADMIN+)
 *   POST  /v1/governance/legal-holds/:id/release      — release hold (ADMIN+)
 *   GET   /v1/governance/evidence/:id/holds           — list holds on an evidence record
 *
 * All routes require authentication AND workspace membership. Mutating
 * routes additionally require the appropriate canonical permission via
 * `requirePermission`.
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
import {
  runGovernanceHandler,
  isPrismaTableOrColumnMissing,
  extractPrismaDiagnostic,
} from "./_governance-error-bound.js";
import { requireIntegrationCronSecret } from "../middleware/cron-secret.js";
import {
  listLegalHoldsForEvidence,
  listLegalHoldsForTeam,
  loadWorkspaceGovernancePolicy,
  placeLegalHold,
  projectEffectivePolicy,
  projectLegalHold,
  releaseLegalHold,
  requirePermission,
  upsertWorkspaceGovernancePolicy,
} from "../services/governance.service.js";
import {
  CaseLegalHoldError,
  isEvidenceUnderAnyLegalHold,
  listCaseLegalHolds,
  placeCaseLegalHold,
  projectCaseLegalHold,
  releaseCaseLegalHold,
} from "../services/governance/case-legal-hold.service.js";
import {
  PublicationError,
  projectPublicationState,
  publishPublicVerify,
  restorePublicVerify,
  suspendPublicVerify,
  unpublishPublicVerify,
} from "../services/governance/publication.service.js";
import {
  listRetentionCandidates,
  reconcileRetention,
} from "../services/governance/retention-sweeper.service.js";
// Phase 19 — sensitive governance routes require step-up.
import { requireStepUpForSensitiveAction } from "../services/identity-security/step-up-middleware.js";

const ParamsId = z.object({ id: z.string().uuid() });

async function requireMember(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
): Promise<{ userId: string; role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER" } | null> {
  const userId = getAuthUserId(req);
  const membership = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
  });
  if (!membership) {
    reply.code(403).send({ message: "Not a member of the workspace" });
    return null;
  }
  return { userId, role: membership.role };
}

function denyByPermission(
  reply: FastifyReply,
  reason: string,
): void {
  reply.code(403).send({
    error: {
      code: "permission_denied",
      reason,
    },
  });
}

export async function governanceRoutes(app: FastifyInstance) {
  // GET policy
  app.get(
    "/v1/governance/policy",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId);
      if (!ok) return;

      const perm = requirePermission(ok.role, "governance.policy.read");
      if (!perm.allowed) {
        denyByPermission(reply, perm.reason);
        return;
      }

      // Phase 32.5 — bounded schema-drift handling. When the
      // governance schema is missing on this environment, return a
      // bounded 503 instead of a raw Prisma error.
      await runGovernanceHandler(reply, async () => {
        const policy = await loadWorkspaceGovernancePolicy(query.teamId);
        reply.code(200).send({ policy: projectEffectivePolicy(policy) });
      });
    },
  );

  // PUT policy (upsert)
  app.put(
    "/v1/governance/policy",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = z
        .object({
          teamId: z.string().uuid(),
          defaultRetentionDays: z
            .number()
            .int()
            .min(0)
            .max(365 * 100)
            .nullable()
            .optional(),
          evidenceDeletionMode: z
            .enum(["ALLOWED", "ADMIN_ONLY", "DISABLED"])
            .optional(),
          requireLegalHoldApprovalForDeletion: z.boolean().optional(),
          requireReviewBeforeReport: z.boolean().optional(),
          requireReviewBeforePackage: z.boolean().optional(),
          requireReviewBeforePublicVerify: z.boolean().optional(),
          allowExternalIntake: z.boolean().optional(),
          allowAnonymousIntake: z.boolean().optional(),
          allowPublicVerify: z.boolean().optional(),
          allowPackageDownload: z.boolean().optional(),
          allowReportDownload: z.boolean().optional(),
          allowOriginalDownload: z.boolean().optional(),
          // Phase 14 — governance approval flags.
          requirePublicationApproval: z.boolean().optional(),
          requireLegalHoldReleaseApproval: z.boolean().optional(),
        })
        .parse(req.body ?? {});
      const ok = await requireMember(req, reply, body.teamId);
      if (!ok) return;

      const perm = requirePermission(ok.role, "governance.policy.manage");
      if (!perm.allowed) {
        denyByPermission(reply, perm.reason);
        return;
      }
      const gate = await requireStepUpForSensitiveAction({
        req, reply,
        teamId: body.teamId,
        userId: ok.userId,
        purpose: "GOVERNANCE_POLICY_UPDATE",
        resourceKind: "workspace_governance_policy",
        resourceId: body.teamId,
      });
      if (gate.sent) return;

      const { teamId, ...patch } = body;
      const row = await upsertWorkspaceGovernancePolicy({
        teamId,
        actorUserId: ok.userId,
        patch,
      });
      const policy = await loadWorkspaceGovernancePolicy(teamId);
      return reply
        .code(200)
        .send({ policy: projectEffectivePolicy(policy), id: row.id });
    },
  );

  // GET workspace legal holds
  app.get(
    "/v1/governance/legal-holds",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = z
        .object({
          teamId: z.string().uuid(),
          status: z.enum(["ACTIVE", "RELEASED"]).optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        })
        .parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId);
      if (!ok) return;

      const perm = requirePermission(ok.role, "governance.legal_hold.manage");
      // Reading the list does NOT require manage permission — every member
      // should be able to see that a hold exists. Only place/release
      // requires the manage permission. (Permission is checked again at
      // mutation time below.)
      void perm;

      // Phase 32.5 — bounded schema-drift handling.
      await runGovernanceHandler(reply, async () => {
        const rows = await listLegalHoldsForTeam({
          teamId: query.teamId,
          status: query.status,
          limit: query.limit,
        });
        reply.code(200).send({
          legalHolds: rows.map(projectLegalHold),
        });
      });
    },
  );

  // POST place legal hold
  app.post(
    "/v1/governance/legal-holds",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = z
        .object({
          teamId: z.string().uuid(),
          evidenceId: z.string().uuid(),
          title: z.string().min(1).max(180),
          reason: z.string().max(4000).nullable().optional(),
          caseId: z.string().uuid().nullable().optional(),
        })
        .parse(req.body ?? {});
      const ok = await requireMember(req, reply, body.teamId);
      if (!ok) return;

      const perm = requirePermission(ok.role, "governance.legal_hold.manage");
      if (!perm.allowed) {
        denyByPermission(reply, perm.reason);
        return;
      }
      // Phase 3 (Enterprise Identity) — placing a legal hold is a
      // sensitive governance action (LEGAL_HOLD_PLACE is in the MFA
      // force-list). Its sibling RELEASE route already gates on
      // step-up; PLACE was left ungated. Reuse the existing step-up
      // middleware (additive guard) so both sides of the legal-hold
      // lifecycle require re-proof before mutating custody-relevant
      // state. No hashing / custody / hold logic is changed here — the
      // gate runs BEFORE `placeLegalHold`.
      const gate = await requireStepUpForSensitiveAction({
        req, reply,
        teamId: body.teamId,
        userId: ok.userId,
        purpose: "LEGAL_HOLD_PLACE",
        resourceKind: "evidence_legal_hold",
        resourceId: body.evidenceId,
      });
      if (gate.sent) return;

      try {
        const hold = await placeLegalHold({
          teamId: body.teamId,
          evidenceId: body.evidenceId,
          actorUserId: ok.userId,
          title: body.title,
          reason: body.reason ?? null,
          caseId: body.caseId ?? null,
        });
        return reply
          .code(201)
          .send({ legalHold: projectLegalHold(hold) });
      } catch (err) {
        const e = err as {
          statusCode?: number;
          code?: string;
          message?: string;
        };
        return reply.code(e.statusCode ?? 500).send({
          error: { code: e.code ?? "internal_error", message: e.message },
        });
      }
    },
  );

  // POST release legal hold
  app.post(
    "/v1/governance/legal-holds/:id/release",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          releaseNote: z.string().min(1).max(4000),
        })
        .parse(req.body ?? {});
      const ok = await requireMember(req, reply, body.teamId);
      if (!ok) return;

      const perm = requirePermission(ok.role, "governance.legal_hold.manage");
      if (!perm.allowed) {
        denyByPermission(reply, perm.reason);
        return;
      }
      const gate = await requireStepUpForSensitiveAction({
        req, reply,
        teamId: body.teamId,
        userId: ok.userId,
        purpose: "LEGAL_HOLD_RELEASE",
        resourceKind: "evidence_legal_hold",
        resourceId: id,
      });
      if (gate.sent) return;

      try {
        const released = await releaseLegalHold({
          id,
          teamId: body.teamId,
          actorUserId: ok.userId,
          releaseNote: body.releaseNote,
        });
        return reply
          .code(200)
          .send({ legalHold: projectLegalHold(released) });
      } catch (err) {
        const e = err as {
          statusCode?: number;
          code?: string;
          message?: string;
        };
        return reply.code(e.statusCode ?? 500).send({
          error: { code: e.code ?? "internal_error", message: e.message },
        });
      }
    },
  );

  // GET governance status badge for one evidence (authenticated-only)
  //
  // Returns the workspace-internal summary used by the evidence detail
  // page to render legal-hold / retention / policy indicators. Public
  // verify NEVER consumes this — it requires authentication and
  // workspace membership.
  app.get(
    "/v1/governance/evidence/:id/status",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const query = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId);
      if (!ok) return;

      const evidence = await prisma.evidence.findUnique({
        where: { id },
        select: {
          id: true,
          teamId: true,
          retentionUntilUtc: true,
          archivedAt: true,
        },
      });
      if (!evidence || evidence.teamId !== query.teamId) {
        return reply
          .code(404)
          .send({ error: { code: "evidence_not_found" } });
      }

      const policy = await loadWorkspaceGovernancePolicy(query.teamId);
      const activeHold = await prisma.evidenceLegalHold.findFirst({
        where: { evidenceId: id, status: "ACTIVE" },
        orderBy: { placedAtUtc: "desc" },
      });

      return reply.code(200).send({
        legalHold: activeHold ? projectLegalHold(activeHold) : null,
        retention: {
          retentionUntilUtc: evidence.retentionUntilUtc?.toISOString() ?? null,
          policyDefaultDays: policy.defaultRetentionDays,
        },
        policy: {
          source: policy.source,
          evidenceDeletionMode: policy.evidenceDeletionMode,
          requireReviewBeforeReport: policy.requireReviewBeforeReport,
          requireReviewBeforePackage: policy.requireReviewBeforePackage,
          requireReviewBeforePublicVerify: policy.requireReviewBeforePublicVerify,
          allowReportDownload: policy.allowReportDownload,
          allowPackageDownload: policy.allowPackageDownload,
          allowPublicVerify: policy.allowPublicVerify,
          allowOriginalDownload: policy.allowOriginalDownload,
        },
      });
    },
  );

  // GET legal holds for one evidence
  app.get(
    "/v1/governance/evidence/:id/holds",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const query = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId);
      if (!ok) return;

      // Verify the evidence is in this workspace.
      const evidence = await prisma.evidence.findUnique({
        where: { id },
        select: { id: true, teamId: true },
      });
      if (!evidence || evidence.teamId !== query.teamId) {
        return reply
          .code(404)
          .send({ error: { code: "evidence_not_found" } });
      }

      const rows = await listLegalHoldsForEvidence(id);
      return reply.code(200).send({
        legalHolds: rows.map(projectLegalHold),
      });
    },
  );

  // ===========================================================================
  // Phase 14 — Case-level legal holds
  // ===========================================================================

  app.get(
    "/v1/governance/case-legal-holds",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = z
        .object({
          teamId: z.string().uuid(),
          caseId: z.string().uuid().optional(),
          status: z.enum(["ACTIVE", "RELEASED"]).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId);
      if (!ok) return;
      // Reading list is workspace-member visible (legal hold existence
      // is a governance fact every member should see).
      //
      // Phase 32.7.6 — case-level legal holds is an OPTIONAL
      // subsystem.
      //
      // The `case_legal_holds` table and its surrounding code path
      // were introduced in Phase 14. Some production environments
      // were deployed before that phase, OR have a partial Phase 14
      // schema (the table exists but is missing some columns the
      // Prisma model declares). When that's the case, the correct
      // operator-facing behavior is:
      //
      //   "No case-level legal holds placed."
      //
      // — NOT "Case-level legal holds temporarily unavailable.
      // Retry shortly." (which is what the generic
      // `runGovernanceHandler` 503 wrapper produced and what the
      // governance page renders for 503s).
      //
      // This per-endpoint handler catches ONLY the two Prisma
      // codes that signal "feature not deployed":
      //   * P2021 — table does not exist
      //   * P2022 — column does not exist
      // Both → return 200 with an empty array AND a bounded
      // `subsystemEnabled: false` marker so the frontend can
      // future-proof if it wants a distinct "feature not
      // configured" message. The current frontend already renders
      // the same empty-state UI for an empty `caseLegalHolds`
      // array, so no frontend change is required.
      //
      // Any OTHER thrown error continues to propagate to Fastify's
      // default error handler (which returns 500). Real failures
      // are NOT swallowed.
      //
      // The legal-holds / policy / retention-candidates endpoints
      // are NOT touched — those are core governance features and
      // continue to use `runGovernanceHandler` (503 on schema
      // drift, surfaces the governance-degraded banner). Only the
      // case-legal-holds endpoint is treated as optional.
      try {
        const rows = await listCaseLegalHolds({
          teamId: query.teamId,
          caseId: query.caseId,
          status: query.status,
          limit: query.limit,
        });
        reply.code(200).send({
          caseLegalHolds: rows.map(projectCaseLegalHold),
        });
      } catch (err) {
        if (isPrismaTableOrColumnMissing(err)) {
          const diag = extractPrismaDiagnostic(err);
          reply.log.warn(
            {
              event: "governance.case_legal_holds.subsystem_not_deployed",
              requestId: reply.request?.id ?? null,
              teamId: query.teamId,
              prismaName: diag.name,
              prismaCode: diag.code,
              missingTable: diag.missingTable,
              missingColumn: diag.missingColumn,
              modelName: diag.modelName,
              message: diag.message,
            },
            "case-legal-holds subsystem not deployed (treating as empty)",
          );
          reply.code(200).send({
            caseLegalHolds: [],
            subsystemEnabled: false,
          });
          return;
        }
        // Phase 32.7.6 — non-schema-drift errors are real failures
        // and must NOT be swallowed. They propagate to Fastify's
        // default handler (500). Operators will see the full
        // exception in server logs as before.
        throw err;
      }
    },
  );

  app.post(
    "/v1/governance/case-legal-holds",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = z
        .object({
          teamId: z.string().uuid(),
          caseId: z.string().uuid(),
          title: z.string().min(1).max(180),
          reason: z.string().max(4000).nullable().optional(),
        })
        .parse(req.body ?? {});
      const ok = await requireMember(req, reply, body.teamId);
      if (!ok) return;
      const perm = requirePermission(ok.role, "governance.legal_hold.manage");
      if (!perm.allowed) {
        denyByPermission(reply, perm.reason);
        return;
      }
      try {
        const hold = await placeCaseLegalHold({
          teamId: body.teamId,
          caseId: body.caseId,
          actorUserId: ok.userId,
          title: body.title,
          reason: body.reason ?? null,
        });
        return reply
          .code(201)
          .send({ caseLegalHold: projectCaseLegalHold(hold) });
      } catch (err) {
        if (err instanceof CaseLegalHoldError) {
          return reply
            .code(err.code === "case_not_in_workspace" ? 404 : 400)
            .send({ error: { code: err.code } });
        }
        throw err;
      }
    },
  );

  app.post(
    "/v1/governance/case-legal-holds/:id/release",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          releaseNote: z.string().min(1).max(4000),
          approvalAcknowledged: z.boolean().optional(),
        })
        .parse(req.body ?? {});
      const ok = await requireMember(req, reply, body.teamId);
      if (!ok) return;
      const perm = requirePermission(ok.role, "governance.legal_hold.manage");
      if (!perm.allowed) {
        denyByPermission(reply, perm.reason);
        return;
      }
      // Phase 14 — release-approval gate. When the workspace requires
      // explicit approval, the caller MUST pass approvalAcknowledged.
      const policy = await loadWorkspaceGovernancePolicy(body.teamId);
      if (
        policy.requireLegalHoldReleaseApproval &&
        !body.approvalAcknowledged
      ) {
        return reply.code(412).send({
          error: { code: "release_approval_required" },
        });
      }
      try {
        const released = await releaseCaseLegalHold({
          id,
          teamId: body.teamId,
          actorUserId: ok.userId,
          releaseNote: body.releaseNote,
        });
        return reply
          .code(200)
          .send({ caseLegalHold: projectCaseLegalHold(released) });
      } catch (err) {
        if (err instanceof CaseLegalHoldError) {
          return reply
            .code(err.code === "hold_not_found" ? 404 : 400)
            .send({ error: { code: err.code } });
        }
        throw err;
      }
    },
  );

  // ===========================================================================
  // Phase 14 — Public verify publication workflow
  // ===========================================================================

  app.post(
    "/v1/governance/evidence/:id/publish",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          reason: z.string().max(400).nullable().optional(),
        })
        .parse(req.body ?? {});
      const ok = await requireMember(req, reply, body.teamId);
      if (!ok) return;
      const perm = requirePermission(ok.role, "evidence.publish_verify");
      if (!perm.allowed) {
        denyByPermission(reply, perm.reason);
        return;
      }
      const gate = await requireStepUpForSensitiveAction({
        req, reply,
        teamId: body.teamId,
        userId: ok.userId,
        purpose: "PUBLIC_VERIFY_PUBLISH",
        resourceKind: "evidence",
        resourceId: id,
      });
      if (gate.sent) return;
      try {
        const updated = await publishPublicVerify({
          evidenceId: id,
          teamId: body.teamId,
          actorUserId: ok.userId,
          reason: body.reason ?? null,
        });
        return reply
          .code(200)
          .send({ publication: projectPublicationState(updated) });
      } catch (err) {
        return publicationErrorToReply(err, reply);
      }
    },
  );

  app.post(
    "/v1/governance/evidence/:id/unpublish",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          reason: z.string().max(400).nullable().optional(),
        })
        .parse(req.body ?? {});
      const ok = await requireMember(req, reply, body.teamId);
      if (!ok) return;
      const perm = requirePermission(ok.role, "evidence.publish_verify");
      if (!perm.allowed) {
        denyByPermission(reply, perm.reason);
        return;
      }
      const gate = await requireStepUpForSensitiveAction({
        req, reply,
        teamId: body.teamId,
        userId: ok.userId,
        purpose: "PUBLIC_VERIFY_UNPUBLISH",
        resourceKind: "evidence",
        resourceId: id,
      });
      if (gate.sent) return;
      try {
        const updated = await unpublishPublicVerify({
          evidenceId: id,
          teamId: body.teamId,
          actorUserId: ok.userId,
          reason: body.reason ?? null,
        });
        return reply
          .code(200)
          .send({ publication: projectPublicationState(updated) });
      } catch (err) {
        return publicationErrorToReply(err, reply);
      }
    },
  );

  app.post(
    "/v1/governance/evidence/:id/suspend",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          reason: z.string().min(1).max(400),
        })
        .parse(req.body ?? {});
      const ok = await requireMember(req, reply, body.teamId);
      if (!ok) return;
      const perm = requirePermission(ok.role, "evidence.publish_verify");
      if (!perm.allowed) {
        denyByPermission(reply, perm.reason);
        return;
      }
      const gate = await requireStepUpForSensitiveAction({
        req, reply,
        teamId: body.teamId,
        userId: ok.userId,
        purpose: "PUBLIC_VERIFY_SUSPEND",
        resourceKind: "evidence",
        resourceId: id,
      });
      if (gate.sent) return;
      try {
        const updated = await suspendPublicVerify({
          evidenceId: id,
          teamId: body.teamId,
          actorUserId: ok.userId,
          reason: body.reason,
        });
        return reply
          .code(200)
          .send({ publication: projectPublicationState(updated) });
      } catch (err) {
        return publicationErrorToReply(err, reply);
      }
    },
  );

  app.post(
    "/v1/governance/evidence/:id/restore",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          reason: z.string().max(400).nullable().optional(),
        })
        .parse(req.body ?? {});
      const ok = await requireMember(req, reply, body.teamId);
      if (!ok) return;
      const perm = requirePermission(ok.role, "evidence.publish_verify");
      if (!perm.allowed) {
        denyByPermission(reply, perm.reason);
        return;
      }
      try {
        const updated = await restorePublicVerify({
          evidenceId: id,
          teamId: body.teamId,
          actorUserId: ok.userId,
          reason: body.reason ?? null,
        });
        return reply
          .code(200)
          .send({ publication: projectPublicationState(updated) });
      } catch (err) {
        return publicationErrorToReply(err, reply);
      }
    },
  );

  // ===========================================================================
  // Phase 14 — Retention reconciliation (cron-protected)
  // ===========================================================================

  app.get(
    "/v1/governance/retention-candidates",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = z
        .object({
          teamId: z.string().uuid(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId);
      if (!ok) return;
      const perm = requirePermission(ok.role, "governance.retention.manage");
      if (!perm.allowed) {
        denyByPermission(reply, perm.reason);
        return;
      }
      // Phase 32.5 — bounded schema-drift handling.
      await runGovernanceHandler(reply, async () => {
        const rows = await listRetentionCandidates({
          teamId: query.teamId,
          limit: query.limit,
        });
        reply.code(200).send({ candidates: rows });
      });
    },
  );

  app.post(
    "/v1/governance/reconcile-retention",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ok = await requireIntegrationCronSecret(req, reply);
      if (!ok) return;
      const body = z
        .object({
          teamId: z.string().uuid().optional(),
          batchSize: z.number().int().min(1).max(2000).optional(),
        })
        .parse(req.body ?? {});
      const summary = await reconcileRetention({
        teamId: body.teamId,
        batchSize: body.batchSize,
      });
      return reply.code(200).send({ summary });
    },
  );

  // ===========================================================================
  // Phase 14 — Workspace-wide governance state (operator dashboard)
  // ===========================================================================

  app.get(
    "/v1/governance/evidence/:id/is-held",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const query = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId);
      if (!ok) return;
      const evidence = await prisma.evidence.findUnique({
        where: { id },
        select: { id: true, teamId: true },
      });
      if (!evidence || evidence.teamId !== query.teamId) {
        return reply
          .code(404)
          .send({ error: { code: "evidence_not_found" } });
      }
      const held = await isEvidenceUnderAnyLegalHold(id);
      return reply.code(200).send({ held });
    },
  );
}

function publicationErrorToReply(err: unknown, reply: FastifyReply): void {
  if (err instanceof PublicationError) {
    const status =
      err.code === "evidence_not_in_workspace"
        ? 404
        : err.code === "invalid_state_transition"
          ? 409
          : err.code === "publication_approval_required"
            ? 412
            : err.code === "reason_required"
              ? 422
              : 400;
    reply.code(status).send({ error: { code: err.code } });
    return;
  }
  reply.code(500).send({ error: { code: "internal_error" } });
}
