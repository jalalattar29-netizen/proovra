/**
 * PROOVRA Phase 3A — Redaction approval service.
 *
 * Bounded approver verdicts on a version that is IN_REVIEW. The
 * verdict choice ties to a downstream state transition:
 *
 *   APPROVE           → version IN_REVIEW → APPROVED
 *   REJECT            → version IN_REVIEW → REJECTED
 *   REQUEST_CHANGES   → version IN_REVIEW → DRAFT (approver sent back)
 *   DEFER             → no state change; recorded for audit
 *
 * Hard rules:
 *   * REJECT and REQUEST_CHANGES require a non-empty rationale.
 *   * Approver MUST be a distinct user from the version author —
 *     enforced server-side here, never UI-only.
 */
import { REDACTION_APPROVAL_VERDICTS, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
import { emitRedactionActivity } from "./redaction-activity.service.js";
import { transitionRedactionVersion } from "./redaction-project.service.js";
export async function recordRedactionApproval(input) {
    if (!REDACTION_APPROVAL_VERDICTS.includes(input.verdict)) {
        return { ok: false, denial: "POLICY_REJECTED" };
    }
    if ((input.verdict === "REJECT" || input.verdict === "REQUEST_CHANGES") &&
        (!input.rationale || input.rationale.trim().length < 6)) {
        return { ok: false, denial: "RATIONALE_REQUIRED" };
    }
    const prisma = input.prisma ?? defaultPrisma;
    const version = await prisma.redactionVersion.findFirst({
        where: { id: input.versionId, teamId: input.teamId },
        select: {
            id: true,
            state: true,
            projectId: true,
            authoredByUserId: true,
        },
    });
    if (!version)
        return { ok: false, denial: "VERSION_NOT_FOUND" };
    if (version.state !== "IN_REVIEW") {
        return { ok: false, denial: "INVALID_TRANSITION" };
    }
    if (version.authoredByUserId === input.approverUserId) {
        // Server-side separation of duties — approver must differ from author.
        return { ok: false, denial: "NOT_PERMITTED" };
    }
    const created = await prisma.redactionApproval.create({
        data: {
            teamId: input.teamId,
            versionId: input.versionId,
            verdict: input.verdict,
            rationale: input.rationale?.slice(0, 600) ?? null,
            approverUserId: input.approverUserId,
        },
        select: { id: true },
    });
    const code = input.verdict === "APPROVE"
        ? "APPROVAL_GRANTED"
        : input.verdict === "REJECT"
            ? "APPROVAL_DENIED"
            : input.verdict === "REQUEST_CHANGES"
                ? "APPROVAL_CHANGES_REQUESTED"
                : "APPROVAL_REQUESTED";
    await emitRedactionActivity({
        prisma,
        teamId: input.teamId,
        projectId: version.projectId,
        versionId: input.versionId,
        code,
        actorUserId: input.approverUserId,
        payload: {
            approvalId: created.id,
            verdict: input.verdict,
            rationalePreview: input.rationale?.slice(0, 80) ?? null,
        },
    });
    // Drive the bounded state machine.
    if (input.verdict === "APPROVE") {
        await transitionRedactionVersion({
            prisma,
            teamId: input.teamId,
            versionId: input.versionId,
            toState: "APPROVED",
            actorUserId: input.approverUserId,
            rationale: input.rationale ?? null,
        });
    }
    else if (input.verdict === "REJECT") {
        await transitionRedactionVersion({
            prisma,
            teamId: input.teamId,
            versionId: input.versionId,
            toState: "REJECTED",
            actorUserId: input.approverUserId,
            rationale: input.rationale ?? null,
        });
    }
    else if (input.verdict === "REQUEST_CHANGES") {
        await transitionRedactionVersion({
            prisma,
            teamId: input.teamId,
            versionId: input.versionId,
            toState: "DRAFT",
            actorUserId: input.approverUserId,
            rationale: input.rationale ?? null,
        });
    }
    return { ok: true, approvalId: created.id };
}
export async function listApprovalsForVersion(input) {
    const prisma = input.prisma ?? defaultPrisma;
    return prisma.redactionApproval.findMany({
        where: { teamId: input.teamId, versionId: input.versionId },
        orderBy: { decidedAtUtc: "asc" },
    });
}
