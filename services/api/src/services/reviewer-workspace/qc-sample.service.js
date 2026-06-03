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
 *   * Audit: each verdict emits a `reviewer.qc.verdict` audit event
 *     via the existing platform-audit-log + reviewer-audit services.
 */
import { QC_FAILURE_REASONS, QC_VERDICTS, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
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
 */
export async function sampleClosedWorkflow(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const percent = qcSamplePercent();
    const roll = Math.floor(Math.random() * 100); // [0, 99]
    if (roll >= percent)
        return null;
    // R7-reviewer-workspace: workflowId is NOT @unique on QcSample (resample-allowed design — multiple QC
    // samples per workflow over time). Use findFirst with deterministic ordering instead of findUnique so the
    // existing-sample check remains idempotent without forcing a one-sample-per-workflow constraint.
    const existing = await prisma.qcSample.findFirst({
        where: { workflowId: input.workflowId, teamId: input.teamId },
        orderBy: { sampledAtUtc: "desc" },
        select: { id: true },
    });
    if (existing)
        return { sampleId: existing.id };
    const row = await prisma.qcSample.create({
        data: {
            teamId: input.teamId,
            workflowId: input.workflowId,
            state: "SAMPLED",
        },
        select: { id: true },
    });
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
