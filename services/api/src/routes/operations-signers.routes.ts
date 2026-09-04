/**
 * Phase P3.1 — Signer governance + custody attestation routes.
 *
 *   GET  /v1/operations/signers
 *   GET  /v1/operations/signers/:id
 *   GET  /v1/operations/signers/:id/health
 *   GET  /v1/operations/signers/:id/audit
 *   POST /v1/operations/signers/stage             — stage a new signer
 *   POST /v1/operations/signers/:id/preview       — rotation preview
 *   POST /v1/operations/signers/:id/promote       — step-up SIGNER_PROMOTE
 *   POST /v1/operations/signers/:id/retire        — step-up SIGNER_RETIRE
 *   POST /v1/operations/signers/:id/revoke        — step-up SIGNER_REVOKE
 *
 *   GET  /v1/operations/custody-attestations
 *   POST /v1/operations/custody-attestations/backfill  — step-up
 *   POST /v1/operations/custody-attestations/:id/verify
 *   GET  /v1/evidence/:evidenceId/custody/attestations
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requireStepUpForSensitiveAction } from "../services/identity-security/step-up-middleware.js";
import { safeEmitSecurityEvent } from "../services/security/security-event.service.js";
import {
  getSignerById,
  listAllSigners,
  SIGNER_PROVIDERS,
  SIGNER_PURPOSES,
} from "../services/operations/signer-registry.service.js";
import { probeSignerHealth } from "../services/operations/signer-health.service.js";
import {
  listSignerAudit,
  previewRotation,
  promoteStagedSigner,
  retireSigner,
  revokeSigner,
  stageSigner,
} from "../services/operations/signer-rotation.service.js";
import {
  backfillCustodyAttestations,
  listAttestations,
  signCustodyEvent,
  verifyCustodyAttestation,
} from "../services/operations/custody-attestation.service.js";
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

export async function operationsSignersRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------
  app.get(
    "/v1/operations/signers",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      const ctx = await requirePlatformOpsActor(req, reply, q.teamId);
      if (!ctx) return;
      const signers = await listAllSigners({ teamId: q.teamId });
      return reply.code(200).send({ signers });
    },
  );

  app.get(
    "/v1/operations/signers/:id",
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
      const signer = await getSignerById({
        teamId: q.teamId,
        signerId: params.id,
      });
      if (!signer) {
        return reply
          .code(404)
          .send({ error: { code: "not_found", message: "Signer not found." } });
      }
      return reply.code(200).send({ signer });
    },
  );

  // -------------------------------------------------------------------
  // Health + audit
  // -------------------------------------------------------------------
  app.get(
    "/v1/operations/signers/:id/health",
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
      const snapshot = await probeSignerHealth();
      safeEmitSecurityEvent({
        teamId: q.teamId,
        eventType: "signer_health_checked",
        severity: snapshot.health === "healthy" ? "INFO" : "WARNING",
        details: {
          actorUserId: ctx.userId,
          signerId: params.id,
          health: snapshot.health,
        },
      });
      if (snapshot.health !== "healthy") {
        safeEmitSecurityEvent({
          teamId: q.teamId,
          eventType: "signer_health_degraded",
          severity: "WARNING",
          details: {
            actorUserId: ctx.userId,
            signerId: params.id,
            health: snapshot.health,
            reason: snapshot.reason,
          },
        });
      }
      return reply.code(200).send({ snapshot });
    },
  );

  app.get(
    "/v1/operations/signers/:id/audit",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = z
        .object({ id: z.string().min(1).max(200) })
        .parse(req.params);
      const q = z
        .object({
          teamId: z.string().uuid(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(req.query ?? {});
      const ctx = await requirePlatformOpsActor(req, reply, q.teamId);
      if (!ctx) return;
      const events = await listSignerAudit({
        teamId: q.teamId,
        signerId: params.id,
        limit: q.limit,
      });
      return reply.code(200).send({ events });
    },
  );

  // -------------------------------------------------------------------
  // Rotation lifecycle
  // -------------------------------------------------------------------
  app.post(
    "/v1/operations/signers/stage",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = z
        .object({
          teamId: z.string().uuid(),
          signerPurpose: z.enum(SIGNER_PURPOSES),
          provider: z.enum(SIGNER_PROVIDERS),
          keyId: z.string().min(1).max(200).nullable().optional(),
          keyVersion: z.string().min(1).max(40).nullable().optional(),
          kmsKeyArn: z.string().min(1).max(400).nullable().optional(),
          algorithm: z.string().min(1).max(80).nullable().optional(),
          notes: z.string().max(400).nullable().optional(),
        })
        .parse(req.body ?? {});
      const ctx = await requirePlatformOpsActor(req, reply, body.teamId);
      if (!ctx) return;
      const result = await stageSigner({
        teamId: body.teamId,
        actorUserId: ctx.userId,
        signerPurpose: body.signerPurpose,
        provider: body.provider,
        keyId: body.keyId ?? null,
        keyVersion: body.keyVersion ?? null,
        kmsKeyArn: body.kmsKeyArn ?? null,
        algorithm: body.algorithm ?? null,
        notes: body.notes ?? null,
      });
      if (!result.ok) {
        return reply
          .code(400)
          .send({ error: { code: result.code, message: result.message } });
      }
      return reply.code(200).send({ result });
    },
  );

  app.post(
    "/v1/operations/signers/:id/preview",
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
      const result = await previewRotation({
        teamId: body.teamId,
        signerId: params.id,
        actorUserId: ctx.userId,
      });
      if (!result.ok) {
        return reply
          .code(404)
          .send({ error: { code: result.code, message: result.message } });
      }
      return reply.code(200).send({ preview: result.preview });
    },
  );

  app.post(
    "/v1/operations/signers/:id/promote",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = z
        .object({ id: z.string().min(1).max(200) })
        .parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          reason: z.string().min(1).max(240),
          // The state the operator was looking at. When supplied, the
          // transition is a compare-and-set: a signer that moved while the
          // dialog was open is refused as stale rather than silently
          // overwritten.
          expectedStateVersion: z.number().int().nonnegative().optional(),
        })
        .parse(req.body ?? {});
      const ctx = await requirePlatformOpsActor(req, reply, body.teamId);
      if (!ctx) return;
      const stepUp = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: body.teamId,
        userId: ctx.userId,
        purpose: "SIGNER_PROMOTE",
        resourceKind: "signer",
        resourceId: params.id,
      });
      if (stepUp.sent) return;
      const result = await promoteStagedSigner({
        teamId: body.teamId,
        actorUserId: ctx.userId,
        signerId: params.id,
        reason: body.reason,
      });
      if (!result.ok) {
        return reply
          .code(404)
          .send({ error: { code: result.code, message: result.message } });
      }
      return reply.code(200).send({ result });
    },
  );

  /**
   * A refusal is not always a bad request. A signer that does not exist is a
   * 404, a state that moved under the operator is a 409, and a transition the
   * domain forbids is a 409 — collapsing all of them into 400 told the console
   * nothing it could act on differently.
   */
  const signerLifecycleStatus = (
    code:
      | "reason_required"
      | "signer_not_found"
      | "transition_not_allowed"
      | "stale_state"
      | "last_active_signer",
  ): number => {
    if (code === "signer_not_found") return 404;
    if (code === "reason_required") return 400;
    return 409;
  };

  app.post(
    "/v1/operations/signers/:id/retire",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = z
        .object({ id: z.string().min(1).max(200) })
        .parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          reason: z.string().min(1).max(240),
          // The state the operator was looking at. When supplied, the
          // transition is a compare-and-set: a signer that moved while the
          // dialog was open is refused as stale rather than silently
          // overwritten.
          expectedStateVersion: z.number().int().nonnegative().optional(),
        })
        .parse(req.body ?? {});
      const ctx = await requirePlatformOpsActor(req, reply, body.teamId);
      if (!ctx) return;
      const stepUp = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: body.teamId,
        userId: ctx.userId,
        purpose: "SIGNER_RETIRE",
        resourceKind: "signer",
        resourceId: params.id,
      });
      if (stepUp.sent) return;
      const result = await retireSigner({
        teamId: body.teamId,
        actorUserId: ctx.userId,
        signerId: params.id,
        reason: body.reason,
        expectedStateVersion: body.expectedStateVersion,
      });
      if (!result.ok) {
        return reply
          .code(signerLifecycleStatus(result.code))
          .send({ error: { code: result.code, message: result.message } });
      }
      return reply.code(200).send({ result });
    },
  );

  app.post(
    "/v1/operations/signers/:id/revoke",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = z
        .object({ id: z.string().min(1).max(200) })
        .parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          reason: z.string().min(1).max(240),
          // The state the operator was looking at. When supplied, the
          // transition is a compare-and-set: a signer that moved while the
          // dialog was open is refused as stale rather than silently
          // overwritten.
          expectedStateVersion: z.number().int().nonnegative().optional(),
        })
        .parse(req.body ?? {});
      const ctx = await requirePlatformOpsActor(req, reply, body.teamId);
      if (!ctx) return;
      const stepUp = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: body.teamId,
        userId: ctx.userId,
        purpose: "SIGNER_REVOKE",
        resourceKind: "signer",
        resourceId: params.id,
      });
      if (stepUp.sent) return;
      const result = await revokeSigner({
        teamId: body.teamId,
        actorUserId: ctx.userId,
        signerId: params.id,
        reason: body.reason,
        expectedStateVersion: body.expectedStateVersion,
      });
      if (!result.ok) {
        return reply
          .code(signerLifecycleStatus(result.code))
          .send({ error: { code: result.code, message: result.message } });
      }
      return reply.code(200).send({ result });
    },
  );

  // -------------------------------------------------------------------
  // Custody attestations
  // -------------------------------------------------------------------
  app.get(
    "/v1/operations/custody-attestations",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({
          teamId: z.string().uuid(),
          evidenceId: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(req.query ?? {});
      const ctx = await requirePlatformOpsActor(req, reply, q.teamId);
      if (!ctx) return;
      const result = await listAttestations({
        teamId: q.teamId,
        evidenceId: q.evidenceId,
        limit: q.limit,
      });
      // total and limit travel with the rows so the client never infers
      // completeness from how many it received.
      return reply.code(200).send(result);
    },
  );

  app.post(
    "/v1/operations/custody-attestations/backfill",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = z
        .object({
          teamId: z.string().uuid(),
          batchSize: z.number().int().min(1).max(200).optional(),
        })
        .parse(req.body ?? {});
      const ctx = await requirePlatformOpsActor(req, reply, body.teamId);
      if (!ctx) return;
      const stepUp = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: body.teamId,
        userId: ctx.userId,
        purpose: "CUSTODY_ATTESTATION_BACKFILL",
        resourceKind: "custody_attestation_backfill",
        resourceId: "batch",
      });
      if (stepUp.sent) return;
      const result = await backfillCustodyAttestations({
        teamId: body.teamId,
        actorUserId: ctx.userId,
        batchSize: body.batchSize,
      });
      return reply.code(200).send({ result });
    },
  );

  app.post(
    "/v1/operations/custody-attestations/:id/verify",
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
      const report = await verifyCustodyAttestation({
        teamId: body.teamId,
        attestationId: params.id,
        actorUserId: ctx.userId,
      });
      return reply.code(200).send({ report });
    },
  );

  app.post(
    "/v1/evidence/:evidenceId/custody/attestations/sign",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // Single-event sign helper — useful for operators producing
      // attestations one at a time without invoking a backfill.
      const params = z
        .object({ evidenceId: z.string().uuid() })
        .parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          custodyEventId: z.string().uuid(),
        })
        .parse(req.body ?? {});
      const ctx = await requirePlatformOpsActor(req, reply, body.teamId);
      if (!ctx) return;
      // Validate the custody event belongs to the evidence ref.
      const evt = await prisma.custodyEvent.findFirst({
        where: { id: body.custodyEventId, evidenceId: params.evidenceId },
        select: { id: true },
      });
      if (!evt) {
        return reply
          .code(404)
          .send({ error: { code: "not_found" } });
      }
      const result = await signCustodyEvent({
        teamId: body.teamId,
        custodyEventId: body.custodyEventId,
        actorUserId: ctx.userId,
      });
      if (!result.ok) {
        return reply
          .code(400)
          .send({ error: { code: result.code, message: result.message } });
      }
      return reply.code(200).send({ attestation: result.attestation });
    },
  );

  app.get(
    "/v1/evidence/:evidenceId/custody/attestations",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = z
        .object({ evidenceId: z.string().uuid() })
        .parse(req.params);
      const q = z
        .object({
          teamId: z.string().uuid(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(req.query ?? {});
      const ctx = await requirePlatformOpsActor(req, reply, q.teamId);
      if (!ctx) return;
      const result = await listAttestations({
        teamId: q.teamId,
        evidenceId: params.evidenceId,
        limit: q.limit,
      });
      // Same envelope as the collection route. Two callers of one service must
      // not return two shapes: reply.send is untyped, so a change to the
      // service silently rewrites the response of any caller that spreads it.
      return reply.code(200).send(result);
    },
  );
}
