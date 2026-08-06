import {
  getPlanCapabilities,
  type PlanType,
  type WorkspaceScopeType,
} from "./plan-catalog.js";

export type BillingWorkspaceScope = {
  workspaceType: WorkspaceScopeType;
  ownerUserId: string;
  teamId: string | null;
  plan: PlanType;
  credits: number;
  teamSeats: number;
};

export type WorkspaceScope = BillingWorkspaceScope;

export function getEffectiveSeatLimit(scope: BillingWorkspaceScope): number {
  const caps = getPlanCapabilities(scope.plan);

  if (scope.workspaceType !== "TEAM") {
    return 0;
  }

  /**
   * Effective team-member cap:
   * - driven first by plan business cap (maxMembersPerTeam)
   * - then by legacy includedSeats
   * - then by any explicit runtime/team seat value
   */
  return Math.max(
    0,
    caps.maxMembersPerTeam || 0,
    caps.includedSeats || 0,
    scope.teamSeats || 0
  );
}

/**
 * PHASE 12 — POINT 7 (2026-08-05): `allowsPersonalWorkspacePurchase` is a
 * PURCHASE-TARGET rule, not a resolution rule.
 *
 * It answers "may this plan be bought FOR a personal workspace?" — which is
 * how the checkout surface uses it, and why TEAM (`teamWorkspaceRequired:
 * true`) is the only plan that says no. It does NOT answer "may this identity
 * have a Personal Space?": that is
 * `resolvePersonalSpaceEligibility` in services/api (identity mode + the
 * Organization's `noPersonalSpace` policy), and it is deliberately
 * plan-independent — every authenticated user is bootstrapped a Personal Team
 * regardless of plan.
 *
 * `assertWorkspacePlanCompatible` used to apply the purchase-target rule to
 * the RESOLUTION path, so resolving the personal scope of a TEAM-plan account
 * threw `PLAN_NOT_ALLOWED_FOR_PERSONAL_WORKSPACE` — a 500 on
 * `/v1/billing/overview` and a broken personal capture. Both the API and the
 * worker worked around it by silently resolving that account's personal space
 * at **PRO**, a plan it does not hold, in two independently-maintained copies
 * of the same substitution. Point 7 removes the misapplication instead: the
 * resolution path no longer asks a purchase question, and the substitutions
 * are gone.
 */
export function assertPlanPurchasableForWorkspaceType(scope: {
  workspaceType: WorkspaceScopeType;
  plan: PlanType;
}): void {
  const caps = getPlanCapabilities(scope.plan);
  if (scope.workspaceType === "PERSONAL" && !caps.allowsPersonalWorkspacePurchase) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "Plan is not valid for personal workspace"
    );
    err.statusCode = 409;
    err.code = "PLAN_NOT_ALLOWED_FOR_PERSONAL_WORKSPACE";
    throw err;
  }
}

/**
 * Workspace compatibility rules
 *
 * PERSONAL workspace:
 * - structurally always valid. The plan a personal space resolves at is the
 *   account's own entitlement; see
 *   {@link assertPlanPurchasableForWorkspaceType} for the purchase-target rule
 *   this branch used to conflate with resolution.
 *
 * TEAM workspace:
 * - may exist on FREE as a readable/non-entitled state
 * - may exist on PRO because PRO now supports teams
 * - may exist on TEAM
 * - may exist on ENTERPRISE, which is exactly what an ORGANIZATION
 *   workspace resolves to under a live organization contract
 * - must reject PAYG because PAYG is an operation entitlement on a
 *   personal account, never a workspace plan
 *
 * Important:
 * This function validates whether the workspace/plan combination is structurally valid.
 * It does NOT decide whether a paid action is allowed.
 */
export function assertWorkspacePlanCompatible(scope: BillingWorkspaceScope) {
  if (scope.workspaceType === "TEAM") {
    /**
     * TEAM workspace is valid when:
     * - FREE: non-entitled but readable/manageable state
     * - PRO: personal subscription that now supports team workspaces
     * - TEAM: dedicated team plan
     * - ENTERPRISE: the plan `resolveWorkspaceEffectivePlan` returns for an
     *   ORGANIZATION workspace under a live contract (ORGANIZATION_CONTRACT).
     *
     * PHASE 12 POINT 4 PASS C0 — ENTERPRISE was missing here, so this
     * structural check contradicted the effective-plan policy in the SAME
     * package: every ORGANIZATION workspace resolved to ENTERPRISE and was
     * then rejected 409 by the canonical scope resolver. PAYG stays
     * rejected — it is an operation entitlement, not a workspace plan.
     */
    if (
      scope.plan === "FREE" ||
      scope.plan === "PRO" ||
      scope.plan === "TEAM" ||
      scope.plan === "ENTERPRISE"
    ) {
      return;
    }

    const err: Error & { statusCode?: number; code?: string } = new Error(
      "Plan is not valid for team workspace"
    );
    err.statusCode = 409;
    err.code = "PLAN_NOT_ALLOWED_FOR_TEAM_WORKSPACE";
    throw err;
  }
}