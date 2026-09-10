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

/**
 * The Pay-per-evidence OFFER. Deliberately NOT a `PricingCatalogPlan`.
 *
 * P1-2 CLOSURE (2026-09-10). It used to be one, projected from
 * `PLAN_CAPABILITIES.PAYG` — a grandfather-resolution row that no write path
 * assigns and that the catalog itself forbids advertising. The page therefore
 * published 5 GB of storage and 50 AI operations a month to a customer who
 * receives FREE's 250 MB and 10.
 *
 * Giving the offer its own type is what stops that recurring: a credit pack is
 * not a subscription tier, and a shape that cannot be mistaken for one cannot
 * be rendered as one. The subscription-level numbers it does carry are FREE's,
 * because that is the plan a credit buyer is on.
 */
export type PricingEvidenceCreditOffer = {
  productKey: "EVIDENCE_CREDIT";
  displayName: string;
  pricingModel: "PER_CREDIT";
  unitPriceCents: number;
  creditsGrantedPerPurchase: number;
  creditsRequiredPerCompletion: number;
  creditsExpire: false;
  /** The underlying subscription. Always FREE — buying credits changes no plan. */
  plan: "FREE";
  requiresSubscription: false;
  /** What ONE credit-funded record earns. Per record, never per account. */
  perFundedRecord: {
    reportIncluded: boolean;
    verificationPackageIncluded: boolean;
    publicVerifyIncluded: boolean;
  };
  /** Subscription-level entitlements, which stay FREE's. */
  storageBytes: string;
  storageLabel: string;
  aiAdvisoryMonthlyOperations: number | null;
  intakeIncluded: boolean;
  casesIncluded: boolean;
  /** PRODUCT OPTION B — an evidence-credit customer may buy storage add-ons. */
  storageAddonsPurchasable: boolean;
};

export type PricingCatalogResponse = {
  currency: "USD" | "EUR";
  free: PricingCatalogPlan;
  payg: PricingEvidenceCreditOffer;
  pro: PricingCatalogPlan;
  team: PricingCatalogPlan;
  enterprise?: PricingEnterpriseCatalog;
  storageAddons?: PricingStorageAddonCatalogItem[];
};

/**
 * Format an evidence-record cap label from the catalog response.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS NOT (2026-09-09)
 * ---------------------------------------------------------------------------
 * The docblock here described this as "the canonical helper ... so the public
 * page and the in-app billing console never drift". It has NO callers. Both
 * of those surfaces build their own label — the Pricing page inline, the
 * billing console in `billing-account-projection.service.ts` — so the sentence
 * described an arrangement that has never existed, in the confident tone of
 * one that does.
 *
 * It is kept because the formatting decision is a real one and a future
 * surface may want it, but its output is now correct in the way that matters:
 * a cap with no monthly window is a LIFETIME cap and must say so. The prior
 * wording named the number and left the window to the reader, which is exactly
 * how the Pro card came to read as monthly beneath a monthly price.
 */
export function formatEvidenceRecordLabel(plan?: PricingCatalogPlan): string {
  if (!plan) return "";
  if (typeof plan.maxEvidenceRecordsPerMonth === "number") {
    return `${plan.maxEvidenceRecordsPerMonth} evidence records / month`;
  }
  if (typeof plan.maxEvidenceRecords === "number") {
    return `${plan.maxEvidenceRecords} evidence records in total`;
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
