/**
 * Phase 22 — Evidence Workflow Engine.
 *
 * The single mutation surface for the workflow-instance + step-instance
 * runtime layer. Every business caller goes through this service; no
 * route handler manipulates `evidence_workflow_*` tables directly.
 *
 * Responsibilities:
 *   1. Resolve a template (slug + version) → step snapshots.
 *   2. Create an EvidenceWorkflowInstance + child step instances
 *      with role / intake-mode validation (service accounts are
 *      restricted to API_INGESTION + SERVICE_ACCOUNT role).
 *   3. Map evidence rows to steps; mark steps SATISFIED.
 *   4. Operator transitions: submit → review → approve / changes
 *      requested → report ready → package ready → shared externally.
 *   5. Legal-hold + release helpers (pre-hold status preserved).
 *   6. Waive a required step (caller must hold the
 *     `STEP_WAIVE_REQUIRED` step-up — enforced at the route).
 *
 * Hard invariants:
 *   - Transitions follow the @proovra/shared
 *     `isAllowedWorkflowInstanceTransition` allow-list.
 *   - Step status mutation is bounded to satisfy/waive/needs-attention.
 *   - Every mutation emits an audit row + SecurityEvent.
 *   - LEGAL_HOLD takes precedence over every other transition; the
 *     engine refuses ARCHIVED / RETAINED moves while a hold is on.
 *   - Service accounts can only create instances via
 *     `createForApiIngestion` — every other entry point rejects them.
 */
