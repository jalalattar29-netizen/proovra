/**
 * RETENTION ARCHIVE + CANONICAL VERIFICATION ACCESS — owner surfaces
 * (owner decisions 2026-10-14).
 *
 *   GET  /v1/evidence/retention-archive                      Archived evidence (Retention Archive)
 *   POST /v1/evidence/:id/archive-restore                    request the verified archive restore
 *   GET  /v1/evidence/:id/archive-restore                    the latest restore request's state
 *   GET  /v1/evidence/:id/verification-access                the canonical verification page: status + link
 *   POST /v1/evidence/:id/verification-access/withdraw       legal / privacy / security withdrawal
 *   POST /v1/evidence/:id/verification-access/reinstate      reinstate a withdrawn page
 *
 * AUTHORITY. Every route asks the canonical record-access engine for the
 * operation's permission on THIS record (the persisted workspace, never the
 * request's): `evidence.archive.view`, `evidence.archive.restore`,
 * `evidence.read`, `evidence.verification.withdraw`. A caller who may read the
 * record but not perform the operation gets 403; anyone else gets the 404 a
 * missing record gets.
 *
 * NOTHING HERE DELETES OR REGENERATES ANYTHING. A restore request is a durable
 * row the worker verifies (every required object version and digest) before
 * the record moves; a withdrawal keeps the verification identity and makes the
 * page answer "withdrawn" truthfully.
 */
import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { roleHasPermission } from "@proovra/shared";
import {
  VERIFICATION_WITHDRAWAL_REASONS,
  canonicalVerificationPath,
  evaluateEffectiveLegalHold,
  resolveCanonicalVerificationStatus,
} from "@proovra/shared-runtime";

import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { appendCustodyEventTx } from "../services/custody-events.service.js";
import { emitTenantAudit } from "../services/audit/tenant-audit.service.js";
import { noteCustodyFailure } from "../services/custody-events-observability.js";
import {
  resolveEvidenceOperationAccess,
  type EvidenceRecordPermission,
} from "../services/evidence/evidence-record-access.service.js";

const ParamsId = z.object({ id: z.string().uuid() });
const RestoreBody = z.object({
  /** Client idempotency key: a retried click returns the same request. */
  clientRequestKey: z.string().trim().min(8).max(120).optional(),
});
const WithdrawBody = z.object({ reason: z.enum(VERIFICATION_WITHDRAWAL_REASONS) });
const ArchiveListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().uuid().optional(),
});

const NOT_FOUND = { message: "Evidence not found" } as const;

function audit(
  req: FastifyRequest,
  p: { actorUserId: string; teamId: string | null; evidenceId: string; action: string; metadata?: Record<string, unknown> },
): void {
  const ua = req.headers["user-agent"];
  void emitTenantAudit({
    action: p.action,
    outcome: "success",
    denialReason: null,
    sourceApp: "API",
    actorUserId: p.actorUserId,
    workspaceId: p.teamId,
    resourceType: "evidence",
    resourceId: p.evidenceId,
    correlationId: req.id ?? null,
    ipAddress: req.ip,
    userAgent: typeof ua === "string" ? ua : null,
    metadata: p.metadata ?? {},
  }).catch(noteCustodyFailure);
}

