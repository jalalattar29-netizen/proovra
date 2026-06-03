/**
 * Phase E4 — Bounded operational analytics service.
 *
 * Real data only. Every metric is source-traceable. Bounded queries.
 * Team-scoped. No fake counters. No AI / no predictions / no truth
 * scores / no legal-admissibility conclusions.
 *
 * Hard rules (pinned by `phase-e4-analytics.test.ts`):
 *
 *   - Every public function returns an `AnalyticsEnvelope` with:
 *       { generatedAt, window, sourceTrace, degradedSources, metrics }
 *   - `sourceTrace` lists every Prisma model + filter shape the
 *     metrics came from. Tests verify it is non-empty.
 *   - `window.days` is bounded by `ANALYTICS_MAX_WINDOW_DAYS = 180`
 *     and defaults to `ANALYTICS_DEFAULT_WINDOW_DAYS = 30`.
 *   - Queries are all `count` / `groupBy` / `findMany(take: limit)`.
 *     No unbounded scans. No `findMany` without `where + teamId`.
 *   - On any source failure, the metric value is `null` and the
 *     source name is pushed to `degradedSources`. The whole envelope
 *     still returns 200 with the partial result.
 *   - Personal workspace gets simplified metrics (a small subset);
 *     team / organization workspace gets the operational depth.
 *
 * Public functions:
 *   - getOperationsOverview(input)
 *   - getReviewerAnalytics(input)
 *   - getGovernanceAnalytics(input)
 *   - getAutomationAnalytics(input)
 *   - getArtifactReadinessAnalytics(input)
 */
import { prisma as defaultPrisma } from "../../db.js";
// ---------------------------------------------------------------------------
// Bounded window
// ---------------------------------------------------------------------------
export const ANALYTICS_DEFAULT_WINDOW_DAYS = 30;
export const ANALYTICS_MAX_WINDOW_DAYS = 180;
export const ANALYTICS_MIN_WINDOW_DAYS = 1;
function resolveWindow(input) {
    const nowMs = input.nowMs ?? Date.now();
    const days = clampWindow(input.windowDays);
    return {
        days,
        start: new Date(nowMs - days * 24 * 60 * 60 * 1000).toISOString(),
        end: new Date(nowMs).toISOString(),
    };
}
export function clampWindow(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return ANALYTICS_DEFAULT_WINDOW_DAYS;
    }
    return Math.max(ANALYTICS_MIN_WINDOW_DAYS, Math.min(ANALYTICS_MAX_WINDOW_DAYS, Math.floor(value)));
}
/**
 * Wrap a Prisma query so the whole envelope never throws. On failure
 * the metric resolves to `null` and the source name is recorded in
 * `degradedSources`. The wrapper is intentionally generic — callers
 * pass a function that returns the metric value.
 */
