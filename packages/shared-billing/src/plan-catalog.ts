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

  allowsPersonalWorkspace: boolean;
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
    maxEvidenceRecords: 3,
    maxEvidenceRecordsPerMonth: null,
    paygCreditsRequiredPerCompletion: 0,
    aiAdvisoryMonthlyOperations: 0,
    allowsPersonalWorkspace: true,
    allowsTeamWorkspace: false,
    teamWorkspaceRequired: false,
    maxOwnedTeams: 0,
    maxMembersPerTeam: 0,
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
    maxEvidenceRecords: null,
    maxEvidenceRecordsPerMonth: null,
    paygCreditsRequiredPerCompletion: 1,
    aiAdvisoryMonthlyOperations: 50,
    allowsPersonalWorkspace: true,
    allowsTeamWorkspace: false,
    teamWorkspaceRequired: false,
    maxOwnedTeams: 0,
    maxMembersPerTeam: 0,
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
    maxEvidenceRecords: 100,
    maxEvidenceRecordsPerMonth: null,
    paygCreditsRequiredPerCompletion: 0,
    aiAdvisoryMonthlyOperations: 100,
    allowsPersonalWorkspace: true,
    allowsTeamWorkspace: true,
    teamWorkspaceRequired: false,
    maxOwnedTeams: 2,
    maxMembersPerTeam: 5,
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
    maxEvidenceRecords: null,
    maxEvidenceRecordsPerMonth: 500,
    paygCreditsRequiredPerCompletion: 0,
    aiAdvisoryMonthlyOperations: 500,
    allowsPersonalWorkspace: false,
    allowsTeamWorkspace: true,
    teamWorkspaceRequired: true,
    maxOwnedTeams: 5,
    maxMembersPerTeam: 5,
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
    maxEvidenceRecords: null,
    maxEvidenceRecordsPerMonth: null,
    paygCreditsRequiredPerCompletion: 0,
    aiAdvisoryMonthlyOperations: null,
    allowsPersonalWorkspace: true,
    allowsTeamWorkspace: true,
    teamWorkspaceRequired: false,
    maxOwnedTeams: 1000,
    maxMembersPerTeam: 500,
    enterpriseFeatures: ALL_ENTERPRISE_FEATURES,
  },
};

export function getPlanCapabilities(plan: PlanType): PlanCapabilities {
  return PLAN_CAPABILITIES[plan] ?? PLAN_CAPABILITIES.FREE;
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

export function canPlanUsePersonalWorkspace(plan: PlanType): boolean {
  return getPlanCapabilities(plan).allowsPersonalWorkspace;
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
