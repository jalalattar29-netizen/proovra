export type WorkspaceStorageInfo = {
  usedBytes?: string;
  limitBytes?: string;
  remainingBytes?: string;
  usedLabel?: string;
  limitLabel?: string;
  remainingLabel?: string;
  usageRatio?: number;
};

export type WorkspaceSeatInfo = {
  used?: number;
  included?: number;
  remaining?: number;
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

export type PersonalWorkspaceSummary = {
  workspaceType: "PERSONAL";
  plan?: string | null;
  credits?: number | null;
  teamSeats?: number | null;
  storage?: WorkspaceStorageInfo | null;
  features?: {
    reportsIncluded?: boolean;
    verificationPackageIncluded?: boolean;
    publicVerifyIncluded?: boolean;
  } | null;
  subscription?: BillingSubscriptionSummary | null;
};

export type TeamWorkspaceSummary = {
  id: string;
  name: string;
  workspaceType: "TEAM";
  plan?: string | null;
  billingStatus?: string | null;
  overSeatLimit?: boolean | null;
  credits?: number | null;
  teamSeats?: number | null;
  storage?: WorkspaceStorageInfo | null;
  seats?: WorkspaceSeatInfo | null;
  features?: {
    reportsIncluded?: boolean;
    verificationPackageIncluded?: boolean;
    publicVerifyIncluded?: boolean;
  } | null;
  subscription?: BillingSubscriptionSummary | null;
  billingActivatedAt?: string | null;
  billingCanceledAt?: string | null;
};

export type BillingOverviewResponse = {
  entitlement?: {
    plan?: string | null;
    credits?: number | null;
    teamSeats?: number | null;
  } | null;
  workspaces?: {
    personal?: PersonalWorkspaceSummary | null;
    teams?: TeamWorkspaceSummary[];
  } | null;
  payments?: BillingPaymentSummary[];
  paymentMethods?: Record<string, string[]>;
};

export type CheckoutPlan = "PAYG" | "PRO" | "TEAM";
export type CheckoutProvider = "STRIPE" | "PAYPAL";
export type CheckoutTargetType = "PERSONAL" | "TEAM";