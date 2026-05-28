/**
 * Phase P2.1 — Immutable export operations routes.
 *
 * Exposes:
 *   GET  /v1/operations/exports                  — paginated list
 *   GET  /v1/operations/exports/object-lock      — platform Object Lock status
 *   GET  /v1/operations/exports/:id              — single export detail (manifest envelope)
 *   GET  /v1/operations/exports/:id/manifest     — manifest envelope (canonical)
 *   POST /v1/operations/exports/:id/verify       — reproducibility verifier
 *
 * Hard rules:
 *   * Every route is auth-required.
 *   * Every route is workspace-scoped (`teamId`).
 *   * Member must be an ACTIVE TeamMember; non-members get 404
 *     (anti-enumeration). Permission check is OPS-domain
 *     (`platform.operations.read` capability; we reuse the
 *     `identity.member.read` decision for now as that is the
 *     gate used by sibling `/v1/ops/health` — this is the same
 *     "workspace admin / operator" actor class).
 *   * The verify endpoint emits an audit event regardless of
 *     outcome so the audit center carries the verification
 *     attempt history.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { prisma } from "../db.js";
import { getAuthUserId } from "../auth.js";
import { requireAuth } from "../middleware/auth.js";
import { evaluateMemberAccess } from "../services/identity/access-policy.service.js";
import { bump } from "../services/ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../services/security/security-event.service.js";
import {
  EXPORT_KINDS,
  listExports,
  resolveExportManifest,
  type ExportKind,
} from "../services/operations/export-manifest.service.js";
import { verifyExportReproducibility } from "../services/operations/export-reproducibility.service.js";
import { getObjectLockStatus } from "../services/operations/object-lock-status.service.js";

async function requireOpsReader(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
): Promise<{ userId: string } | null> {
  const userId = getAuthUserId(req);
  const member = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
    select: { id: true, status: true },
  });
  if (!member) {
    reply.code(404).send({ error: { code: "not_found" } });
    return null;
  }
  if (member.status !== "ACTIVE") {
    reply.code(403).send({ error: { code: "member_inactive" } });
    return null;
  }
  // Same permission gate as sibling `/v1/ops/*` routes.
  const decision = await evaluateMemberAccess({
    teamId,
    userId,
    permission: "identity.member.read",
  });
  if (!decision.allowed) {
    reply.code(403).send({
      error: {
        code: "permission_denied",
        reason: decision.reason,
        detail: decision.detail ?? null,
      },
    });
    return null;
  }
  return { userId };
}

export async function operationsExportsRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------
  // List
  // -------------------------------------------------------------------
  app.get(
    "/v1/operations/exports",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({
          teamId: z.string().uuid(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
          kind: z.enum(EXPORT_KINDS).optional(),
        })
        .parse(req.query ?? {});
      const ctx = await requireOpsReader(req, reply, q.teamId);
      if (!ctx) return;
      const kinds: ReadonlyArray<ExportKind> = q.kind
        ? [q.kind]
        : EXPORT_KINDS;
      const exports = await listExports({
        teamId: q.teamId,
        limit: q.limit,
        kinds,
      });
      return reply.code(200).send({ exports });
    },
  );

  // -------------------------------------------------------------------
  // Object Lock status — workspace-agnostic (platform-wide). Still
  // requires auth + active membership for ANY workspace.
  // -------------------------------------------------------------------
  app.get(
    "/v1/operations/exports/object-lock",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      const ctx = await requireOpsReader(req, reply, q.teamId);
      if (!ctx) return;
      const status = await getObjectLockStatus();
      return reply.code(200).send({ status });
    },
  );

  // -------------------------------------------------------------------
  // Detail (manifest envelope)
  // -------------------------------------------------------------------
  app.get(
    "/v1/operations/exports/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = z
        .object({ id: z.string().min(1).max(200) })
        .parse(req.params);
      const q = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      const ctx = await requireOpsReader(req, reply, q.teamId);
      if (!ctx) return;
      const result = await resolveExportManifest({
        teamId: q.teamId,
        exportId: params.id,
      });
      if (!result.ok) {
        return reply
          .code(404)
          .send({ error: { code: result.code, message: result.message } });
      }
      return reply.code(200).send({ envelope: result.envelope });
    },
  );

  // -------------------------------------------------------------------
  // Manifest (canonical JSON for download)
  // -------------------------------------------------------------------
  app.get(
    "/v1/operations/exports/:id/manifest",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = z
        .object({ id: z.string().min(1).max(200) })
        .parse(req.params);
      const q = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      const ctx = await requireOpsReader(req, reply, q.teamId);
      if (!ctx) return;
      const result = await resolveExportManifest({
        teamId: q.teamId,
        exportId: params.id,
      });
      if (!result.ok) {
        return reply
          .code(404)
          .send({ error: { code: result.code, message: result.message } });
      }
      return reply.code(200).send({
        manifest: result.envelope.manifest,
        manifestHash: result.envelope.manifestHash,
      });
    },
  );

  // -------------------------------------------------------------------
  // Verify reproducibility
  // -------------------------------------------------------------------
  app.post(
    "/v1/operations/exports/:id/verify",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = z
        .object({ id: z.string().min(1).max(200) })
        .parse(req.params);
      const body = z
        .object({ teamId: z.string().uuid() })
        .parse(req.body ?? {});
      const ctx = await requireOpsReader(req, reply, body.teamId);
      if (!ctx) return;

      const result = await verifyExportReproducibility({
        teamId: body.teamId,
        exportId: params.id,
      });
      if (!result.ok) {
        return reply
          .code(404)
          .send({ error: { code: result.code, message: result.message } });
      }

      bump("export_verification_total");
      if (
        result.report.outcome === "artifact_drift" ||
        result.report.outcome === "retention_drift" ||
        result.report.outcome === "artifact_missing"
      ) {
        bump("export_reproducibility_failure_total");
      }

      safeEmitSecurityEvent({
        teamId: body.teamId,
        eventType: "export_reproducibility_verified",
        severity:
          result.report.outcome === "match" ? "INFO" : "WARNING",
        details: {
          actorUserId: ctx.userId,
          exportId: params.id,
          outcome: result.report.outcome,
          manifestHash: result.report.manifestEnvelope.manifestHash,
        },
      });

      return reply.code(200).send({ report: result.report });
    },
  );
}
