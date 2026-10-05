/**
 * PHASE 12 CORRECTIVE PASS §1 (ARCH-001 + LEGACY-001, 2026-08-07) — THE
 * COMMERCIAL SHAPE OF A WORKSPACE. NOT ITS TENANCY KIND.
 *
 * This type used to be `WorkspaceScopeType = "PERSONAL" | "TEAM"`, and those
 * two spellings were the whole problem. `PERSONAL` and `TEAM` READ like
 * container categories, sat next to a `TEAM` PLAN, and were consumed by
 * functions called `allowsTeamWorkspace` and errors called
 * `TEAM_WORKSPACE_LIMIT_REACHED` — so a reader had no way to tell whether
 * "TEAM" meant a kind of workspace, a plan, or a capability bundle. It meant
 * the second and third; there has never been a TEAM workspace KIND.
 *
 * The canonical tenancy vocabulary is `WorkspaceKind` (PERSONAL | OWNED |
 * ORGANIZATION) in @proovra/shared, and it lives in the database. What THIS
 * type expresses is the only thing billing actually needs to know:
 *
 *   SINGLE_OCCUPANT  one identity occupies it — a Personal Space. No seats to
 *                    sell, no members to invite.
 *   SHARED           more than one identity can occupy it — an Owned or an
 *                    Organization workspace. Seats and member limits apply.
 *
 * It is DERIVED from the canonical kind by `billingShapeForWorkspaceKind`, in
 * one place, and is never persisted, never authorizes, and never selects a
 * tenant.
 */
export type WorkspaceBillingShape = "SINGLE_OCCUPANT" | "SHARED";

/**
 * The plan catalogue. TEAM is a PLAN — a capability bundle bought for a
 * workspace — and never a workspace kind.
 */
export type PlanType = "FREE" | "PAYG" | "PRO" | "TEAM" | "ENTERPRISE";

/**
 * Enterprise-only feature flags. Enforced by
 * `assertEnterpriseFeature()` in services/api. A feature being `true`
 * on a non-Enterprise plan means the plan is allowed to use it; in
 * practice all of these stay `false` on FREE/PAYG/PRO/TEAM and `true`
 * on ENTERPRISE. Sales-provisioned entitlement overrides can set them
 * per-account via `Entitlement.featureOverrides` (future surface).
 */
export type EnterpriseFeatureFlags = {
  ssoScim: boolean;
  mfaEnforcement: boolean;
  accessReviews: boolean;
  sessionGovernance: boolean;
  legalHold: boolean;
  /**
   * DESTRUCTION GOVERNANCE — destruction reviews and forced lifecycle
   * transitions.
   *
   * Split out of `legalHold` (2026-09-07). Three routes in
   * `governance-lifecycle.routes.ts` — create a destruction review, decide
   * one, and force a lifecycle transition — were gated on the `legalHold`
   * flag. None of them places, reads or releases a legal hold. Borrowing the
   * name made it read as though this catalog were a second eligibility
   * authority for Legal Hold, competing with the `FEATURE_LEGAL_HOLD`
   * entitlement that actually governs `/v1/lifecycle/legal-holds`.
   *
   * The VALUE is deliberately identical to `legalHold` on every plan, so no
   * account gains or loses access to anything. Only the name of the question
   * changes.
   */
  destructionGovernance: boolean;
  retentionPolicy: boolean;
  organizationAuditLogs: boolean;
  objectLock: boolean;
};

