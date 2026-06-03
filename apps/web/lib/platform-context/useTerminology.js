"use client";
/**
 * PHASE 38-CLOSURE — Persona terminology layer.
 *
 * Returns persona-tuned labels for canonical product concepts. The
 * underlying backend objects keep their canonical names (`Case`,
 * `Evidence`, `Report`, etc.) — this hook ONLY changes the visible
 * label.
 *
 * Hard rules:
 *
 *   1. NEVER changes a backend identifier, route, or permission.
 *   2. NEVER conditions visibility — labels apply regardless of whether
 *      a feature is reachable.
 *   3. Bounded vocabulary. Every label has a default (the canonical
 *      term) and a per-persona override. Unknown personas fall back to
 *      the default — never throws.
 */
import { usePersonaProfile } from "./usePersonaProfile";
const DEFAULT_TERMS = {
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
const PERSONA_TERMS = {
    INDIVIDUAL: {},
    LAWYER: {
        case: "Matter",
        caseLower: "matter",
        casePlural: "Matters",
        report: "Evidence report",
        reportLower: "evidence report",
        timeline: "Custody timeline",
    },
    INSURANCE: {
        case: "Claim",
        caseLower: "claim",
        casePlural: "Claims",
        review: "Claim review",
        assignment: "Handler assignment",
        queue: "Claims queue",
    },
    INVESTIGATOR: {
        case: "Investigation",
        caseLower: "investigation",
        casePlural: "Investigations",
        evidence: "Material",
        evidenceLower: "material",
        timeline: "Reconstruction",
    },
    JOURNALIST: {
        evidence: "Media record",
        evidenceLower: "media record",
        report: "Verification brief",
        reportLower: "verification brief",
        publicVerify: "Publication verification",
    },
    ENTERPRISE_COMPLIANCE: {
        case: "Review matter",
        caseLower: "review matter",
        casePlural: "Review matters",
        report: "Compliance report",
        reportLower: "compliance report",
    },
    ADMIN_OPERATOR: {
        dashboard: "Command Center",
        queue: "Operations queue",
        incident: "Operational incident",
    },
};
export function useTerminology() {
    const profile = usePersonaProfile();
    return resolveTerminology(profile.primaryProfile);
}
/**
 * Pure-function variant for tests + non-React callers.
 */
export function resolveTerminology(persona) {
    const overrides = PERSONA_TERMS[persona] ?? {};
    return { ...DEFAULT_TERMS, ...overrides };
}
