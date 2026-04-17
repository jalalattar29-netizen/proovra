export type PlanType = "FREE" | "PAYG" | "PRO" | "TEAM";

export type PricingCatalogPlan = {
  plan: PlanType;
  displayName?: string;
  storageBytes?: string;
  storageLabel?: string;
  seats?: number;
  reportsIncluded?: boolean;
  verificationPackageIncluded?: boolean;
  publicVerifyIncluded?: boolean;
  maxEvidenceRecords?: number | null;
  monthlyPriceCents?: number | null;
  workspaceType?: "PERSONAL" | "TEAM" | "BOTH";
  maxOwnedTeams?: number;
  maxMembersPerTeam?: number;
};

export type PricingStorageAddonCatalogItem = {
  key: string;
  label: string;
  storageBytes: number;
  priceCents: number;
  currency: string;
  workspaceType: "PERSONAL" | "TEAM";
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