export type PlanCapabilities = {
  plan: PlanType;
  displayName: string;
  /**
   * Which commercial shape this plan may be bought FOR. `BOTH` means the plan
   * is valid for a Personal Space and for a shared workspace alike.
   */
  billingShape: WorkspaceBillingShape | "BOTH";
  monthlyPriceCents: number | null;

  includedStorageBytes: bigint;
  includedSeats: number;

  reportsIncluded: boolean;
  verificationPackageIncluded: boolean;
  publicVerifyIncluded: boolean;

  /**
   * Operational-workflow commercial flags (Teams Entitlement Alignment
   * follow-up, 2026-07-15). These encode the EXACT published Pricing
   * comparison rows so the machine-readable capability table is the one
   * commercial source of truth for these features (previously the rows
   * existed only as pricing-page prose). Pricing rows, in plan order
   * FREE / PAYG / PRO / TEAM / ENTERPRISE:
   *   - "Intake links" + "Submission requests":
   *       Not included / Included / Included / Included / Included
   *   - "Cases & matters":
   *       Not included / Not included / Personal / Team / Org-wide
   *   - "Reviewer operations" + "Tasks & review queues":
   *       Not included / Not included / Not included / Team / Advanced
   */
  intakeIncluded: boolean;
  casesIncluded: boolean;
  reviewerOperationsIncluded: boolean;
  /**
   * PHASE 12B Track 1A — does this plan unlock the PROFESSIONAL surface
   * tier (professional Evidence/Case/Intake/Reports/Search/collaboration
   * product surfaces)? THE one commercial source for surface-tier
   * visibility; the frontend consumes the server projection of this flag
   * and never derives it from the plan name.
   */
  professionalSurfacesIncluded: boolean;
  reviewQueuesIncluded: boolean;

  /**
   * PLATFORM COMMERCIAL AUTHORITY CLOSURE (2026-09-07) — does this plan
   * include EXTERNAL REVIEW: controlled, bounded, time-limited access for
   * someone OUTSIDE the workspace to review named evidence, without that
   * person becoming a Workspace member or a Collaboration Team member?
   *
   * Approved commercial decision, in plan order:
   *   FREE / PAYG        not included
   *   PRO / TEAM         included
   *   ENTERPRISE         included
   *
   * THIS IS THE ONLY AUTHORITY. It replaces `FEATURE_EXTERNAL_PORTAL` in the
   * ProductLine packaging engine, which resolved the same question from a
   * grants table whose only writer was a manual operator route — so the
   * capability defaulted to false for every workspace that ever bought a
   * plan, and no purchase path could turn it on. Pricing sold it; nothing
   * granted it.
   *
   * Read it through `resolveEffectiveExternalReviewIncluded` so the
   * Enterprise-contract question is asked in exactly one place.
   */
  externalReviewIncluded: boolean;

  /**
   * Lifetime cap on evidence records. `null` = no lifetime cap (the
   * monthly cap may still apply). The enforcement guard checks this
   * via a non-deleted Evidence count on the workspace.
   */
  maxEvidenceRecords: number | null;

  /**
   * Rolling 30-day cap on evidence records. `null` = no monthly cap.
   * Enforced by counting `Evidence.createdAt >= now() - 30 days` on
   * the workspace. Pro is lifetime-capped (100, no monthly); Team is
   * monthly-capped (500, no lifetime).
   */
  maxEvidenceRecordsPerMonth: number | null;

  paygCreditsRequiredPerCompletion: number;

  /**
   * Calendar-month cap on AI assistance calls (chat messages +
   * capture analyses combined). `null` = custom (Enterprise). `0` =
   * AI disabled (FREE). Enforced by `AiCostGuard` against the
   * caller's resolved plan.
   */
  aiAdvisoryMonthlyOperations: number | null;

  /**
   * PHASE 12 — POINT 7 CORRECTIVE PASS (2026-08-05): renamed from
   * `allowsPersonalWorkspace`, which was one boolean serving two questions.
   *
   * IT ANSWERS: "may this plan be PURCHASED with a Personal Workspace as the
   * target?" TEAM says no — you buy
   * TEAM for a team, not for yourself.
   *
   * IT DOES NOT ANSWER: "may this identity HAVE a Personal Space?" That is
   * `resolvePersonalSpaceEligibility` in services/api — identity mode plus the
   * Organization's `noPersonalSpace` policy — and it is deliberately
   * plan-independent, because every authenticated user is bootstrapped a
   * Personal Team at first login regardless of what they pay.
   *
   * Under the old name the two readings were indistinguishable, and the
   * platform had already picked the wrong one twice: the structural assert
   * applied the purchase rule to scope RESOLUTION, so a TEAM-plan account's
   * own Personal Space threw — and both the API and the worker papered over it
   * by resolving that space at PRO, a plan the account does not hold. A TEAM
   * user keeps their Personal Space; only an explicit Organization policy can
   * take it away.
   */
  allowsPersonalWorkspacePurchase: boolean;
  /**
   * ARCH-001 — may this plan operate a SHARED workspace (Owned or
   * Organization)? Renamed from `allowsTeamWorkspace`, which read as a
   * statement about a workspace KIND called "team" that has never existed.
   */
  allowsSharedWorkspace: boolean;
  /*
   * AUDIT-001 (2026-08-15) — `teamWorkspaceRequired` was REMOVED from here.
   *
   * It was the exact inverse of `allowsPersonalWorkspacePurchase` on all five
   * plans, so it encoded one decision twice, and NOTHING in production read it
   * — the purchase rule is enforced by `allowsPersonalWorkspacePurchase` in
   * workspace.ts. Two fields for one fact in the canonical commercial registry
   * is a duplicate authority waiting for the day they disagree, and this one
   * additionally carried the retired "Team Workspace" vocabulary that ARCH-001
   * and LEGACY-001 removed everywhere else: TEAM is a PLAN, never a workspace
   * KIND. The rule it documented is unchanged and still enforced.
   */

  /**
   * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — `maxOwnedTeams` and
   * `maxMembersPerTeam` were REMOVED and replaced by the four explicit fields
   * below. Both old names were semantically overloaded, and each overload had
   * already produced a live defect.
   *
   * `maxOwnedTeams` was ONE integer enforced over TWO unrelated tables:
   *   - `teams.routes.ts`      counted `Team` rows      (Owned Workspaces)
   *   - `billing-guards.ts`    counted `CollaborationTeam` rows
   * so a PRO account actually received 2 Owned Workspaces AND 2 Collaboration
   * Teams — four things called "Teams" — while Pricing advertised "Up to 2"
   * and Billing rendered a usage line that compared a CollaborationTeam
   * membership count against the Owned-Workspace cap.
   *
   * `maxMembersPerTeam` was ONE integer serving the WORKSPACE seat ceiling
   * (`getEffectiveSeatLimit`, `computeOverSeatLimit`) and the COLLABORATION
   * TEAM accepted-member ceiling (`assertCollaborationTeamMemberLimit`). Two
   * different containers, two different membership tables, one number.
   *
   * Four questions, four fields. None is derived from another.
   */

  /*
   * BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — `maxOwnedWorkspaces`
   * was REMOVED from the commercial catalog.
   *
   * It answered "how many additional workspaces does this plan sell?", and in
   * the final model no self-service plan sells any. There is ONE Personal
   * Workspace per account, and FREE → PRO → TEAM are tiers OF that workspace,
   * not a licence to acquire more of them. A number that said 2 for PRO and 5
   * for TEAM was the clearest remaining statement of the opposite model, and
   * it was read straight onto the Pricing page.
   *
   * Nothing about additional workspaces is enforced commercially any more, so
   * the enforcement did not move to another field — it stopped being a
   * commercial question. `teams.routes.ts` now refuses self-service workspace
   * creation as a platform rule, for a reason no catalog integer could carry:
   * a workspace created there could never be paid for, since checkout has one
   * subject and it is the person. Multi-workspace tenancy remains real and is
   * created by Enterprise PROVISIONING against an Organization contract, which
   * never consulted this field.
   *
   * The two Collaboration-Team capacities below are unaffected: they were
   * separated from this field in 2026-08-27 precisely because they are a
   * different question about a different container.
   */

  /**
   * How many ACTIVE Collaboration Teams may exist INSIDE ONE WORKSPACE.
   * Enforced by `assertCanCreateCollaborationTeam` against the workspace the
   * team is being created in — not across every workspace the account owns.
   * A Collaboration Team is a grouping inside a workspace; it is never a
   * billing account, never a tenant, and owns no storage or subscription.
   */
  maxCollaborationTeamsPerWorkspace: number;

  /**
   * Hard cap on ACCEPTED members inside one Collaboration Team.
   * NOT an invite cap: pending invitations may exist above this number, but
   * accepting or adding a member must fail once the cap is reached.
   */
  maxAcceptedMembersPerCollaborationTeam: number;

  /**
   * Hard cap on ACCEPTED `TeamMember` seats inside one SHARED workspace
   * (Owned or Organization). Drives `getEffectiveSeatLimit` and the
   * `overSeatLimit` comparison. Always 0 for a SINGLE_OCCUPANT workspace —
   * a Personal Space has no seats to sell.
   */
  maxWorkspaceSeats: number;

  /**
   * PHASE 9 §9.6 (2026-07-22) — invitation abuse rails, folded from the
   * former parallel `COLLABORATION_TEAM_PLAN_LIMITS` table (packages/shared)
   * so ONE capability vocabulary carries every published Teams limit.
   * Operational abuse rails, not commercial promises.
   */
  maxPendingInvitesPerTeam: number;
  maxInvitesPer24h: number;

  /**
   * Enterprise governance features. On non-Enterprise plans every
   * flag is `false`. The API gate `assertEnterpriseFeature()` reads
   * this block to decide whether SSO/SCIM, MFA enforcement, legal
   * hold, retention policy, organization audit logs, and Object Lock
   * routes are reachable.
   */
  enterpriseFeatures: EnterpriseFeatureFlags;
};


const NO_ENTERPRISE_FEATURES: EnterpriseFeatureFlags = {
  ssoScim: false,
  mfaEnforcement: false,
  accessReviews: false,
  sessionGovernance: false,
  legalHold: false,
  destructionGovernance: false,
  retentionPolicy: false,
  organizationAuditLogs: false,
  objectLock: false,
};

const ALL_ENTERPRISE_FEATURES: EnterpriseFeatureFlags = {
  ssoScim: true,
  mfaEnforcement: true,
  accessReviews: true,
  sessionGovernance: true,
  legalHold: true,
  destructionGovernance: true,
  retentionPolicy: true,
  organizationAuditLogs: true,
  objectLock: true,
};

