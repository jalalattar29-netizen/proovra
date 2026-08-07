/**
 * PHASE 12 CORRECTIVE PASS §1 (ARCH-001 + LEGACY-001, 2026-08-07) — ONE
 * WORKSPACE LANGUAGE.
 *
 * What this file used to say, and why it was the problem
 * ---------------------------------------------------------------------------
 * `BillingWorkspaceScope.workspaceType: "PERSONAL" | "TEAM"`. Two values that
 * READ like container categories, sitting next to a `TEAM` PLAN, consumed by a
 * flag called `allowsTeamWorkspace` and reported through errors called
 * `TEAM_WORKSPACE_LIMIT_REACHED`. Nothing in the code said whether "TEAM"
 * meant a workspace kind, a plan, or a capability bundle — and the answer was
 * "a plan and a capability bundle", because there has never been a TEAM
 * workspace KIND.
 *
 * That ambiguity was not cosmetic. It is how `getTeamWorkspaceScope` came to
 * stamp every scope `TEAM` including a user's own Personal Space, which made
 * `assertWorkspaceAllowsEvidenceCreation` refuse a FREE user's own capture and
 * gave `getEffectiveSeatLimit` seats to sell on a workspace with one occupant.
 *
 * The vocabulary now
 * ---------------------------------------------------------------------------
 *   WorkspaceKind         PERSONAL | OWNED | ORGANIZATION. The TENANCY fact.
 *                         Lives in the database, is NOT NULL, and is the only
 *                         thing that decides what a workspace IS.
 *   WorkspaceBillingShape SINGLE_OCCUPANT | SHARED. The COMMERCIAL fact,
 *                         DERIVED from the kind by the one function below,
 *                         never persisted, never authorizing.
 *   PlanType              FREE | PAYG | PRO | TEAM | ENTERPRISE. What is
 *                         bought. TEAM is here and nowhere else.
 */

import {
  getPlanCapabilities,
  type PlanType,
  type WorkspaceBillingShape,
} from "./plan-catalog.js";

/**
 * The canonical tenancy kinds, restated here as an INPUT type only.
 *
 * Deliberately not imported from @proovra/shared: shared-billing must not
 * depend on the domain package for a three-value union, and the derivation
 * below is total over it, so a new kind is a compile error here rather than a
 * silent default.
 */
export type WorkspaceKindInput = "PERSONAL" | "OWNED" | "ORGANIZATION";

/**
 * THE ONE DERIVATION. Tenancy kind → commercial shape.
 *
 * Total and explicit. A Personal Space has exactly one occupant, so there are
 * no seats to sell and no members to invite; an Owned or Organization
 * workspace can hold more than one, so seat and member limits apply. Nothing
 * else about the plan, the subscription or the role matters to this question.
 */
export function billingShapeForWorkspaceKind(
  kind: WorkspaceKindInput,
): WorkspaceBillingShape {
  switch (kind) {
    case "PERSONAL":
      return "SINGLE_OCCUPANT";
    case "OWNED":
    case "ORGANIZATION":
      return "SHARED";
  }
}

export type BillingWorkspaceScope = {
  /**
   * The COMMERCIAL shape. Derived from the workspace's canonical kind by
   * `billingShapeForWorkspaceKind` and never assigned by hand.
   */
  billingShape: WorkspaceBillingShape;
  ownerUserId: string;
  teamId: string | null;
  plan: PlanType;
  credits: number;
  teamSeats: number;
};

export type WorkspaceScope = BillingWorkspaceScope;

export function getEffectiveSeatLimit(scope: BillingWorkspaceScope): number {
  const caps = getPlanCapabilities(scope.plan);

  // A single-occupant workspace has no seats to sell. Reporting a plan's
  // member cap here gave a Personal Space capacity that can never be filled.
  if (scope.billingShape !== "SHARED") {
    return 0;
  }

  /**
   * Effective member cap:
   * - driven first by plan business cap (maxMembersPerTeam)
   * - then by legacy includedSeats
   * - then by any explicit runtime/team seat value
   */
  return Math.max(
    0,
    caps.maxMembersPerTeam || 0,
    caps.includedSeats || 0,
    scope.teamSeats || 0,
  );
}

