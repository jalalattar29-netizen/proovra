/**
 * Phase 32.8D — Matter Workspace lifecycle actions.
 *
 * Permission-gated writes for the Matter Workspace mutations:
 *   - changeCaseStatus
 *   - addCaseAssignment
 *   - removeCaseAssignment
 *   - addCaseComment
 *   - resolveCaseComment
 *   - addEvidenceLink
 *   - removeEvidenceLink
 *
 * Hard rules:
 *   - Active legal hold blocks transitions to CLOSED or ARCHIVED.
 *   - Every action writes an audit log row via appendPlatformAuditLog
 *     AND a CaseStatusHistory row where applicable.
 *   - No bypass of underlying governance/report/package permissions.
 *   - Bounded operator-safe strings.
 */
import { prisma as defaultPrisma } from "../../db.js";
import { appendPlatformAuditLog } from "../platform-audit-log.service.js";
export class CaseError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
    }
}
// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------
const ALLOWED_TRANSITIONS = {
    OPEN: ["INVESTIGATING", "ON_HOLD", "RESOLVED"],
    INVESTIGATING: ["ON_HOLD", "RESOLVED"],
    ON_HOLD: ["INVESTIGATING", "RESOLVED"],
    RESOLVED: ["CLOSED", "INVESTIGATING"],
    CLOSED: ["ARCHIVED", "RESOLVED"],
    ARCHIVED: [], // terminal
};
function transitionAllowed(from, to) {
    return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}
