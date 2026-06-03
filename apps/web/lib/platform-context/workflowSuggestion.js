/**
 * PHASE 38.3 — Workflow profile suggestion helper.
 *
 * Pure function. Given bounded usage signals, returns the most likely
 * workflow profile the user would benefit from selecting. Used by the
 * workflow setup banner / settings page to recommend a starting
 * workflow without ever forcing a choice.
 *
 * Hard rules:
 *
 *   1. Suggestion only — NEVER auto-applies. The caller decides whether
 *      to surface the suggestion and how the user confirms.
 *   2. NEVER grants capabilities. The suggested profile is presentation-
 *      only when it's eventually applied; the suggestion logic itself is
 *      pure.
 *   3. Bounded inputs. Only counts of canonical operational signals; no
 *      free-form text, no PII.
 *   4. Stable. Same input → same output.
 *
 * Signals are integers. The caller derives them from envelope counters
 * (e.g. `projectionSummary.openIncidentCount`, organization size,
 * recent reviewer-queue usage) — the helper itself never reads from
 * the network or platform context.
 */
const EMPTY_SIGNALS = {
    reviewerQueueActivity: 0,
    caseActivity: 0,
    governanceActivity: 0,
    operationalIncidentActivity: 0,
    mediaVerificationActivity: 0,
    investigationActivity: 0,
};
/**
 * Compute the most likely workflow suggestion from usage signals.
 *
 * The signals form a simple weighted vote. The strongest signal wins;
 * ties break in canonical priority order (the order signals are declared
 * in this file). Always returns a suggestion — falls back to
 * `VERIFICATION_DOCUMENTATION` for empty input.
 */
export function suggestWorkflow(signals = {}) {
    const merged = { ...EMPTY_SIGNALS, ...signals };
    const total = merged.reviewerQueueActivity +
        merged.caseActivity +
        merged.governanceActivity +
        merged.operationalIncidentActivity +
        merged.mediaVerificationActivity +
        merged.investigationActivity;
    if (total === 0) {
        return {
            recommended: "VERIFICATION_DOCUMENTATION",
            confidence: 0,
            reason: "Default starting point for capture, verification, and documentation workflows.",
        };
    }
    // Ranking — strongest signal wins; ties resolved by declaration order.
    const ranked = [
        {
            code: "OPERATIONAL_ADMINISTRATION",
            score: merged.operationalIncidentActivity,
            reason: "Operational incident and queue pressure signal is high. Operational Administration prioritises Command Center surfaces.",
        },
        {
            code: "REVIEW_OPERATIONS",
            score: merged.reviewerQueueActivity,
            reason: "Reviewer queue activity is high. Review & Operations prioritises intake queues, SLA tracking, and assignments.",
        },
        {
            code: "GOVERNANCE_COMPLIANCE",
            score: merged.governanceActivity,
            reason: "Governance and legal-hold activity is high. Governance & Compliance prioritises retention, audit posture, and policy workflows.",
        },
        {
            code: "INVESTIGATION_RECONSTRUCTION",
            score: merged.investigationActivity,
            reason: "Timeline and relationship usage is high. Investigation & Reconstruction prioritises cross-case intelligence and discovery.",
        },
        {
            code: "LEGAL_CASEWORK",
            score: merged.caseActivity,
            reason: "Case / matter activity is high. Legal & Case Workflows prioritises matters, custody timelines, and verification packages.",
        },
        {
            code: "MEDIA_VERIFICATION",
            score: merged.mediaVerificationActivity,
            reason: "Media verification activity is high. Media & Publication Verification prioritises authenticity, public verify, and export readiness.",
        },
    ];
    // Sort by score desc; declaration order acts as tiebreaker because
    // `.sort` is stable in modern engines.
    ranked.sort((a, b) => b.score - a.score);
    const winner = ranked[0];
    const confidence = Math.min(100, Math.round((winner.score / total) * 100));
    return {
        recommended: winner.code,
        confidence,
        reason: winner.reason,
    };
}
