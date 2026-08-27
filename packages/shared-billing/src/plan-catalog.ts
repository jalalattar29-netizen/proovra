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

  /**
   * How many OWNED WORKSPACES (`Team` rows, `workspaceKind: OWNED`) this
   * ACCOUNT may create. A PERSONAL_ACCOUNT-subject decision, enforced by
   * `assertUserCanCreateAnotherOwnedWorkspace`. Excludes the bootstrap
   * Personal Space and provisioned Organization workspaces.
   */
  maxOwnedWorkspaces: number;

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
    maxEvidenceRecords: 3,
    maxEvidenceRecordsPerMonth: null,
    paygCreditsRequiredPerCompletion: 0,
    aiAdvisoryMonthlyOperations: 0,
    allowsPersonalWorkspacePurchase: true,
    allowsSharedWorkspace: false,
    maxOwnedWorkspaces: 0,
    maxCollaborationTeamsPerWorkspace: 0,
    maxAcceptedMembersPerCollaborationTeam: 0,
    maxWorkspaceSeats: 0,
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
    maxEvidenceRecords: null,
    maxEvidenceRecordsPerMonth: null,
    paygCreditsRequiredPerCompletion: 1,
    aiAdvisoryMonthlyOperations: 50,
    allowsPersonalWorkspacePurchase: true,
    allowsSharedWorkspace: false,
    maxOwnedWorkspaces: 0,
    maxCollaborationTeamsPerWorkspace: 0,
    maxAcceptedMembersPerCollaborationTeam: 0,
    maxWorkspaceSeats: 0,
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
    maxEvidenceRecords: 100,
    maxEvidenceRecordsPerMonth: null,
    paygCreditsRequiredPerCompletion: 0,
    aiAdvisoryMonthlyOperations: 100,
    allowsPersonalWorkspacePurchase: true,
    allowsSharedWorkspace: true,
    maxOwnedWorkspaces: 2,
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
    maxEvidenceRecords: null,
    maxEvidenceRecordsPerMonth: 500,
    paygCreditsRequiredPerCompletion: 0,
    aiAdvisoryMonthlyOperations: 500,
    allowsPersonalWorkspacePurchase: false,
    allowsSharedWorkspace: true,
    maxOwnedWorkspaces: 5,
    maxCollaborationTeamsPerWorkspace: 5,
    maxAcceptedMembersPerCollaborationTeam: 5,
    maxWorkspaceSeats: 5,
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
    maxEvidenceRecords: null,
    maxEvidenceRecordsPerMonth: null,
    paygCreditsRequiredPerCompletion: 0,
    aiAdvisoryMonthlyOperations: null,
    allowsPersonalWorkspacePurchase: true,
    allowsSharedWorkspace: true,
    maxOwnedWorkspaces: 1000,
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
 *                         Owned Workspace (maxOwnedWorkspaces governs CREATION
 *                         allowance only, at the PERSONAL_ACCOUNT subject).
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
}): {
  plan: PlanType;
  source:
    | "PERSONAL_ENTITLEMENT"
    | "WORKSPACE_SUBSCRIPTION"
    | "ORGANIZATION_CONTRACT"
    | "LEGACY_AMBIGUOUS_FAIL_CLOSED"
    | "NONE";
} {
  const live =
    input.billingStatus === "ACTIVE" || input.billingStatus === "PAST_DUE";

  switch (input.workspaceKind) {
    case "PERSONAL":
      return { plan: input.ownerPlan, source: "PERSONAL_ENTITLEMENT" };
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
