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
 * Workspace compatibility rules
 *
 * PERSONAL workspace:
 * - must use a plan that allows personal workspaces
 *
 * TEAM workspace:
 * - may exist on FREE as a readable/non-entitled state
 * - may exist on PRO because PRO now supports teams
 * - may exist on TEAM
 * - must reject PAYG because PAYG is still personal-only
 *
 * Important:
 * This function validates whether the workspace/plan combination is structurally valid.
 * It does NOT decide whether a paid action is allowed.
 */
export function assertWorkspacePlanCompatible(scope: BillingWorkspaceScope) {
  const caps = getPlanCapabilities(scope.plan);

  if (scope.workspaceType === "PERSONAL" && !caps.allowsPersonalWorkspace) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "Plan is not valid for personal workspace"
    );
    err.statusCode = 409;
    err.code = "PLAN_NOT_ALLOWED_FOR_PERSONAL_WORKSPACE";
    throw err;
  }

  if (scope.workspaceType === "TEAM") {
    /**
     * TEAM workspace is valid when:
     * - FREE: non-entitled but readable/manageable state
     * - PRO: personal subscription that now supports team workspaces
     * - TEAM: dedicated team plan
     */
    if (scope.plan === "FREE" || scope.plan === "PRO" || scope.plan === "TEAM") {
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