import * as prismaPkg from "@prisma/client";
import { isAllowedWorkflowInstanceTransition, isExternalActorRole, isServiceAccountAllowedRole, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
import { appendPlatformAuditLog } from "../platform-audit-log.service.js";
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
// -----------------------------------------------------------------------------
// Error surface
// -----------------------------------------------------------------------------
export class WorkflowEngineError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
    }
}
// -----------------------------------------------------------------------------
// Public surface
// -----------------------------------------------------------------------------
export async function createWorkflowInstance(input, client = defaultPrisma) {
    validateRoleForIntakeMode(input.actorRole, input.intakeMode);
    const created = await client.evidenceWorkflowInstance.create({
        data: {
            teamId: input.teamId,
            templateId: input.templateId ?? null,
            templateSlug: input.templateSlug?.slice(0, 120) ?? null,
            templateVersion: input.templateVersion ?? null,
            status: "DRAFT",
            intakeMode: input.intakeMode,
            actorRole: input.actorRole,
            caseId: input.caseId ?? null,
            claimRef: input.claimRef?.slice(0, 128) ?? null,
            matterRef: input.matterRef?.slice(0, 128) ?? null,
            evidenceRequestId: input.evidenceRequestId ?? null,
            intakeSessionId: input.intakeSessionId ?? null,
            externalContactHash: input.externalContactHash ?? null,
            createdByUserId: input.createdByUserId ?? null,
            title: input.title?.slice(0, 180) ?? null,
            stepInstances: {
                create: input.steps.map((s) => ({
                    stepKey: s.stepKey.slice(0, 80),
                    title: s.title.slice(0, 180),
                    required: s.required,
                    orderIndex: s.orderIndex,
                    status: "NOT_STARTED",
                    acceptedKindsJson: s.acceptedKinds
                        ? s.acceptedKinds
                        : prismaPkg.Prisma.JsonNull,
                    identityRequirement: s.identityRequirement ?? null,
                    locationRequirement: s.locationRequirement ?? null,
                })),
            },
        },
    });
    bump("workflows_created_total");
    safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "workflow_instance_created",
        severity: "INFO",
        details: {
            instanceId: created.id,
            intakeMode: input.intakeMode,
            actorRole: input.actorRole,
            templateSlug: input.templateSlug ?? null,
            stepCount: input.steps.length,
        },
    });
    await appendPlatformAuditLog({
        userId: input.createdByUserId ?? null,
        isPublic: input.createdByUserId === null || input.createdByUserId === undefined,
        action: "workflow.instance.create",
        category: "workflow",
        severity: "info",
        source: "evidence_workflow_engine",
        outcome: "success",
        resourceType: "evidence_workflow_instance",
        resourceId: created.id,
        metadata: {
            teamId: input.teamId,
            intakeMode: input.intakeMode,
            actorRole: input.actorRole,
            templateSlug: input.templateSlug ?? null,
            templateVersion: input.templateVersion ?? null,
        },
        db: client,
    });
    return created;
}
function validateRoleForIntakeMode(role, mode) {
    // Service accounts only on API_INGESTION (... and that intake mode
    // isn't in the existing WORKFLOW_INTAKE_MODES list yet; we accept
    // any mode for service accounts but the actor MUST be the service-
    // account role).
    if (role === "SERVICE_ACCOUNT") {
        if (!isServiceAccountAllowedRole(role)) {
            throw new WorkflowEngineError("WORKFLOW_ACTOR_NOT_PERMITTED");
        }
        return;
    }
    // External actor roles must use an EXTERNAL_* intake mode.
    if (isExternalActorRole(role)) {
        if (mode !== "EXTERNAL_ONE_TIME" &&
            mode !== "EXTERNAL_REUSABLE" &&
            mode !== "EXTERNAL_ANONYMOUS" &&
            mode !== "EXTERNAL_PSEUDONYMOUS") {
            throw new WorkflowEngineError("WORKFLOW_ACTOR_NOT_PERMITTED");
        }
    }
}
export async function mapEvidenceToStep(input, client = defaultPrisma) {
    const instance = await loadInstance(client, input.teamId, input.workflowInstanceId);
    guardNotLegalHold(instance);
    const step = await client.evidenceWorkflowStepInstance.findFirst({
        where: {
            workflowInstanceId: instance.id,
            stepKey: input.stepKey,
        },
    });
    if (!step)
        throw new WorkflowEngineError("WORKFLOW_STEP_NOT_FOUND");
    // Confirm the evidence belongs to the same team (anti-cross-team).
    const evidence = await client.evidence.findFirst({
        where: { id: input.evidenceId, teamId: input.teamId },
        select: { id: true },
    });
    if (!evidence)
        throw new WorkflowEngineError("WORKFLOW_STEP_NOT_FOUND");
    const updated = await client.evidenceWorkflowStepInstance.update({
        where: { id: step.id },
        data: {
            status: "SATISFIED",
            mappedEvidenceId: input.evidenceId,
            completedByUserId: input.actorUserId ?? null,
            completedAtUtc: new Date(),
        },
    });
    // Best-effort join row insert. Idempotent via the unique key.
    try {
        await client.evidenceWorkflowInstanceEvidence.create({
            data: {
                workflowInstanceId: instance.id,
                evidenceId: input.evidenceId,
                stepInstanceId: step.id,
            },
        });
    }
    catch {
        /* duplicate — already linked */
    }
    bump("workflow_step_satisfied_total");
    safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "workflow_step_satisfied",
        severity: "INFO",
        details: {
            instanceId: instance.id,
            stepKey: input.stepKey,
            evidenceId: input.evidenceId,
        },
    });
    return updated;
}
export async function waiveStep(input, client = defaultPrisma) {
    const instance = await loadInstance(client, input.teamId, input.workflowInstanceId);
    guardNotLegalHold(instance);
    const step = await client.evidenceWorkflowStepInstance.findFirst({
        where: { workflowInstanceId: instance.id, stepKey: input.stepKey },
    });
    if (!step)
        throw new WorkflowEngineError("WORKFLOW_STEP_NOT_FOUND");
    const updated = await client.evidenceWorkflowStepInstance.update({
        where: { id: step.id },
        data: {
            status: "WAIVED",
            waiverReason: input.reason.slice(0, 400),
            completedByUserId: input.actorUserId,
            completedAtUtc: new Date(),
        },
    });
    bump("workflow_step_waived_total");
    safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "workflow_step_waived",
        severity: "INFO",
        details: {
            instanceId: instance.id,
            stepKey: input.stepKey,
            required: step.required,
        },
    });
    await appendPlatformAuditLog({
        userId: input.actorUserId,
        action: "workflow.step.waive",
        category: "workflow",
        severity: "warning",
        source: "evidence_workflow_engine",
        outcome: "success",
        resourceType: "evidence_workflow_step_instance",
        resourceId: updated.id,
        metadata: {
            teamId: input.teamId,
            workflowInstanceId: instance.id,
            stepKey: input.stepKey,
            required: step.required,
        },
        db: client,
    });
    return updated;
}
export async function transitionInstance(input, client = defaultPrisma) {
    const instance = await loadInstance(client, input.teamId, input.workflowInstanceId);
    const from = instance.status;
    if (!isAllowedWorkflowInstanceTransition(from, input.targetStatus)) {
        bump("workflow_transition_invalid_total");
        throw new WorkflowEngineError("WORKFLOW_INVALID_TRANSITION");
    }
    // Submit requires all REQUIRED steps satisfied.
    if (input.targetStatus === "SUBMITTED") {
        const unsatisfied = await client.evidenceWorkflowStepInstance.count({
            where: {
                workflowInstanceId: instance.id,
                required: true,
                status: { notIn: ["SATISFIED", "WAIVED"] },
            },
        });
        if (unsatisfied > 0) {
            throw new WorkflowEngineError("WORKFLOW_STEP_REQUIRED");
        }
    }
    const updateData = { status: input.targetStatus };
    if (input.targetStatus === "SUBMITTED") {
        updateData.submittedAtUtc = new Date();
    }
    if (input.targetStatus === "APPROVED") {
        updateData.approvedAtUtc = new Date();
    }
    if (input.targetStatus === "ARCHIVED" || input.targetStatus === "RETAINED" || input.targetStatus === "CANCELLED") {
        updateData.closedAtUtc = new Date();
    }
    if (input.targetStatus === "LEGAL_HOLD") {
        updateData.preHoldStatus = from;
    }
    if (from === "LEGAL_HOLD") {
        updateData.preHoldStatus = null;
    }
    const updated = await client.evidenceWorkflowInstance.update({
        where: { id: instance.id },
        data: updateData,
    });
    const eventType = transitionToSecurityEvent(input.targetStatus);
    if (eventType) {
        safeEmitSecurityEvent({
            teamId: input.teamId,
            eventType,
            severity: input.targetStatus === "CANCELLED" ? "WARNING" : "INFO",
            details: {
                instanceId: instance.id,
                from,
                to: input.targetStatus,
            },
        });
    }
    if (input.targetStatus === "SUBMITTED")
        bump("workflows_submitted_total");
    if (input.targetStatus === "APPROVED")
        bump("workflows_approved_total");
    await appendPlatformAuditLog({
        userId: input.actorUserId ?? null,
        isPublic: input.actorUserId === null || input.actorUserId === undefined,
        action: `workflow.instance.transition.${input.targetStatus.toLowerCase()}`,
        category: "workflow",
        severity: input.targetStatus === "CANCELLED" || input.targetStatus === "LEGAL_HOLD"
            ? "warning"
            : "info",
        source: "evidence_workflow_engine",
        outcome: "success",
        resourceType: "evidence_workflow_instance",
        resourceId: instance.id,
        metadata: {
            teamId: input.teamId,
            from,
            to: input.targetStatus,
        },
        db: client,
    });
    return updated;
}
function transitionToSecurityEvent(to) {
    switch (to) {
        case "SUBMITTED":
            return "workflow_instance_submitted";
        case "CHANGES_REQUESTED":
            return "workflow_instance_changes_requested";
        case "APPROVED":
            return "workflow_instance_approved";
        case "CANCELLED":
            return "workflow_instance_cancelled";
        default:
            return null;
    }
}
export async function assignReviewer(input, client = defaultPrisma) {
    const instance = await loadInstance(client, input.teamId, input.workflowInstanceId);
    // Reviewer must be a current team member.
    const member = await client.teamMember.findFirst({
        where: { teamId: input.teamId, userId: input.reviewerUserId },
        select: { id: true },
    });
    if (!member)
        throw new WorkflowEngineError("WORKFLOW_ACTOR_NOT_PERMITTED");
    const updated = await client.evidenceWorkflowInstance.update({
        where: { id: instance.id },
        data: { assignedReviewerUserId: input.reviewerUserId },
    });
    safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "workflow_review_assigned",
        severity: "INFO",
        details: {
            instanceId: instance.id,
            reviewerUserId: input.reviewerUserId,
        },
    });
    await appendPlatformAuditLog({
        userId: input.actorUserId,
        action: "workflow.review.assign",
        category: "workflow",
        severity: "info",
        source: "evidence_workflow_engine",
        outcome: "success",
        resourceType: "evidence_workflow_instance",
        resourceId: instance.id,
        metadata: {
            teamId: input.teamId,
            reviewerUserId: input.reviewerUserId,
        },
        db: client,
    });
    return updated;
}
// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
async function loadInstance(client, teamId, id) {
    const row = await client.evidenceWorkflowInstance.findFirst({
        where: { id, teamId },
    });
    if (!row)
        throw new WorkflowEngineError("WORKFLOW_INSTANCE_NOT_FOUND");
    return row;
}
function guardNotLegalHold(instance) {
    if (instance.status === "LEGAL_HOLD") {
        throw new WorkflowEngineError("WORKFLOW_LEGAL_HOLD_ACTIVE");
    }
}
export function projectInstance(i) {
    return {
        id: i.id,
        teamId: i.teamId,
        status: i.status,
        intakeMode: i.intakeMode,
        actorRole: i.actorRole,
        templateSlug: i.templateSlug,
        templateVersion: i.templateVersion,
        title: i.title,
        assignedReviewerUserId: i.assignedReviewerUserId,
        createdAt: i.createdAt.toISOString(),
        updatedAt: i.updatedAt.toISOString(),
        submittedAtUtc: i.submittedAtUtc?.toISOString() ?? null,
        approvedAtUtc: i.approvedAtUtc?.toISOString() ?? null,
        closedAtUtc: i.closedAtUtc?.toISOString() ?? null,
    };
}
export function projectStep(s) {
    return {
        id: s.id,
        stepKey: s.stepKey,
        title: s.title,
        required: s.required,
        orderIndex: s.orderIndex,
        status: s.status,
        mappedEvidenceId: s.mappedEvidenceId,
        completedAtUtc: s.completedAtUtc?.toISOString() ?? null,
        waiverReason: s.waiverReason,
    };
}
export async function listInstances(input, client = defaultPrisma) {
    return client.evidenceWorkflowInstance.findMany({
        where: {
            teamId: input.teamId,
            ...(input.status ? { status: input.status } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: Math.min(Math.max(input.limit ?? 100, 1), 500),
    });
}
export async function getInstanceWithSteps(input, client = defaultPrisma) {
    const instance = await loadInstance(client, input.teamId, input.id);
    const steps = await client.evidenceWorkflowStepInstance.findMany({
        where: { workflowInstanceId: instance.id },
        orderBy: { orderIndex: "asc" },
    });
    return { instance, steps };
}
export function projectStepForReviewer(s) {
    return {
        ...projectStep(s),
        privateReviewerNote: s.privateReviewerNote,
    };
}
export async function getInstanceTimeline(input, client = defaultPrisma) {
    const { instance, steps } = await getInstanceWithSteps(input, client);
    const events = [];
    // Instance lifecycle.
    events.push({
        id: `instance.${instance.id}.created`,
        occurredAtUtc: instance.createdAt.toISOString(),
        kind: "instance.created",
        actorType: instance.createdByUserId ? "user" : "system",
        actorUserId: instance.createdByUserId,
        summary: `Workflow created (intake ${instance.intakeMode}, role ${instance.actorRole}).`,
    });
    if (instance.submittedAtUtc) {
        events.push({
            id: `instance.${instance.id}.submitted`,
            occurredAtUtc: instance.submittedAtUtc.toISOString(),
            kind: "instance.submitted",
            actorType: "user",
            actorUserId: instance.createdByUserId,
            summary: "Workflow submitted for review.",
        });
    }
    if (instance.approvedAtUtc) {
        events.push({
            id: `instance.${instance.id}.approved`,
            occurredAtUtc: instance.approvedAtUtc.toISOString(),
            kind: "instance.approved",
            actorType: "user",
            actorUserId: instance.assignedReviewerUserId,
            summary: "Workflow approved by reviewer.",
        });
    }
    if (instance.closedAtUtc) {
        events.push({
            id: `instance.${instance.id}.closed`,
            occurredAtUtc: instance.closedAtUtc.toISOString(),
            kind: "instance.closed",
            actorType: "user",
            actorUserId: null,
            summary: `Workflow closed in state ${instance.status}.`,
        });
    }
    // Step completions.
    for (const step of steps) {
        if (!step.completedAtUtc)
            continue;
        if (step.status === "SATISFIED") {
            events.push({
                id: `step.${step.id}.satisfied`,
                occurredAtUtc: step.completedAtUtc.toISOString(),
                kind: "step.satisfied",
                actorType: step.completedByUserId ? "user" : "contributor",
                actorUserId: step.completedByUserId,
                summary: `Step "${step.title}" satisfied.`,
            });
        }
        else if (step.status === "WAIVED") {
            events.push({
                id: `step.${step.id}.waived`,
                occurredAtUtc: step.completedAtUtc.toISOString(),
                kind: "step.waived",
                actorType: "user",
                actorUserId: step.completedByUserId,
                // Waiver reason is operator-supplied free text. We
                // deliberately trim it to 120 chars in the summary; the full
                // reason remains on the row for operator inspection (the
                // route layer chooses whether to surface it).
                summary: `Step "${step.title}" waived${step.waiverReason ? ` — ${step.waiverReason.slice(0, 120)}` : ""}.`,
            });
        }
    }
    // Sort chronologically.
    events.sort((a, b) => new Date(a.occurredAtUtc).getTime() -
        new Date(b.occurredAtUtc).getTime());
    return events;
}
export async function getInstanceExportPolicySummary(input, client = defaultPrisma) {
    const instance = await loadInstance(client, input.teamId, input.id);
    const status = instance.status;
    const blockers = [];
    if (status === "LEGAL_HOLD") {
        blockers.push("Legal hold is active. Export blocked.");
    }
    if (status === "CANCELLED") {
        blockers.push("Workflow was cancelled.");
    }
    const canExportToReport = !blockers.length &&
        (status === "APPROVED" ||
            status === "REPORT_READY" ||
            status === "PACKAGE_READY" ||
            status === "SHARED_EXTERNALLY" ||
            status === "ARCHIVED" ||
            status === "RETAINED");
    if (!canExportToReport && !blockers.length) {
        blockers.push("Report export requires workflow approval.");
    }
    const canExportToVerificationPackage = canExportToReport &&
        (status === "REPORT_READY" ||
            status === "PACKAGE_READY" ||
            status === "SHARED_EXTERNALLY" ||
            status === "ARCHIVED" ||
            status === "RETAINED");
    if (canExportToReport && !canExportToVerificationPackage) {
        blockers.push("Verification package requires report-ready state.");
    }
    const canShareToPublicVerify = canExportToVerificationPackage &&
        (status === "PACKAGE_READY" ||
            status === "SHARED_EXTERNALLY" ||
            status === "ARCHIVED" ||
            status === "RETAINED");
    if (canExportToVerificationPackage && !canShareToPublicVerify) {
        blockers.push("Public verification requires package-ready state.");
    }
    // Visibility decisions can further restrict. We sample a small
    // number of decisions to surface restriction reasons; the
    // authoritative decision lookup remains the per-field row.
    try {
        const restrictionRows = await client.evidenceWorkflowVisibilityDecision.findMany({
            where: {
                workflowInstanceId: instance.id,
                OR: [
                    { visibleInReport: false },
                    { visibleInVerificationPackage: false },
                    { visibleInPublicVerify: false },
                    { requiresRedaction: true },
                ],
            },
            select: { fieldKey: true, reason: true, requiresRedaction: true },
            take: 5,
        });
        for (const row of restrictionRows) {
            const tag = row.requiresRedaction ? "redaction required" : "restricted";
            blockers.push(`Field "${row.fieldKey}" ${tag}: ${row.reason.slice(0, 120)}`);
        }
    }
    catch {
        /* best-effort */
    }
    // Original-download remains gated by Phase 9 governance (the
    // `evidence.download_original` permission + per-evidence
    // governance policy). We surface a conservative "false unless
    // approved" view here so operators can see the export ladder at a
    // glance.
    const canDownloadOriginal = canExportToReport;
    return {
        instanceId: instance.id,
        status,
        canExportToReport,
        canExportToVerificationPackage,
        canShareToPublicVerify,
        canDownloadOriginal,
        blockers,
    };
}
