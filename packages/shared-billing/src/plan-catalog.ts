export type WorkspaceScopeType = "PERSONAL" | "TEAM";
export type PlanType = "FREE" | "PAYG" | "PRO" | "TEAM";

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

  maxEvidenceRecords: number | null;
  paygCreditsRequiredPerCompletion: number;

  allowsPersonalWorkspace: boolean;
  allowsTeamWorkspace: boolean;
  teamWorkspaceRequired: boolean;
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
    paygCreditsRequiredPerCompletion: 0,
    allowsPersonalWorkspace: true,
    allowsTeamWorkspace: false,
    teamWorkspaceRequired: false,
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
    paygCreditsRequiredPerCompletion: 1,
    allowsPersonalWorkspace: true,
    allowsTeamWorkspace: false,
    teamWorkspaceRequired: false,
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
    maxEvidenceRecords: null,
    paygCreditsRequiredPerCompletion: 0,
    allowsPersonalWorkspace: true,
    allowsTeamWorkspace: false,
    teamWorkspaceRequired: false,
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
    paygCreditsRequiredPerCompletion: 0,
    allowsPersonalWorkspace: false,
    allowsTeamWorkspace: true,
    teamWorkspaceRequired: true,
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

export function formatBytesHuman(bytes: bigint): string {
  if (bytes >= TB) return `${Number(bytes) / Number(TB)} TB`;
  if (bytes >= GB) return `${Number(bytes) / Number(GB)} GB`;
  if (bytes >= MB) return `${Number(bytes) / Number(MB)} MB`;
  if (bytes >= 1024n) return `${Number(bytes) / 1024} KB`;
  return `${bytes} B`;
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
      "Custom seat volume and onboarding scope",
      "Custom storage envelope and rollout planning",
      "Shared review and multi-stakeholder workflow alignment",
      "Commercial discussion for legal, compliance, claims, or enterprise review teams",
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
    free: {
      plan: "FREE" as const,
      displayName: PLAN_CAPABILITIES.FREE.displayName,
      monthlyPriceCents: PLAN_CAPABILITIES.FREE.monthlyPriceCents,
      storageBytes: PLAN_CAPABILITIES.FREE.includedStorageBytes.toString(),
      storageLabel: formatBytesHuman(PLAN_CAPABILITIES.FREE.includedStorageBytes),
      reportsIncluded: PLAN_CAPABILITIES.FREE.reportsIncluded,
      verificationPackageIncluded:
        PLAN_CAPABILITIES.FREE.verificationPackageIncluded,
      publicVerifyIncluded: PLAN_CAPABILITIES.FREE.publicVerifyIncluded,
      maxEvidenceRecords: PLAN_CAPABILITIES.FREE.maxEvidenceRecords,
      seats: PLAN_CAPABILITIES.FREE.includedSeats,
      workspaceType: PLAN_CAPABILITIES.FREE.workspaceType,
    },
    payg: {
      plan: "PAYG" as const,
      displayName: PLAN_CAPABILITIES.PAYG.displayName,
      monthlyPriceCents: PLAN_CAPABILITIES.PAYG.monthlyPriceCents,
      storageBytes: PLAN_CAPABILITIES.PAYG.includedStorageBytes.toString(),
      storageLabel: formatBytesHuman(PLAN_CAPABILITIES.PAYG.includedStorageBytes),
      reportsIncluded: PLAN_CAPABILITIES.PAYG.reportsIncluded,
      verificationPackageIncluded:
        PLAN_CAPABILITIES.PAYG.verificationPackageIncluded,
      publicVerifyIncluded: PLAN_CAPABILITIES.PAYG.publicVerifyIncluded,
      creditsRequiredPerCompletion:
        PLAN_CAPABILITIES.PAYG.paygCreditsRequiredPerCompletion,
      seats: PLAN_CAPABILITIES.PAYG.includedSeats,
      workspaceType: PLAN_CAPABILITIES.PAYG.workspaceType,
    },
    pro: {
      plan: "PRO" as const,
      displayName: PLAN_CAPABILITIES.PRO.displayName,
      monthlyPriceCents: PLAN_CAPABILITIES.PRO.monthlyPriceCents,
      storageBytes: PLAN_CAPABILITIES.PRO.includedStorageBytes.toString(),
      storageLabel: formatBytesHuman(PLAN_CAPABILITIES.PRO.includedStorageBytes),
      reportsIncluded: PLAN_CAPABILITIES.PRO.reportsIncluded,
      verificationPackageIncluded:
        PLAN_CAPABILITIES.PRO.verificationPackageIncluded,
      publicVerifyIncluded: PLAN_CAPABILITIES.PRO.publicVerifyIncluded,
      seats: PLAN_CAPABILITIES.PRO.includedSeats,
      workspaceType: PLAN_CAPABILITIES.PRO.workspaceType,
    },
    team: {
      plan: "TEAM" as const,
      displayName: PLAN_CAPABILITIES.TEAM.displayName,
      monthlyPriceCents: PLAN_CAPABILITIES.TEAM.monthlyPriceCents,
      storageBytes: PLAN_CAPABILITIES.TEAM.includedStorageBytes.toString(),
      storageLabel: formatBytesHuman(PLAN_CAPABILITIES.TEAM.includedStorageBytes),
      reportsIncluded: PLAN_CAPABILITIES.TEAM.reportsIncluded,
      verificationPackageIncluded:
        PLAN_CAPABILITIES.TEAM.verificationPackageIncluded,
      publicVerifyIncluded: PLAN_CAPABILITIES.TEAM.publicVerifyIncluded,
      seats: PLAN_CAPABILITIES.TEAM.includedSeats,
      workspaceType: PLAN_CAPABILITIES.TEAM.workspaceType,
    },
    enterprise,
  };
}