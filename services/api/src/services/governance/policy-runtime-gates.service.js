/**
 * PROOVRA Phase 4A Closure — Runtime caller-site wrappers for the six
 * governance policy evaluators.
 *
 * The evaluators in `policy-evaluation.service.ts` are the decision
 * engines (they load effective policies, walk rules, and emit audit
 * rows). They return a tri-valued `PolicyEvaluationResult`
 * (ALLOW/WARN/BLOCK), which is the right surface for a decision engine
 * but is awkward to wire from operational routes.
 *
 * This module is the thin, opinionated boundary that real call sites
 * (routes, jobs, controllers) bind to. Each `gate*` wrapper:
 *   * Invokes the corresponding evaluator.
 *   * Collapses the verdict into a binary `{ ok: true }` /
 *     `{ ok: false, denial, reason }` shape.
 *   * Maps WARN to `POLICY_WARN_ACK_REQUIRED` — the caller decides
 *     whether to proceed (e.g. after a user acknowledgement) and
 *     remains in control of UX.
 *   * Maps BLOCK to `POLICY_BLOCK` — the caller must short-circuit.
 *
 * Bounded reason strings come straight from the evaluator (already
 * snake-case, <=80 chars, no PII). On ALLOW we drop the reason — a
 * gate does not need to explain itself when it lets you through.
 *
 * The `POLICY_RUNTIME_GATE_REGISTRY` constant lets test harnesses and
 * the governance control plane iterate the gate surface without
 * hard-coding the five kinds.
 */
import { evaluateRedactionPolicy, evaluateRetentionPolicy, evaluateReviewPolicy, evaluateSecurityPolicy, evaluateVerificationPolicy, } from "./policy-evaluation.service.js";
const FALLBACK_REASON = "policy_denied";
function collapse(decision, reason) {
    if (decision === "ALLOW")
        return { ok: true };
    if (decision === "WARN") {
        return {
            ok: false,
            denial: "POLICY_WARN_ACK_REQUIRED",
            reason: reason ?? FALLBACK_REASON,
        };
    }
    return {
        ok: false,
        denial: "POLICY_BLOCK",
        reason: reason ?? FALLBACK_REASON,
    };
}
export async function gateSecurityAction(input) {
    const evalInput = {
        prisma: input.prisma,
        teamId: input.teamId,
        userId: input.userId,
        action: input.action,
        mfaSatisfied: input.mfaSatisfied,
        samlAuthenticated: input.samlAuthenticated,
        organizationId: input.organizationId,
        departmentId: input.departmentId,
        workspaceId: input.workspaceId,
    };
    const result = await evaluateSecurityPolicy(evalInput);
    return collapse(result.decision, result.reason);
}
export async function gateRetentionAction(input) {
    const evalInput = {
        prisma: input.prisma,
        teamId: input.teamId,
        evidenceId: input.evidenceId,
        action: input.action,
        organizationId: input.organizationId,
        departmentId: input.departmentId,
        workspaceId: input.workspaceId,
    };
    const result = await evaluateRetentionPolicy(evalInput);
    return collapse(result.decision, result.reason);
}
export async function gateReviewDecision(input) {
    const evalInput = {
        prisma: input.prisma,
        teamId: input.teamId,
        workflowId: input.workflowId,
        decision: input.decision,
        organizationId: input.organizationId,
        departmentId: input.departmentId,
        workspaceId: input.workspaceId,
    };
    const result = await evaluateReviewPolicy(evalInput);
    return collapse(result.decision, result.reason);
}
export async function gateVerificationAction(input) {
    const evalInput = {
        prisma: input.prisma,
        teamId: input.teamId,
        evidenceId: input.evidenceId,
        action: input.action,
        organizationId: input.organizationId,
        departmentId: input.departmentId,
        workspaceId: input.workspaceId,
    };
    const result = await evaluateVerificationPolicy(evalInput);
    return collapse(result.decision, result.reason);
}
export async function gateRedactionAction(input) {
    const evalInput = {
        prisma: input.prisma,
        teamId: input.teamId,
        evidenceId: input.evidenceId,
        organizationId: input.organizationId,
        departmentId: input.departmentId,
        workspaceId: input.workspaceId,
    };
    const result = await evaluateRedactionPolicy(evalInput);
    return collapse(result.decision, result.reason);
}
// ===========================================================================
// Registry — lets consumers iterate the gate surface uniformly.
// ===========================================================================
export const POLICY_RUNTIME_GATE_REGISTRY = {
    SECURITY: gateSecurityAction,
    RETENTION: gateRetentionAction,
    REVIEW: gateReviewDecision,
    VERIFICATION: gateVerificationAction,
    REDACTION: gateRedactionAction,
};
