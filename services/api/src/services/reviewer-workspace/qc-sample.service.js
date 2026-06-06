/**
 * PROOVRA Phase 2A — QC Sampling service.
 *
 *   - sampleClosedWorkflow   — opportunistic sampling at workflow close
 *   - assignSample           — assign a sample to a QC reviewer
 *   - renderVerdict          — record PASS / FAIL / PARTIAL verdict
 *   - listSamples            — workspace-anchored list with bounded filter
 *   - getQcAccuracy7d        — bounded 7-day accuracy metric
 *
 * Sampling is configured per workspace via an env-defaultable
 * percentage. The default is 5% — bounded to [1, 100].
 *
 * Hard rules:
 *   * One QcSample per workflow id.
 *   * Verdicts are bounded (PASS / FAIL / PARTIAL).
 *   * Failure reasons are bounded (QC_FAILURE_REASONS).
 *   * Audit (Phase 4 wiring): each new sample emits a best-effort
 *     `reviewer.qc.sampled` event and each rendered verdict emits a
 *     best-effort `reviewer.qc.verdict_rendered` event via the
 *     canonical `appendPlatformAuditLog` chain. Bounded metadata
 *     only — raw rationale bodies are never included.
 */
import { QC_FAILURE_REASONS, QC_VERDICTS, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
// Phase 4 — wire audit emission via the canonical platform audit log.
import { appendPlatformAuditLog } from "../platform-audit-log.service.js";
const DEFAULT_QC_SAMPLE_PERCENT = 5;
function qcSamplePercent() {
    const raw = process.env.REVIEWER_QC_SAMPLE_PERCENT;
    const n = raw ? Number.parseInt(raw, 10) : DEFAULT_QC_SAMPLE_PERCENT;
    if (!Number.isFinite(n) || n < 1 || n > 100)
        return DEFAULT_QC_SAMPLE_PERCENT;
    return n;
}
/**
 * Opportunistically sample a workflow at close. Returns the sample
 * id when one was drawn; null when the workflow was not selected.
 *
 * Idempotency contract (Phase 3 wiring): the existence check runs
 * BEFORE the sampling RNG roll. Once a workflow has been sampled
 * (whether by a previous close attempt or by a manual sample), every
 * subsequent call returns the existing sample id and skips the roll.
 *
 * `decision` is accepted as optional context for the caller's audit
 * trail; it is not persisted on QcSample (no schema change).
 */
export async function sampleClosedWorkflow(input) {
    const prisma = input.prisma ?? defaultPrisma;
    // R7-reviewer-workspace: workflowId is NOT @unique on QcSample (resample-allowed design — multiple QC
    // samples per workflow over time). Use findFirst with deterministic ordering instead of findUnique so the
    // existing-sample check remains idempotent without forcing a one-sample-per-workflow constraint.
    //
    // Phase 3 wiring: the idempotency check runs FIRST so a redundant
    // close attempt always returns the existing sample id rather than
    // re-rolling the RNG.
    const existing = await prisma.qcSample.findFirst({
        where: { workflowId: input.workflowId, teamId: input.teamId },
        orderBy: { sampledAtUtc: "desc" },
        select: { id: true },
    });
    if (existing)
        return { sampleId: existing.id };
    const percent = qcSamplePercent();
    const roll = Math.floor(Math.random() * 100); // [0, 99]
    if (roll >= percent)
        return null;
    const row = await prisma.qcSample.create({
        data: {
            teamId: input.teamId,
            workflowId: input.workflowId,
            state: "SAMPLED",
        },
        select: { id: true },
    });
    // Phase 4 — best-effort audit emission.
    await appendPlatformAuditLog({
        userId: null,
        isPublic: true,
        action: "reviewer.qc.sampled",
        category: "review",
        severity: "info",
        source: "reviewer_workspace.qc_sample",
        outcome: "success",
        resourceType: "qc_sample",
        resourceId: row.id,
        metadata: {
            teamId: input.teamId,
            workflowId: input.workflowId,
            sampleId: row.id,
            decision: input.decision ?? null,
        },
    }).catch(() => { });
    return { sampleId: row.id };
}
export async function assignSample(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const row = await prisma.qcSample.findFirst({
        where: { id: input.sampleId, teamId: input.teamId },
        select: { id: true, state: true },
    });
    if (!row)
        return deny("QC_SAMPLE_NOT_FOUND");
    if (row.state !== "SAMPLED" && row.state !== "ASSIGNED") {
        return deny("QC_VERDICT_INVALID");
    }
    await prisma.qcSample.update({
        where: { id: row.id },
        data: {
            qcReviewerUserId: input.qcReviewerUserId,
            state: "ASSIGNED",
            assignedAtUtc: new Date(),
        },
    });
    return { ok: true };
}
export async function renderQcVerdict(input) {
    const prisma = input.prisma ?? defaultPrisma;
    if (!QC_VERDICTS.includes(input.verdict)) {
        return deny("QC_VERDICT_INVALID");
    }
    if (input.verdict === "FAIL" &&
        (!input.failureReason ||
            !QC_FAILURE_REASONS.includes(input.failureReason))) {
        return deny("QC_VERDICT_INVALID");
    }
    if (input.verdict === "FAIL" && (!input.rationale || input.rationale.length === 0)) {
        return deny("RATIONALE_REQUIRED");
    }
    const row = await prisma.qcSample.findFirst({
        where: { id: input.sampleId, teamId: input.teamId },
        select: { id: true, state: true, qcReviewerUserId: true },
    });
    if (!row)
        return deny("QC_SAMPLE_NOT_FOUND");
    if (row.qcReviewerUserId !== input.actorUserId)
        return deny("NOT_PERMITTED");
    await prisma.qcSample.update({
        where: { id: row.id },
        data: {
            state: "VERDICT_RENDERED",
            verdict: input.verdict,
            failureReason: input.failureReason ?? null,
            rationale: input.rationale?.slice(0, 600) ?? null,
            renderedAtUtc: new Date(),
        },
    });
    // Phase 4 — best-effort audit emission. Bounded metadata only.
    await appendPlatformAuditLog({
        userId: input.actorUserId,
        action: "reviewer.qc.verdict_rendered",
        category: "review",
        severity: input.verdict === "FAIL" ? "warning" : "info",
        source: "reviewer_workspace.qc_sample",
        outcome: "success",
        resourceType: "qc_sample",
        resourceId: row.id,
        metadata: {
            teamId: input.teamId,
            sampleId: row.id,
            verdict: input.verdict,
            failureReason: input.failureReason ?? null,
            qcReviewerUserId: input.actorUserId,
        },
    }).catch(() => { });
    return { ok: true };
}
export async function listSamples(input) {
    const prisma = input.prisma ?? defaultPrisma;
    return prisma.qcSample.findMany({
        where: {
            teamId: input.teamId,
            ...(input.qcReviewerUserId
                ? { qcReviewerUserId: input.qcReviewerUserId }
                : {}),
            ...(input.state ? { state: input.state } : {}),
        },
        orderBy: { sampledAtUtc: "desc" },
        take: Math.min(input.limit ?? 50, 200),
    });
}
/**
 * Phase RW3-3 — Team-scoped count of QC samples awaiting a verdict.
 *
 * "Pending" means state IN ('SAMPLED', 'ASSIGNED'). VERDICT_RENDERED
 * rows are terminal and excluded. Bounded projection: { pendingCount }.
 */
export async function countPendingQcSamples(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const pendingCount = await prisma.qcSample.count({
        where: {
            teamId: input.teamId,
            state: { in: ["SAMPLED", "ASSIGNED"] },
        },
    });
    return { pendingCount };
}
export async function getQcAccuracy7d(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const rows = await prisma.qcSample.findMany({
        where: {
            teamId: input.teamId,
            state: "VERDICT_RENDERED",
            renderedAtUtc: { gte: since },
        },
        select: { verdict: true },
        take: 5_000,
    });
    if (rows.length === 0) {
        return { rendered: 0, passRatePct: 0, failureRatePct: 0 };
    }
    const pass = rows.filter((r) => r.verdict === "PASS").length;
    const fail = rows.filter((r) => r.verdict === "FAIL").length;
    return {
        rendered: rows.length,
        passRatePct: Math.round((pass * 100) / rows.length),
        failureRatePct: Math.round((fail * 100) / rows.length),
    };
}
function deny(reason) {
    return { ok: false, denial: reason };
}
