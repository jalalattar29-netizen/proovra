/**
 * Phase 10 — Public enterprise integration API.
 *
 * Authentication: Bearer API key (`Authorization: Bearer pwk_v1_...`).
 * The credential's `teamId` defines the workspace scope; the caller
 * does not pass `teamId` in the request body / query.
 *
 *   GET   /v1/integrations/api/evidence              — list (safe projection)
 *   GET   /v1/integrations/api/evidence/:id          — fetch one
 *   POST  /v1/integrations/api/intake-links          — create intake link
 *   POST  /v1/integrations/api/evidence-requests     — create evidence request
 *
 * Privacy: no internal notes, no legal-hold reasons, no raw tokens,
 * no IP/UA. Workspace-internal review state is summarised, never
 * surfaced verbatim.
 *
 * Every handler:
 *   1. `requireApiKey` (sets req.apiCredential, gates feature flag).
 *   2. `requireApiScope` for the action-specific permission.
 *   3. Operates only on the workspace from req.apiCredential.teamId.
 */

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";

import { prisma } from "../db.js";
import {
  requireApiKey,
  requireApiScope,
  runWithApiAudit,
} from "../middleware/integrations-auth.js";
import { createEvidenceRequest } from "../services/evidence-request.service.js";
import { createWorkflowIntakeLink } from "../services/workflow-intake-link.service.js";
import {
  canCreateIntakeLink,
  loadWorkspaceGovernancePolicy,
} from "../services/governance.service.js";
import {
  EvidenceRequestInputSchema,
} from "@proovra/shared";

const ParamsId = z.object({ id: z.string().uuid() });

function projectEvidenceForApi(e: {
  id: string;
  type: string;
  status: string;
  verificationStatus: string | null;
  title: string | null;
  mimeType: string | null;
  sizeBytes: bigint | null;
  fileSha256: string | null;
  originalFileName: string | null;
  displayFileName: string | null;
  capturedAtUtc: Date | null;
  createdAt: Date;
  updatedAt: Date;
  retentionUntilUtc: Date | null;
  archivedAt: Date | null;
  teamId: string | null;
}) {
  return {
    id: e.id,
    type: e.type,
    status: e.status,
    verificationStatus: e.verificationStatus,
    title: e.title,
    mimeType: e.mimeType,
    sizeBytes: e.sizeBytes ? e.sizeBytes.toString() : null,
    fileSha256: e.fileSha256,
    displayFileName: e.displayFileName ?? e.originalFileName,
    capturedAtUtc: e.capturedAtUtc?.toISOString() ?? null,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
    retentionUntilUtc: e.retentionUntilUtc?.toISOString() ?? null,
    archived: Boolean(e.archivedAt),
    // Deliberately NOT projected: internalNotes, intakePlanJson (may
    // contain workspace-internal context), capture-method telemetry,
    // submittedBy fields, lastAccessedBy, audit chain pointers.
  };
}

const EvidenceSelect = {
  id: true,
  type: true,
  status: true,
  verificationStatus: true,
  title: true,
  mimeType: true,
  sizeBytes: true,
  fileSha256: true,
  originalFileName: true,
  displayFileName: true,
  capturedAtUtc: true,
  createdAt: true,
  updatedAt: true,
  retentionUntilUtc: true,
  archivedAt: true,
  teamId: true,
} as const;