const MB = 1024n * 1024n;
const GB = 1024n * 1024n * 1024n;
const TB = 1024n * 1024n * 1024n * 1024n;

export const PLAN_CAPABILITIES: Record<PlanType, PlanCapabilities> = {
  FREE: {
    plan: "FREE",
    displayName: "Free",
    billingShape: "SINGLE_OCCUPANT",
    monthlyPriceCents: 0,
    includedStorageBytes: 250n * MB,
    includedSeats: 0,
    reportsIncluded: false,
    verificationPackageIncluded: false,
    publicVerifyIncluded: true,
    intakeIncluded: false,
    casesIncluded: false,
    reviewerOperationsIncluded: false,
    professionalSurfacesIncluded: false,
    reviewQueuesIncluded: false,
    externalReviewIncluded: false,
    maxEvidenceRecords: 3,
    maxEvidenceRecordsPerMonth: null,
    paygCreditsRequiredPerCompletion: 0,
    /*
     * FREE gets a LIMITED TRIAL of AI, not AI access.
     *
     * This was 0, which the enforcement layer reads as "the plan does not
     * include the capability" and refuses with AI_NOT_INCLUDED before any
     * usage exists. Ten operations a month makes the assistant something a
     * free account can actually try.
     *
     * ALLOWANCE IS NOT ENTITLEMENT. This number only says how many billable
     * operations a month the plan may spend. WHICH AI capabilities exist for a
     * workspace is decided separately by `WorkspaceAiPolicy` and the capability
     * registry — reviewer and case copilots default off, content intelligence
     * and semantic search default off, and the enterprise governance surfaces
     * need an organization workspace. Raising this opens none of them; it opens
     * the support assistant, capture assistance and evidence categorisation
     * that a personal workspace already carries.
     *
     * Deterministic product answers do not consume it: the chat route records a
     * monthly operation only for a real provider call
     * (`status === "ok" && !preflight`), so a free account's ten are spent on
     * inference, not on answers compiled into the build.
     */
    aiAdvisoryMonthlyOperations: 10,
    allowsPersonalWorkspacePurchase: true,
    allowsSharedWorkspace: false,
    maxCollaborationTeamsPerWorkspace: 0,
    maxAcceptedMembersPerCollaborationTeam: 0,
    maxWorkspaceSeats: 1,
    maxPendingInvitesPerTeam: 0,
    maxInvitesPer24h: 0,
    enterpriseFeatures: NO_ENTERPRISE_FEATURES,
  },

  /**
   * GRANDFATHER-RESOLUTION ROW ONLY (2026-08-27). NOT A SELLABLE PLAN.
   *
   * PAYG is now the evidence-credit WALLET (see `EVIDENCE_CREDIT_PRODUCT` at
   * the foot of this file), and no current write path assigns
   * `entitlements.plan = 'PAYG'`. This row exists so that any row already
   * carrying that value — from earlier code or the dev-only plan route —
   * still resolves to the entitlements it was granted, rather than silently
   * losing storage and AI it was told it had. Removing rights from an
   * existing account is not a refactor.
   *
   * Nothing may advertise these values: Pricing and Billing render
   * `EVIDENCE_CREDIT_PRODUCT`, never this row.
   */
  PAYG: {
    plan: "PAYG",
    displayName: "Pay-as-you-go (legacy)",
    billingShape: "SINGLE_OCCUPANT",
    monthlyPriceCents: 500,
    includedStorageBytes: 5n * GB,
    includedSeats: 0,
    reportsIncluded: true,
    verificationPackageIncluded: true,
    publicVerifyIncluded: true,
    intakeIncluded: true,
    casesIncluded: false,
    reviewerOperationsIncluded: false,
    professionalSurfacesIncluded: false,
    reviewQueuesIncluded: false,
    externalReviewIncluded: false,
    maxEvidenceRecords: null,
    maxEvidenceRecordsPerMonth: null,
    paygCreditsRequiredPerCompletion: 1,
    aiAdvisoryMonthlyOperations: 50,
    allowsPersonalWorkspacePurchase: true,
    allowsSharedWorkspace: false,
    maxCollaborationTeamsPerWorkspace: 0,
    maxAcceptedMembersPerCollaborationTeam: 0,
    maxWorkspaceSeats: 1,
    maxPendingInvitesPerTeam: 0,
    maxInvitesPer24h: 0,
    enterpriseFeatures: NO_ENTERPRISE_FEATURES,
  },

  PRO: {
    plan: "PRO",
    displayName: "Pro",
    billingShape: "SINGLE_OCCUPANT",
    monthlyPriceCents: 1900,
    includedStorageBytes: 100n * GB,
    includedSeats: 0,
    reportsIncluded: true,
    verificationPackageIncluded: true,
    publicVerifyIncluded: true,
    intakeIncluded: true,
    casesIncluded: true,
    reviewerOperationsIncluded: false,
    professionalSurfacesIncluded: true,
    reviewQueuesIncluded: false,
    externalReviewIncluded: true,
    maxEvidenceRecords: 100,
    maxEvidenceRecordsPerMonth: null,
    paygCreditsRequiredPerCompletion: 0,
    aiAdvisoryMonthlyOperations: 100,
    allowsPersonalWorkspacePurchase: true,
    allowsSharedWorkspace: true,
    maxCollaborationTeamsPerWorkspace: 2,
    maxAcceptedMembersPerCollaborationTeam: 5,
    maxWorkspaceSeats: 5,
    maxPendingInvitesPerTeam: 10,
    maxInvitesPer24h: 50,
    enterpriseFeatures: NO_ENTERPRISE_FEATURES,
  },

  TEAM: {
    plan: "TEAM",
    displayName: "Team",
    billingShape: "SHARED",
    monthlyPriceCents: 7900,
    includedStorageBytes: 500n * GB,
    includedSeats: 5,
    reportsIncluded: true,
    verificationPackageIncluded: true,
    publicVerifyIncluded: true,
    intakeIncluded: true,
    casesIncluded: true,
    reviewerOperationsIncluded: true,
    professionalSurfacesIncluded: true,
    reviewQueuesIncluded: true,
    externalReviewIncluded: true,
    maxEvidenceRecords: null,
    maxEvidenceRecordsPerMonth: 500,
    paygCreditsRequiredPerCompletion: 0,
    aiAdvisoryMonthlyOperations: 500,
    allowsPersonalWorkspacePurchase: true,
    allowsSharedWorkspace: true,
    maxCollaborationTeamsPerWorkspace: 5,
    maxAcceptedMembersPerCollaborationTeam: 10,
    maxWorkspaceSeats: 10,
    maxPendingInvitesPerTeam: 25,
    maxInvitesPer24h: 100,
    enterpriseFeatures: NO_ENTERPRISE_FEATURES,
  },

  ENTERPRISE: {
    plan: "ENTERPRISE",
    displayName: "Enterprise",
    billingShape: "BOTH",
    monthlyPriceCents: null,
    includedStorageBytes: 500n * GB,
    includedSeats: 5,
    reportsIncluded: true,
    verificationPackageIncluded: true,
    publicVerifyIncluded: true,
    intakeIncluded: true,
    casesIncluded: true,
    reviewerOperationsIncluded: true,
    professionalSurfacesIncluded: true,
    reviewQueuesIncluded: true,
    externalReviewIncluded: true,
    maxEvidenceRecords: null,
    maxEvidenceRecordsPerMonth: null,
    paygCreditsRequiredPerCompletion: 0,
    aiAdvisoryMonthlyOperations: null,
    allowsPersonalWorkspacePurchase: true,
    allowsSharedWorkspace: true,
    maxCollaborationTeamsPerWorkspace: 1000,
    maxAcceptedMembersPerCollaborationTeam: 500,
    maxWorkspaceSeats: 500,
    maxPendingInvitesPerTeam: 1000,
    maxInvitesPer24h: 5000,
    enterpriseFeatures: ALL_ENTERPRISE_FEATURES,
  },
};

