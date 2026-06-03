/**
 * Phase P2.5 — DR / Recovery operations routes.
 *
 *   GET  /v1/operations/recovery                       — last-N reports + readiness
 *   POST /v1/operations/recovery/validate-backup       — run backup validation
 *   POST /v1/operations/recovery/validate-restore      — run restore validation (step-up)
 *   GET  /v1/operations/recovery/reports               — paginated reports
 *   GET  /v1/operations/recovery/reports/:id           — single report
 */
import { z } from "zod";
import { prisma } from "../db.js";
import { getAuthUserId } from "../auth.js";
import { requireAuth } from "../middleware/auth.js";
import { evaluateMemberAccess } from "../services/identity/access-policy.service.js";
import { requireStepUpForSensitiveAction } from "../services/identity-security/step-up-middleware.js";
import { validateBackup, validateRestore, listRecoveryReports, getRecoveryReport, } from "../services/operations/recovery-validation.service.js";
import { getObjectLockStatus } from "../services/operations/object-lock-status.service.js";
async function requireOpsActor(req, reply, teamId) {
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
export async function operationsRecoveryRoutes(app) {
    // -------------------------------------------------------------------
    // Readiness overview
    // -------------------------------------------------------------------
    app.get("/v1/operations/recovery", { preHandler: requireAuth }, async (req, reply) => {
        const q = z
            .object({ teamId: z.string().uuid() })
            .parse(req.query ?? {});
        const ctx = await requireOpsActor(req, reply, q.teamId);
        if (!ctx)
            return;
        const reports = await listRecoveryReports({
            teamId: q.teamId,
            limit: 10,
        });
        const objectLock = await getObjectLockStatus();
        const lastBackup = reports.find((r) => r.kind === "backup_validation_report");
        const lastRestore = reports.find((r) => r.kind === "restore_validation_report");
        return reply.code(200).send({
            readiness: {
                objectLockMode: objectLock.mode,
                lastBackupReport: lastBackup ?? null,
                lastRestoreReport: lastRestore ?? null,
                unsupportedDomains: [
                    "infrastructure_database_backups",
                    "infrastructure_s3_backups",
                    "full_disaster_recovery_rehearsal",
                    "cross_region_failover",
                    "infrastructure_layer_restore_orchestration",
                ],
            },
            recentReports: reports,
        });
    });
    // -------------------------------------------------------------------
    // Run backup validation
    // -------------------------------------------------------------------
    app.post("/v1/operations/recovery/validate-backup", { preHandler: requireAuth }, async (req, reply) => {
        const body = z
            .object({ teamId: z.string().uuid() })
            .parse(req.body ?? {});
        const ctx = await requireOpsActor(req, reply, body.teamId);
        if (!ctx)
            return;
        const report = await validateBackup({
            teamId: body.teamId,
            actorUserId: ctx.userId,
        });
        return reply.code(200).send({ report });
    });
    // -------------------------------------------------------------------
    // Run restore validation (step-up gated)
    // -------------------------------------------------------------------
    app.post("/v1/operations/recovery/validate-restore", { preHandler: requireAuth }, async (req, reply) => {
        const body = z
            .object({ teamId: z.string().uuid() })
            .parse(req.body ?? {});
        const ctx = await requireOpsActor(req, reply, body.teamId);
        if (!ctx)
            return;
        const stepUp = await requireStepUpForSensitiveAction({
            req,
            reply,
            teamId: body.teamId,
            userId: ctx.userId,
            purpose: "RESTORE_VALIDATION_EXECUTE",
            resourceKind: "recovery_validation",
            resourceId: "restore",
        });
        if (stepUp.sent)
            return;
        const report = await validateRestore({
            teamId: body.teamId,
            actorUserId: ctx.userId,
        });
        return reply.code(200).send({ report });
    });
    // -------------------------------------------------------------------
    // List reports
    // -------------------------------------------------------------------
    app.get("/v1/operations/recovery/reports", { preHandler: requireAuth }, async (req, reply) => {
        const q = z
            .object({
            teamId: z.string().uuid(),
            limit: z.coerce.number().int().min(1).max(200).optional(),
        })
            .parse(req.query ?? {});
        const ctx = await requireOpsActor(req, reply, q.teamId);
        if (!ctx)
            return;
        const reports = await listRecoveryReports({
            teamId: q.teamId,
            limit: q.limit,
        });
        return reply.code(200).send({ reports });
    });
    // -------------------------------------------------------------------
    // Single report
    // -------------------------------------------------------------------
    app.get("/v1/operations/recovery/reports/:id", { preHandler: requireAuth }, async (req, reply) => {
        const params = z
            .object({ id: z.string().min(1).max(120) })
            .parse(req.params);
        const q = z
            .object({ teamId: z.string().uuid() })
            .parse(req.query ?? {});
        const ctx = await requireOpsActor(req, reply, q.teamId);
        if (!ctx)
            return;
        const report = await getRecoveryReport({
            teamId: q.teamId,
            reportId: params.id,
        });
        if (!report) {
            return reply
                .code(404)
                .send({ error: { code: "not_found", message: "Report not found." } });
        }
        return reply.code(200).send({ report });
    });
}
