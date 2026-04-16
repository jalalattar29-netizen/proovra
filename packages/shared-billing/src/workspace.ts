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

  return Math.max(caps.includedSeats, scope.teamSeats || 0);
}

/**
 * Important billing rule:
 *
 * A TEAM workspace may legitimately exist while its billing plan is FREE,
 * INACTIVE, or CANCELED. In that state, the workspace is still valid and
 * should remain readable in billing/settings/admin flows.
 *
 * What must be blocked is not the existence of the team workspace itself,
 * but specific paid/team-only actions elsewhere (for example creating team
 * evidence while the team is not on an active TEAM plan).
 *
 * Therefore:
 * - PERSONAL workspace must still reject plans that do not support personal use
 * - TEAM workspace should allow:
 *   - TEAM
 *   - FREE
 * - TEAM workspace should still reject personal-only paid plans such as PAYG/PRO
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
    // TEAM workspace is allowed to exist on FREE as a non-active billing state.
    if (scope.plan === "FREE" || scope.plan === "TEAM") {
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