export function getPlanCapabilities(plan: PlanType): PlanCapabilities {
  return PLAN_CAPABILITIES[plan] ?? PLAN_CAPABILITIES.FREE;
}

// =============================================================================
// PHASE 9 §9.4/§9.5 (2026-07-22) — CANONICAL PURE COMMERCIAL POLICY.
// The effective-plan and subscription-active DECISIONS for the
// OWNED_WORKSPACE subject live HERE (the one shared pure policy package);
// services/api/workspace-billing is an input ADAPTER that loads persisted
// fields and delegates to these functions. No service may re-derive them.
// =============================================================================

/** Persisted workspace billing lifecycle vocabulary (Team.billingStatus). */
export type WorkspaceBillingStatus =
  | "ACTIVE"
  | "PAST_DUE"
  | "CANCELED"
  | "INACTIVE";

/**
 * THE one rule for "this workspace has an active paid workspace
 * subscription" (previously `isPaidTeamSubscriptionActive` inside
 * services/api/workspace-billing — MOVED here, single implementation).
 * PAST_DUE remains eligible at this layer; the bounded grace clock is
 * enforced by the canonical lifecycle policy in resolveCommercialContext.
 */
export function isWorkspaceSubscriptionActive(input: {
  billingPlan: PlanType;
  billingStatus: WorkspaceBillingStatus;
}): boolean {
  return (
    input.billingPlan === "TEAM" &&
    (input.billingStatus === "ACTIVE" || input.billingStatus === "PAST_DUE")
  );
}

/**
 * TENANT-CLASSIFICATION BOUNDARY (corrected 2026-07-22): WorkspaceKind is a
 * DOMAIN fact — its single normalization implementation lives in the general
 * domain package (`@proovra/shared`, `normalizeWorkspaceKind`), NOT here.
 * This billing package RECEIVES an explicit kind and never infers
 * PERSONAL/OWNED/ORGANIZATION from plan, owner or commercial fields. The
 * union below is a structural input type only (no logic, no dependency).
 */
export type NormalizedWorkspaceKind =
  | "PERSONAL"
  | "OWNED"
  | "ORGANIZATION"
  | "UNKNOWN";

/** Where an effective plan came from — reported beside the plan, always. */
export type EffectivePlanSource =
  | "PERSONAL_ENTITLEMENT"
  | "INTERNAL_GRANT"
  | "WORKSPACE_SUBSCRIPTION"
  | "ORGANIZATION_CONTRACT"
  | "LEGACY_AMBIGUOUS_FAIL_CLOSED"
  | "NONE";

/** Commercial order of the plans: a higher rank never resolves below a lower one. */
export const PLAN_RANK: Readonly<Record<PlanType, number>> = Object.freeze({
  FREE: 0,
  PAYG: 1,
  PRO: 2,
  TEAM: 3,
  ENTERPRISE: 4,
});

/**
 * INTERNAL PLAN GRANT — the PERSONAL subject's plan: the HIGHER of what the
 * providers established (Entitlement.plan, written only by provider lifecycle)
 * and an active, unexpired internal grant. A grant never lowers a provider
 * plan, and on a tie the provider governs (the grant adds nothing), so the
 * source says INTERNAL_GRANT only when the grant is what lifts the account.
 */
export function resolvePersonalEffectivePlan(input: {
  providerPlan: PlanType;
  internalGrantPlan: PlanType | null;
}): { plan: PlanType; source: "PERSONAL_ENTITLEMENT" | "INTERNAL_GRANT" } {
  const grant = input.internalGrantPlan;
  if (grant !== null && PLAN_RANK[grant] > PLAN_RANK[input.providerPlan]) {
    return { plan: grant, source: "INTERNAL_GRANT" };
  }
  return { plan: input.providerPlan, source: "PERSONAL_ENTITLEMENT" };
}

/**
 * THE one workspace effective-plan decision — SUBJECT-CORRECT (§9.4
 * corrected 2026-07-22; owner-coverage REMOVED).
 *
 * LOCKED SEMANTICS:
 *   PERSONAL workspace  → the PERSONAL_ACCOUNT subject governs: the owner's
 *                         entitlement plan (this is the personal space — the
 *                         only place ownerPlan participates).
 *   OWNED workspace     → ONLY the workspace's OWN commercial state:
 *                         live TEAM subscription → TEAM; a raw ENTERPRISE
 *                         plan string on an OWNED row is LEGACY AMBIGUITY →
 *                         FAIL CLOSED (FREE + reason); otherwise FREE.
 *                         The owner's Personal plan NEVER covers an existing
 *                         Owned Workspace. Legacy rows only: nothing creates
 *                         a self-service Owned Workspace any more.
 *   ORGANIZATION        → the parent CUSTOMER Organization's contract
 *                         coverage, represented by the provisioned
 *                         ENTERPRISE workspace billing; any other live plan
 *                         resolves as-is; inactive → FREE (fail closed).
 *   UNKNOWN             → FAIL CLOSED (FREE).
 */
export function resolveWorkspaceEffectivePlan(input: {
  workspaceKind: NormalizedWorkspaceKind;
  billingPlan: PlanType;
  billingStatus: WorkspaceBillingStatus;
  /** Used ONLY when workspaceKind === "PERSONAL" (personal-space subject). */
  ownerPlan: PlanType;
  /**
   * The owner's ACTIVE, UNEXPIRED internal plan grant (PlanGrant), or null.
   * Like ownerPlan it governs ONLY the PERSONAL subject: a personal grant no
   * more covers an Owned / Organization workspace than a personal plan does.
   */
  internalGrantPlan?: PlanType | null;
}): {
  plan: PlanType;
  source: EffectivePlanSource;
} {
  const live =
    input.billingStatus === "ACTIVE" || input.billingStatus === "PAST_DUE";

  switch (input.workspaceKind) {
    case "PERSONAL":
      return resolvePersonalEffectivePlan({
        providerPlan: input.ownerPlan,
        internalGrantPlan: input.internalGrantPlan ?? null,
      });
    case "OWNED": {
      if (live && input.billingPlan === "TEAM") {
        return { plan: "TEAM", source: "WORKSPACE_SUBSCRIPTION" };
      }
      if (input.billingPlan === "ENTERPRISE") {
        // OWNED + ENTERPRISE plan string is not valid Enterprise coverage —
        // Enterprise applies only to ORGANIZATION workspaces under a
        // CUSTOMER org contract. Legacy rows fail closed pending the
        // deterministic report/backfill (authored, never auto-trusted).
        return { plan: "FREE", source: "LEGACY_AMBIGUOUS_FAIL_CLOSED" };
      }
      return { plan: "FREE", source: "NONE" };
    }
    case "ORGANIZATION": {
      if (live && input.billingPlan === "ENTERPRISE") {
        return { plan: "ENTERPRISE", source: "ORGANIZATION_CONTRACT" };
      }
      if (live && input.billingPlan === "TEAM") {
        return { plan: "TEAM", source: "WORKSPACE_SUBSCRIPTION" };
      }
      return { plan: "FREE", source: "NONE" };
    }
    case "UNKNOWN":
      return { plan: "FREE", source: "NONE" };
  }
}

