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
import {
  REVIEW_GATE_TABLE,
  classifyReviewBulkRequest,
  policyFlagReason,
  type ReviewBulkClassification,
  type ReviewGateAction as SharedReviewGateAction,
} from "@proovra/shared";

import { prisma } from "../../db.js";
import { runtimeAdaptiveGate } from "../access-control/adaptive-runtime-gate.service.js";
import { evidenceVisibleThroughCasesWhere } from "../cases/case-visibility.js";
import { requireStepUpForSensitiveAction } from "../identity-security/step-up-middleware.js";
import { loadWorkspaceReviewerOpsFlags } from "./sla-policy.service.js";

/**
 * T-031 — the gate table is DATA in `@proovra/shared` (review-step-up-policy),
 * so Review settings renders exactly what this gate enforces:
 *   approve            → approve checkbox, 8 h window
 *   reject             → reject checkbox (also Evidence-page Close / Reopen), 8 h
 *   archive            → reject checkbox, its own purpose, 8 h (T-030: a single
 *                        archive is not a bulk act)
 *   bulk               → bulk checkbox, 4 h
 *   escalationResolve  → escalation checkbox, 8 h
 *   escalationSuppress → escalation checkbox, 4 h
 * Assignment (single or bulk) is not in the table: it is not a step-up action
 * (T-036, P8). See `enforceReviewBulkDoorGate`.
 */
export type ReviewGateAction = SharedReviewGateAction;

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
 *
 * Order (CONSUMER-MAP §3.7): session trust and age window, then risk, then the
 * workspace flag — one merged challenge covers flag ∨ risk. The refusal names
 * WHY in `details.reason` (T-028): `policy_flag:<flag>` when the checkbox is on,
 * `elevated_session_risk` when only the session's risk asks for it.
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
  const gate = REVIEW_GATE_TABLE[input.action];
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
  const flagOn = flags[gate.flag] === true;
  if (!flagOn && !adaptive.stepUpRequired) return true;
  const stepUp = await requireStepUpForSensitiveAction({
    req,
    reply,
    teamId: input.teamId,
    userId: input.userId,
    purpose: gate.purpose,
    resourceKind: input.resource.kind,
    resourceId: input.resource.id,
    reason: flagOn ? policyFlagReason(gate.flag) : (adaptive.stepUpReason ?? "elevated_session_risk"),
  });
  return !stepUp.sent;
}

/**
 * T-030 / T-036 — THE ONE GATE FOR A BULK-DOOR REQUEST.
 *
 * Every bulk door (`/v1/reviewer-ops/reviews/bulk`, `/v1/review-operations/bulk`,
 * `/v1/reviewer/bulk/*`) classifies its request here, by the shared
 * `classifyReviewBulkRequest`, instead of calling the gate with "bulk":
 *   - assignment (ASSIGN / REASSIGN, any count): no step-up and no session-age
 *     window — the same answer as the single assign and reassign routes.
 *     Session trust still applies (a quarantined or CRITICAL-risk session is
 *     refused). Authorization, the eligible-reviewer check and the audit row
 *     stay where they are, in the door and its service.
 *   - a single archive (CLOSE of one review sent as `scope: "single"`): the
 *     archive gate (reject checkbox, 8 h).
 *   - everything else: the bulk gate.
 */
export async function enforceReviewBulkDoorGate(
  req: FastifyRequest,
  reply: FastifyReply,
  input: {
    teamId: string;
    userId: string;
    action: string;
    itemIds: readonly string[];
    scope?: "single" | "bulk" | null;
    resourceKind: string;
  },
): Promise<{ allowed: boolean; classification: ReviewBulkClassification }> {
  const classification = classifyReviewBulkRequest({
    action: input.action,
    itemCount: input.itemIds.length,
    scope: input.scope ?? null,
  });
  if (classification === "assignment") {
    const trust = await runtimeAdaptiveGate({
      req,
      reply,
      teamId: input.teamId,
      userId: input.userId,
      action: "REVIEWER_BULK",
      trustOnly: true,
    });
    return { allowed: trust.allow, classification };
  }
  const allowed = await enforceReviewActionGate(req, reply, {
    teamId: input.teamId,
    userId: input.userId,
    action: classification,
    resource:
      classification === "archive"
        ? { kind: "review_workflow", id: input.itemIds[0]! }
        : { kind: input.resourceKind, id: input.itemIds.slice(0, 8).join(",") },
  });
  return { allowed, classification };
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
