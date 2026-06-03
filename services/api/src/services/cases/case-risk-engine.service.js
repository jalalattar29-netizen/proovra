/**
 * Phase 32.8D — Matter Workspace: Case Risk Engine.
 *
 * Deterministically computes a 0..100 risk score per case from real
 * existing counters. Persists the result as an advisory
 * `CaseRiskSnapshot` row. The score is INVERTED for risk level (high
 * score = low risk).
 *
 * Hard rules:
 *   - No AI / ML / statistical scoring. Every penalty is a documented
 *     bounded contribution.
 *   - Reads from REAL existing tables only.
 *   - Generator failures NEVER block evidence/report/package/verify
 *     core flows. Every step wrapped in try/catch.
 *   - Bounded operator-safe strings; no raw payloads.
 *   - Lazy-write: the case workspace read path invokes this; the
 *     persisted snapshot is the source of truth for the dashboard.
 */
import { prisma } from "../../db.js";
const REASON_LABELS = {
    EVIDENCE_GAP: "Linked evidence is missing report or verification package",
    INCIDENT_OPEN: "Operational incident linked to this case is open",
    WORKFLOW_OVERDUE: "Operational workflow past its due timestamp",
    WORKFLOW_ACTIVE: "Active operational workflow ongoing",
    INTEGRITY_FAILED: "Worker integrity classifier marked linked evidence FAILED",
    INTEGRITY_REVIEW_REQUIRED: "Worker integrity classifier flagged evidence for review",
    GOVERNANCE_BLOCKER: "Governance workflow or active legal hold present",
    LEGAL_HOLD_ACTIVE: "Active legal hold blocks closure transitions",
    REVIEWER_OVERLOAD: "Reviewer at HIGH/CRITICAL saturation on linked workflows",
    AUDIT_GAP: "Audit-readiness gap on linked evidence",
    PACKAGE_MISSING: "Reported evidence has no verification package",
    REPORT_MISSING: "Signed evidence has no generated report",
    CUSTODY_CONCERN: "Linked evidence has a non-active lifecycle state",
};
const RISK_THRESHOLDS = {
    // riskScore is 0..100. HIGHER = LOWER risk.
    NONE_MIN: 90,
    LOW_MIN: 75,
    MEDIUM_MIN: 55,
    HIGH_MIN: 30,
    // < HIGH_MIN → CRITICAL
};
function clamp100(n) {
    if (!Number.isFinite(n))
        return 0;
    return Math.max(0, Math.min(100, Math.round(n)));
}
function levelForScore(score) {
    if (score >= RISK_THRESHOLDS.NONE_MIN)
        return "NONE";
    if (score >= RISK_THRESHOLDS.LOW_MIN)
        return "LOW";
    if (score >= RISK_THRESHOLDS.MEDIUM_MIN)
        return "MEDIUM";
    if (score >= RISK_THRESHOLDS.HIGH_MIN)
        return "HIGH";
    return "CRITICAL";
}
/**
 * Resolve the canonical set of evidence IDs linked to this case via
 * EITHER the legacy `Evidence.caseId` singular column OR the canonical
 * `CaseEvidenceLink` many-to-many table. Both sources are unioned per
 * the Phase 32.8D backward-compatibility decision.
 *
 * Bounded — caps at 500 evidence rows per case for the risk engine.
 */
export async function listCaseEvidenceIds(input) {
    const set = new Set();
    try {
        const legacy = await prisma.evidence.findMany({
            where: { caseId: input.caseId },
            select: { id: true },
            take: 500,
        });
        for (const r of legacy)
            set.add(r.id);
    }
    catch {
        /* best-effort */
    }
    try {
        const links = await prisma.caseEvidenceLink.findMany({
            where: { caseId: input.caseId },
            select: { evidenceId: true },
            take: 500,
        });
        for (const r of links)
            set.add(r.evidenceId);
    }
    catch {
        /* best-effort */
    }
    return Array.from(set);
}
/**
 * Compute the risk for a case without persisting. Returns a deterministic
 * snapshot derived from real existing counters. Never throws.
 */