/**
 * PHASE 12 — POINT 7 (2026-08-05): `allowsPersonalWorkspacePurchase` is a
 * PURCHASE-TARGET rule, not a resolution rule.
 *
 * It answers "may this plan be bought FOR a personal workspace?" — which is
 * how the checkout surface uses it, and why TEAM (`teamWorkspaceRequired:
 * true`) is the only plan that says no. It does NOT answer "may this identity
 * have a Personal Space?": that is `resolvePersonalSpaceEligibility` in
 * services/api (identity mode + the Organization's `noPersonalSpace` policy),
 * and it is deliberately plan-independent — every authenticated user is
 * bootstrapped a Personal Space regardless of plan.
 *
 * `assertWorkspacePlanCompatible` used to apply the purchase-target rule to
 * the RESOLUTION path, so resolving the personal scope of a TEAM-plan account
 * threw `PLAN_NOT_ALLOWED_FOR_PERSONAL_WORKSPACE` — a 500 on
 * `/v1/billing/overview` and a broken personal capture. Both the API and the
 * worker worked around it by silently resolving that account's personal space
 * at **PRO**, a plan it does not hold, in two independently-maintained copies
 * of the same substitution. Point 7 removes the misapplication instead.
 */
export function assertPlanPurchasableForWorkspaceShape(scope: {
  billingShape: WorkspaceBillingShape;
  plan: PlanType;
}): void {
  const caps = getPlanCapabilities(scope.plan);
  if (
    scope.billingShape === "SINGLE_OCCUPANT" &&
    !caps.allowsPersonalWorkspacePurchase
  ) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "Plan is not valid for a personal workspace",
    );
    err.statusCode = 409;
    err.code = "PLAN_NOT_ALLOWED_FOR_PERSONAL_WORKSPACE";
    throw err;
  }
}

/**
 * Structural plan/shape compatibility.
 *
 * SINGLE_OCCUPANT (a Personal Space):
 * - structurally always valid. The plan a personal space resolves at is the
 *   account's own entitlement; see
 *   {@link assertPlanPurchasableForWorkspaceShape} for the purchase-target
 *   rule this branch used to conflate with resolution.
 *
 * SHARED (an Owned or Organization workspace):
 * - may exist on FREE as a readable/non-entitled state
 * - may exist on PRO, which supports shared workspaces
 * - may exist on TEAM
 * - may exist on ENTERPRISE, which is what an ORGANIZATION workspace resolves
 *   to under a live organization contract
 * - must reject PAYG, because PAYG is an operation entitlement on a personal
 *   account and never a workspace plan
 *
 * This validates whether the combination is structurally valid. It does NOT
 * decide whether a paid action is allowed.
 */
export function assertWorkspacePlanCompatible(scope: BillingWorkspaceScope) {
  if (scope.billingShape === "SHARED") {
    /**
     * PHASE 12 POINT 4 PASS C0 — ENTERPRISE was missing here, so this
     * structural check contradicted the effective-plan policy in the SAME
     * package: every ORGANIZATION workspace resolved to ENTERPRISE and was
     * then rejected 409 by the canonical scope resolver. PAYG stays rejected —
     * it is an operation entitlement, not a workspace plan.
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
      "Plan is not valid for a shared workspace",
    );
    err.statusCode = 409;
    // ARCH-001/LEGACY-001 — the code names the SHAPE, not a workspace kind
    // called "team" that has never existed. The legacy spelling remains
    // reachable for old clients through the bounded compatibility map in
    // `packages/shared/src/legacy-workspace-vocabulary.ts`.
    err.code = "PLAN_NOT_ALLOWED_FOR_SHARED_WORKSPACE";
    throw err;
  }
}