// =============================================================================
// BILLING COMMERCIAL CORRECTNESS (2026-08-27) — the "collaboration-team limits
// adapter" (`CollaborationTeamPlanLimits`, `COLLABORATION_TEAM_PLAN_LIMITS`,
// `getCollaborationTeamPlanLimits`) was DELETED here.
//
// It carried its own removal note ("TEMPORARY ADAPTER … Phase 12 target: delete
// this block") and it was the vehicle through which the `maxOwnedTeams`
// overload reached the Collaboration Team surface: it projected the
// OWNED-WORKSPACE cap into a field called `maxTeams` that
// `assertCanCreateCollaborationTeam` then enforced over `CollaborationTeam`
// rows. Its only consumer (`collaboration-team/billing-guards.ts`) now reads
// the explicit `maxCollaborationTeamsPerWorkspace` /
// `maxAcceptedMembersPerCollaborationTeam` fields from `PlanCapabilities`
// directly, so there is one name per question and no projection in between.
// =============================================================================

export function getPlanStorageLimitBytes(plan: PlanType): bigint {
  return getPlanCapabilities(plan).includedStorageBytes;
}

export function getPlanSeatLimit(plan: PlanType): number {
  return getPlanCapabilities(plan).includedSeats;
}

/**
 * ARCH-001 — may this plan operate a SHARED workspace?
 *
 * Renamed from `canPlanOperateSharedWorkspace`, which invited the reading "can this plan use
 * the Teams feature" and was in fact answering "may a workspace on this plan
 * have more than one occupant". The old name is kept as a deprecated alias
 * below so no call site had to be touched blind; the gate forbids new uses.
 */
export function canPlanOperateSharedWorkspace(plan: PlanType): boolean {
  return getPlanCapabilities(plan).allowsSharedWorkspace;
}

export function canPlanPurchasePersonalWorkspacePlan(plan: PlanType): boolean {
  return getPlanCapabilities(plan).allowsPersonalWorkspacePurchase;
}

export function canPlanGenerateReports(plan: PlanType): boolean {
  return getPlanCapabilities(plan).reportsIncluded;
}

export function canPlanGenerateVerificationPackage(plan: PlanType): boolean {
  return getPlanCapabilities(plan).verificationPackageIncluded;
}

export function planHasEnterpriseFeature(
  plan: PlanType,
  feature: keyof EnterpriseFeatureFlags,
): boolean {
  return getPlanCapabilities(plan).enterpriseFeatures[feature];
}

export function formatBytesHuman(bytes: bigint): string {
  const trim = (n: number): string => {
    if (Number.isFinite(n) && Math.abs(n - Math.round(n)) < 0.005) {
      return String(Math.round(n));
    }
    return n.toFixed(2).replace(/\.?0+$/, "");
  };
  if (bytes >= TB) return `${trim(Number(bytes) / Number(TB))} TB`;
  if (bytes >= GB) return `${trim(Number(bytes) / Number(GB))} GB`;
  if (bytes >= MB) return `${trim(Number(bytes) / Number(MB))} MB`;
  if (bytes >= 1024n) return `${trim(Number(bytes) / 1024)} KB`;
  return `${bytes} B`;
}

// =============================================================================
// BILLING COMMERCIAL CORRECTNESS (2026-08-27) — `projectPlan` and
// `getPricingCatalogResponse` were DELETED here, together with the
// `EnterprisePricingCatalog` type they alone used.
//
// They were a SECOND pricing-catalog projection carrying a second hard-coded
// copy of the Enterprise marketing block, byte-for-byte duplicating
// `buildPricingCatalogResponse` in services/api. A repo-wide search proved
// zero call sites: `plan-catalog.service.ts` re-exported the symbol and
// nothing ever invoked it. The served catalog has exactly one producer.
// =============================================================================

// =============================================================================
// BILLING COMMERCIAL CORRECTNESS (2026-08-27) — THE EVIDENCE-CREDIT PRODUCT.
//
// The defect this replaces
// ---------------------------------------------------------------------------
// `PLAN_CAPABILITIES.PAYG` described a PLAN — 5 GB of storage, 50 AI
// operations a month, intake, reports — but no production code path ever set
// `Entitlement.plan = 'PAYG'`. The only writer was `setPersonalPlan` reached
// from `POST /v1/billing/plan`, a route registered exclusively behind
// `devAuthEnabled()`. Stripe PAYG checkout runs in `mode: "payment"` and
// PayPal PAYG creates an ORDER, so neither produces a subscription event, and
// `syncPlanForSubscription` — the one production writer of a personal plan —
// is only reached from subscription events.
//
// A real buyer therefore received `addCredits(userId, 1)` and stayed on FREE.
// On FREE, `paygCreditsRequiredPerCompletion` is 0, so the credit-spend branch
// in `assertWorkspaceAllowsEvidenceCreation` was unreachable: at 3 records the
// buyer was refused with `FREE_LIMIT_REACHED` while holding paid, unspendable
// credits. The 5 GB and the 50 AI operations were never reachable either.
//
// What replaces it
// ---------------------------------------------------------------------------
// PAYG is not a plan. It is a CREDIT WALLET layered over the Personal FREE
// account, and this descriptor is the whole product: a price, a credit grant,
// and the outputs a credit-funded completion earns. There is deliberately no
// storage and no AI allowance here, because a one-time payment cannot fund a
// perpetual monthly entitlement — that is the promise the old row made and
// could not keep.
//
// `PLAN_CAPABILITIES.PAYG` is RETAINED, but strictly as a resolution row for
// grandfathered `entitlements.plan = 'PAYG'` rows that may exist from earlier
// code. It is never sold, never advertised, and never assigned by any current
// write path.
// =============================================================================

/**
 * How a single Evidence record's completion was funded.
 *
 *   PLAN             the workspace's own plan allowance covered it (the FREE
 *                    lifetime allowance, PRO's lifetime cap, TEAM's rolling
 *                    30-day cap, or an Enterprise contract).
 *   EVIDENCE_CREDIT  a purchased evidence credit was consumed for it.
 */
export type EvidenceFundingSource = "PLAN" | "EVIDENCE_CREDIT";