export async function integrationsApiRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // GET /v1/integrations/api/evidence
  // ---------------------------------------------------------------------------

  app.get(
    "/v1/integrations/api/evidence",
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!(await requireApiKey(req, reply))) return;
      if (!requireApiScope(req, reply, "integration.evidence.read")) return;
      const cred = req.apiCredential!;
      return runWithApiAudit(req, reply, "evidence.list", async () => {
        const query = z
          .object({
            status: z.string().max(40).optional(),
            createdAfter: z.string().datetime().optional(),
            createdBefore: z.string().datetime().optional(),
            limit: z.coerce.number().int().min(1).max(100).optional(),
            cursor: z.string().uuid().optional(),
          })
          .parse(req.query ?? {});

        const dateFilter: { gte?: Date; lte?: Date } = {};
        if (query.createdAfter) dateFilter.gte = new Date(query.createdAfter);
        if (query.createdBefore) dateFilter.lte = new Date(query.createdBefore);

        const rows = await prisma.evidence.findMany({
          where: {
            teamId: cred.teamId,
            ...(query.status ? { status: query.status as never } : {}),
            ...(Object.keys(dateFilter).length > 0
              ? { createdAt: dateFilter }
              : {}),
            ...(query.cursor ? { id: { lt: query.cursor } } : {}),
          },
          select: EvidenceSelect,
          orderBy: { createdAt: "desc" },
          take: Math.min(Math.max(query.limit ?? 25, 1), 100),
        });

        return reply.code(200).send({
          evidence: rows.map(projectEvidenceForApi),
          nextCursor: rows.length > 0 ? rows[rows.length - 1].id : null,
        });
      });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/integrations/api/evidence/:id
  // ---------------------------------------------------------------------------

  app.get(
    "/v1/integrations/api/evidence/:id",
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!(await requireApiKey(req, reply))) return;
      if (!requireApiScope(req, reply, "integration.evidence.read")) return;
      const cred = req.apiCredential!;
      return runWithApiAudit(req, reply, "evidence.get", async () => {
        const { id } = ParamsId.parse(req.params);
        const row = await prisma.evidence.findUnique({
          where: { id },
          select: EvidenceSelect,
        });
        if (!row || row.teamId !== cred.teamId) {
          return reply.code(404).send({ error: { code: "not_found" } });
        }
        return reply.code(200).send({ evidence: projectEvidenceForApi(row) });
      });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/integrations/api/intake-links
  // ---------------------------------------------------------------------------

  app.post(
    "/v1/integrations/api/intake-links",
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!(await requireApiKey(req, reply))) return;
      if (!requireApiScope(req, reply, "integration.intake_link.create")) return;
      const cred = req.apiCredential!;
      return runWithApiAudit(req, reply, "intake_link.create", async () => {
        const body = z
          .object({
            workflowTemplateSlug: z.string().min(1).max(120),
            intakeMode: z.string().min(1).max(48),
            caseId: z.string().uuid().nullable().optional(),
            recipientLabel: z.string().max(180).nullable().optional(),
            recipientEmail: z.string().email().max(320).nullable().optional(),
            maxUses: z.number().int().min(1).max(10_000).optional(),
            expiresAtUtc: z.string().datetime(),
          })
          .parse(req.body ?? {});

        // Phase 10.5 — fail-closed governance gate. The integration API
        // must not be able to mint an intake link the workspace policy
        // would otherwise block. Service-account scope was already
        // validated above; here we run the policy half of the decision
        // against an ADMIN-equivalent role since the scope grants that
        // capability by design.
        let policy;
        try {
          policy = await loadWorkspaceGovernancePolicy(cred.teamId);
        } catch (err) {
          return reply.code(503).send({
            error: {
              code: "GOVERNANCE_CHECK_FAILED",
              message:
                err instanceof Error ? err.message : "policy_lookup_failed",
            },
          });
        }
        const decision = canCreateIntakeLink({
          role: "ADMIN",
          intakeMode: body.intakeMode,
          policy,
        });
        if (!decision.allowed) {
          return reply.code(403).send({
            error: {
              code: "INTAKE_LINK_BLOCKED_BY_POLICY",
              reason: decision.reason,
            },
          });
        }

        try {
          const { link, rawToken } = await createWorkflowIntakeLink(
            {
              teamId: cred.teamId,
              workflowTemplateSlug: body.workflowTemplateSlug,
              intakeMode: body.intakeMode as never,
              caseId: body.caseId ?? null,
              recipientLabel: body.recipientLabel ?? null,
              recipientEmail: body.recipientEmail ?? null,
              maxUses: body.maxUses ?? 1,
              expiresAtUtc: new Date(body.expiresAtUtc),
            },
            { actorUserId: cred.credentialId },
          );
          return reply.code(201).send({
            intakeLink: {
              id: link.id,
              teamId: link.teamId,
              workflowTemplateSlug: link.workflowTemplateSlug,
              workflowTemplateVersion: link.workflowTemplateVersion,
              intakeMode: link.intakeMode,
              recipientLabel: link.recipientLabel,
              recipientEmail: link.recipientEmail,
              maxUses: link.maxUses,
              usedCount: link.usedCount,
              expiresAtUtc: link.expiresAtUtc?.toISOString() ?? null,
              createdAt: link.createdAt.toISOString(),
              // No tokenHash, no IP allowlist details, no consent text.
            },
            // Returned ONCE so the caller can hand it to a recipient.
            rawToken,
          });
        } catch (err) {
          const e = err as { code?: string; message?: string };
          return reply.code(400).send({
            error: { code: e.code ?? "intake_link_failed", message: e.message },
          });
        }
      });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/integrations/api/evidence-requests
  // ---------------------------------------------------------------------------

  app.post(
    "/v1/integrations/api/evidence-requests",
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!(await requireApiKey(req, reply))) return;
      if (
        !requireApiScope(req, reply, "integration.evidence_request.create")
      )
        return;
      const cred = req.apiCredential!;
      return runWithApiAudit(
        req,
        reply,
        "evidence_request.create",
        async () => {
          const body = EvidenceRequestInputSchema.omit({ teamId: true }).parse(
            req.body ?? {},
          );
          try {
            const { request } = await createEvidenceRequest(
              { ...body, teamId: cred.teamId },
              { actorUserId: cred.credentialId },
            );
            return reply.code(201).send({
              evidenceRequest: {
                id: request.id,
                teamId: request.teamId,
                evidenceId: request.evidenceId,
                caseId: request.caseId,
                workflowTemplateSlug: request.workflowTemplateSlug,
                requestType: request.requestType,
                title: request.title,
                priority: request.priority,
                status: request.status,
                recipientMode: request.recipientMode,
                recipientLabel: request.recipientLabel,
                recipientEmail: request.recipientEmail,
                dueAtUtc: request.dueAtUtc?.toISOString() ?? null,
                createdAt: request.createdAt.toISOString(),
                // Deliberately NOT projected: instructions, assignedReviewer,
                // internal event log, raw tokens.
              },
            });
          } catch (err) {
            const e = err as {
              code?: string;
              message?: string;
              statusCode?: number;
            };
            return reply.code(e.statusCode ?? 400).send({
              error: {
                code: e.code ?? "evidence_request_failed",
                message: e.message,
              },
            });
          }
        },
      );
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/integrations/api/evidence-requests/:id
  // ---------------------------------------------------------------------------

  app.get(
    "/v1/integrations/api/evidence-requests/:id",
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!(await requireApiKey(req, reply))) return;
      if (!requireApiScope(req, reply, "integration.evidence_request.read"))
        return;
      const cred = req.apiCredential!;
      return runWithApiAudit(req, reply, "evidence_request.get", async () => {
        const { id } = ParamsId.parse(req.params);
        const row = await prisma.evidenceRequest.findUnique({
          where: { id },
          select: {
            id: true,
            teamId: true,
            evidenceId: true,
            caseId: true,
            workflowTemplateSlug: true,
            requestType: true,
            title: true,
            priority: true,
            status: true,
            recipientMode: true,
            recipientLabel: true,
            recipientEmail: true,
            dueAtUtc: true,
            createdAt: true,
          },
        });
        if (!row || row.teamId !== cred.teamId) {
          return reply.code(404).send({ error: { code: "not_found" } });
        }
        return reply.code(200).send({
          evidenceRequest: {
            ...row,
            dueAtUtc: row.dueAtUtc?.toISOString() ?? null,
            createdAt: row.createdAt.toISOString(),
          },
        });
      });
    },
  );
}
