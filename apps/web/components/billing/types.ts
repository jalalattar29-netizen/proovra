export type WorkspaceStorageInfo = {
  usedBytes?: string;
  limitBytes?: string;
  remainingBytes?: string;
  usedLabel?: string;
  limitLabel?: string;
  remainingLabel?: string;
  usageRatio?: number;
  usagePercent?: number;
  nearLimit?: boolean;
  limitReached?: boolean;
  basePlanLimitBytes?: string;
  activeAddonBytes?: string;
};

export type WorkspaceSeatInfo = {
  used?: number;
  included?: number;
  remaining?: number;
  usageRatio?: number;
  usagePercent?: number;
  nearLimit?: boolean;
  limitReached?: boolean;
};

export type WorkspaceHealthSummary = {
  storageNearLimit?: boolean;
  storageLimitReached?: boolean;
  seatNearLimit?: boolean;
  seatLimitReached?: boolean;
  overSeatLimit?: boolean;
};

export type BillingSubscriptionSummary = {
  id?: string;
  provider?: string | null;
  providerSubId?: string | null;
  status?: string | null;
  plan?: string | null;
  currentPeriodEnd?: string | null;
  createdAt?: string | null;
};

export type BillingPaymentSummary = {
  id: string;
  provider: string;
  providerPaymentId: string;
  amountCents: number;
  currency: string;
  status: string;
  createdAt: string;
  teamId?: string | null;
};

export type StorageAddonCatalogItem = {
  key: string;
  workspaceType: "PERSONAL" | "TEAM";
  label: string;
  storageBytes: string;
  priceCents: number;
  currency: string;
};

export type WorkspaceStorageAddonSummary = {
  id: string;
  ownerUserId?: string;
  teamId?: string | null;
  teamName?: string | null;
  addonKey: string;
  extraStorageBytes?: string;
  billingCycle?: string;
  status?: string;
  paymentProvider?: string | null;
  externalSubscriptionId?: string | null;
  externalPaymentId?: string | null;
  currency?: string | null;
  amountCents?: number | null;
  activatedAtUtc?: string | null;
  currentPeriodEnd?: string | null;
  expiresAtUtc?: string | null;
  canceledAtUtc?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type WorkspaceFeatureFlags = {
  reportsIncluded?: boolean;
  verificationPackageIncluded?: boolean;
  publicVerifyIncluded?: boolean;
  allowsPersonalWorkspace?: boolean;
  allowsTeamWorkspace?: boolean;
};

export type WorkspaceCapabilityLimits = {
  maxOwnedTeams?: number | null;
  maxMembersPerTeam?: number | null;
};

export type PersonalWorkspaceSummary = {
  workspaceType: "PERSONAL";
  plan?: string | null;
  credits?: number | null;
  teamSeats?: number | null;
  storage?: WorkspaceStorageInfo | null;
  workspaceHealth?: WorkspaceHealthSummary | null;
  features?: WorkspaceFeatureFlags | null;
  limits?: WorkspaceCapabilityLimits | null;
  subscription?: BillingSubscriptionSummary | null;
  storageAddons?: WorkspaceStorageAddonSummary[];
  activeStorageAddonSummary?: {
    count?: number;
    totalExtraStorageBytes?: string;
  } | null;
  counts?: {
    evidence?: number;
  } | null;
};

export type TeamWorkspaceSummary = {
  id: string;
  name: string;
  workspaceType: "TEAM";
  plan?: string | null;
  effectivePlan?: string | null;
  billingStatus?: string | null;
  billingOwnerUserId?: string | null;
  overSeatLimit?: boolean | null;
  credits?: number | null;
  teamSeats?: number | null;
  storage?: WorkspaceStorageInfo | null;
  seats?: WorkspaceSeatInfo | null;
  workspaceHealth?: WorkspaceHealthSummary | null;
  counts?: {
    evidence?: number;
    members?: number;
  } | null;
  features?: WorkspaceFeatureFlags | null;
  limits?: WorkspaceCapabilityLimits | null;
  subscription?: BillingSubscriptionSummary | null;
  storageAddons?: WorkspaceStorageAddonSummary[];
  activeStorageAddonSummary?: {
    count?: number;
    totalExtraStorageBytes?: string;
  } | null;
  billingActivatedAt?: string | null;
  billingCanceledAt?: string | null;
};

export type BillingOverviewResponse = {
  entitlement?: {
    plan?: string | null;
    credits?: number | null;
    teamSeats?: number | null;
    maxOwnedTeams?: number | null;
    maxMembersPerTeam?: number | null;
  } | null;
  summary?: {
    personalPlan?: string | null;
    personalCredits?: number | null;
    totalTeams?: number;
    activeTeamPlans?: number;
    overSeatLimitTeams?: number;
    nearStorageLimitTeams?: number;
    activeStorageAddons?: number;
    activeStorageAddonBytes?: string;
    payments?: {
      total?: number;
      succeeded?: number;
      failed?: number;
      refunded?: number;
      pending?: number;
      personalPayments?: number;
      teamPayments?: number;
      totalAmountCents?: number;
    } | null;
  } | null;
  workspaces?: {
    personal?: PersonalWorkspaceSummary | null;
    teams?: TeamWorkspaceSummary[];
  } | null;
  storageAddons?: {
    all?: WorkspaceStorageAddonSummary[];
    active?: WorkspaceStorageAddonSummary[];
  } | null;
  payments?: BillingPaymentSummary[];
  paymentMethods?: Record<string, string[]>;
};

export type CheckoutPlan = "PAYG" | "PRO" | "TEAM";
export type CheckoutProvider = "STRIPE" | "PAYPAL";
export type CheckoutTargetType = "PERSONAL" | "TEAM";
export type StorageAddonCheckoutTargetType = "PERSONAL" | "TEAM";