/** The purchasable evidence-credit product. One SKU, one grant. */
export type EvidenceCreditProduct = {
  /** Stable product key. Not a `PlanType`; a credit pack is not a plan. */
  productKey: "EVIDENCE_CREDIT";
  displayName: string;
  /** Credits granted per successful purchase of one unit. */
  creditsGrantedPerPurchase: number;
  /** Credits burned by one credit-funded Evidence completion. */
  creditsPerCompletion: number;
  /** List price per unit, in minor units. Currency comes from the server. */
  unitPriceCents: number;
  /** Credits do not expire. Stated explicitly so nothing has to infer it. */
  creditsExpire: false;
};

export const EVIDENCE_CREDIT_PRODUCT: EvidenceCreditProduct = {
  productKey: "EVIDENCE_CREDIT",
  displayName: "Evidence credit",
  creditsGrantedPerPurchase: 1,
  creditsPerCompletion: 1,
  unitPriceCents: 500,
  creditsExpire: false,
};

/**
 * The outputs one Evidence record earns, resolved from the plan that governs
 * its workspace AND how that record's completion was funded.
 *
 * THE ONE RULE THAT MATTERS: a credit-funded completion is a PAID Evidence
 * operation, so it earns the paid outputs — report, verification package and
 * public verification — even though the account's recurring plan is FREE. The
 * entitlement is attached to the RECORD, not to the account, which is exactly
 * why buying one credit does not turn a FREE account into a PRO subscription.
 */
export function resolveEvidenceOutputEntitlements(input: {
  plan: PlanType;
  funding: EvidenceFundingSource;
}): {
  reportsIncluded: boolean;
  verificationPackageIncluded: boolean;
  publicVerifyIncluded: boolean;
} {
  const caps = getPlanCapabilities(input.plan);

  if (input.funding === "EVIDENCE_CREDIT") {
    return {
      reportsIncluded: true,
      verificationPackageIncluded: true,
      // Public verification is plan-independent everywhere it is offered; a
      // paid record is never the one that loses it.
      publicVerifyIncluded: true,
    };
  }

  return {
    reportsIncluded: caps.reportsIncluded,
    verificationPackageIncluded: caps.verificationPackageIncluded,
    publicVerifyIncluded: caps.publicVerifyIncluded,
  };
}

/**
 * ===========================================================================
 * EVIDENCE OUTPUT ISSUANCE — THE ONE DECISION (2026-09-29)
 * ===========================================================================
 *
 * `resolveEvidenceOutputEntitlements` answers what a PLAN includes. Whether a
 * report or package may be ISSUED right now also depends on the subscription's
 * commercial lifecycle (active, trial, past due, cancelled) and on whether that
 * lifecycle could be read at all. Every producer — finalization, the
 * first-issuance reconciliation, recovery, Operations, the worker gates — asks
 * this function, with the same inputs, and gets the same answer.
 *
 * POLICY (documented in docs/architecture/evidence-output-lifecycle-2026-09-29.md):
 *
 *   funding EVIDENCE_CREDIT      ENTITLED   — the record itself was paid for.
 *   plan excludes outputs (FREE) NOT_ENTITLED FREE_PLAN — original evidence is
 *                                            finalized and verifiable; no PDF
 *                                            or package is issued.
 *   lifecycle not resolvable     UNRESOLVED — issue nothing, grant nothing;
 *                                            retry later. Never read as FREE,
 *                                            never read as paid.
 *   ACTIVE, provider ACTIVE /
 *     authoritative plan /
 *     cancelled before period end ENTITLED PAID_SUBSCRIPTION — the only basis
 *                                            that schedules FIRST ISSUANCE for
 *                                            records finalized before it.
 *   ACTIVE, provider TRIALING    ENTITLED TRIAL — new records get outputs as
 *                                            they always have; historical
 *                                            records wait for a confirmed
 *                                            payment.
 *   GRACE (past due, in grace)   ENTITLED PAYMENT_GRACE — same as trial:
 *                                            no historical first issuance
 *                                            while payment is failing.
 *   PAST_DUE_EXPIRED             NOT_ENTITLED PAYMENT_LAPSED
 *   CANCELLED                    NOT_ENTITLED SUBSCRIPTION_ENDED
 *
 * A pending checkout, an approval page or a client callback never changes the
 * inputs: only the server-side subscription/entitlement rows do. Refunds and
 * disputes are recorded as billing review items and do not change entitlement
 * until the provider ends the subscription.
 *
 * Losing entitlement never deletes or relabels an issued artifact; it only
 * stops NEW issuance (and download access follows the paid-access policy).
 */
export const OUTPUT_ISSUANCE_DECISIONS = [
  "ENTITLED",
  "NOT_ENTITLED",
  "UNRESOLVED",
] as const;
export type OutputIssuanceDecision = (typeof OUTPUT_ISSUANCE_DECISIONS)[number];

export const OUTPUT_ISSUANCE_BASES = [
  "EVIDENCE_CREDIT",
  "PAID_SUBSCRIPTION",
  "TRIAL",
  "PAYMENT_GRACE",
  "FREE_PLAN",
  "PAYMENT_LAPSED",
  "SUBSCRIPTION_ENDED",
  /**
   * ET-COM-04 — the record was finalized while its subject was entitled, and
   * that fact was stored on the record. A later lapse does not revoke it.
   */
  "EARNED_AT_FINALIZATION",
  "UNKNOWN",
] as const;
export type OutputIssuanceBasis = (typeof OUTPUT_ISSUANCE_BASES)[number];

/** The commercial lifecycle as the resolver reads it; `null` = could not be read. */
export type OutputIssuanceLifecycle = {
  state: "ACTIVE" | "GRACE" | "PAST_DUE_EXPIRED" | "CANCELLED" | "INACTIVE";
  providerStatus: "ACTIVE" | "TRIALING" | "PAST_DUE" | "CANCELED" | null;
} | null;

export type OutputIssuanceEntitlement = {
  decision: OutputIssuanceDecision;
  basis: OutputIssuanceBasis;
  reportsIncluded: boolean;
  verificationPackageIncluded: boolean;
  /**
   * May the reconciliation schedule the FIRST report/package for a record that
   * was finalized before this entitlement existed? Only a confirmed paid
   * subscription (or a credit-funded record) does that.
   */
  mayIssueHistoricalFirstOutputs: boolean;
};

/**
 * THE STORED FUNDING FACT (ET-COM-04, owner decision 2026-09-30).
 *
 * What a record EARNED when it was finalized: the plan that funded it and the
 * basis on which that plan was in force. It is written once, inside the
 * completion transaction, and only when the decision at that moment was
 * ENTITLED on a plan basis (a credit-funded record's fact is its ledger row).
 *
 * A billing lapse is not a revocation: outputs a record earned while the plan
 * was paid stay owed to it — a report job queued before the lapse still runs,
 * and a lost one is still recovered — whatever the subscription does later.
 * `null` = no fact stored (every record finalized before this existed, and
 * every record finalized while not entitled); the current lifecycle then
 * decides, exactly as before.
 */
