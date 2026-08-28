export type PlanType = "FREE" | "PAYG" | "PRO" | "TEAM" | "ENTERPRISE";

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

export type PricingCatalogPlan = {
  plan: PlanType;
  displayName?: string;
  storageBytes?: string;
  storageLabel?: string;
  seats?: number;
  reportsIncluded?: boolean;
  verificationPackageIncluded?: boolean;
  publicVerifyIncluded?: boolean;
  /** Lifetime cap on evidence records; null = no lifetime cap. */
  maxEvidenceRecords?: number | null;
  /** Rolling 30-day cap on evidence records; null = no monthly cap. */
  maxEvidenceRecordsPerMonth?: number | null;
  /** Monthly cap on AI advisory operations; null = custom (Enterprise); 0 = AI disabled. */
  aiAdvisoryMonthlyOperations?: number | null;
  monthlyPriceCents?: number | null;
  /**
   * ARCH-001 (2026-08-07) — the COMMERCIAL shape this plan may be bought for.
   * Renamed with the server: `workspaceType: "PERSONAL" | "TEAM"` read as a
   * tenancy kind next to a TEAM plan, and there has never been a TEAM
   * workspace KIND.
   */
  billingShape?: "SINGLE_OCCUPANT" | "SHARED" | "BOTH";
  /*
   * BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — `maxOwnedWorkspaces`
   * was REMOVED. Pricing advertised "Up to 2" and "Up to 5" additional
   * workspaces on PRO and TEAM; no plan sells additional workspaces, and the
   * comparison row that rendered these went with the field.
   */
  /** ACTIVE Collaboration Teams allowed inside ONE workspace. */
  maxCollaborationTeamsPerWorkspace?: number;
  /** ACCEPTED members allowed in ONE Collaboration Team. */
  maxAcceptedMembersPerCollaborationTeam?: number;
  /** ACCEPTED seats allowed in ONE shared workspace. */
  maxWorkspaceSeats?: number;
  enterpriseFeatures?: EnterpriseFeatureFlags;
};

export type PricingStorageAddonCatalogItem = {
  key: string;
  label: string;
  storageBytes: number;
  priceCents: number;
  currency: string;
  /** ARCH-001 — which commercial shape this add-on is sold for. */
  billingShape: "SINGLE_OCCUPANT" | "SHARED";
};

export type PricingEnterpriseCatalog = {
  displayName: string;
  pricingModel: "CUSTOM";
  ctaLabel: string;
  ctaHref: string;
  summary: string;
  capabilities: string[];
  operationalFit: string[];
  supportWindow: string;
  enterpriseFeatures?: EnterpriseFeatureFlags;
};

export type PricingCatalogResponse = {
  currency: "USD" | "EUR";
  free: PricingCatalogPlan;
  payg: PricingCatalogPlan;
  pro: PricingCatalogPlan;
  team: PricingCatalogPlan;
  enterprise?: PricingEnterpriseCatalog;
  storageAddons?: PricingStorageAddonCatalogItem[];
};

/**
 * Canonical helper for rendering an evidence-record cap label on the
 * public Pricing page AND every in-product surface. Source of truth is
 * the catalog response; this helper formats it consistently so the
 * public page and the in-app billing console never drift.
 */
export function formatEvidenceRecordLabel(plan?: PricingCatalogPlan): string {
  if (!plan) return "";
  if (typeof plan.maxEvidenceRecordsPerMonth === "number") {
    return `${plan.maxEvidenceRecordsPerMonth} evidence records / month`;
  }
  if (typeof plan.maxEvidenceRecords === "number") {
    return `${plan.maxEvidenceRecords} evidence records included`;
  }
  // null / undefined = Enterprise custom; never advertise "Unlimited"
  // on a published plan card. Enterprise gets a distinct "Custom" cell.
  return "Custom operational volume";
}

export function formatAiOperationsLabel(plan?: PricingCatalogPlan): string {
  if (!plan) return "";
  const cap = plan.aiAdvisoryMonthlyOperations;
  if (cap === null || cap === undefined) return "Custom AI assistance";
  if (cap === 0) return "AI assistance not included";
  return `AI assistance: ${cap} operations / month`;
}
