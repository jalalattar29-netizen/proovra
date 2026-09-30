/**
 * PUBLIC VERIFICATION LINKS — OWNER CONTROLS (ET-PKG-07, 2026-09-30).
 *
 *   GET  /v1/evidence/:id/verify-links                      list (active, expired, revoked) + the legacy link
 *   POST /v1/evidence/:id/verify-links                      create — the ONLY response carrying a new token
 *   POST /v1/evidence/:id/verify-links/:linkId/revoke       withdraw one link; every other link keeps working
 *   POST /v1/evidence/:id/verify-links/:linkId/rotate       replace one link; the old token stops at once
 *   POST /v1/evidence/:id/verify-links/legacy/revoke        end the record-id link before its grace runs out
 *   GET  /v1/verify-links/legacy-inventory                  the workspace's records still reachable by id
 *
 * AUTHORITY. Every route asks the canonical record-access engine for
 * `evidence.publish_verify` on THIS record (current ACTIVE membership, access
 * expiry, organization lifecycle; the owner rule for a personal record). A
 * caller who may read the record but not publish gets 403; anyone else gets
 * the 404 a missing record gets. The workspace is the record's own, never the
 * request's.
 *
 * PUBLICATION. A link works only while the record is PUBLISHED, and a record
 * is never published automatically. Creating the first link on an unpublished
 * record IS the owner's act of publishing it: it goes through the publication
 * authority (custody event, and the step-up every publish requires). Creating
 * further links on a published record publishes nothing new.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { VERIFICATION_SHARE_AUDIENCE_MAX, VERIFICATION_SHARE_PROJECTIONS } from "@proovra/shared-runtime";

import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { authorizeOrFail } from "../middleware/authorize.js";
import { emitTenantAudit } from "../services/audit/tenant-audit.service.js";
import { noteCustodyFailure } from "../services/custody-events-observability.js";
import { resolveEvidenceOperationAccess } from "../services/evidence/evidence-record-access.service.js";
import { PublicationError, publishPublicVerify } from "../services/governance/publication.service.js";
import {
  VERIFICATION_LINK_MAX_EXPIRY_DAYS,
  VERIFICATION_LINK_MAX_USES_CEILING,
  VerificationShareError,
  createVerificationLink,
  legacyVerifyLinkInventory,
  listVerificationLinks,
  loadRecordForShare,
  recordIsShareable,
  revokeLegacyVerifyLink,
  revokeVerificationLink,
  rotateVerificationLink,
} from "../services/governance/verification-share.service.js";
import { requireStepUpForSensitiveAction } from "../services/identity-security/step-up-middleware.js";

const ParamsId = z.object({ id: z.string().uuid() });
const ParamsLink = z.object({ id: z.string().uuid(), linkId: z.string().uuid() });

const CreateBody = z.object({
  /** Who the link is for — the owner's label, never shown publicly. */
  audience: z.string().trim().min(1).max(VERIFICATION_SHARE_AUDIENCE_MAX),
  /** Days until it expires; null = no expiry, stated on purpose. */
  expiresInDays: z.number().int().min(1).max(VERIFICATION_LINK_MAX_EXPIRY_DAYS).nullable(),
  projection: z.enum(VERIFICATION_SHARE_PROJECTIONS).default("STANDARD"),
  maxUses: z.number().int().min(1).max(VERIFICATION_LINK_MAX_USES_CEILING).nullable().default(null),
});

function audit(
  req: FastifyRequest,
  p: {
    actorUserId: string;
    teamId: string | null;
    evidenceId: string;
    action: string;
    outcome?: "success" | "denied";
    denialReason?: string | null;
    metadata?: Record<string, unknown>;
  },
): void {
  const ua = req.headers["user-agent"];
  void emitTenantAudit({
    action: p.action,
    outcome: p.outcome ?? "success",
    denialReason: p.outcome === "denied" ? (p.denialReason ?? null) : null,
    sourceApp: "API",
    actorUserId: p.actorUserId,
    workspaceId: p.teamId,
    resourceType: "evidence_verification",
    resourceId: p.evidenceId,
    correlationId: req.id ?? null,
    ipAddress: req.ip,
    userAgent: typeof ua === "string" ? ua : null,
    metadata: p.metadata ?? {},
  }).catch(noteCustodyFailure);
}