export const OUTPUT_EARNED_BASES = ["PAID_SUBSCRIPTION", "TRIAL", "PAYMENT_GRACE"] as const;
export type OutputEarnedBasis = (typeof OUTPUT_EARNED_BASES)[number];
export type OutputEarnedFact = { plan: PlanType; basis: OutputEarnedBasis } | null;

/** Parse the stored columns; anything not written by the completion path is no fact. */
export function readOutputEarnedFact(row: {
  outputEarnedPlan?: string | null;
  outputEarnedBasis?: string | null;
} | null | undefined): OutputEarnedFact {
  const basis = row?.outputEarnedBasis;
  const plan = row?.outputEarnedPlan;
  if (!plan || !basis) return null;
  if (!(OUTPUT_EARNED_BASES as readonly string[]).includes(basis)) return null;
  return { plan: plan as PlanType, basis: basis as OutputEarnedBasis };
}

/**
 * The fact to STORE for a record being finalized, from the decision taken at
 * that moment. `null` when nothing plan-based was earned.
 */
export function outputEarnedFactFromDecision(input: {
  plan: PlanType;
  decision: OutputIssuanceEntitlement;
}): OutputEarnedFact {
  if (input.decision.decision !== "ENTITLED") return null;
  const basis = input.decision.basis;
  if (!(OUTPUT_EARNED_BASES as readonly string[]).includes(basis)) return null;
  return { plan: input.plan, basis: basis as OutputEarnedBasis };
}

export function resolveOutputIssuanceEntitlement(input: {
  plan: PlanType | null;
  funding: EvidenceFundingSource | null;
  lifecycle: OutputIssuanceLifecycle;
  /** The stored funding fact, when the record has one. */
  earned?: OutputEarnedFact;
}): OutputIssuanceEntitlement {
  if (input.funding === "EVIDENCE_CREDIT") {
    return {
      decision: "ENTITLED",
      basis: "EVIDENCE_CREDIT",
      reportsIncluded: true,
      verificationPackageIncluded: true,
      mayIssueHistoricalFirstOutputs: true,
    };
  }
  if (input.earned) {
    const earnedOutputs = resolveEvidenceOutputEntitlements({
      plan: input.earned.plan,
      funding: "PLAN",
    });
    if (earnedOutputs.reportsIncluded || earnedOutputs.verificationPackageIncluded) {
      return {
        decision: "ENTITLED",
        basis: "EARNED_AT_FINALIZATION",
        reportsIncluded: earnedOutputs.reportsIncluded,
        verificationPackageIncluded: earnedOutputs.verificationPackageIncluded,
        // The first issuance was owed at finalization; recovering it is not
        // a historical backfill.
        mayIssueHistoricalFirstOutputs: true,
      };
    }
  }
  if (input.plan === null || input.funding === null) {
    return unresolvedIssuance();
  }
  const outputs = resolveEvidenceOutputEntitlements({
    plan: input.plan,
    funding: input.funding,
  });
  if (!outputs.reportsIncluded && !outputs.verificationPackageIncluded) {
    return {
      decision: "NOT_ENTITLED",
      basis: "FREE_PLAN",
      reportsIncluded: false,
      verificationPackageIncluded: false,
      mayIssueHistoricalFirstOutputs: false,
    };
  }
  const lifecycle = input.lifecycle;
  if (!lifecycle) return unresolvedIssuance();

  const granted = (basis: OutputIssuanceBasis, historical: boolean): OutputIssuanceEntitlement => ({
    decision: "ENTITLED",
    basis,
    reportsIncluded: outputs.reportsIncluded,
    verificationPackageIncluded: outputs.verificationPackageIncluded,
    mayIssueHistoricalFirstOutputs: historical,
  });
  const denied = (basis: OutputIssuanceBasis): OutputIssuanceEntitlement => ({
    decision: "NOT_ENTITLED",
    basis,
    reportsIncluded: false,
    verificationPackageIncluded: false,
    mayIssueHistoricalFirstOutputs: false,
  });

  switch (lifecycle.state) {
    case "ACTIVE":
      return lifecycle.providerStatus === "TRIALING"
        ? granted("TRIAL", false)
        : granted("PAID_SUBSCRIPTION", true);
    case "GRACE":
      return granted("PAYMENT_GRACE", false);
    case "PAST_DUE_EXPIRED":
      return denied("PAYMENT_LAPSED");
    case "CANCELLED":
      return denied("SUBSCRIPTION_ENDED");
    case "INACTIVE":
      // A paid plan with an INACTIVE lifecycle is a contradiction in the
      // inputs; it is not evidence of payment.
      return unresolvedIssuance();
  }
}

function unresolvedIssuance(): OutputIssuanceEntitlement {
  return {
    decision: "UNRESOLVED",
    basis: "UNKNOWN",
    reportsIncluded: false,
    verificationPackageIncluded: false,
    mayIssueHistoricalFirstOutputs: false,
  };
}

/**
 * THE PLAN THAT GOVERNS EVIDENCE CREATION (ET-COM-04, owner decision 2026-09-30).
 *
 * A billing lapse is not an account-security suspension. A paid personal
 * account whose subscription has lapsed (past due beyond grace, ended, or
 * ambiguous) used to be refused EVERY new record with 402 — worse than FREE,
 * and unable to spend credits it had bought. It now falls back to the
 * FREE-equivalent creation policy: the FREE allowance funds included records,
 * and a purchased credit funds one past it.
 *
 * A SHARED workspace has no FREE-equivalent: FREE does not include a shared
 * workspace at all, so a lapsed shared workspace still cannot record — that is
 * the plan rule, stated as such, not a lockout.
 *
 * This decides only which plan's CREATION policy applies. It never changes the
 * account's plan, and organization suspension / compliance locks are separate
 * authorities that this function knows nothing about and cannot loosen.
 */
export function resolveEvidenceCreationPlan(input: {
  plan: PlanType;
  billingShape: "SINGLE_OCCUPANT" | "SHARED";
  /** `mutationsAllowed` of the commercial lifecycle; undefined = not lapsed. */
  lifecycleAllowsPaidMutations: boolean | undefined;
}):
  | { lapsed: false; creationPlan: PlanType }
  | { lapsed: true; creationPlan: "FREE"; lapsedPlan: PlanType }
  | { lapsed: true; creationPlan: null; lapsedPlan: PlanType } {
  if (input.lifecycleAllowsPaidMutations !== false || input.plan === "FREE") {
    return { lapsed: false, creationPlan: input.plan };
  }
  if (input.billingShape === "SINGLE_OCCUPANT") {
    return { lapsed: true, creationPlan: "FREE", lapsedPlan: input.plan };
  }
  return { lapsed: true, creationPlan: null, lapsedPlan: input.plan };
}

