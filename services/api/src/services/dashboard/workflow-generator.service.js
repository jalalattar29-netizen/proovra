/**
 * Phase 32.8C FINAL-2 — Workflow Orchestration: Workflow Generator.
 *
 * Deterministically creates `OperationalWorkflow` rows from real open
 * incidents + correlations. Idempotent on `(teamId, workflowKey)` — a
 * repeat detection ticks the existing row instead of creating a new one.
 *
 * Hard rules:
 *   - Generator failures NEVER block evidence / report / package /
 *     verify flows. The dashboard wraps invocations in try/catch.
 *   - No fake workflows. Every workflow row sources from a real
 *     OperationalIncident or OperationalCorrelation.
 *   - Reopen semantics: a RESOLVED workflow whose source condition
 *     recurs is reopened (status OPEN) with `escalationLevel + 1`.
 *   - Bounded operator-safe summaries — no raw payloads.
 */
import { prisma } from "../../db.js";
// Maps incident category → workflow type. The dashboard incident
// generator already deterministically maps real conditions to specific
// IncidentCategory values, so this mapping closes the loop:
//   pipeline incident   → REPORT_RETRY / PACKAGE_RETRY
//   reviewer incident   → REVIEW_ESCALATION
//   governance incident → GOVERNANCE_ESCALATION
//   worker incident     → QUEUE_RECOVERY / TELEMETRY_RECOVERY
function workflowTypeForIncident(input) {
    const c = input.category;
    const fp = input.fingerprint;
    if (c === "REPORT")
        return "REPORT_RETRY";
    if (c === "PACKAGE")
        return "PACKAGE_RETRY";
    if (c === "GOVERNANCE") {
        if (fp.includes("coordination"))
            return "COORDINATION_RESOLUTION";
        if (fp.includes("unsigned_aged"))
            return "AUDIT_READINESS";
        if (fp.includes("export"))
            return "EXPORT_BLOCKER_RESOLUTION";
        return "GOVERNANCE_ESCALATION";
    }
    if (c === "WORKER") {
        if (fp.includes("review:"))
            return "REVIEW_ESCALATION";
        if (fp.includes("telemetry:"))
            return "TELEMETRY_RECOVERY";
        if (fp.includes("worker:") || fp.includes("heartbeat"))
            return "TELEMETRY_RECOVERY";
        if (fp.includes("retry_storm"))
            return "QUEUE_RECOVERY";
        return "QUEUE_RECOVERY";
    }
    return "OTHER";
}
function severityFromIncident(severity) {
    if (severity === "CRITICAL")
        return "CRITICAL";
    if (severity === "HIGH")
        return "HIGH";
    if (severity === "WARNING")
        return "MEDIUM";
    return "LOW";
}
function priorityFromSeverity(severity) {
    if (severity === "CRITICAL")
        return "P0";
    if (severity === "HIGH")
        return "P1";
    if (severity === "MEDIUM")
        return "P2";
    return "P3";
}
/**
 * Map a workflow type to its bounded recommended action catalog. The
 * dashboard renders these as the operator's next-step buttons. Every
 * action is gated by `permissionRequired` + `requiredRoles`; the route
 * points at the existing ops surface, not at a fabricated one.
 */
function actionCatalogForType(type) {
    const baseAssignSet = [
        {
            actionType: "ASSIGN",
            permissionRequired: "ops.workflow.assign",
            requiredRoles: ["OWNER", "ADMIN"],
            safeActionLabel: "Assign owner",
            route: "/ops/observability",
        },
        {
            actionType: "RESOLVE",
            permissionRequired: "ops.workflow.resolve",
            requiredRoles: ["OWNER", "ADMIN"],
            safeActionLabel: "Mark resolved",
            route: null,
        },
        {
            actionType: "SUPPRESS",
            permissionRequired: "ops.workflow.suppress",
            requiredRoles: ["OWNER", "ADMIN"],
            safeActionLabel: "Suppress",
            route: null,
        },
    ];
    switch (type) {
        case "REPORT_RETRY":
        case "PACKAGE_RETRY":
            // Phase 32.8C — we do NOT add a "Retry now" action because the
            // dashboard does not have a safe retry endpoint for report/package
            // jobs. The action surfaces as "Schedule retry review" instead.
            return [
                ...baseAssignSet,
                {
                    actionType: "SCHEDULE_RETRY",
                    permissionRequired: "ops.workflow.schedule_retry",
                    requiredRoles: ["OWNER", "ADMIN"],
                    safeActionLabel: "Schedule retry review",
                    route: "/ops/observability",
                },
            ];
        case "REVIEW_ESCALATION":
            return [
                ...baseAssignSet,
                {
                    actionType: "ESCALATE",
                    permissionRequired: "ops.workflow.escalate",
                    requiredRoles: ["OWNER", "ADMIN"],
                    safeActionLabel: "Escalate",
                    route: "/reviewer-ops/escalations",
                },
            ];
        case "GOVERNANCE_ESCALATION":
        case "EXPORT_BLOCKER_RESOLUTION":
        case "AUDIT_READINESS":
            return [
                ...baseAssignSet,
                {
                    actionType: "ESCALATE",
                    permissionRequired: "ops.workflow.escalate",
                    requiredRoles: ["OWNER", "ADMIN"],
                    safeActionLabel: "Escalate to governance",
                    route: "/governance",
                },
            ];
        default:
            return baseAssignSet;
    }
}
/**
 * Generate workflows for one workspace. Reads OPEN/ACKNOWLEDGED
 * incidents + recent correlations, deterministically maps each to a
 * workflow type, upserts. Never throws.
 */