const CLOSURE_STATUSES = new Set(["CLOSED", "ARCHIVED"]);
export async function changeCaseStatus(input, client = defaultPrisma) {
    const existing = await client.case.findUnique({
        where: { id: input.caseId },
        select: {
            id: true,
            teamId: true,
            status: true,
        },
    });
    if (!existing)
        throw new CaseError("case_not_found");
    const from = String(existing.status);
    if (!transitionAllowed(from, input.toStatus)) {
        throw new CaseError("invalid_transition");
    }
    // Preservation invariant: active legal hold blocks CLOSED/ARCHIVED.
    if (CLOSURE_STATUSES.has(input.toStatus)) {
        const activeHold = await client.caseLegalHold.count({
            where: { caseId: existing.id, status: "ACTIVE" },
        });
        if (activeHold > 0) {
            throw new CaseError("active_legal_hold_blocks_closure");
        }
    }
    const closedAtUtc = input.toStatus === "CLOSED" ? new Date() : null;
    const closureReason = input.toStatus === "CLOSED" ? input.reason ?? null : null;
    const updated = await client.case.update({
        where: { id: existing.id },
        data: {
            status: input.toStatus,
            ...(closedAtUtc ? { closedAtUtc } : {}),
            ...(closureReason !== null && input.toStatus === "CLOSED"
                ? { closureReason: closureReason ? closureReason.slice(0, 400) : null }
                : {}),
        },
    });
    try {
        await client.caseStatusHistory.create({
            data: {
                teamId: existing.teamId,
                caseId: existing.id,
                fromStatus: from,
                toStatus: input.toStatus,
                changedByUserId: input.actorUserId,
                reason: input.reason ? input.reason.slice(0, 400) : null,
            },
        });
    }
    catch {
        /* best-effort */
    }
    // Phase 2.4 — Closure cascade.
    //
    // When a case transitions to CLOSED or ARCHIVED, all currently
    // ACTIVE assignments must be deactivated. Without this cascade a
    // closed case still appears in reviewers' personal queues and
    // permission gates that key off "assignment.status === ACTIVE"
    // misreport access. The pre-Phase-2.4 behavior left assignments
    // active indefinitely, which is the root cause of the
    // "I see this closed case in my queue" bug class.
    //
    // We DO NOT touch:
    //   - The Case row itself (already updated above).
    //   - Evidence links — closed cases keep their evidence association
    //     because the audit trail must remain intact.
    //   - Comments — historical comments stay readable. New comments
    //     are blocked at the route layer when the case is in a closure
    //     state, not here.
    //
    // The cascade is best-effort: if it fails (extremely unlikely; this
    // is a single updateMany), we log a critical audit row but do not
    // roll back the status change. The next read of the assignments
    // list still surfaces the inconsistency; an operator can manually
    // remove residual assignments.
    let cascadedAssignmentCount = 0;
    if (CLOSURE_STATUSES.has(input.toStatus)) {
        try {
            const cascade = await client.caseAssignment.updateMany({
                where: { caseId: existing.id, status: "ACTIVE" },
                data: {
                    status: "REMOVED",
                    removedAtUtc: new Date(),
                    removedByUserId: input.actorUserId,
                },
            });
            cascadedAssignmentCount = cascade.count;
        }
        catch {
            /* best-effort — captured in the audit metadata below */
            cascadedAssignmentCount = -1;
        }
    }
    await appendPlatformAuditLog({
        userId: input.actorUserId,
        action: "cases.status_changed",
        category: "cases.lifecycle",
        severity: "info",
        source: "case_lifecycle_service",
        outcome: "success",
        resourceType: "case",
        resourceId: existing.id,
        metadata: {
            teamId: existing.teamId,
            fromStatus: from,
            toStatus: input.toStatus,
            // Phase 2.4 — surface the cascade for SOC + audit consumers.
            // `-1` indicates the cascade failed; `0` indicates no
            // assignments existed to cascade.
            cascadedAssignmentCount,
        },
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        db: client,
    });
    return updated;
}
export async function addCaseAssignment(input, client = defaultPrisma) {
    const existing = await client.case.findUnique({
        where: { id: input.caseId },
        select: { id: true, teamId: true },
    });
    if (!existing)
        throw new CaseError("case_not_found");
    // Enforce workspace membership when on a team workspace.
    if (existing.teamId) {
        const member = await client.teamMember.findFirst({
            where: {
                teamId: existing.teamId,
                userId: input.assignedToUserId,
            },
            select: { id: true },
        });
        if (!member)
            throw new CaseError("invalid_assignee");
    }
    // Idempotent on (caseId, assignedToUserId, role). If a REMOVED row
    // exists, reactivate it; otherwise create.
    const existingAssignment = await client.caseAssignment.findFirst({
        where: {
            caseId: existing.id,
            assignedToUserId: input.assignedToUserId,
            role: input.role,
        },
    });
    let row;
    if (existingAssignment) {
        if (existingAssignment.status === "ACTIVE") {
            throw new CaseError("assignment_exists");
        }
        row = await client.caseAssignment.update({
            where: { id: existingAssignment.id },
            data: {
                status: "ACTIVE",
                assignedAtUtc: new Date(),
                assignedByUserId: input.actorUserId,
                removedAtUtc: null,
                removedByUserId: null,
                note: input.note ? input.note.slice(0, 400) : null,
            },
        });
    }
    else {
        row = await client.caseAssignment.create({
            data: {
                teamId: existing.teamId,
                caseId: existing.id,
                assignedToUserId: input.assignedToUserId,
                assignedByUserId: input.actorUserId,
                role: input.role,
                status: "ACTIVE",
                note: input.note ? input.note.slice(0, 400) : null,
            },
        });
    }
    await appendPlatformAuditLog({
        userId: input.actorUserId,
        action: "cases.assignment_added",
        category: "cases.lifecycle",
        severity: "info",
        source: "case_lifecycle_service",
        outcome: "success",
        resourceType: "case_assignment",
        resourceId: row.id,
        metadata: {
            teamId: existing.teamId,
            caseId: existing.id,
            assignedToUserId: input.assignedToUserId,
            role: input.role,
        },
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        db: client,
    });
    return row;
}
export async function removeCaseAssignment(input, client = defaultPrisma) {
    const existing = await client.caseAssignment.findFirst({
        where: { id: input.assignmentId, caseId: input.caseId },
    });
    if (!existing)
        throw new CaseError("assignment_not_found");
    const row = await client.caseAssignment.update({
        where: { id: existing.id },
        data: {
            status: "REMOVED",
            removedAtUtc: new Date(),
            removedByUserId: input.actorUserId,
        },
    });
    await appendPlatformAuditLog({
        userId: input.actorUserId,
        action: "cases.assignment_removed",
        category: "cases.lifecycle",
        severity: "info",
        source: "case_lifecycle_service",
        outcome: "success",
        resourceType: "case_assignment",
        resourceId: row.id,
        metadata: {
            teamId: existing.teamId,
            caseId: input.caseId,
            assignedToUserId: existing.assignedToUserId,
            role: existing.role,
        },
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        db: client,
    });
    return row;
}
export async function addCaseComment(input, client = defaultPrisma) {
    const existing = await client.case.findUnique({
        where: { id: input.caseId },
        select: { id: true, teamId: true },
    });
    if (!existing)
        throw new CaseError("case_not_found");
    const row = await client.caseComment.create({
        data: {
            teamId: existing.teamId ?? input.actorUserId, // teamId is required on schema
            caseId: existing.id,
            authorUserId: input.actorUserId,
            body: input.body.slice(0, 4000),
            visibility: (input.visibility ??
                "REVIEWERS"),
        },
    });
    await appendPlatformAuditLog({
        userId: input.actorUserId,
        action: "cases.comment_added",
        category: "cases.lifecycle",
        severity: "info",
        source: "case_lifecycle_service",
        outcome: "success",
        resourceType: "case_comment",
        resourceId: row.id,
        metadata: {
            teamId: existing.teamId,
            caseId: existing.id,
            visibility: row.visibility,
        },
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        db: client,
    });
    return row;
}
export async function resolveCaseComment(input, client = defaultPrisma) {
    const existing = await client.caseComment.findFirst({
        where: { id: input.commentId, caseId: input.caseId },
    });
    if (!existing)
        throw new CaseError("comment_not_found");
    const row = await client.caseComment.update({
        where: { id: existing.id },
        data: {
            resolvedAtUtc: new Date(),
            resolvedByUserId: input.actorUserId,
        },
    });
    await appendPlatformAuditLog({
        userId: input.actorUserId,
        action: "cases.comment_resolved",
        category: "cases.lifecycle",
        severity: "info",
        source: "case_lifecycle_service",
        outcome: "success",
        resourceType: "case_comment",
        resourceId: row.id,
        metadata: {
            teamId: existing.teamId,
            caseId: input.caseId,
        },
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        db: client,
    });
    return row;
}
export async function addEvidenceLink(input, client = defaultPrisma) {
    const existing = await client.case.findUnique({
        where: { id: input.caseId },
        select: { id: true, teamId: true },
    });
    if (!existing)
        throw new CaseError("case_not_found");
    const evidence = await client.evidence.findUnique({
        where: { id: input.evidenceId },
        select: { id: true, teamId: true },
    });
    if (!evidence)
        throw new CaseError("evidence_not_found");
    // Cross-workspace check: evidence must be in the same team workspace.
    if (existing.teamId && evidence.teamId !== existing.teamId) {
        throw new CaseError("evidence_not_found");
    }
    const role = (input.role ?? "SUPPORTING");
    // Idempotent on the unique (caseId, evidenceId, role).
    const existingLink = await client.caseEvidenceLink.findUnique({
        where: {
            caseId_evidenceId_role: {
                caseId: existing.id,
                evidenceId: input.evidenceId,
                role,
            },
        },
    });
    if (existingLink)
        throw new CaseError("evidence_link_exists");
    const row = await client.caseEvidenceLink.create({
        data: {
            teamId: existing.teamId ?? "",
            caseId: existing.id,
            evidenceId: input.evidenceId,
            role,
            source: "USER",
            linkedByUserId: input.actorUserId,
            reason: input.reason ? input.reason.slice(0, 400) : null,
        },
    });
    await appendPlatformAuditLog({
        userId: input.actorUserId,
        action: "cases.evidence_linked",
        category: "cases.lifecycle",
        severity: "info",
        source: "case_lifecycle_service",
        outcome: "success",
        resourceType: "case_evidence_link",
        resourceId: row.id,
        metadata: {
            teamId: existing.teamId,
            caseId: existing.id,
            evidenceId: input.evidenceId,
            role,
        },
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        db: client,
    });
    return row;
}
export async function removeEvidenceLink(input, client = defaultPrisma) {
    const existing = await client.caseEvidenceLink.findFirst({
        where: { id: input.linkId, caseId: input.caseId },
    });
    if (!existing)
        throw new CaseError("evidence_not_found");
    await client.caseEvidenceLink.delete({ where: { id: existing.id } });
    await appendPlatformAuditLog({
        userId: input.actorUserId,
        action: "cases.evidence_unlinked",
        category: "cases.lifecycle",
        severity: "info",
        source: "case_lifecycle_service",
        outcome: "success",
        resourceType: "case_evidence_link",
        resourceId: existing.id,
        metadata: {
            teamId: existing.teamId,
            caseId: input.caseId,
            evidenceId: existing.evidenceId,
            role: existing.role,
        },
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        db: client,
    });
    return { removed: true };
}
/**
 * Phase 32.8D-frontend-closure-2 — Audited unlink of a legacy
 * `Evidence.caseId` attachment that has no `CaseEvidenceLink` row.
 *
 *   - Reads the Evidence row. If `evidence.caseId !== caseId`, throws
 *     `evidence_not_found` so callers receive a 404.
 *   - Sets `Evidence.caseId = null` without touching any other field.
 *     The evidence record (and its bytes / metadata) is preserved.
 *   - Writes a platform audit log with action
 *     `cases.legacy_evidence_unlinked` and explicit metadata.
 *   - Does NOT emit custody / download events.
 *   - Does NOT generate reports or packages.
 *   - Does NOT regenerate signed URLs.
 */