/**
 * THE INTAKE ENTITLEMENT DECISION — plan OR a funded credit wallet.
 *
 * ---------------------------------------------------------------------------
 * THE CONTRADICTION THIS CLOSES (2026-09-08)
 * ---------------------------------------------------------------------------
 * Pricing sells "Intake links" as part of Pay-per-evidence. A real evidence-
 * credit buyer is on the FREE plan — that is the whole design of
 * `EVIDENCE_CREDIT_PRODUCT`, and the retired `PLAN_CAPABILITIES.PAYG` row is
 * explicitly never assigned — and FREE has `intakeIncluded: false`. So the
 * gate refused `409 INTAKE_NOT_INCLUDED` to exactly the customers the row was
 * sold to, and the only thing that could have granted it was a plan nothing
 * writes.
 *
 * The rule, once:
 *
 *   the plan includes intake
 *   OR the subject holds at least one unspent evidence credit.
 *
 * WHY A BALANCE AND NOT A PURCHASE HISTORY. Intake exists to COLLECT evidence,
 * and on this account evidence is funded per record. A wallet with nothing in
 * it cannot fund a submission, so a link that could still be used would be a
 * collection surface with no way to complete what it collects. The balance is
 * the honest gate, and it moves the customer to the one action that fixes it.
 *
 * WHAT THIS DOES NOT DO. It does not make a submission free: an intake
 * submission reaches `resolvePersonalEvidenceAdmission` and settles its credit
 * at completion like every other record. Intake is the door; the wallet still
 * pays for what comes through it.
 *
 * SHARED workspaces are unaffected. A member's personal wallet never funds a
 * shared workspace (`WorkspaceScope.credits` is 0 for them by construction),
 * so the credit arm cannot open intake on a workspace nobody is paying for.
 */
export function resolveWorkspaceIntakeEntitlement(input: {
  plan: PlanType;
  billingShape: WorkspaceBillingShape;
  /** Unspent purchased evidence credits on the subject's wallet. */
  availableEvidenceCredits: number;
}): { intakeIncluded: boolean; source: "PLAN" | "EVIDENCE_CREDIT" | "NONE" } {
  if (getPlanCapabilities(input.plan).intakeIncluded) {
    return { intakeIncluded: true, source: "PLAN" };
  }
  if (
    input.billingShape === "SINGLE_OCCUPANT" &&
    input.availableEvidenceCredits >= EVIDENCE_CREDIT_PRODUCT.creditsPerCompletion
  ) {
    return { intakeIncluded: true, source: "EVIDENCE_CREDIT" };
  }
  return { intakeIncluded: false, source: "NONE" };
}

/**
 * ============================================================================
 * FINAL COMMERCIAL RESIDUAL CLOSURE (2026-09-16) — THE STORAGE ADD-ON
 * ENTITLEMENT.
 * ============================================================================
 * "May this subject buy additional storage?" — one decision, in the one pure
 * commercial policy package.
 *
 * FREE storage is now explicit Product policy: every normal FREE personal
 * account may buy the supported personal storage add-ons. That increases bytes
 * only. It does not change the plan, grant evidence credits, raise evidence
 * record capacity, or make ordinary FREE records eligible for reports/packages.
 *
 * ENTERPRISE is deliberately absent from the plan arm: an Organization's
 * capacity is a term of its contract, never a self-service purchase.
 */
export function resolveStorageAddonEntitlement(input: {
  plan: PlanType;
}): {
  storageAddonsPurchasable: boolean;
  source: "PLAN" | "FREE_STORAGE" | "NONE";
} {
  if (input.plan === "FREE") {
    return { storageAddonsPurchasable: true, source: "FREE_STORAGE" };
  }

  if (
    input.plan === "PRO" ||
    input.plan === "TEAM" ||
    /*
     * The grandfathered credit-overlay row. It is never sold and never
     * assigned by any current write path, but rows carrying it may exist from
     * earlier code, and those accounts have always been offered two storage
     * add-ons. Removing a right from an existing account is not a refactor, and
     * the pre-ledger PAYG buyers this row exists for may have no credit-grant
     * entry to qualify them through the arm below.
     */
    input.plan === "PAYG"
  ) {
    return { storageAddonsPurchasable: true, source: "PLAN" };
  }
  /*
   * ENTERPRISE is stated as its own branch rather than folded into the final
   * denial so the reason is legible: an Organization's capacity comes from its
   * contract, and the absence of a self-service option there is a decision,
   * not a gap.
   */
  if (input.plan === "ENTERPRISE") {
    return { storageAddonsPurchasable: false, source: "NONE" };
  }
  return { storageAddonsPurchasable: false, source: "NONE" };
}

/**
 * THE evidence-creation admission decision for a SINGLE_OCCUPANT (personal)
 * subject, stated once as pure policy so the API gate and any other consumer
 * cannot drift.
 *
 * Consumption order is fixed and deterministic:
 *   1. spend the remaining PLAN allowance;
 *   2. only then spend ONE purchased credit.
 *
 * The returned `funding` is what the caller must record when — and only when —
 * the completion actually succeeds. This function decides admission; it never
 * mutates a balance.
 */
export function resolvePersonalEvidenceAdmission(input: {
  plan: PlanType;
  /** Non-destroyed evidence records already held by the personal subject. */
  currentRecordCount: number;
  /**
   * Effective lifetime cap after the canonical envelope has applied any
   * grandfather override. `null` = no lifetime cap on this plan.
   */
  effectiveLifetimeRecordCap: number | null;
  /** Unspent purchased evidence credits on the account's wallet. */
  availableEvidenceCredits: number;
}):
  | { allowed: true; funding: EvidenceFundingSource }
  | {
      allowed: false;
      /**
       * CREDIT_REQUIRED_NONE_AVAILABLE — this plan grants no free allowance at
       * all, so the denial is purely "you are out of credits" (402).
       * PLAN_ALLOWANCE_EXHAUSTED_NO_CREDITS — the plan's included allowance ran
       * out and no credit is banked to continue past it (409).
       */
      reason:
        | "PLAN_ALLOWANCE_EXHAUSTED_NO_CREDITS"
        | "CREDIT_REQUIRED_NONE_AVAILABLE";
    } {
  /**
   * GRANDFATHERED PAYG-PLAN ROWS. `paygCreditsRequiredPerCompletion > 0` means
   * this plan grants NO free record allowance at all — every completion costs a
   * credit. Only the legacy PAYG resolution row says that, and it must keep
   * saying it: those accounts have always been credit-bound, and a null
   * lifetime cap on that row means "no cap BEYOND the credit requirement", not
   * "unlimited free records". Reading the cap alone would have handed every
   * grandfathered PAYG account unlimited free evidence.
   */
  const planGrantsNoFreeAllowance =
    getPlanCapabilities(input.plan).paygCreditsRequiredPerCompletion > 0;

  const withinPlanAllowance =
    !planGrantsNoFreeAllowance &&
    (input.effectiveLifetimeRecordCap === null ||
      input.currentRecordCount < input.effectiveLifetimeRecordCap);

  if (withinPlanAllowance) {
    return { allowed: true, funding: "PLAN" };
  }

  if (input.availableEvidenceCredits >= EVIDENCE_CREDIT_PRODUCT.creditsPerCompletion) {
    return { allowed: true, funding: "EVIDENCE_CREDIT" };
  }

  return {
    allowed: false,
    reason: planGrantsNoFreeAllowance
      ? "CREDIT_REQUIRED_NONE_AVAILABLE"
      : "PLAN_ALLOWANCE_EXHAUSTED_NO_CREDITS",
  };
}
