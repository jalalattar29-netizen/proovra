/**
 * ONE GATE FOR A REVIEW ACTION, WHICHEVER DOOR IT CAME THROUGH (WF-R04, WF-R05).
 *
 * Three generations of review routes stay live, and each carried its own copy
 * of the adaptive gate and the step-up flag, or none: a quarantined session
 * refused on the console could approve through the decisions route, and a plain
 * reviewer could close 200 reviews through the legacy bulk route while the
 * console said that needed an admin and a fresh factor.
 *
 * Every door now asks this function for the action it performs. The action
 * decides the adaptive check and the step-up flag; the door decides nothing.
 *
 * Reach is not here. It lives where the row is loaded (`evidence` filter on the
 * workflow), so a door cannot skip it by skipping a gate.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { PrivilegedAction, StepUpPurpose } from "@proovra/shared";

import { prisma } from "../../db.js";
import { runtimeAdaptiveGate } from "../access-control/adaptive-runtime-gate.service.js";
import { evidenceVisibleThroughCasesWhere } from "../cases/case-visibility.js";
import { requireStepUpForSensitiveAction } from "../identity-security/step-up-middleware.js";
import { loadWorkspaceReviewerOpsFlags, type WorkspaceReviewerOpsFlags } from "./sla-policy.service.js";

export type ReviewGateAction =
  | "approve"
  | "reject"
  | "bulk"
  | "escalationResolve"
  | "escalationSuppress";

const GATE: Record<
  ReviewGateAction,
  { adaptive: PrivilegedAction; flag: keyof WorkspaceReviewerOpsFlags; purpose: StepUpPurpose }
> = {
  approve: {
    adaptive: "REVIEWER_APPROVE",
    flag: "requireStepUpForApprove",
    purpose: "REVIEW_APPROVAL_HIGH_RISK",
  },
  reject: {
    adaptive: "REVIEWER_REJECT",
    flag: "requireStepUpForReject",
    purpose: "REVIEWER_OPS_REJECT",
  },
  bulk: {
    adaptive: "REVIEWER_BULK",
    flag: "requireStepUpForBulk",
    purpose: "REVIEWER_OPS_BULK_ACTION",
  },
  escalationResolve: {
    adaptive: "REVIEW_ESCALATION_RESOLVE",
    flag: "requireStepUpForEscalationResolve",
    purpose: "REVIEWER_OPS_ESCALATION_RESOLVE",
  },
  escalationSuppress: {
    adaptive: "REVIEW_ESCALATION_SUPPRESS",
    flag: "requireStepUpForEscalationResolve",
    purpose: "REVIEWER_OPS_ESCALATION_RESOLVE",
  },
};

/** The gate a verdict kind answers to, or null for a verdict with no flag. */
export function gateForVerdict(
  kind: string,
): "approve" | "reject" | null {
  if (kind === "APPROVE" || kind === "APPROVE_INTERNAL" || kind.startsWith("UPHOLD_")) return "approve";
  if (kind === "REJECT" || kind === "REJECT_INSUFFICIENT") return "reject";
  return null;
}

/**
 * True when the request may proceed. False means this function has already
 * replied (adaptive refusal or step-up challenge) and the handler must return.
 */
export async function enforceReviewActionGate(
  req: FastifyRequest,
  reply: FastifyReply,
  input: {
    teamId: string;
    userId: string;
    action: ReviewGateAction;
    resource: { kind: string; id: string };
  },
): Promise<boolean> {
  const gate = GATE[input.action];
  const adaptive = await runtimeAdaptiveGate({
    req,
    reply,
    teamId: input.teamId,
    userId: input.userId,
    action: gate.adaptive,
    callerEnforcesStepUp: true,
  });
  if (!adaptive.allow) return false;
  const flags = await loadWorkspaceReviewerOpsFlags(input.teamId);
  if (!flags[gate.flag] && !adaptive.stepUpRequired) return true;
  const stepUp = await requireStepUpForSensitiveAction({
    req,
    reply,
    teamId: input.teamId,
    userId: input.userId,
    purpose: gate.purpose,
    resourceKind: input.resource.kind,
    resourceId: input.resource.id,
  });
  return !stepUp.sent;
}

/**
 * The bulk authority every bulk door shares: the administrative tier holding
 * `review.escalate` (the rule the console has had since R5). A role-literal
 * here is the floor that rule states, read from the proven role.
 */
export function holdsReviewBulkAuthority(
  role: string,
  hasEscalate: boolean,
): boolean {
  return (role === "OWNER" || role === "ADMIN") && hasEscalate;
}

/** Which of these workflows this caller may open, by the record rule. */
export async function workflowIdsInReach(input: {
  teamId: string;
  userId: string;
  workflowIds: readonly string[];
}): Promise<Set<string>> {
  if (input.workflowIds.length === 0) return new Set();
  const rows = await prisma.evidenceReviewWorkflow.findMany({
    where: {
      id: { in: [...input.workflowIds] },
      teamId: input.teamId,
      evidence: evidenceVisibleThroughCasesWhere(input.userId),
    },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}
