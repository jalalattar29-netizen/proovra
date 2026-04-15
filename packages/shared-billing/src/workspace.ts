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
  if (scope.workspaceType !== "TEAM") return 0;
  return Math.max(caps.includedSeats, scope.teamSeats || 0);
}

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

  if (scope.workspaceType === "TEAM" && !caps.allowsTeamWorkspace) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "Plan is not valid for team workspace"
    );
    err.statusCode = 409;
    err.code = "PLAN_NOT_ALLOWED_FOR_TEAM_WORKSPACE";
    throw err;
  }
}