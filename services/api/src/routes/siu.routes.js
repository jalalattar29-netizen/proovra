/**
 * Phase M3 — Insurance SIU routes.
 *
 *   GET    /v1/cases/:id/siu-profile               — load bounded profile
 *   PUT    /v1/cases/:id/siu-profile               — upsert profile
 *   POST   /v1/cases/:id/siu-profile/checklist/:itemId/map-evidence — map evidence
 *   POST   /v1/cases/:id/siu-profile/checklist/:itemId/status        — set status
 *   POST   /v1/cases/:id/siu-profile/indicators                       — add indicator
 *   POST   /v1/cases/:id/siu-profile/follow-ups                       — create follow-up
 *   POST   /v1/cases/:id/siu-profile/follow-ups/:followUpId/status    — update follow-up
 *   GET    /v1/cases/:id/siu-export/preflight                         — run preflight
 *   POST   /v1/cases/:id/siu-export                                    — build bundle (step-up)
 *   GET    /v1/siu/intake-templates                                    — list bounded templates
 *
 * All routes are auth-gated, workspace-scoped, and emit bounded audit
 * events.
 */
import { z } from "zod";
import { prisma } from "../db.js";
import { getAuthUserId } from "../auth.js";
import { requireAuth } from "../middleware/auth.js";
import { evaluateMemberAccess } from "../services/identity/access-policy.service.js";
import { requireStepUpForSensitiveAction } from "../services/identity-security/step-up-middleware.js";
import { appendPlatformAuditLog } from "../services/platform-audit-log.service.js";
import { SIU_INTAKE_TEMPLATES, SIU_REVIEW_INDICATOR_CODES, SIU_CHECKLIST_ITEM_STATUSES, SIU_FOLLOW_UP_STATUSES, SIU_SAVED_VIEW_PRESETS, SiuProfileUpsertInputSchema, } from "@proovra/shared";
import { addReviewIndicator, createFollowUpRequest, loadSiuProfile, mapEvidenceToChecklistItem, setChecklistItemStatus, updateFollowUpStatus, upsertSiuProfile, } from "../services/siu/siu-profile.service.js";
import { runSiuExportPreflight } from "../services/siu/siu-preflight.service.js";
import { buildSiuExportBundle, downloadSiuExportArtifact, listSiuExports, } from "../services/siu/siu-export-bundle.service.js";
import { evaluateSiuCapability, } from "../services/siu/siu-capabilities.service.js";
import { CreateSavedViewSchema, UpdateSavedViewSchema, createSavedView, deleteSavedView, listCustomSavedViews, markSavedViewUsed, updateSavedView, } from "../services/siu/siu-saved-views.service.js";
async function requireCaseActor(req, reply, caseId) {
    const userId = getAuthUserId(req);
    const c = await prisma.case.findUnique({
        where: { id: caseId },
        select: { id: true, teamId: true, ownerUserId: true },
    });
    if (!c) {
        reply.code(404).send({ error: { code: "not_found" } });
        return null;
    }
    if (!c.teamId) {
        reply.code(403).send({
            error: {
                code: "permission_denied",
                reason: "siu_requires_team_case",
            },
        });
        return null;
    }
    const member = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: c.teamId, userId } },
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
        teamId: c.teamId,
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
    // Bounded PII exposure policy: only the case owner sees claimant
    // fields by default. Future phases can wire this to a dedicated
    // capability.
    const exposePii = c.ownerUserId === userId;
    return { userId, teamId: c.teamId, exposePii };
}
export async function siuRoutes(app) {
    // -------------------------------------------------------------------
    // Intake templates (bounded, static)
    // -------------------------------------------------------------------
    app.get("/v1/siu/intake-templates", { preHandler: requireAuth }, async (_req, reply) => {
        return reply.code(200).send({ templates: SIU_INTAKE_TEMPLATES });
    });
    // -------------------------------------------------------------------
    // Profile read
    // -------------------------------------------------------------------
    app.get("/v1/cases/:id/siu-profile", { preHandler: requireAuth }, async (req, reply) => {
        const params = z.object({ id: z.string().uuid() }).parse(req.params);
        const ctx = await requireCaseActor(req, reply, params.id);
        if (!ctx)
            return;
        // Phase M3.1 — basic profile read returns PII-redacted projection
        // regardless of caller role. PII is only exposed via the dedicated
        // `reveal-pii` endpoint, which requires step-up + audit.
        const profile = await loadSiuProfile({
            caseId: params.id,
            teamId: ctx.teamId,
            exposePii: false,
        });
        if (!profile) {
            return reply.code(404).send({
                error: { code: "siu_profile_not_found" },
                durable: true,
                storage: "prisma",
            });
        }
        return reply.code(200).send({
            profile,
            durable: true,
            storage: "prisma",
            piiRedacted: true,
        });
    });
    // -------------------------------------------------------------------
    // Profile upsert
    // -------------------------------------------------------------------
    app.put("/v1/cases/:id/siu-profile", { preHandler: requireAuth }, async (req, reply) => {
        const params = z.object({ id: z.string().uuid() }).parse(req.params);
        const ctx = await requireCaseActor(req, reply, params.id);
        if (!ctx)
            return;
        const patch = SiuProfileUpsertInputSchema.parse(req.body);
        const profile = await upsertSiuProfile({
            caseId: params.id,
            teamId: ctx.teamId,
            patch,
            actorUserId: ctx.userId,
        });
        if (!profile) {
            return reply.code(404).send({ error: { code: "case_not_found" } });
        }
        await appendPlatformAuditLog({
            userId: ctx.userId,
            action: "siu_profile_updated",
            category: "case",
            severity: "info",
            source: "siu_routes",
            outcome: "success",
            resourceType: "case",
            resourceId: params.id,
            metadata: {
                teamId: ctx.teamId,
                claimType: patch.claimType,
                investigationStatus: patch.investigationStatus ?? null,
            },
        }).catch(() => { });
        return reply.code(200).send({ profile });
    });
    // -------------------------------------------------------------------
    // Checklist — map evidence
    // -------------------------------------------------------------------
    app.post("/v1/cases/:id/siu-profile/checklist/:itemId/map-evidence", { preHandler: requireAuth }, async (req, reply) => {
        const params = z
            .object({ id: z.string().uuid(), itemId: z.string().min(1).max(120) })
            .parse(req.params);
        const body = z
            .object({ evidenceId: z.string().uuid() })
            .parse(req.body ?? {});
        const ctx = await requireCaseActor(req, reply, params.id);
        if (!ctx)
            return;
        const profile = await mapEvidenceToChecklistItem({
            caseId: params.id,
            teamId: ctx.teamId,
            itemId: params.itemId,
            evidenceId: body.evidenceId,
        });
        if (!profile) {
            return reply.code(404).send({ error: { code: "not_found" } });
        }
        return reply.code(200).send({ profile });
    });
    // -------------------------------------------------------------------
    // Checklist — set status
    // -------------------------------------------------------------------
    app.post("/v1/cases/:id/siu-profile/checklist/:itemId/status", { preHandler: requireAuth }, async (req, reply) => {
        const params = z
            .object({ id: z.string().uuid(), itemId: z.string().min(1).max(120) })
            .parse(req.params);
        const body = z
            .object({
            status: z.enum(SIU_CHECKLIST_ITEM_STATUSES),
            note: z.string().max(240).optional().nullable(),
        })
            .parse(req.body ?? {});
        const ctx = await requireCaseActor(req, reply, params.id);
        if (!ctx)
            return;
        const profile = await setChecklistItemStatus({
            caseId: params.id,
            teamId: ctx.teamId,
            itemId: params.itemId,
            status: body.status,
            note: body.note,
            actorUserId: ctx.userId,
        });
        if (!profile) {
            return reply.code(404).send({ error: { code: "not_found" } });
        }
        return reply.code(200).send({ profile });
    });
    // -------------------------------------------------------------------
    // Review indicators
    // -------------------------------------------------------------------
    app.post("/v1/cases/:id/siu-profile/indicators", { preHandler: requireAuth }, async (req, reply) => {
        const params = z.object({ id: z.string().uuid() }).parse(req.params);
        const body = z
            .object({
            code: z.enum(SIU_REVIEW_INDICATOR_CODES),
            explanation: z.string().min(1).max(240),
            severity: z.enum(["info", "warning", "block_export"]),
            evidenceId: z.string().uuid().optional().nullable(),
        })
            .parse(req.body ?? {});
        const ctx = await requireCaseActor(req, reply, params.id);
        if (!ctx)
            return;
        const profile = await addReviewIndicator({
            caseId: params.id,
            teamId: ctx.teamId,
            code: body.code,
            explanation: body.explanation,
            severity: body.severity,
            evidenceId: body.evidenceId,
            actorUserId: ctx.userId,
        });
        if (!profile) {
            return reply.code(404).send({ error: { code: "not_found" } });
        }
        await appendPlatformAuditLog({
            userId: ctx.userId,
            action: "siu_review_indicator_added",
            category: "case",
            severity: body.severity === "block_export" ? "warning" : "info",
            source: "siu_routes",
            outcome: "success",
            resourceType: "case",
            resourceId: params.id,
            metadata: { teamId: ctx.teamId, code: body.code },
        }).catch(() => { });
        return reply.code(200).send({ profile });
    });
    // -------------------------------------------------------------------
    // Follow-up create
    // -------------------------------------------------------------------
    app.post("/v1/cases/:id/siu-profile/follow-ups", { preHandler: requireAuth }, async (req, reply) => {
        const params = z.object({ id: z.string().uuid() }).parse(req.params);
        const body = z
            .object({
            checklistItemId: z.string().min(1).max(120),
            dueByUtc: z.string().datetime().optional().nullable(),
            note: z.string().max(240).optional().nullable(),
            intakeLinkId: z.string().uuid().optional().nullable(),
        })
            .parse(req.body ?? {});
        const ctx = await requireCaseActor(req, reply, params.id);
        if (!ctx)
            return;
        const followUp = await createFollowUpRequest({
            caseId: params.id,
            teamId: ctx.teamId,
            checklistItemId: body.checklistItemId,
            dueByUtc: body.dueByUtc,
            note: body.note,
            intakeLinkId: body.intakeLinkId,
            actorUserId: ctx.userId,
        });
        if (!followUp) {
            return reply.code(404).send({ error: { code: "not_found" } });
        }
        await appendPlatformAuditLog({
            userId: ctx.userId,
            action: "siu_follow_up_requested",
            category: "case",
            severity: "info",
            source: "siu_routes",
            outcome: "success",
            resourceType: "case",
            resourceId: params.id,
            metadata: {
                teamId: ctx.teamId,
                followUpId: followUp.id,
                checklistItemId: body.checklistItemId,
            },
        }).catch(() => { });
        return reply.code(200).send({ followUp });
    });
    // -------------------------------------------------------------------
    // Follow-up status update
    // -------------------------------------------------------------------
    app.post("/v1/cases/:id/siu-profile/follow-ups/:followUpId/status", { preHandler: requireAuth }, async (req, reply) => {
        const params = z
            .object({
            id: z.string().uuid(),
            followUpId: z.string().uuid(),
        })
            .parse(req.params);
        const body = z
            .object({
            status: z.enum(SIU_FOLLOW_UP_STATUSES),
            receivedEvidenceId: z.string().uuid().optional().nullable(),
        })
            .parse(req.body ?? {});
        const ctx = await requireCaseActor(req, reply, params.id);
        if (!ctx)
            return;
        const followUp = await updateFollowUpStatus({
            caseId: params.id,
            teamId: ctx.teamId,
            followUpId: params.followUpId,
            status: body.status,
            receivedEvidenceId: body.receivedEvidenceId,
        });
        if (!followUp) {
            return reply.code(404).send({ error: { code: "not_found" } });
        }
        if (body.status === "received" || body.status === "satisfied") {
            await appendPlatformAuditLog({
                userId: ctx.userId,
                action: "siu_follow_up_received",
                category: "case",
                severity: "info",
                source: "siu_routes",
                outcome: "success",
                resourceType: "case",
                resourceId: params.id,
                metadata: {
                    teamId: ctx.teamId,
                    followUpId: followUp.id,
                    status: body.status,
                },
            }).catch(() => { });
        }
        return reply.code(200).send({ followUp });
    });
    // -------------------------------------------------------------------
    // Export preflight
    // -------------------------------------------------------------------
    app.get("/v1/cases/:id/siu-export/preflight", { preHandler: requireAuth }, async (req, reply) => {
        const params = z.object({ id: z.string().uuid() }).parse(req.params);
        const ctx = await requireCaseActor(req, reply, params.id);
        if (!ctx)
            return;
        const result = await runSiuExportPreflight({
            caseId: params.id,
            teamId: ctx.teamId,
        });
        if (!result) {
            return reply.code(404).send({ error: { code: "siu_profile_not_found" } });
        }
        await appendPlatformAuditLog({
            userId: ctx.userId,
            action: "siu_export_preflight_run",
            category: "case",
            severity: result.readiness === "blocked" ? "warning" : "info",
            source: "siu_routes",
            outcome: "success",
            resourceType: "case",
            resourceId: params.id,
            metadata: {
                teamId: ctx.teamId,
                readiness: result.readiness,
                warnings: result.totals.warnings,
                blockers: result.totals.blockers,
            },
        }).catch(() => { });
        return reply.code(200).send({ preflight: result });
    });
    // -------------------------------------------------------------------
    // Export generate (step-up gated)
    // -------------------------------------------------------------------
    app.post("/v1/cases/:id/siu-export", { preHandler: requireAuth }, async (req, reply) => {
        const params = z.object({ id: z.string().uuid() }).parse(req.params);
        const body = z
            .object({
            warningExportReason: z.string().max(240).optional().nullable(),
        })
            .parse(req.body ?? {});
        const ctx = await requireCaseActor(req, reply, params.id);
        if (!ctx)
            return;
        const stepUp = await requireStepUpForSensitiveAction({
            req,
            reply,
            teamId: ctx.teamId,
            userId: ctx.userId,
            purpose: "SIU_EXPORT_GENERATE",
            resourceKind: "case",
            resourceId: params.id,
        });
        if (stepUp.sent)
            return;
        const preflight = await runSiuExportPreflight({
            caseId: params.id,
            teamId: ctx.teamId,
        });
        if (!preflight) {
            return reply.code(404).send({ error: { code: "siu_profile_not_found" } });
        }
        if (preflight.readiness === "blocked") {
            await appendPlatformAuditLog({
                userId: ctx.userId,
                action: "siu_export_blocked",
                category: "case",
                severity: "warning",
                source: "siu_routes",
                outcome: "denied",
                resourceType: "case",
                resourceId: params.id,
                metadata: {
                    teamId: ctx.teamId,
                    blockers: preflight.totals.blockers,
                },
            }).catch(() => { });
            return reply.code(409).send({
                error: {
                    code: "siu_export_blocked",
                    preflight,
                },
            });
        }
        if (preflight.readiness === "ready_with_warnings" &&
            (!body.warningExportReason ||
                body.warningExportReason.trim().length < 8)) {
            return reply.code(400).send({
                error: {
                    code: "siu_export_warning_reason_required",
                    preflight,
                },
            });
        }
        const profile = await loadSiuProfile({
            caseId: params.id,
            teamId: ctx.teamId,
            exposePii: ctx.exposePii,
        });
        if (!profile) {
            return reply.code(404).send({ error: { code: "siu_profile_not_found" } });
        }
        const out = await buildSiuExportBundle({
            caseId: params.id,
            teamId: ctx.teamId,
            profile,
            preflight,
            warningExportReason: body.warningExportReason ?? null,
            actorUserId: ctx.userId,
        });
        await appendPlatformAuditLog({
            userId: ctx.userId,
            action: "siu_export_generated",
            category: "case",
            severity: "info",
            source: "siu_routes",
            outcome: "success",
            resourceType: "case",
            resourceId: params.id,
            metadata: {
                teamId: ctx.teamId,
                fileCount: out.files.length,
                readiness: preflight.readiness,
                exportRowId: out.exportRowId,
                reportsIncluded: out.artifactInclusion.reportsIncluded,
                reportsMissing: out.artifactInclusion.reportsMissing,
                verificationPackagesIncluded: out.artifactInclusion.verificationPackagesIncluded,
                verificationPackagesMissing: out.artifactInclusion.verificationPackagesMissing,
            },
        }).catch(() => { });
        reply
            .header("content-type", "application/zip")
            .header("content-disposition", `attachment; filename="siu-export-${params.id}.zip"`)
            .header("x-proovra-siu-export-id", out.exportRowId)
            .header("x-proovra-siu-artifact-sha256", out.artifactSha256)
            .header("x-proovra-siu-manifest-sha256", out.manifestSha256);
        return reply.code(200).send(out.buffer);
    });
    // -------------------------------------------------------------------
    // Phase M3.1 — durable export history
    // -------------------------------------------------------------------
    app.get("/v1/cases/:id/siu-exports", { preHandler: requireAuth }, async (req, reply) => {
        const params = z.object({ id: z.string().uuid() }).parse(req.params);
        const q = z
            .object({
            limit: z.coerce.number().int().min(1).max(200).optional(),
        })
            .parse(req.query ?? {});
        const ctx = await requireCaseActor(req, reply, params.id);
        if (!ctx)
            return;
        const exports = await listSiuExports({
            caseId: params.id,
            teamId: ctx.teamId,
            limit: q.limit,
        });
        return reply.code(200).send({
            exports,
            durable: true,
            storage: "prisma",
        });
    });
    // -------------------------------------------------------------------
    // Phase M3.1 — saved-view presets (bounded)
    // -------------------------------------------------------------------
    app.get("/v1/siu/saved-views", { preHandler: requireAuth }, async (_req, reply) => {
        return reply.code(200).send({ views: SIU_SAVED_VIEW_PRESETS });
    });
    // -------------------------------------------------------------------
    // Phase M3.1 — PII reveal (step-up + audit). Returns the SIU
    // profile with claimant fields un-redacted. Caller MUST have the
    // `siu.pii.view` capability AND a fresh step-up.
    // -------------------------------------------------------------------
    app.post("/v1/cases/:id/siu-profile/reveal-pii", { preHandler: requireAuth }, async (req, reply) => {
        const params = z.object({ id: z.string().uuid() }).parse(req.params);
        const ctx = await requireCaseActor(req, reply, params.id);
        if (!ctx)
            return;
        // Phase M3.2 — bounded capability evaluation.
        const ownerRow = await prisma.case.findUnique({
            where: { id: params.id },
            select: { ownerUserId: true },
        });
        const decision = await evaluateSiuCapability({
            teamId: ctx.teamId,
            userId: ctx.userId,
            caseOwnerUserId: ownerRow?.ownerUserId ?? null,
            capability: "siu.pii.view",
        });
        if (!decision.allowed) {
            await appendPlatformAuditLog({
                userId: ctx.userId,
                action: "siu_pii_revealed",
                category: "case",
                severity: "warning",
                source: "siu_routes",
                outcome: "denied",
                resourceType: "case",
                resourceId: params.id,
                metadata: {
                    teamId: ctx.teamId,
                    capability: decision.capability,
                    reason: decision.reason,
                },
            }).catch(() => { });
            return reply.code(403).send({
                error: {
                    code: "siu_pii_capability_required",
                    reason: "siu.pii.view capability required to reveal claimant PII.",
                    decisionReason: decision.reason,
                },
            });
        }
        // Phase M3.2 — dedicated step-up purpose `SIU_PII_REVEAL`.
        const stepUp = await requireStepUpForSensitiveAction({
            req,
            reply,
            teamId: ctx.teamId,
            userId: ctx.userId,
            purpose: "SIU_PII_REVEAL",
            resourceKind: "case",
            resourceId: params.id,
        });
        if (stepUp.sent)
            return;
        const profile = await loadSiuProfile({
            caseId: params.id,
            teamId: ctx.teamId,
            exposePii: true,
        });
        if (!profile) {
            return reply
                .code(404)
                .send({ error: { code: "siu_profile_not_found" } });
        }
        await appendPlatformAuditLog({
            userId: ctx.userId,
            action: "siu_pii_revealed",
            category: "case",
            severity: "warning",
            source: "siu_routes",
            outcome: "success",
            resourceType: "case",
            resourceId: params.id,
            metadata: {
                teamId: ctx.teamId,
                capability: decision.capability,
                reason: decision.reason,
            },
        }).catch(() => { });
        return reply.code(200).send({
            profile,
            piiRedacted: false,
            durable: true,
            capability: "siu.pii.view",
        });
    });
    // -------------------------------------------------------------------
    // Phase M3.2 — durable saved-view CRUD
    // -------------------------------------------------------------------
    app.get("/v1/siu/saved-views/custom", { preHandler: requireAuth }, async (req, reply) => {
        const q = z
            .object({ teamId: z.string().uuid() })
            .parse(req.query ?? {});
        const userId = getAuthUserId(req);
        // Tenancy + member check.
        const member = await prisma.teamMember.findUnique({
            where: { teamId_userId: { teamId: q.teamId, userId } },
            select: { id: true, status: true },
        });
        if (!member || member.status !== "ACTIVE") {
            return reply
                .code(403)
                .send({ error: { code: "member_inactive" } });
        }
        const views = await listCustomSavedViews({
            teamId: q.teamId,
            userId,
        });
        return reply.code(200).send({ views });
    });
    app.post("/v1/siu/saved-views", { preHandler: requireAuth }, async (req, reply) => {
        const body = CreateSavedViewSchema.parse(req.body);
        const userId = getAuthUserId(req);
        const member = await prisma.teamMember.findUnique({
            where: { teamId_userId: { teamId: body.teamId, userId } },
            select: { id: true, status: true, team: { select: { organizationId: true } } },
        });
        if (!member || member.status !== "ACTIVE") {
            return reply.code(403).send({ error: { code: "member_inactive" } });
        }
        const view = await createSavedView({
            payload: body,
            userId,
            organizationId: member.team?.organizationId ?? null,
        });
        return reply.code(201).send({ view });
    });
    app.patch("/v1/siu/saved-views/:id", { preHandler: requireAuth }, async (req, reply) => {
        const params = z
            .object({ id: z.string().uuid() })
            .parse(req.params);
        const body = UpdateSavedViewSchema.parse(req.body);
        const q = z
            .object({ teamId: z.string().uuid() })
            .parse(req.query ?? {});
        const userId = getAuthUserId(req);
        const member = await prisma.teamMember.findUnique({
            where: { teamId_userId: { teamId: q.teamId, userId } },
            select: { id: true, status: true },
        });
        if (!member || member.status !== "ACTIVE") {
            return reply.code(403).send({ error: { code: "member_inactive" } });
        }
        const view = await updateSavedView({
            id: params.id,
            teamId: q.teamId,
            userId,
            payload: body,
        });
        if (!view) {
            return reply.code(404).send({ error: { code: "not_found" } });
        }
        return reply.code(200).send({ view });
    });
    app.delete("/v1/siu/saved-views/:id", { preHandler: requireAuth }, async (req, reply) => {
        const params = z.object({ id: z.string().uuid() }).parse(req.params);
        const q = z
            .object({ teamId: z.string().uuid() })
            .parse(req.query ?? {});
        const userId = getAuthUserId(req);
        const member = await prisma.teamMember.findUnique({
            where: { teamId_userId: { teamId: q.teamId, userId } },
            select: { id: true, status: true },
        });
        if (!member || member.status !== "ACTIVE") {
            return reply.code(403).send({ error: { code: "member_inactive" } });
        }
        const ok = await deleteSavedView({
            id: params.id,
            teamId: q.teamId,
            userId,
        });
        if (!ok) {
            return reply.code(404).send({ error: { code: "not_found" } });
        }
        return reply.code(200).send({ deleted: true });
    });
    app.post("/v1/siu/saved-views/:id/use", { preHandler: requireAuth }, async (req, reply) => {
        const params = z.object({ id: z.string().uuid() }).parse(req.params);
        const body = z
            .object({ teamId: z.string().uuid() })
            .parse(req.body ?? {});
        const userId = getAuthUserId(req);
        const member = await prisma.teamMember.findUnique({
            where: { teamId_userId: { teamId: body.teamId, userId } },
            select: { id: true, status: true },
        });
        if (!member || member.status !== "ACTIVE") {
            return reply.code(403).send({ error: { code: "member_inactive" } });
        }
        const view = await markSavedViewUsed({
            id: params.id,
            teamId: body.teamId,
            userId,
        });
        if (!view) {
            return reply.code(404).send({ error: { code: "not_found" } });
        }
        return reply.code(200).send({ view });
    });
    // -------------------------------------------------------------------
    // Phase M3.2 — download a previously generated SIU export
    // -------------------------------------------------------------------
    app.get("/v1/cases/:id/siu-exports/:exportId/download", { preHandler: requireAuth }, async (req, reply) => {
        const params = z
            .object({
            id: z.string().uuid(),
            exportId: z.string().uuid(),
        })
            .parse(req.params);
        const ctx = await requireCaseActor(req, reply, params.id);
        if (!ctx)
            return;
        const outcome = await downloadSiuExportArtifact({
            caseId: params.id,
            teamId: ctx.teamId,
            exportId: params.exportId,
            actorUserId: ctx.userId,
        });
        if ("notFound" in outcome) {
            return reply
                .code(404)
                .send({ error: { code: "siu_export_not_found" } });
        }
        if ("notAvailable" in outcome) {
            return reply.code(409).send({
                error: {
                    code: "siu_export_not_downloadable",
                    reason: outcome.reason,
                },
            });
        }
        await appendPlatformAuditLog({
            userId: ctx.userId,
            action: "siu_export_downloaded",
            category: "case",
            severity: "info",
            source: "siu_routes",
            outcome: "success",
            resourceType: "case",
            resourceId: params.id,
            metadata: {
                teamId: ctx.teamId,
                exportRowId: outcome.exportRowId,
                artifactSha256: outcome.artifactSha256,
            },
        }).catch(() => { });
        reply
            .header("content-type", "application/zip")
            .header("content-disposition", `attachment; filename="siu-export-${params.id}.zip"`)
            .header("x-proovra-siu-export-id", outcome.exportRowId);
        if (outcome.artifactSha256) {
            reply.header("x-proovra-siu-artifact-sha256", outcome.artifactSha256);
        }
        return reply.code(200).send(outcome.stream);
    });
}