/** The record, if the caller may manage its public links; otherwise the reply is already sent. */
async function authorizeShare(req: FastifyRequest, reply: FastifyReply, evidenceId: string) {
  const actorUserId = getAuthUserId(req);
  const access = await resolveEvidenceOperationAccess({
    userId: actorUserId,
    evidenceId,
    permission: "evidence.publish_verify",
  });
  if (!access.allowed) {
    if (access.visibility === "FORBIDDEN") {
      reply.code(403).send({
        code: "VERIFICATION_LINKS_NOT_PERMITTED",
        message:
          "You can view this record, but managing its public verification links needs a role with the publish permission.",
      });
    } else {
      reply.code(404).send({ message: "Evidence not found" });
    }
    return null;
  }
  const record = await loadRecordForShare(evidenceId);
  if (!record) {
    reply.code(404).send({ message: "Evidence not found" });
    return null;
  }
  return { actorUserId, record };
}

function shareErrorToReply(err: unknown, reply: FastifyReply): FastifyReply {
  if (err instanceof VerificationShareError) {
    // Each refusal is written out whole — `code: "<LITERAL>"` — because the
    // web's error-code coverage gate reads a route file's codes from exactly
    // that shape; a code assembled by a ternary is one the gate cannot see.
    const details = err.details ? { details: err.details } : {};
    switch (err.code) {
      case "link_not_found":
        return reply.code(404).send({ code: "VERIFICATION_LINK_NOT_FOUND", ...details });
      case "too_many_active_links":
        return reply.code(409).send({ code: "VERIFICATION_LINK_LIMIT_REACHED", ...details });
      case "record_not_shareable":
        return reply.code(409).send({ code: "RECORD_NOT_SHAREABLE", ...details });
      case "legacy_link_not_active":
        return reply.code(409).send({ code: "LEGACY_LINK_NOT_ACTIVE", ...details });
      default:
        return reply.code(409).send({ code: "VERIFICATION_LINK_NOT_ACTIVE", ...details });
    }
  }
  if (err instanceof PublicationError) {
    return reply
      .code(err.code === "evidence_not_in_workspace" ? 404 : 409)
      .send({ code: "PUBLICATION_NOT_AVAILABLE", reason: err.code });
  }
  throw err;
}