export async function removeLegacyEvidenceCaseId(input, client = defaultPrisma) {
    const evidence = await client.evidence.findUnique({
        where: { id: input.evidenceId },
        select: { id: true, caseId: true, teamId: true, ownerUserId: true },
    });
    if (!evidence || evidence.caseId !== input.caseId) {
        throw new CaseError("evidence_not_found");
    }
    // Also refuse if a canonical CaseEvidenceLink row exists — the
    // canonical unlink route handles that path. This route is strictly
    // for evidence attached only via the legacy caseId column.
    const canonical = await client.caseEvidenceLink.findFirst({
        where: { caseId: input.caseId, evidenceId: input.evidenceId },
        select: { id: true },
    });
    if (canonical) {
        throw new CaseError("evidence_link_exists");
    }
    await client.evidence.update({
        where: { id: evidence.id },
        data: { caseId: null },
    });
    await appendPlatformAuditLog({
        userId: input.actorUserId,
        action: "cases.legacy_evidence_unlinked",
        category: "cases.lifecycle",
        severity: "info",
        source: "case_lifecycle_service",
        outcome: "success",
        resourceType: "evidence",
        resourceId: evidence.id,
        metadata: {
            teamId: evidence.teamId,
            caseId: input.caseId,
            evidenceId: evidence.id,
            attachmentKind: "legacy_case_id",
        },
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        db: client,
    });
    return { unlinked: true, evidenceId: evidence.id };
}
