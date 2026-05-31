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

import type { PrismaClient } from "@prisma/client";

import {
  evaluateRedactionPolicy,
  evaluateRetentionPolicy,
  evaluateReviewPolicy,
  evaluateSecurityPolicy,
  evaluateVerificationPolicy,
  type EvaluateRedactionPolicyInput,
  type EvaluateRetentionPolicyInput,
  type EvaluateReviewPolicyInput,
  type EvaluateSecurityPolicyInput,
  type EvaluateVerificationPolicyInput,
} from "./policy-evaluation.service.js";

// ===========================================================================
// Common types
// ===========================================================================

export type PolicyGateDenial = "POLICY_BLOCK" | "POLICY_WARN_ACK_REQUIRED";

export type PolicyGateResult =
  | { ok: true }
  | { ok: false; denial: PolicyGateDenial; reason: string };

const FALLBACK_REASON = "policy_denied";

function collapse(
  decision: "ALLOW" | "WARN" | "BLOCK",
  reason: string | null,
): PolicyGateResult {
  if (decision === "ALLOW") return { ok: true };
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

// ===========================================================================
// SECURITY
// ===========================================================================

export type GateSecurityActionInput = {
  prisma?: PrismaClient;
  teamId: string;
  userId: string;
  action: string;
  mfaSatisfied?: boolean;
  samlAuthenticated?: boolean;
  organizationId?: string | null;
  departmentId?: string | null;
  workspaceId?: string | null;
};

export async function gateSecurityAction(
  input: GateSecurityActionInput,
): Promise<PolicyGateResult> {
  const evalInput: EvaluateSecurityPolicyInput = {
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

// ===========================================================================
// RETENTION
// ===========================================================================

export type GateRetentionActionInput = {
  prisma?: PrismaClient;
  teamId: string;
  evidenceId: string;
  action: "DELETE" | "ARCHIVE" | "EXPORT";
  organizationId?: string | null;
  departmentId?: string | null;
  workspaceId?: string | null;
};

export async function gateRetentionAction(
  input: GateRetentionActionInput,
): Promise<PolicyGateResult> {
  const evalInput: EvaluateRetentionPolicyInput = {
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

// ===========================================================================
// REVIEW
// ===========================================================================

export type GateReviewDecisionInput = {
  prisma?: PrismaClient;
  teamId: string;
  workflowId: string;
  decision: string;
  organizationId?: string | null;
  departmentId?: string | null;
  workspaceId?: string | null;
};

export async function gateReviewDecision(
  input: GateReviewDecisionInput,
): Promise<PolicyGateResult> {
  const evalInput: EvaluateReviewPolicyInput = {
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

// ===========================================================================
// VERIFICATION
// ===========================================================================

export type GateVerificationActionInput = {
  prisma?: PrismaClient;
  teamId: string;
  evidenceId: string;
  action: "PUBLISH_PACKAGE" | "PUBLIC_VERIFY_EXPOSE";
  organizationId?: string | null;
  departmentId?: string | null;
  workspaceId?: string | null;
};

export async function gateVerificationAction(
  input: GateVerificationActionInput,
): Promise<PolicyGateResult> {
  const evalInput: EvaluateVerificationPolicyInput = {
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

// ===========================================================================
// REDACTION
// ===========================================================================

export type GateRedactionActionInput = {
  prisma?: PrismaClient;
  teamId: string;
  evidenceId: string;
  organizationId?: string | null;
  departmentId?: string | null;
  workspaceId?: string | null;
};

export async function gateRedactionAction(
  input: GateRedactionActionInput,
): Promise<PolicyGateResult> {
  const evalInput: EvaluateRedactionPolicyInput = {
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
} as const;

export type PolicyRuntimeGateKind = keyof typeof POLICY_RUNTIME_GATE_REGISTRY;