export async function verificationShareRoutes(app: FastifyInstance) {
  app.get("/v1/evidence/:id/verify-links", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = ParamsId.parse(req.params);
    const ctx = await authorizeShare(req, reply, id);
    if (!ctx) return reply;
    const listing = await listVerificationLinks(ctx.record);
    return reply.code(200).send({ ...listing, shareable: recordIsShareable(ctx.record) });
  });

  app.post("/v1/evidence/:id/verify-links", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = ParamsId.parse(req.params);
    const body = CreateBody.parse(req.body ?? {});
    const ctx = await authorizeShare(req, reply, id);
    if (!ctx) return reply;
    let record = ctx.record;
    if (!recordIsShareable(record)) {
      return reply.code(409).send({ code: "RECORD_NOT_SHAREABLE" });
    }

    // THE FIRST LINK PUBLISHES — explicitly, through the publication authority.
    let published = false;
    if (record.publicVerifyState !== "PUBLISHED") {
      if (!record.teamId) {
        // A record with no workspace row has no publication workflow to run.
        return reply.code(409).send({ code: "PUBLICATION_NOT_AVAILABLE", reason: "record_has_no_workspace" });
      }
      const gate = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: record.teamId,
        userId: ctx.actorUserId,
        purpose: "PUBLIC_VERIFY_PUBLISH",
        resourceKind: "evidence",
        resourceId: id,
      });
      if (gate.sent) return reply;
      try {
        await publishPublicVerify({
          evidenceId: id,
          teamId: record.teamId,
          actorUserId: ctx.actorUserId,
          reason: `Public verification link created for: ${body.audience}`.slice(0, 400),
        });
      } catch (err) {
        return shareErrorToReply(err, reply);
      }
      published = true;
      record = (await loadRecordForShare(id)) ?? record;
    }

    try {
      const created = await createVerificationLink({
        record,
        actorUserId: ctx.actorUserId,
        audience: body.audience,
        expiresInDays: body.expiresInDays,
        projection: body.projection,
        maxUses: body.maxUses,
      });
      audit(req, {
        actorUserId: ctx.actorUserId,
        teamId: record.teamId,
        evidenceId: id,
        action: "verification.link_created",
        metadata: {
          linkId: created.link.id,
          projection: created.link.projection,
          expiresAtUtc: created.link.expiresAtUtc,
          maxUses: created.link.maxUses,
          published,
        },
      });
      return reply.code(201).send({
        link: created.link,
        // Shown once. It cannot be read back: only its hash is stored.
        token: created.token,
        verifyPath: `/verify/${created.token}`,
        published,
      });
    } catch (err) {
      return shareErrorToReply(err, reply);
    }
  });

  app.post("/v1/evidence/:id/verify-links/legacy/revoke", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = ParamsId.parse(req.params);
    const ctx = await authorizeShare(req, reply, id);
    if (!ctx) return reply;
    try {
      const result = await revokeLegacyVerifyLink({ record: ctx.record });
      audit(req, {
        actorUserId: ctx.actorUserId,
        teamId: ctx.record.teamId,
        evidenceId: id,
        action: "verification.legacy_link_revoked",
        metadata: { changed: result.changed },
      });
      return reply.code(200).send(result);
    } catch (err) {
      return shareErrorToReply(err, reply);
    }
  });

  app.post("/v1/evidence/:id/verify-links/:linkId/revoke", { preHandler: requireAuth }, async (req, reply) => {
    const { id, linkId } = ParamsLink.parse(req.params);
    const ctx = await authorizeShare(req, reply, id);
    if (!ctx) return reply;
    try {
      const result = await revokeVerificationLink({ record: ctx.record, linkId, actorUserId: ctx.actorUserId });
      audit(req, {
        actorUserId: ctx.actorUserId,
        teamId: ctx.record.teamId,
        evidenceId: id,
        action: "verification.link_revoked",
        metadata: { linkId, changed: result.changed },
      });
      return reply.code(200).send(result);
    } catch (err) {
      return shareErrorToReply(err, reply);
    }
  });

  app.post("/v1/evidence/:id/verify-links/:linkId/rotate", { preHandler: requireAuth }, async (req, reply) => {
    const { id, linkId } = ParamsLink.parse(req.params);
    const ctx = await authorizeShare(req, reply, id);
    if (!ctx) return reply;
    try {
      const rotated = await rotateVerificationLink({ record: ctx.record, linkId, actorUserId: ctx.actorUserId });
      audit(req, {
        actorUserId: ctx.actorUserId,
        teamId: ctx.record.teamId,
        evidenceId: id,
        action: "verification.link_rotated",
        metadata: { replacedLinkId: rotated.replacedLinkId, linkId: rotated.link.id },
      });
      return reply.code(201).send({
        link: rotated.link,
        token: rotated.token,
        verifyPath: `/verify/${rotated.token}`,
        replacedLinkId: rotated.replacedLinkId,
      });
    } catch (err) {
      return shareErrorToReply(err, reply);
    }
  });

  app.get("/v1/verify-links/legacy-inventory", { preHandler: requireAuth }, async (req, reply) => {
    // The workspace is the caller's persisted active workspace, never a query value.
    const user = await prisma.user.findUnique({
      where: { id: getAuthUserId(req) },
      select: { currentWorkspaceId: true },
    });
    if (!user?.currentWorkspaceId) {
      return reply.code(404).send({ message: "Workspace not found" });
    }
    const authz = await authorizeOrFail(req, reply, {
      teamId: user.currentWorkspaceId,
      permission: "evidence.publish_verify",
      antiEnumeration: true,
    });
    if (!authz) return reply;
    return reply.code(200).send(await legacyVerifyLinkInventory({ teamId: authz.teamId }));
  });
}