export async function generateWorkflowsForWorkspace(input) {
    let persisted = 0;
    let failed = 0;
    const types = [];
    // Read OPEN/ACKNOWLEDGED incidents in workspace scope.
    let incidents = [];
    try {
        incidents = await prisma.operationalIncident.findMany({
            where: {
                OR: [{ teamId: input.teamId }, { teamId: null }],
                status: { in: ["OPEN", "ACKNOWLEDGED"] },
            },
            orderBy: { lastSeenAtUtc: "desc" },
            take: 200,
            select: {
                id: true,
                category: true,
                severity: true,
                status: true,
                fingerprint: true,
                title: true,
                safeSummary: true,
                relatedEvidenceId: true,
            },
        });
    }
    catch {
        return { persisted: 0, failed: 0, types: [] };
    }
    for (const inc of incidents) {
        const wfType = workflowTypeForIncident({
            category: inc.category,
            fingerprint: inc.fingerprint,
            title: inc.title,
        });
        const wfSeverity = severityFromIncident(inc.severity);
        const wfPriority = priorityFromSeverity(wfSeverity);
        const workflowKey = `incident:${inc.id}:${wfType}`;
        try {
            const existing = await prisma.operationalWorkflow.findUnique({
                where: {
                    teamId_workflowKey: {
                        teamId: input.teamId,
                        workflowKey,
                    },
                },
                select: { id: true, status: true, escalationLevel: true },
            });
            let workflowId;
            let eventType;
            let fromStatus = null;
            let toStatus;
            if (!existing) {
                // Create new workflow.
                const created = await prisma.operationalWorkflow.create({
                    data: {
                        teamId: input.teamId,
                        workflowKey,
                        workflowType: wfType,
                        status: "OPEN",
                        severity: wfSeverity,
                        priority: wfPriority,
                        title: inc.title.slice(0, 180),
                        safeSummary: inc.safeSummary.slice(0, 400),
                        sourceIncidentId: inc.id,
                        evidenceId: inc.relatedEvidenceId,
                    },
                });
                workflowId = created.id;
                eventType = "CREATED";
                toStatus = "OPEN";
                // Persist the action catalog.
                const actions = actionCatalogForType(wfType);
                for (const a of actions) {
                    try {
                        await prisma.operationalWorkflowAction.create({
                            data: {
                                workflowId: created.id,
                                teamId: input.teamId,
                                actionType: a.actionType,
                                permissionRequired: a.permissionRequired,
                                requiredRoles: a.requiredRoles,
                                safeActionLabel: a.safeActionLabel,
                                route: a.route,
                            },
                        });
                    }
                    catch {
                        /* per-action best-effort */
                    }
                }
            }
            else if (existing.status === "RESOLVED" ||
                existing.status === "SUPPRESSED") {
                // Reopen: bump escalationLevel + 1.
                const reopened = await prisma.operationalWorkflow.update({
                    where: { id: existing.id },
                    data: {
                        status: "OPEN",
                        severity: wfSeverity,
                        priority: wfPriority,
                        escalationLevel: existing.escalationLevel + 1,
                        resolvedAtUtc: null,
                        resolutionSummary: null,
                    },
                });
                workflowId = reopened.id;
                eventType = "REOPENED";
                fromStatus = existing.status;
                toStatus = "OPEN";
            }
            else {
                // Existing open workflow — escalate severity if higher.
                const updated = await prisma.operationalWorkflow.update({
                    where: { id: existing.id },
                    data: {
                        severity: wfSeverity,
                        priority: wfPriority,
                    },
                });
                workflowId = updated.id;
                eventType = "STATUS_CHANGED";
                fromStatus = existing.status;
                toStatus = existing.status;
            }
            try {
                await prisma.operationalWorkflowEvent.create({
                    data: {
                        workflowId,
                        teamId: input.teamId,
                        eventType: eventType,
                        fromStatus: fromStatus,
                        toStatus: toStatus,
                        summary: eventType === "CREATED"
                            ? `Workflow created from incident ${inc.id.slice(0, 8)} (${wfType}).`
                            : eventType === "REOPENED"
                                ? `Workflow reopened — source condition recurred.`
                                : `Workflow updated from incident ${inc.id.slice(0, 8)}.`,
                    },
                });
            }
            catch {
                /* best-effort */
            }
            persisted += 1;
            types.push(wfType);
        }
        catch {
            failed += 1;
        }
    }
    // Cross-system correlation → workflow linkage. If a correlation is
    // active, ensure each linked-incident workflow points at the
    // correlation via `sourceCorrelationId`. Idempotent.
    try {
        const correlations = await prisma.operationalCorrelation.findMany({
            where: {
                teamId: input.teamId,
                expiresAtUtc: { gt: new Date() },
            },
            take: 50,
            select: { id: true, linkedIncidentIds: true },
        });
        for (const c of correlations) {
            const ids = Array.isArray(c.linkedIncidentIds)
                ? c.linkedIncidentIds
                : [];
            if (ids.length === 0)
                continue;
            try {
                await prisma.operationalWorkflow.updateMany({
                    where: {
                        teamId: input.teamId,
                        sourceIncidentId: { in: ids },
                        sourceCorrelationId: null,
                    },
                    data: { sourceCorrelationId: c.id },
                });
            }
            catch {
                /* best-effort */
            }
        }
    }
    catch {
        /* outer best-effort */
    }
    return { persisted, failed, types };
}
/**
 * Dashboard reader: open/assigned/in-progress workflows for the
 * workspace, severity-sorted then due-pressure-sorted.
 */
