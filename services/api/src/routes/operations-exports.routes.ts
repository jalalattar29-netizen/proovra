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

import { requireAuth } from "../middleware/auth.js";
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
import { requirePlatformOpsActor } from "./require-platform-ops-actor.js";

/**
 * ADM-013 — the authority for this family lives in ONE place.
 *
 * This file used to carry its own local actor check, and so did the three
 * sibling families; three of the four copies were byte-identical and the
 * fourth differed only in name. All four authorized on
 * `identity.member.read`, which every authenticated user holds in their own
 * personal workspace — so every authenticated user could reach platform data
 * by passing their own `teamId`.
 *
 * See `require-platform-ops-actor.ts` for what was proven and why the check is
 * now platform authority AND workspace membership, in that order.
 */

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
      const ctx = await requirePlatformOpsActor(req, reply, q.teamId);
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
      const ctx = await requirePlatformOpsActor(req, reply, q.teamId);
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
      const ctx = await requirePlatformOpsActor(req, reply, q.teamId);
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
      const ctx = await requirePlatformOpsActor(req, reply, q.teamId);
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
      const ctx = await requirePlatformOpsActor(req, reply, body.teamId);
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
