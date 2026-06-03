/**
 * Phase 4 — Workflow intake link CRUD service.
 *
 * Authenticated administrative operations: create / list / get / revoke.
 * Does NOT serve public traffic — that path is in
 * external-intake.routes.ts which calls into workflow-intake-session.service.ts.
 *
 * Contract:
 *   - Every create gets a freshly-issued token from the token service. The
 *     raw token is returned to the caller exactly once; everything stored
 *     in the DB is an HMAC.
 *   - Listing never exposes the token hash. It is treated as a server-side
 *     secret on the same level as a password hash.
 *   - Revocation is idempotent.
 *
 * Phase 4 explicitly does NOT implement:
 *   - delivery (SMS / email) — Phase 5.
 *   - upload orchestration via the link — Phase 5+, wired into the existing
 *     authenticated capture pipeline with EXTERNAL_INTAKE_UPLOAD capture
 *     method.
 */
import { isExternalWorkflowIntakeMode, WorkflowIntakeModeSchema, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../db.js";
import { issueIntakeToken } from "./workflow-intake-token.service.js";
import { liftIntakeTemplateToWorkflowTemplate, parseDbWorkflowTemplate, } from "./workflow-template.service.js";
import { getIntakeTemplate, } from "./capture-intake-templates.js";
export class WorkflowIntakeLinkError extends Error {
    code;
    constructor(code, message) {
        super(message ?? code);
        this.code = code;
        this.name = "WorkflowIntakeLinkError";
    }
}
// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
async function loadEffectiveWorkflowTemplate(teamId, slug, client) {
    // 1. Workspace-scoped DB row wins by slug.
    const workspaceRow = await client.evidenceWorkflowTemplate.findFirst({
        where: { teamId, slug, archived: false },
    });
    if (workspaceRow) {
        const parsed = parseDbWorkflowTemplate(workspaceRow);
        if (parsed) {
            return {
                source: "workspace_db",
                templateId: workspaceRow.id,
                version: parsed.version,
                snapshot: parsed,
                intakeModes: parsed.intakeModes,
            };
        }
    }
    // 2. Global DB row.
    const globalRow = await client.evidenceWorkflowTemplate.findFirst({
        where: { teamId: null, slug, archived: false },
    });
    if (globalRow) {
        const parsed = parseDbWorkflowTemplate(globalRow);
        if (parsed) {
            return {
                source: "platform_db",
                templateId: globalRow.id,
                version: parsed.version,
                snapshot: parsed,
                intakeModes: parsed.intakeModes,
            };
        }
    }
    // 3. Seed list as a final fallback.
    const seed = getIntakeTemplate(slug);
    if (seed) {
        const lifted = liftIntakeTemplateToWorkflowTemplate(seed);
        return {
            source: "platform_seed",
            templateId: null,
            version: lifted.version,
            snapshot: lifted,
            intakeModes: lifted.intakeModes,
        };
    }
    throw new WorkflowIntakeLinkError("template_not_found");
}
// -----------------------------------------------------------------------------
// Create
// -----------------------------------------------------------------------------
export async function createWorkflowIntakeLink(input, ctx, client = defaultPrisma) {
    // Mode must validate against the canonical enum and must be EXTERNAL_*.
    const intakeMode = WorkflowIntakeModeSchema.parse(input.intakeMode);
    if (!isExternalWorkflowIntakeMode(intakeMode)) {
        throw new WorkflowIntakeLinkError("intake_mode_not_external");
    }
    // Expiry must be in the future.
    if (input.expiresAtUtc.getTime() <= Date.now()) {
        throw new WorkflowIntakeLinkError("expiry_in_past");
    }
    const maxUses = input.maxUses ?? 1;
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 10_000) {
        throw new WorkflowIntakeLinkError("max_uses_invalid");
    }
    // Resolve effective template + snapshot.
    const tpl = await loadEffectiveWorkflowTemplate(input.teamId, input.workflowTemplateSlug, client);
    if (!tpl.intakeModes.includes(intakeMode)) {
        throw new WorkflowIntakeLinkError("intake_mode_not_supported_by_template");
    }
    // Issue a fresh token. issueIntakeToken returns null when the secret is
    // not configured — that is the master kill switch.
    const issued = issueIntakeToken();
    if (!issued) {
        throw new WorkflowIntakeLinkError("feature_disabled");
    }
    const link = await client.workflowIntakeLink.create({
        data: {
            teamId: input.teamId,
            workflowTemplateId: tpl.templateId,
            workflowTemplateSlug: input.workflowTemplateSlug,
            workflowTemplateVersion: tpl.version,
            workflowTemplateSnapshot: tpl.snapshot,
            intakeMode,
            caseId: input.caseId ?? null,
            tokenHash: issued.tokenHash,
            tokenVersion: issued.tokenVersion,
            recipientLabel: input.recipientLabel ?? null,
            recipientEmail: input.recipientEmail ?? null,
            recipientPhone: input.recipientPhone ?? null,
            maxUses,
            usedCount: 0,
            maxFileCountPerSession: input.maxFileCountPerSession ?? null,
            maxBytesPerSession: input.maxBytesPerSession ?? null,
            allowedAcceptedKinds: input.allowedAcceptedKinds ?? [],
            consentPolicyVersion: input.consentPolicyVersion ?? null,
            consentDisclosureText: input.consentDisclosureText ?? null,
            expiresAtUtc: input.expiresAtUtc,
            ipAllowlistCidrs: input.ipAllowlistCidrs ?? [],
            createdByUserId: ctx.actorUserId,
        },
    });
    return { link, rawToken: issued.rawToken };
}
export async function listWorkflowIntakeLinks(input, client = defaultPrisma) {
    return client.workflowIntakeLink.findMany({
        where: {
            teamId: input.teamId,
            ...(input.status ? { status: input.status } : {}),
            ...(input.workflowTemplateSlug
                ? { workflowTemplateSlug: input.workflowTemplateSlug }
                : {}),
            ...(input.caseId ? { caseId: input.caseId } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: Math.min(Math.max(input.limit ?? 50, 1), 200),
    });
}
// -----------------------------------------------------------------------------
// Get
// -----------------------------------------------------------------------------
export async function getWorkflowIntakeLink(id, client = defaultPrisma) {
    return client.workflowIntakeLink.findUnique({ where: { id } });
}
export async function revokeWorkflowIntakeLink(input, client = defaultPrisma) {
    const existing = await client.workflowIntakeLink.findFirst({
        where: { id: input.id, teamId: input.teamId },
    });
    if (!existing)
        return null;
    if (existing.status === "REVOKED") {
        return existing; // idempotent
    }
    return client.workflowIntakeLink.update({
        where: { id: input.id },
        data: {
            status: "REVOKED",
            revokedAtUtc: new Date(),
            revokedByUserId: input.actorUserId,
            revokedReason: input.reason ?? null,
        },
    });
}
export async function sendIntakeLinkViaSms(input, client = defaultPrisma) {
    const link = await client.workflowIntakeLink.findFirst({
        where: { id: input.intakeLinkId, teamId: input.teamId },
        select: {
            id: true,
            revokedAtUtc: true,
            expiresAtUtc: true,
            recipientPhone: true,
        },
    });
    if (!link)
        return { ok: false, reason: "link_not_found" };
    if (link.revokedAtUtc)
        return { ok: false, reason: "link_revoked" };
    if (link.expiresAtUtc.getTime() <= Date.now()) {
        return { ok: false, reason: "link_expired" };
    }
    if (!link.recipientPhone)
        return { ok: false, reason: "link_missing_phone" };
    // Dynamic import avoids a circular dependency: communication.service
    // does not import workflow-intake-link.service, but workflow-intake-
    // link.service now wants the dispatch helper. The dynamic import
    // keeps the dependency graph linear at module-load time.
    const { enqueueOutboundMessage } = await import("./communications/communication.service.js");
    const { renderIntakeLinkSmsBody, appendStopFooter } = await import("@proovra/shared");
    const body = appendStopFooter(renderIntakeLinkSmsBody({
        workspaceName: input.workspaceName,
        intakeUrl: input.intakeUrl,
    }));
    const result = await enqueueOutboundMessage({
        teamId: input.teamId,
        channel: input.channel,
        purpose: "INTAKE_LINK",
        recipientPhone: link.recipientPhone,
        body,
        sender: "PROOVRA",
        related: { intakeLinkId: link.id },
        createdByUserId: input.actorUserId,
    }, client);
    if (result.status === "sent" ||
        result.status === "queued" ||
        result.status === "retry_scheduled") {
        return { ok: true, communicationMessageId: result.message.id };
    }
    return { ok: false, reason: "delivery_failed_or_skipped" };
}
export function projectWorkflowIntakeLink(link) {
    return {
        id: link.id,
        teamId: link.teamId,
        workflowTemplateSlug: link.workflowTemplateSlug,
        workflowTemplateVersion: link.workflowTemplateVersion,
        intakeMode: link.intakeMode,
        caseId: link.caseId,
        recipientLabel: link.recipientLabel,
        recipientEmail: link.recipientEmail,
        recipientPhone: link.recipientPhone,
        maxUses: link.maxUses,
        usedCount: link.usedCount,
        maxFileCountPerSession: link.maxFileCountPerSession,
        maxBytesPerSession: link.maxBytesPerSession !== null && link.maxBytesPerSession !== undefined
            ? link.maxBytesPerSession.toString()
            : null,
        allowedAcceptedKinds: link.allowedAcceptedKinds,
        consentPolicyVersion: link.consentPolicyVersion,
        status: link.status,
        expiresAtUtc: link.expiresAtUtc.toISOString(),
        revokedAtUtc: link.revokedAtUtc?.toISOString() ?? null,
        revokedReason: link.revokedReason,
        createdAt: link.createdAt.toISOString(),
        updatedAt: link.updatedAt.toISOString(),
    };
}