export async function listWorkspaceWorkflows(input) {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    try {
        const rows = await prisma.operationalWorkflow.findMany({
            where: {
                teamId: input.teamId,
                status: {
                    in: [
                        "OPEN",
                        "ASSIGNED",
                        "IN_PROGRESS",
                        "WAITING_ON_SYSTEM",
                        "WAITING_ON_REVIEWER",
                        "WAITING_ON_GOVERNANCE",
                        "MITIGATING",
                        "FAILED",
                    ],
                },
            },
            orderBy: [{ severity: "desc" }, { priority: "asc" }, { updatedAt: "desc" }],
            take: limit,
            include: {
                actions: {
                    orderBy: { createdAt: "asc" },
                    select: {
                        actionType: true,
                        permissionRequired: true,
                        requiredRoles: true,
                        safeActionLabel: true,
                        route: true,
                    },
                },
            },
        });
        return rows.map((r) => ({
            id: r.id,
            workflowType: r.workflowType,
            status: r.status,
            severity: r.severity,
            priority: r.priority,
            title: r.title,
            safeSummary: r.safeSummary,
            sourceIncidentId: r.sourceIncidentId,
            sourceCorrelationId: r.sourceCorrelationId,
            caseId: r.caseId,
            evidenceId: r.evidenceId,
            queueName: r.queueName,
            assignedOwnerUserId: r.assignedOwnerUserId,
            assignedAtUtc: r.assignedAtUtc?.toISOString() ?? null,
            escalationLevel: r.escalationLevel,
            retryCount: r.retryCount,
            dueAtUtc: r.dueAtUtc?.toISOString() ?? null,
            mitigationSummary: r.mitigationSummary,
            resolutionSummary: r.resolutionSummary,
            lastFailureCode: r.lastFailureCode,
            nextRetryAtUtc: r.nextRetryAtUtc?.toISOString() ?? null,
            createdAt: r.createdAt.toISOString(),
            updatedAt: r.updatedAt.toISOString(),
            actions: r.actions.map((a) => ({
                actionType: a.actionType,
                permissionRequired: a.permissionRequired,
                requiredRoles: Array.isArray(a.requiredRoles)
                    ? a.requiredRoles
                    : [],
                safeActionLabel: a.safeActionLabel,
                route: a.route,
            })),
        }));
    }
    catch {
        return [];
    }
}
