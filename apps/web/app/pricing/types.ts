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
};

export type PricingStorageAddonCatalogItem = {
  key: string;
  label: string;
  storageBytes: number;
  priceCents: number;
  currency: string;
  workspaceType: "PERSONAL" | "TEAM";
};

export type PricingCatalogResponse = {
  free: PricingCatalogPlan;
  payg: PricingCatalogPlan;
  pro: PricingCatalogPlan;
  team: PricingCatalogPlan;
  storageAddons?: PricingStorageAddonCatalogItem[];
};