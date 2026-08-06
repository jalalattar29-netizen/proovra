export type WorkspaceScopeType = "PERSONAL" | "TEAM";
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
  workspaceType: WorkspaceScopeType | "BOTH";
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
   * target?" TEAM says no because `teamWorkspaceRequired` is true — you buy
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
  allowsTeamWorkspace: boolean;
  teamWorkspaceRequired: boolean;

  /**
   * Business limits:
   * - FREE / PAYG => no owned teams
   * - PRO => up to 2 owned teams
   * - TEAM => up to 5 owned teams
   * - ENTERPRISE => custom (modelled as a generous default; Sales
   *                  provisions per-account overrides as needed)
   */
  maxOwnedTeams: number;

  /**
   * Hard cap for actual members inside one team.
   * This is NOT an invite cap.
   * Invites may exist above the limit, but accepting / adding a member
   * must fail once this cap is reached.
   */
  maxMembersPerTeam: number;

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

export type EnterprisePricingCatalog = {
  displayName: string;
  pricingModel: "CUSTOM";
  ctaLabel: string;
  ctaHref: string;
  summary: string;
  capabilities: string[];
  operationalFit: string[];
  supportWindow: string;
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
    workspaceType: "PERSONAL",
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
    allowsTeamWorkspace: false,
    teamWorkspaceRequired: false,
    maxOwnedTeams: 0,
    maxMembersPerTeam: 0,
    maxPendingInvitesPerTeam: 0,
    maxInvitesPer24h: 0,
    enterpriseFeatures: NO_ENTERPRISE_FEATURES,
  },

  PAYG: {
    plan: "PAYG",
    displayName: "Pay-as-you-go",
    workspaceType: "PERSONAL",
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
    allowsTeamWorkspace: false,
    teamWorkspaceRequired: false,
    maxOwnedTeams: 0,
    maxMembersPerTeam: 0,
    maxPendingInvitesPerTeam: 0,
    maxInvitesPer24h: 0,
    enterpriseFeatures: NO_ENTERPRISE_FEATURES,
  },

  PRO: {
    plan: "PRO",
    displayName: "Pro",
    workspaceType: "PERSONAL",
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
    allowsTeamWorkspace: true,
    teamWorkspaceRequired: false,
    maxOwnedTeams: 2,
    maxMembersPerTeam: 5,
    maxPendingInvitesPerTeam: 10,
    maxInvitesPer24h: 50,
    enterpriseFeatures: NO_ENTERPRISE_FEATURES,
  },

  TEAM: {
    plan: "TEAM",
    displayName: "Team",
    workspaceType: "TEAM",
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
    allowsTeamWorkspace: true,
    teamWorkspaceRequired: true,
    maxOwnedTeams: 5,
    maxMembersPerTeam: 5,
    maxPendingInvitesPerTeam: 25,
    maxInvitesPer24h: 100,
    enterpriseFeatures: NO_ENTERPRISE_FEATURES,
  },

  ENTERPRISE: {
    plan: "ENTERPRISE",
    displayName: "Enterprise",
    workspaceType: "BOTH",
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
    allowsTeamWorkspace: true,
    teamWorkspaceRequired: false,
    maxOwnedTeams: 1000,
    maxMembersPerTeam: 500,
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
 *                         Owned Workspace (maxOwnedTeams governs CREATION
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
// PHASE 9 §9.6 corrected (2026-07-22) — collaboration-team limits adapter,
// RELOCATED here from @proovra/shared to fix the package-layering inversion
// (the generic shared package must not depend on the billing package).
// ZERO-DECISION projections of PlanCapabilities: no literal limits, no
// subject inference, no owner-plan fallback, no lifecycle interpretation.
// TEMPORARY ADAPTER — owner: billing domain · removal: callers read
// PlanCapabilities fields directly · Phase 12 target: delete this block.
// =============================================================================

export type CollaborationTeamPlanLimits = {
  maxTeams: number;
  maxMembersPerTeam: number;
  maxPendingInvitesPerTeam: number;
  maxInvitesPer24h: number;
};

function projectCollaborationLimits(plan: PlanType): CollaborationTeamPlanLimits {
  const caps = getPlanCapabilities(plan);
  return {
    maxTeams: caps.maxOwnedTeams,
    maxMembersPerTeam: caps.maxMembersPerTeam,
    maxPendingInvitesPerTeam: caps.maxPendingInvitesPerTeam,
    maxInvitesPer24h: caps.maxInvitesPer24h,
  };
}

export const COLLABORATION_TEAM_PLAN_LIMITS: Record<
  PlanType,
  CollaborationTeamPlanLimits
> = {
  FREE: projectCollaborationLimits("FREE"),
  PAYG: projectCollaborationLimits("PAYG"),
  PRO: projectCollaborationLimits("PRO"),
  TEAM: projectCollaborationLimits("TEAM"),
  ENTERPRISE: projectCollaborationLimits("ENTERPRISE"),
};

export function getCollaborationTeamPlanLimits(
  plan: string | null | undefined,
): CollaborationTeamPlanLimits {
  const key = (plan ?? "FREE").toUpperCase();
  if (key in COLLABORATION_TEAM_PLAN_LIMITS) {
    return COLLABORATION_TEAM_PLAN_LIMITS[key as PlanType];
  }
  return COLLABORATION_TEAM_PLAN_LIMITS.FREE;
}

export function getPlanStorageLimitBytes(plan: PlanType): bigint {
  return getPlanCapabilities(plan).includedStorageBytes;
}

export function getPlanSeatLimit(plan: PlanType): number {
  return getPlanCapabilities(plan).includedSeats;
}

export function canPlanUseTeams(plan: PlanType): boolean {
  return getPlanCapabilities(plan).allowsTeamWorkspace;
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

function projectPlan(plan: PlanType) {
  const caps = PLAN_CAPABILITIES[plan];
  return {
    plan,
    displayName: caps.displayName,
    monthlyPriceCents: caps.monthlyPriceCents,
    storageBytes: caps.includedStorageBytes.toString(),
    storageLabel: formatBytesHuman(caps.includedStorageBytes),
    reportsIncluded: caps.reportsIncluded,
    verificationPackageIncluded: caps.verificationPackageIncluded,
    publicVerifyIncluded: caps.publicVerifyIncluded,
    maxEvidenceRecords: caps.maxEvidenceRecords,
    maxEvidenceRecordsPerMonth: caps.maxEvidenceRecordsPerMonth,
    aiAdvisoryMonthlyOperations: caps.aiAdvisoryMonthlyOperations,
    seats: caps.includedSeats,
    workspaceType: caps.workspaceType,
    maxOwnedTeams: caps.maxOwnedTeams,
    maxMembersPerTeam: caps.maxMembersPerTeam,
    enterpriseFeatures: caps.enterpriseFeatures,
  };
}

export function getPricingCatalogResponse() {
  const enterprise: EnterprisePricingCatalog = {
    displayName: "Enterprise",
    pricingModel: "CUSTOM",
    ctaLabel: "Contact Sales",
    ctaHref: "/contact-sales",
    summary:
      "Custom commercial terms for larger organizations that need procurement handling, governance review, rollout planning, or higher-volume evidence operations.",
    capabilities: [
      "Custom operational volume and onboarding scope",
      "Custom storage envelope and rollout planning",
      "SAML SSO and SCIM provisioning",
      "MFA enforcement, access reviews, session governance",
      "Legal hold and custom retention policies",
      "Organization audit logs",
      "Object Lock / immutable storage controls",
    ],
    operationalFit: [
      "Procurement and security review",
      "Retention and governance alignment",
      "Departmental or organization-wide rollout",
      "Higher-volume evidence operations",
    ],
    supportWindow:
      "Enterprise inquiries are typically reviewed within 4 business hours, depending on workflow clarity and commercial fit.",
  };

  return {
    free: projectPlan("FREE"),
    payg: {
      ...projectPlan("PAYG"),
      creditsRequiredPerCompletion:
        PLAN_CAPABILITIES.PAYG.paygCreditsRequiredPerCompletion,
    },
    pro: projectPlan("PRO"),
    team: projectPlan("TEAM"),
    enterprise,
  };
}