/** The operation's permission on this record, or the reply is already sent. */
async function authorize(
  req: FastifyRequest,
  reply: FastifyReply,
  evidenceId: string,
  permission: EvidenceRecordPermission,
  forbidden: { code: string; message: string },
): Promise<string | null> {
  const actorUserId = getAuthUserId(req);
  const access = await resolveEvidenceOperationAccess({ userId: actorUserId, evidenceId, permission });
  if (!access.allowed) {
    if (access.visibility === "FORBIDDEN") reply.code(403).send(forbidden);
    else reply.code(404).send(NOT_FOUND);
    return null;
  }
  return actorUserId;
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

export async function evidenceRetentionVerificationRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // Archived evidence (the Retention Archive)
  // -------------------------------------------------------------------------
  app.get("/v1/evidence/retention-archive", { preHandler: requireAuth }, async (req, reply) => {
    const userId = getAuthUserId(req);
    const query = ArchiveListQuery.parse(req.query ?? {});
    // The workspaces where the caller's ROLE grants `evidence.archive.view`;
    // each row is then re-confirmed through the canonical record-access engine.
    const memberships = await prisma.teamMember.findMany({
      where: { userId, status: "ACTIVE" },
      select: { teamId: true, role: true },
    });
    const teamIds = memberships
      .filter((m) => roleHasPermission(m.role, "evidence.archive.view"))
      .map((m) => m.teamId);
    const rows = await prisma.evidence.findMany({
      where: {
        lifecycleState: "RETENTION_ARCHIVED",
        OR: [{ teamId: null, ownerUserId: userId }, ...(teamIds.length > 0 ? [{ teamId: { in: teamIds } }] : [])],
        ...(query.cursor ? { id: { gt: query.cursor } } : {}),
      },
      orderBy: [{ id: "asc" }],
      take: query.limit + 1,
      select: {
        id: true,
        teamId: true,
        title: true,
        displayFileName: true,
        originalFileName: true,
        verificationRef: true,
        retentionArchivedAtUtc: true,
        purgeEligibleAtUtc: true,
        retentionBarrierState: true,
        caseLinks: { select: { caseId: true } },
        archiveRestoreRequests: {
          orderBy: { requestedAtUtc: "desc" },
          take: 1,
          select: { id: true, status: true, failureCode: true, requestedAtUtc: true },
        },
      },
    });
    const page = rows.slice(0, query.limit);
    const items = [];
    for (const row of page) {
      const view = await resolveEvidenceOperationAccess({ userId, evidenceId: row.id, permission: "evidence.archive.view" });
      if (!view.allowed) continue;
      const canRestore = (
        await resolveEvidenceOperationAccess({ userId, evidenceId: row.id, permission: "evidence.archive.restore" })
      ).allowed;
      // Legal-hold status is shown only to a caller who may act on the archive
      // (the same roles that hold governance.legal_hold.manage).
      let legalHold: boolean | null = null;
      if (canRestore) {
        try {
          legalHold = (
            await evaluateEffectiveLegalHold(prisma, {
              teamId: row.teamId ?? null,
              evidenceId: row.id,
              caseIds: row.caseLinks.map((l) => l.caseId),
            })
          ).held;
        } catch {
          legalHold = null; // unknown is stated as unknown, never as "no hold"
        }
      }
      const latest = row.archiveRestoreRequests[0] ?? null;
      const restoreInProgress = latest?.status === "REQUESTED" || latest?.status === "RUNNING";
      items.push({
        id: row.id,
        title: row.title ?? row.displayFileName ?? row.originalFileName ?? null,
        verificationReference: row.verificationRef ?? null,
        archivedAtUtc: iso(row.retentionArchivedAtUtc),
        reason: "RETENTION" as const,
        retentionBarrier: row.retentionBarrierState ?? null,
        earliestPurgeAtUtc: iso(row.purgeEligibleAtUtc),
        legalHold,
        restore: {
          available: canRestore && !restoreInProgress,
          inProgress: restoreInProgress,
          lastRequest: latest
            ? { status: latest.status, failureCode: latest.failureCode ?? null, requestedAtUtc: iso(latest.requestedAtUtc) }
            : null,
        },
      });
    }
    return reply.code(200).send({
      items,
      nextCursor: rows.length > query.limit ? (page[page.length - 1]?.id ?? null) : null,
    });
  });

  // -------------------------------------------------------------------------
  // Archive restore
  // -------------------------------------------------------------------------
  app.post("/v1/evidence/:id/archive-restore", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = ParamsId.parse(req.params);
    const body = RestoreBody.parse(req.body ?? {});
    const actorUserId = await authorize(req, reply, id, "evidence.archive.restore", {
      code: "ARCHIVE_RESTORE_NOT_PERMITTED",
      message: "You can view this record, but restoring it from the retention archive needs an owner or administrator.",
    });
    if (!actorUserId) return reply;

    const outcome = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
      const evidence = await tx.evidence.findUnique({
        where: { id },
        select: { teamId: true, lifecycleState: true, destructionClaimedAtUtc: true },
      });
      if (!evidence) return { kind: "NOT_FOUND" as const };
      if (body.clientRequestKey) {
        const replay = await tx.evidenceArchiveRestoreRequest.findUnique({
          where: { idempotencyKey: `${id}:${body.clientRequestKey}` },
          select: { id: true, status: true },
        });
        if (replay) return { kind: "EXISTING" as const, request: replay, teamId: evidence.teamId };
      }
      const open = await tx.evidenceArchiveRestoreRequest.findFirst({
        where: { evidenceId: id, status: { in: ["REQUESTED", "RUNNING"] } },
        select: { id: true, status: true },
      });
      if (open) return { kind: "EXISTING" as const, request: open, teamId: evidence.teamId };
      if (evidence.lifecycleState !== "RETENTION_ARCHIVED" || evidence.destructionClaimedAtUtc) {
        return { kind: "NOT_ARCHIVED" as const };
      }
      const request = await tx.evidenceArchiveRestoreRequest.create({
        data: {
          evidenceId: id,
          teamId: evidence.teamId ?? null,
          requestedByUserId: actorUserId,
          idempotencyKey: `${id}:${body.clientRequestKey ?? randomUUID()}`,
        },
        select: { id: true, status: true },
      });
      await appendCustodyEventTx(tx, {
        evidenceId: id,
        eventType: "ARCHIVE_RESTORE_REQUESTED",
        payload: { requestId: request.id, requestedByUserId: actorUserId },
        ip: req.ip,
      });
      return { kind: "CREATED" as const, request, teamId: evidence.teamId };
    });

    if (outcome.kind === "NOT_FOUND") return reply.code(404).send(NOT_FOUND);
    if (outcome.kind === "NOT_ARCHIVED") {
      return reply.code(409).send({
        code: "EVIDENCE_NOT_IN_RETENTION_ARCHIVE",
        message: "This record is not in the retention archive, so there is nothing to restore from it.",
      });
    }
    if (outcome.kind === "CREATED") {
      audit(req, {
        actorUserId,
        teamId: outcome.teamId ?? null,
        evidenceId: id,
        action: "evidence.archive_restore_requested",
        metadata: { requestId: outcome.request.id },
      });
    }
    return reply.code(outcome.kind === "CREATED" ? 202 : 200).send({
      request: { id: outcome.request.id, status: outcome.request.status },
      deduplicated: outcome.kind === "EXISTING",
    });
  });

  app.get("/v1/evidence/:id/archive-restore", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = ParamsId.parse(req.params);
    const actorUserId = await authorize(req, reply, id, "evidence.archive.view", {
      code: "ARCHIVE_VIEW_NOT_PERMITTED",
      message: "Viewing the retention archive needs an owner or administrator.",
    });
    if (!actorUserId) return reply;
    const latest = await prisma.evidenceArchiveRestoreRequest.findFirst({
      where: { evidenceId: id },
      orderBy: { requestedAtUtc: "desc" },
      select: { id: true, status: true, failureCode: true, requestedAtUtc: true, completedAtUtc: true, failedAtUtc: true },
    });
    return reply.code(200).send({
      request: latest
        ? {
            id: latest.id,
            status: latest.status,
            failureCode: latest.failureCode ?? null,
            requestedAtUtc: iso(latest.requestedAtUtc),
            completedAtUtc: iso(latest.completedAtUtc),
            failedAtUtc: iso(latest.failedAtUtc),
          }
        : null,
    });
  });

  // -------------------------------------------------------------------------
  // Canonical verification access
  // -------------------------------------------------------------------------
  app.get("/v1/evidence/:id/verification-access", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = ParamsId.parse(req.params);
    const actorUserId = await authorize(req, reply, id, "evidence.read", { code: "NOT_PERMITTED", message: "Not permitted." });
    if (!actorUserId) return reply;
    const row = await prisma.evidence.findUnique({
      where: { id },
      select: {
        lifecycleState: true,
        destroyedAtUtc: true,
        verificationRef: true,
        verificationRefIssuedAtUtc: true,
        verificationAccessState: true,
        verificationAccessChangedAtUtc: true,
        verificationAccessReason: true,
      },
    });
    if (!row) return reply.code(404).send(NOT_FOUND);
    const canWithdraw = (
      await resolveEvidenceOperationAccess({ userId: actorUserId, evidenceId: id, permission: "evidence.verification.withdraw" })
    ).allowed;
    return reply.code(200).send({
      // NOT_ISSUED until the record's first report is issued; then permanent.
      status: row.verificationRef ? resolveCanonicalVerificationStatus(row) : "NOT_ISSUED",
      reference: row.verificationRef ?? null,
      verifyPath: row.verificationRef ? canonicalVerificationPath(row.verificationRef) : null,
      issuedAtUtc: iso(row.verificationRefIssuedAtUtc),
      withdrawal:
        row.verificationAccessState !== "AVAILABLE"
          ? {
              state: row.verificationAccessState,
              reason: row.verificationAccessReason ?? null,
              changedAtUtc: iso(row.verificationAccessChangedAtUtc),
            }
          : null,
      canWithdraw,
    });
  });

  const changeAccess = (target: "WITHDRAWN" | "AVAILABLE") =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = target === "WITHDRAWN" ? WithdrawBody.parse(req.body ?? {}) : null;
      const actorUserId = await authorize(req, reply, id, "evidence.verification.withdraw", {
        code: "VERIFICATION_WITHDRAWAL_NOT_PERMITTED",
        message: "Withdrawing or reinstating a verification page needs an owner or administrator.",
      });
      if (!actorUserId) return reply;
      const result = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
        const row = await tx.evidence.findUnique({
          where: { id },
          select: { teamId: true, verificationAccessState: true },
        });
        if (!row) return null;
        if (row.verificationAccessState === target) return { changed: false, teamId: row.teamId };
        const now = new Date();
        await tx.evidence.update({
          where: { id },
          data: {
            verificationAccessState: target,
            verificationAccessChangedAtUtc: now,
            verificationAccessChangedByUserId: actorUserId,
            verificationAccessReason: body?.reason ?? null,
          },
        });
        await appendCustodyEventTx(tx, {
          evidenceId: id,
          eventType: target === "WITHDRAWN" ? "VERIFICATION_ACCESS_WITHDRAWN" : "VERIFICATION_ACCESS_REINSTATED",
          atUtc: now,
          payload: { reason: body?.reason ?? null, changedByUserId: actorUserId },
          ip: req.ip,
        });
        return { changed: true, teamId: row.teamId };
      });
      if (!result) return reply.code(404).send(NOT_FOUND);
      if (result.changed) {
        audit(req, {
          actorUserId,
          teamId: result.teamId ?? null,
          evidenceId: id,
          action: target === "WITHDRAWN" ? "verification.access_withdrawn" : "verification.access_reinstated",
          metadata: { reason: body?.reason ?? null },
        });
      }
      return reply.code(200).send({ state: target, changed: result.changed });
    };

  app.post("/v1/evidence/:id/verification-access/withdraw", { preHandler: requireAuth }, changeAccess("WITHDRAWN"));
  app.post("/v1/evidence/:id/verification-access/reinstate", { preHandler: requireAuth }, changeAccess("AVAILABLE"));
}
