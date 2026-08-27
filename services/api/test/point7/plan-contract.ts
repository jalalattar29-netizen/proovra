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
  /** Owned Workspaces this account may CREATE. 0 = the capability is absent. */
  maxOwnedWorkspaces: number;
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
 *               collaborative, no Owned Workspace, no Organization.
 *   PAYG        a PERSONAL commercial MODE: it buys operations (reports,
 *               packages, intake), never a collaboration workspace and never a
 *               recurring workspace plan. `maxOwnedWorkspaces: 0` is the whole
 *               "PAYG must not create an Owned or Organization Workspace"
 *               clause expressed as a number.
 *   PRO         personal-professional: cases, intake, professional surfaces,
 *               and up to two Owned Workspaces — but NOT reviewer operations.
 *   TEAM        the collaboration plan: reviewer operations and review queues
 *               on top of PRO, commercial state on the Workspace.
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
    maxOwnedWorkspaces: 0,
    maxWorkspaceSeats: 0,
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
    maxOwnedWorkspaces: 0,
    maxWorkspaceSeats: 0,
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
    maxOwnedWorkspaces: 2,
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
    maxOwnedWorkspaces: 5,
    maxWorkspaceSeats: 5,
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
    maxOwnedWorkspaces: 1000,
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
  ownedWorkspaceCreationNotAllowed: "TEAM_CREATION_NOT_ALLOWED",
  // ARCH-001 (2026-08-07) — the code names the workspace SHAPE, not a kind
  // called "team" that has never existed. Old clients still receive the legacy
  // spelling through the bounded adapter in @proovra/shared.
  ownedWorkspaceLimitReached: "SHARED_WORKSPACE_LIMIT_REACHED",
  managedIdentityNoPersonalSpace: "MANAGED_IDENTITY_NO_PERSONAL_SPACE",
  orgPolicyNoPersonalSpace: "ORG_POLICY_NO_PERSONAL_SPACE",
  workspaceMembershipRequired: "workspace_membership_required",
} as const;