export async function computeCaseRisk(input) {
    const evidenceIds = await listCaseEvidenceIds(input);
    // Per-evidence counts (parallel, bounded).
    let missingReports = 0;
    let missingPackages = 0;
    let nonActiveLifecycle = 0;
    let integrityFailed = 0;
    let integrityReviewRequired = 0;
    let openIncidents = 0;
    let activeWorkflows = 0;
    let overdueWorkflows = 0;
    let governanceBlockers = 0;
    let activeLegalHolds = 0;
    let reviewerPressure = 0;
    if (evidenceIds.length > 0) {
        try {
            missingReports = await prisma.evidence.count({
                where: {
                    id: { in: evidenceIds },
                    status: "SIGNED",
                    latestReportVersion: null,
                },
            });
        }
        catch {
            /* best-effort */
        }
        try {
            missingPackages = await prisma.evidence.count({
                where: {
                    id: { in: evidenceIds },
                    status: "REPORTED",
                    verificationPackageVersion: null,
                },
            });
        }
        catch {
            /* best-effort */
        }
        try {
            nonActiveLifecycle = await prisma.evidence.count({
                where: {
                    id: { in: evidenceIds },
                    lifecycleState: { not: "ACTIVE" },
                },
            });
        }
        catch {
            /* best-effort */
        }
        try {
            // EvidenceIntegritySnapshot per linked evidence — bounded enum.
            const snaps = await prisma.evidenceIntegritySnapshot.findMany({
                where: { evidenceId: { in: evidenceIds } },
                select: { overallStatus: true },
                take: 500,
            });
            for (const s of snaps) {
                if (s.overallStatus === "FAILED")
                    integrityFailed += 1;
                if (s.overallStatus === "REVIEW_REQUIRED")
                    integrityReviewRequired += 1;
            }
        }
        catch {
            /* best-effort */
        }
        try {
            openIncidents = await prisma.operationalIncident.count({
                where: {
                    relatedEvidenceId: { in: evidenceIds },
                    status: { in: ["OPEN", "ACKNOWLEDGED"] },
                },
            });
        }
        catch {
            /* best-effort */
        }
    }
    // Case-scoped reads (workflows + holds + governance).
    try {
        activeWorkflows = await prisma.operationalWorkflow.count({
            where: {
                caseId: input.caseId,
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
        });
    }
    catch {
        /* best-effort */
    }
    try {
        overdueWorkflows = await prisma.operationalWorkflow.count({
            where: {
                caseId: input.caseId,
                status: {
                    in: [
                        "OPEN",
                        "ASSIGNED",
                        "IN_PROGRESS",
                        "WAITING_ON_SYSTEM",
                        "WAITING_ON_REVIEWER",
                        "WAITING_ON_GOVERNANCE",
                        "MITIGATING",
                    ],
                },
                dueAtUtc: { lt: new Date(), not: null },
            },
        });
    }
    catch {
        /* best-effort */
    }
    try {
        governanceBlockers = await prisma.operationalWorkflow.count({
            where: {
                caseId: input.caseId,
                workflowType: {
                    in: [
                        "GOVERNANCE_ESCALATION",
                        "EXPORT_BLOCKER_RESOLUTION",
                        "AUDIT_READINESS",
                    ],
                },
                status: {
                    in: [
                        "OPEN",
                        "ASSIGNED",
                        "IN_PROGRESS",
                        "WAITING_ON_REVIEWER",
                        "WAITING_ON_GOVERNANCE",
                        "MITIGATING",
                        "FAILED",
                    ],
                },
            },
        });
    }
    catch {
        /* best-effort */
    }
    try {
        activeLegalHolds = await prisma.caseLegalHold.count({
            where: { caseId: input.caseId, status: "ACTIVE" },
        });
    }
    catch {
        /* best-effort */
    }
    // Reviewer pressure: count of HIGH/CRITICAL reviewer capacity rows
    // whose reviewer is currently assigned to a workflow that links back
    // to this case. Bounded read.
    if (input.teamId && evidenceIds.length > 0) {
        try {
            const ownerIds = await prisma.operationalWorkflow.findMany({
                where: {
                    caseId: input.caseId,
                    assignedOwnerUserId: { not: null },
                    status: {
                        in: [
                            "OPEN",
                            "ASSIGNED",
                            "IN_PROGRESS",
                            "WAITING_ON_REVIEWER",
                        ],
                    },
                },
                select: { assignedOwnerUserId: true },
                take: 100,
            });
            const ids = Array.from(new Set(ownerIds
                .map((o) => o.assignedOwnerUserId)
                .filter((x) => !!x)));
            if (ids.length > 0) {
                reviewerPressure = await prisma.reviewerCapacitySnapshot.count({
                    where: {
                        teamId: input.teamId,
                        reviewerUserId: { in: ids },
                        saturationLevel: { in: ["HIGH", "CRITICAL"] },
                    },
                });
            }
        }
        catch {
            /* best-effort */
        }
    }
    const evidenceGapCount = missingReports + missingPackages;
    const integrityConcernCount = integrityFailed + integrityReviewRequired;
    // Bounded penalty contributions per the approved formula.
    const baseScore = 100;
    const incidentPenalty = Math.min(40, openIncidents * 10);
    const overduePenalty = Math.min(20, overdueWorkflows * 8);
    const integrityPenalty = Math.min(20, integrityConcernCount * 12);
    const governancePenalty = Math.min(20, governanceBlockers * 8);
    const holdPenalty = activeLegalHolds > 0 ? 5 : 0;
    const reviewerPenalty = Math.min(10, reviewerPressure * 5);
    const evidenceGapPenalty = Math.min(15, evidenceGapCount * 2);
    const custodyPenalty = Math.min(10, nonActiveLifecycle * 3);
    const riskScore = clamp100(baseScore -
        incidentPenalty -
        overduePenalty -
        integrityPenalty -
        governancePenalty -
        holdPenalty -
        reviewerPenalty -
        evidenceGapPenalty -
        custodyPenalty);
    const riskLevel = levelForScore(riskScore);
    const reasonCodes = [];
    if (openIncidents > 0)
        reasonCodes.push("INCIDENT_OPEN");
    if (overdueWorkflows > 0)
        reasonCodes.push("WORKFLOW_OVERDUE");
    if (activeWorkflows > 0 && overdueWorkflows === 0)
        reasonCodes.push("WORKFLOW_ACTIVE");
    if (integrityFailed > 0)
        reasonCodes.push("INTEGRITY_FAILED");
    if (integrityReviewRequired > 0)
        reasonCodes.push("INTEGRITY_REVIEW_REQUIRED");
    if (governanceBlockers > 0)
        reasonCodes.push("GOVERNANCE_BLOCKER");
    if (activeLegalHolds > 0)
        reasonCodes.push("LEGAL_HOLD_ACTIVE");
    if (reviewerPressure > 0)
        reasonCodes.push("REVIEWER_OVERLOAD");
    if (missingReports > 0)
        reasonCodes.push("REPORT_MISSING");
    if (missingPackages > 0)
        reasonCodes.push("PACKAGE_MISSING");
    if (evidenceGapCount > 0)
        reasonCodes.push("EVIDENCE_GAP");
    if (nonActiveLifecycle > 0)
        reasonCodes.push("CUSTODY_CONCERN");
    // Audit readiness: inverted gap count, bounded.
    const auditReadinessScore = clamp100(100 - Math.min(80, evidenceGapCount * 4 + governanceBlockers * 8));
    if (auditReadinessScore < 60 && !reasonCodes.includes("AUDIT_GAP")) {
        reasonCodes.push("AUDIT_GAP");
    }
    // Recommended action — chosen from the highest-severity reason.
    let recommendedAction = "Workspace operating within risk tolerance.";
    if (reasonCodes.includes("INTEGRITY_FAILED")) {
        recommendedAction =
            "Open the linked evidence's integrity panel — the worker classifier flagged a FAILED state.";
    }
    else if (reasonCodes.includes("INCIDENT_OPEN")) {
        recommendedAction =
            "Open the linked operational incident — it is currently open and tied to this case.";
    }
    else if (reasonCodes.includes("LEGAL_HOLD_ACTIVE")) {
        recommendedAction =
            "Review the active legal hold before considering case closure — preservation invariant is enforced.";
    }
    else if (reasonCodes.includes("WORKFLOW_OVERDUE")) {
        recommendedAction =
            "An operational workflow linked to this case is past its due timestamp — assign or escalate.";
    }
    else if (reasonCodes.includes("GOVERNANCE_BLOCKER")) {
        recommendedAction =
            "Resolve the governance workflow blocking deliverables for this case.";
    }
    else if (reasonCodes.includes("EVIDENCE_GAP")) {
        recommendedAction =
            "Linked evidence is missing a report or verification package — initiate the artifact pipeline from the evidence detail page.";
    }
    else if (reasonCodes.includes("REVIEWER_OVERLOAD")) {
        recommendedAction =
            "Reviewer assigned to a workflow on this case is at HIGH/CRITICAL saturation — consider reassignment from the dashboard reviewer board.";
    }
    return {
        riskScore,
        riskLevel,
        evidenceGapCount,
        openIncidentCount: openIncidents,
        activeWorkflowCount: activeWorkflows,
        overdueWorkflowCount: overdueWorkflows,
        governanceBlockerCount: governanceBlockers,
        reviewerPressureScore: reviewerPressure,
        auditReadinessScore,
        custodyConcernCount: nonActiveLifecycle,
        integrityConcernCount,
        packageReportGapCount: evidenceGapCount,
        reasonCodes,
        recommendedAction: recommendedAction.slice(0, 400),
    };
}
/**
 * Compute the risk AND persist the snapshot. Never throws. Returns the
 * computation (with persistence best-effort).
 */
export async function recordCaseRiskSnapshot(input) {
    const computation = await computeCaseRisk(input);
    try {
        await prisma.caseRiskSnapshot.create({
            data: {
                teamId: input.teamId,
                caseId: input.caseId,
                riskScore: computation.riskScore,
                riskLevel: computation.riskLevel,
                evidenceGapCount: computation.evidenceGapCount,
                openIncidentCount: computation.openIncidentCount,
                activeWorkflowCount: computation.activeWorkflowCount,
                overdueWorkflowCount: computation.overdueWorkflowCount,
                governanceBlockerCount: computation.governanceBlockerCount,
                reviewerPressureScore: computation.reviewerPressureScore,
                auditReadinessScore: computation.auditReadinessScore,
                custodyConcernCount: computation.custodyConcernCount,
                integrityConcernCount: computation.integrityConcernCount,
                packageReportGapCount: computation.packageReportGapCount,
                reasonCodes: computation.reasonCodes,
                recommendedAction: computation.recommendedAction,
                source: "DB_DERIVED",
            },
        });
    }
    catch {
        /* advisory write — never throws */
    }
    return computation;
}
export function labelForReason(code) {
    return REASON_LABELS[code] ?? code;
}