async function safe(promise, source, degraded) {
    try {
        return await promise;
    }
    catch {
        if (!degraded.includes(source))
            degraded.push(source);
        return null;
    }
}
export async function getOperationsOverview(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const window = resolveWindow(input);
    const windowStart = new Date(window.start);
    const degraded = [];
    const sourceTrace = [
        { metric: "evidenceCreated", source: "Evidence", filter: "teamId + createdAt>=window", windowed: true },
        { metric: "evidenceFinalized", source: "Evidence", filter: "teamId + status=REPORTED + createdAt>=window", windowed: true },
        { metric: "openCases", source: "Case", filter: "teamId + status=OPEN", windowed: false },
        { metric: "openReviewWorkflows", source: "EvidenceReviewWorkflow", filter: "teamId + status not in (APPROVED_INTERNAL, CLOSED)", windowed: false },
        { metric: "openEscalations", source: "ReviewEscalation", filter: "teamId + status=OPEN", windowed: false },
        { metric: "reviewerCount", source: "TeamMember", filter: "teamId + role in (ADMIN, OWNER, MEMBER)", windowed: false },
    ];
    const [evidenceCreated, evidenceFinalized, openCases, openReviewWorkflows, openEscalations, reviewerCount,] = await Promise.all([
        safe(prisma.evidence.count({
            where: { teamId: input.teamId, createdAt: { gte: windowStart } },
        }), "Evidence", degraded),
        safe(prisma.evidence.count({
            where: {
                teamId: input.teamId,
                createdAt: { gte: windowStart },
                // EvidenceStatus.REPORTED is the canonical "finalized" state
                // (artifact generated). String match to avoid enum import.
                status: "REPORTED",
            },
        }), "Evidence", degraded),
        safe(prisma.case.count({
            where: { teamId: input.teamId, status: "OPEN" },
        }), "Case", degraded),
        safe(prisma.evidenceReviewWorkflow.count({
            where: {
                teamId: input.teamId,
                status: { notIn: ["APPROVED_INTERNAL", "CLOSED"] },
            },
        }), "EvidenceReviewWorkflow", degraded),
        safe(prisma.reviewEscalation.count({
            where: { teamId: input.teamId, status: "OPEN" },
        }), "ReviewEscalation", degraded),
        input.scope === "PERSONAL"
            ? Promise.resolve(null)
            : safe(prisma.teamMember.count({
                where: {
                    teamId: input.teamId,
                    // Members who can act on reviews — VIEWER cannot.
                    role: { in: ["OWNER", "ADMIN", "MEMBER"] },
                },
            }), "TeamMember", degraded),
    ]);
    return {
        generatedAt: new Date(input.nowMs ?? Date.now()).toISOString(),
        window,
        sourceTrace,
        degradedSources: degraded,
        metrics: {
            evidenceCreated,
            evidenceFinalized,
            openCases,
            openReviewWorkflows,
            openEscalations,
            reviewerCount,
        },
    };
}
export async function getReviewerAnalytics(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const window = resolveWindow(input);
    const windowStart = new Date(window.start);
    const degraded = [];
    const sourceTrace = [
        { metric: "activeReviews", source: "EvidenceReviewWorkflow", filter: "teamId + status in (NOT_STARTED, IN_REVIEW, NEEDS_INFO, READY_FOR_EXTERNAL_REVIEW, ESCALATED)", windowed: false },
        { metric: "assignedReviews", source: "EvidenceReviewWorkflow", filter: "teamId + assignedToUserId not null + status in active", windowed: false },
        { metric: "overdueReviews", source: "EvidenceReviewWorkflow", filter: "teamId + dueAt < now + status in active", windowed: false },
        { metric: "openEscalations", source: "ReviewEscalation", filter: "teamId + status=OPEN", windowed: false },
        { metric: "resolvedEscalationsInWindow", source: "ReviewEscalation", filter: "teamId + status=RESOLVED + updatedAt>=window", windowed: true },
    ];
    const activeStatuses = [
        "NOT_STARTED",
        "IN_REVIEW",
        "NEEDS_INFO",
        "READY_FOR_EXTERNAL_REVIEW",
        "ESCALATED",
    ];
    const now = new Date(input.nowMs ?? Date.now());
    const [activeReviews, assignedReviews, overdueReviews, openEscalations, resolvedEscalationsInWindow,] = await Promise.all([
        safe(prisma.evidenceReviewWorkflow.count({
            where: {
                teamId: input.teamId,
                status: { in: activeStatuses },
            },
        }), "EvidenceReviewWorkflow", degraded),
        safe(prisma.evidenceReviewWorkflow.count({
            where: {
                teamId: input.teamId,
                status: { in: activeStatuses },
                assignedToUserId: { not: null },
            },
        }), "EvidenceReviewWorkflow", degraded),
        safe(prisma.evidenceReviewWorkflow.count({
            where: {
                teamId: input.teamId,
                status: { in: activeStatuses },
                dueAt: { lt: now },
            },
        }), "EvidenceReviewWorkflow", degraded),
        safe(prisma.reviewEscalation.count({
            where: { teamId: input.teamId, status: "OPEN" },
        }), "ReviewEscalation", degraded),
        safe(prisma.reviewEscalation.count({
            where: {
                teamId: input.teamId,
                status: "RESOLVED",
                updatedAt: { gte: windowStart },
            },
        }), "ReviewEscalation", degraded),
    ]);
    return {
        generatedAt: new Date(input.nowMs ?? Date.now()).toISOString(),
        window,
        sourceTrace,
        degradedSources: degraded,
        metrics: {
            activeReviews,
            assignedReviews,
            overdueReviews,
            openEscalations,
            resolvedEscalationsInWindow,
        },
    };
}
export async function getGovernanceAnalytics(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const window = resolveWindow(input);
    const windowStart = new Date(window.start);
    const degraded = [];
    const sourceTrace = [
        { metric: "activeLegalHolds", source: "EvidenceLegalHold", filter: "teamId + status=ACTIVE", windowed: false },
        { metric: "activeCaseLegalHolds", source: "CaseLegalHold", filter: "teamId + status=ACTIVE", windowed: false },
        { metric: "legalHoldsPlacedInWindow", source: "EvidenceLegalHold", filter: "teamId + placedAtUtc>=window", windowed: true },
        { metric: "legalHoldsReleasedInWindow", source: "EvidenceLegalHold", filter: "teamId + releasedAtUtc>=window", windowed: true },
    ];
    const [activeLegalHolds, activeCaseLegalHolds, legalHoldsPlacedInWindow, legalHoldsReleasedInWindow,] = await Promise.all([
        safe(prisma.evidenceLegalHold.count({
            where: { teamId: input.teamId, status: "ACTIVE" },
        }), "EvidenceLegalHold", degraded),
        safe(prisma.caseLegalHold.count({
            where: { teamId: input.teamId, status: "ACTIVE" },
        }), "CaseLegalHold", degraded),
        safe(prisma.evidenceLegalHold.count({
            where: { teamId: input.teamId, placedAtUtc: { gte: windowStart } },
        }), "EvidenceLegalHold", degraded),
        safe(prisma.evidenceLegalHold.count({
            where: {
                teamId: input.teamId,
                releasedAtUtc: { gte: windowStart, not: null },
            },
        }), "EvidenceLegalHold", degraded),
    ]);
    return {
        generatedAt: new Date(input.nowMs ?? Date.now()).toISOString(),
        window,
        sourceTrace,
        degradedSources: degraded,
        metrics: {
            activeLegalHolds,
            activeCaseLegalHolds,
            legalHoldsPlacedInWindow,
            legalHoldsReleasedInWindow,
        },
    };
}
export async function getAutomationAnalytics(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const window = resolveWindow(input);
    const windowStart = new Date(window.start);
    const degraded = [];
    const sourceTrace = [
        { metric: "enabledRules", source: "AutomationRule", filter: "teamId + enabled=true", windowed: false },
        { metric: "runsInWindow", source: "AutomationRun", filter: "teamId + createdAt>=window", windowed: true },
        { metric: "runsSucceededInWindow", source: "AutomationRun", filter: "teamId + status=SUCCEEDED + createdAt>=window", windowed: true },
        { metric: "runsFailedInWindow", source: "AutomationRun", filter: "teamId + status=FAILED + createdAt>=window", windowed: true },
        { metric: "runsSkippedInWindow", source: "AutomationRun", filter: "teamId + status=SKIPPED + createdAt>=window", windowed: true },
        { metric: "webhookDeliveriesInWindow", source: "AutomationWebhookDelivery", filter: "teamId + createdAt>=window", windowed: true },
        { metric: "webhookDeliveriesSucceededInWindow", source: "AutomationWebhookDelivery", filter: "teamId + status=SUCCEEDED + createdAt>=window", windowed: true },
        { metric: "webhookDeliveriesFailedInWindow", source: "AutomationWebhookDelivery", filter: "teamId + status=FAILED + createdAt>=window", windowed: true },
        { metric: "webhookDeliveriesRetryScheduled", source: "AutomationWebhookDelivery", filter: "teamId + status=RETRY_SCHEDULED", windowed: false },
        { metric: "webhookDeliveriesRetryExhaustedInWindow", source: "AutomationWebhookDelivery", filter: "teamId + status=RETRY_EXHAUSTED + createdAt>=window", windowed: true },
        { metric: "autoDisabledDestinations", source: "AutomationWebhookDestination", filter: "teamId + autoDisabledAt not null", windowed: false },
    ];
    const [enabledRules, runsInWindow, runsSucceededInWindow, runsFailedInWindow, runsSkippedInWindow, webhookDeliveriesInWindow, webhookDeliveriesSucceededInWindow, webhookDeliveriesFailedInWindow, webhookDeliveriesRetryScheduled, webhookDeliveriesRetryExhaustedInWindow, autoDisabledDestinations,] = await Promise.all([
        safe(prisma.automationRule.count({ where: { teamId: input.teamId, enabled: true } }), "AutomationRule", degraded),
        safe(prisma.automationRun.count({ where: { teamId: input.teamId, createdAt: { gte: windowStart } } }), "AutomationRun", degraded),
        safe(prisma.automationRun.count({ where: { teamId: input.teamId, status: "SUCCEEDED", createdAt: { gte: windowStart } } }), "AutomationRun", degraded),
        safe(prisma.automationRun.count({ where: { teamId: input.teamId, status: "FAILED", createdAt: { gte: windowStart } } }), "AutomationRun", degraded),
        safe(prisma.automationRun.count({ where: { teamId: input.teamId, status: "SKIPPED", createdAt: { gte: windowStart } } }), "AutomationRun", degraded),
        safe(prisma.automationWebhookDelivery.count({ where: { teamId: input.teamId, createdAt: { gte: windowStart } } }), "AutomationWebhookDelivery", degraded),
        safe(prisma.automationWebhookDelivery.count({ where: { teamId: input.teamId, status: "SUCCEEDED", createdAt: { gte: windowStart } } }), "AutomationWebhookDelivery", degraded),
        safe(prisma.automationWebhookDelivery.count({ where: { teamId: input.teamId, status: "FAILED", createdAt: { gte: windowStart } } }), "AutomationWebhookDelivery", degraded),
        safe(prisma.automationWebhookDelivery.count({ where: { teamId: input.teamId, status: "RETRY_SCHEDULED" } }), "AutomationWebhookDelivery", degraded),
        safe(prisma.automationWebhookDelivery.count({ where: { teamId: input.teamId, status: "RETRY_EXHAUSTED", createdAt: { gte: windowStart } } }), "AutomationWebhookDelivery", degraded),
        safe(prisma.automationWebhookDestination.count({ where: { teamId: input.teamId, autoDisabledAt: { not: null } } }), "AutomationWebhookDestination", degraded),
    ]);
    return {
        generatedAt: new Date(input.nowMs ?? Date.now()).toISOString(),
        window,
        sourceTrace,
        degradedSources: degraded,
        metrics: {
            enabledRules,
            runsInWindow,
            runsSucceededInWindow,
            runsFailedInWindow,
            runsSkippedInWindow,
            webhookDeliveriesInWindow,
            webhookDeliveriesSucceededInWindow,
            webhookDeliveriesFailedInWindow,
            webhookDeliveriesRetryScheduled,
            webhookDeliveriesRetryExhaustedInWindow,
            autoDisabledDestinations,
        },
    };
}
export async function getArtifactReadinessAnalytics(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const window = resolveWindow(input);
    const windowStart = new Date(window.start);
    const degraded = [];
    const sourceTrace = [
        { metric: "reportsGeneratedInWindow", source: "Report", filter: "evidence.teamId + generatedAtUtc>=window", windowed: true },
        { metric: "packagesGeneratedInWindow", source: "VerificationPackage", filter: "evidence.teamId + generatedAtUtc>=window", windowed: true },
    ];
    // Reports + VerificationPackages do not carry teamId directly — they
    // are tied to Evidence, which is the team-owned row. We scope through
    // the evidence relation so cross-team leakage is structurally
    // impossible: a delete of the Evidence cascades the artifact away.
    const [reportsGeneratedInWindow, packagesGeneratedInWindow] = await Promise.all([
        safe(prisma.report.count({
            where: {
                generatedAtUtc: { gte: windowStart },
                evidence: { teamId: input.teamId },
            },
        }), "Report", degraded),
        safe(prisma.verificationPackage.count({
            where: {
                generatedAtUtc: { gte: windowStart },
                evidence: { teamId: input.teamId },
            },
        }), "VerificationPackage", degraded),
    ]);
    return {
        generatedAt: new Date(input.nowMs ?? Date.now()).toISOString(),
        window,
        sourceTrace,
        degradedSources: degraded,
        metrics: { reportsGeneratedInWindow, packagesGeneratedInWindow },
    };
}
