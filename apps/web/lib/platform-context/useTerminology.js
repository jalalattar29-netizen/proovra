"use client";
// Canonical product terminology. (2026-07-20) persona/workflow override
// dimension removed with the workspace-persona feature family.
const CANONICAL_TERMS = {
    case: "Case",
    caseLower: "case",
    casePlural: "Cases",
    evidence: "Evidence",
    evidenceLower: "evidence",
    report: "Report",
    reportLower: "report",
    timeline: "Timeline",
    publicVerify: "Public Verify",
    review: "Review",
    assignment: "Assignment",
    dashboard: "Dashboard",
    queue: "Queue",
    incident: "Incident",
};
export function useTerminology() {
    return CANONICAL_TERMS;
}
export function resolveTerminology() {
    return CANONICAL_TERMS;
}
