/**
 * PHASE 12 — POINT 7: the product contract, written down INDEPENDENTLY.
 *
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * The mandate's rule is blunt and correct: "Every fixture must carry explicit
 * expected authority values independent of production code. Do not generate
 * expectations by calling the resolver being tested." A matrix that computes
 * its expectations from `getPlanCapabilities` proves that the catalog equals
 * itself. It stays green through any catalog edit, including one that quietly
 * gives FREE the collaboration surface.
 *
 * So the five plans are transcribed here as LITERALS, from the Point-7 product
 * contract and the published pricing rows, and `plan-catalog-agreement` asserts
 * the running catalog agrees. When the catalog changes, that assertion fails
 * and a human decides whether the contract moved or the catalog drifted. That
 * is the whole point: the failure is the feature.
 *
 * WHAT IS AND IS NOT PINNED HERE
 * ---------------------------------------------------------------------------
 * Only the fields the Point-7 behaviour matrix actually reasons about. Pinning
 * every catalog field would turn every pricing change into a merge conflict in
 * a security test, which teaches people to update the literal without reading
 * it — the exact habit this file exists to prevent.
 */

export const CANONICAL_PLANS = [
  "FREE",
  "PAYG",
  "PRO",
  "TEAM",
  "ENTERPRISE",
] as const;

export type CanonicalPlan = (typeof CANONICAL_PLANS)[number];

export type PlanContractRow = {
  /** Does the plan include the professional/collaboration surface tier? */
  professionalSurfaces: boolean;
  /** Cases & matters. */
  cases: boolean;
  /** Reports + verification packages. */
  reports: boolean;
  /** Intake links / submission requests. */
  intake: boolean;
  /** Reviewer operations + review queues. */
  reviewerOperations: boolean;
  /*
   * BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — `maxOwnedWorkspaces`
   * was REMOVED from the contract along with the catalog field it mirrors. No
   * plan sells additional workspaces: there is one Personal Workspace, and the
   * tiers are tiers OF it. The absence is asserted in `plan-matrix` so this
   * removal cannot be undone by a merge that quietly restores the field.
   */
  /** Members per collaboration team. */
  maxWorkspaceSeats: number;
  /** Lifetime evidence-record cap; null = uncapped. */
  lifetimeRecordCap: number | null;
  /** Rolling 30-day evidence-record cap; null = uncapped. */
  monthlyRecordCap: number | null;
  /** PAYG credits consumed per completion. */
  creditsPerCompletion: number;
  /** Enterprise governance feature block. */
  enterpriseFeatures: boolean;
};

/**
 * The contract. Read it as prose:
 *
 *   FREE        capture / evidence / verify / basic reads, 3 records, nothing
 *               collaborative, no Organization.
 *   PAYG        a PERSONAL commercial MODE: it buys operations (reports,
 *               packages, intake), never a collaboration workspace and never a
 *               recurring workspace plan.
 *   PRO         personal-professional: cases, intake and professional surfaces
 *               on the SAME Personal Workspace — but NOT reviewer operations.
 *
 *   WORKSPACE AND COLLABORATION ARCHITECTURE RECONCILIATION (2026-09-06) —
 *   `maxWorkspaceSeats` moved on three rows, by approved product decision,
 *   and this independent transcription follows the decision:
 *
 *     FREE / PAYG  0 -> 1. Zero seats described a workspace whose OWNER did
 *                  not occupy one, so "1 of 0 used" was the honest reading of
 *                  every free workspace. The owner counts as one seat; a free
 *                  workspace holds exactly its owner.
 *     TEAM         5 -> 10.
 *
 *   Nothing else in this table moved.
 *
 *   TEAM        the collaboration tier of that same Personal Workspace:
 *               reviewer operations and review queues on top of PRO. A tier,
 *               not a second workspace.
 *   ENTERPRISE  contract-governed: everything, plus the governance block
 *               (SSO/SCIM, MFA enforcement, access reviews, legal hold,
 *               retention, org audit logs, Object Lock).
 */
export const PLAN_CONTRACT: Record<CanonicalPlan, PlanContractRow> = {
  FREE: {
    professionalSurfaces: false,
    cases: false,
    reports: false,
    intake: false,
    reviewerOperations: false,
    maxWorkspaceSeats: 1,
    lifetimeRecordCap: 3,
    monthlyRecordCap: null,
    creditsPerCompletion: 0,
    enterpriseFeatures: false,
  },
  PAYG: {
    professionalSurfaces: false,
    cases: false,
    reports: true,
    intake: true,
    reviewerOperations: false,
    maxWorkspaceSeats: 1,
    lifetimeRecordCap: null,
    monthlyRecordCap: null,
    creditsPerCompletion: 1,
    enterpriseFeatures: false,
  },
  PRO: {
    professionalSurfaces: true,
    cases: true,
    reports: true,
    intake: true,
    reviewerOperations: false,
    maxWorkspaceSeats: 5,
    lifetimeRecordCap: 100,
    monthlyRecordCap: null,
    creditsPerCompletion: 0,
    enterpriseFeatures: false,
  },
  TEAM: {
    professionalSurfaces: true,
    cases: true,
    reports: true,
    intake: true,
    reviewerOperations: true,
    maxWorkspaceSeats: 10,
    lifetimeRecordCap: null,
    monthlyRecordCap: 500,
    creditsPerCompletion: 0,
    enterpriseFeatures: false,
  },
  ENTERPRISE: {
    professionalSurfaces: true,
    cases: true,
    reports: true,
    intake: true,
    reviewerOperations: true,
    maxWorkspaceSeats: 500,
    lifetimeRecordCap: null,
    monthlyRecordCap: null,
    creditsPerCompletion: 0,
    enterpriseFeatures: true,
  },
};

/**
 * Denial vocabulary the matrix asserts on.
 *
 * A denial that returns the wrong code is a product defect even when it denies
 * — the client renders remediation from the code, so "you are over your member
 * limit" and "your plan has no Teams" cannot be the same string.
 */
export const DENIAL_CODES = {
  planHasNoTeams: "TEAM_PLAN_REQUIRED",
  teamLimitReached: "TEAM_LIMIT_REACHED",
  // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — one code replaces
  // two. There used to be a "your plan includes none" refusal and a "you have
  // used them all" refusal; with no plan granting any, every account gets the
  // same answer for the same reason, and a second code would imply a quota
  // somebody could still be under.
  ownedWorkspaceCreationNotAllowed: "WORKSPACE_CREATION_NOT_SELF_SERVICE",
  // ARCH-001 (2026-08-07) — the code names the workspace SHAPE, not a kind
  // called "team" that has never existed. Old clients still receive the legacy
  // spelling through the bounded adapter in @proovra/shared.
  ownedWorkspaceLimitReached: "SHARED_WORKSPACE_LIMIT_REACHED",
  managedIdentityNoPersonalSpace: "MANAGED_IDENTITY_NO_PERSONAL_SPACE",
  orgPolicyNoPersonalSpace: "ORG_POLICY_NO_PERSONAL_SPACE",
  workspaceMembershipRequired: "workspace_membership_required",
} as const;
