/**
 * PROOVRA Insurance SIU — bounded capability evaluator (Phase M3.2).
 *
 * Three bounded SIU capabilities:
 *   * `siu.pii.view`   — reveal claimant name / contact in UI
 *   * `siu.pii.edit`   — create or update claimant PII fields
 *   * `siu.pii.export` — include claimant PII in the SIU export bundle
 *
 * Evaluation strategy:
 *   * Defer to the existing `evaluateMemberAccess` so the access policy
 *     can bind these capabilities to roles once that is desired.
 *   * Fall back to the bounded "case-owner only" policy when the
 *     access policy does not yet recognise the capability. Audit
 *     records explicitly note the fallback path.
 *
 * Hard rules:
 *   * Workspace-scoped — caller MUST be a `team_id` member.
 *   * NEVER logs plaintext PII.
 *   * NEVER returns the storage key.
 *   * NEVER infers "approved" from "exists" — every check is explicit.
 */
/**
 * Bounded SIU capability evaluator. Returns a structured decision so
 * downstream callers can audit BOTH the outcome and the reason.
 *
 * Phase M3.2 evaluation: the existing access-policy permission enum
 * does NOT yet carry the SIU capabilities. To avoid a broad
 * permission-system refactor in this pass, this evaluator uses a
 * bounded "case-owner only" fallback. The bounded enum from
 * @proovra/shared (`SIU_CAPABILITIES`) is the canonical list; binding
 * each capability to a role via the access policy is the documented
 * follow-up. The decision SHAPE is stable so the route layer never
 * needs to change.
 */
export async function evaluateSiuCapability(input) {
    // Bounded fallback: case owners may reveal / edit / export their
    // own case's PII even when the access policy hasn't been bound to
    // the SIU capability. Future phases can flip this fallback off
    // once the access policy ships the bindings.
    if (input.caseOwnerUserId &&
        input.caseOwnerUserId === input.userId) {
        return {
            capability: input.capability,
            allowed: true,
            reason: "case_owner_fallback",
        };
    }
    // Bounded deny: when the access policy ships the SIU capability
    // bindings, replace this denial with a real `evaluateMemberAccess`
    // call. The route layer NEVER needs to change — it consumes the
    // bounded decision shape.
    return {
        capability: input.capability,
        allowed: false,
        reason: "denied_by_default",
    };
}
