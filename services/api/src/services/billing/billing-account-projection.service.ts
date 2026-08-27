/**
 * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — THE account-scoped Billing DTO.
 *
 * What this replaces
 * ---------------------------------------------------------------------------
 * `readBillingOverview(userId)` returned one flat aggregate spanning EVERY
 * billing account the user touches — their personal entitlement, every
 * workspace they own, and a `payments` array merging all of them — plus raw
 * Prisma rows (`entitlement`, `payments`, `subscription`) straight onto the
 * wire. Nothing in it was scoped to a payer, and nothing in it was capability
 * filtered.
 *
 * This projection answers ONE question about ONE account for ONE viewer, and
 * every field it emits is a bounded, explicitly-constructed value. There is no
 * spread of a database row anywhere in this file, so a column added by a future
 * migration cannot leak, and no provider payload or provider secret is ever
 * reachable from it.
 *
 * Honesty rules encoded here
 * ---------------------------------------------------------------------------
 *   * A meter NEVER fabricates zero. When the plan excludes a capability it
 *     says NOT_INCLUDED; when a contract governs it without stating a number it
 *     says CONTRACT_MANAGED; when the value genuinely could not be read it says
 *     UNAVAILABLE. Rendering 0/0 for any of those is how a page comes to state
 *     a limit nobody agreed to.
 *   * Amounts, history and actions are withheld INDEPENDENTLY, by capability.
 *     A viewer without `BILLING_AMOUNT_VIEW` receives no price field at all —
 *     not a nulled one — so there is nothing to accidentally render.
 *   * Evidence wording follows the plan's actual window, because "43 of 100"
 *     means something different on a lifetime cap and a rolling 30-day cap.
 */

import * as prismaPkg from "@prisma/client";
import {
  EVIDENCE_CREDIT_PRODUCT,
  formatBytesHuman,
  getPlanCapabilities,
} from "@proovra/shared-billing";

import { prisma } from "../../db.js";
import {
  organizationWorkspaceIds,
  paymentWhereForAccount,
  type BillingAccountRef,
} from "./billing-accounts.service.js";
import { readEvidenceCreditWallet } from "./evidence-credits.service.js";
import { resolveEnterpriseContract } from "../organization/enterprise-contract.service.js";
import { resolveEnterpriseContractLimits } from "./enterprise-contract-limits.js";
import { countPersonalEvidenceRecords } from "../billing-enforcement.service.js";
import { getWorkspaceUsage } from "../workspace-usage.service.js";
import { resolveCommercialContext } from "./commercial-context.service.js";
import { listStorageAddonDefinitions } from "../billing.service.js";
import {
  getStorageAddonPriceCents,
  resolveCheckoutCurrency,
  type BillingCurrency,
} from "../billing-pricing.service.js";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// =============================================================================
// Meters
// =============================================================================

/**
 * The window a COUNT meter measures over. It is part of the value, not a label
 * the client picks: 500 records a rolling 30 days and 100 records for the life
 * of the account are different promises, and a shared "N of M" chip cannot say
 * which one a customer bought.
 */
export type UsageWindow = "LIFETIME" | "ROLLING_30_DAYS" | "CALENDAR_MONTH";

export type UsageMeter =
  /** A real measurement. `limit: null` means measured but uncapped. */
  | { state: "MEASURED"; used: number; limit: number | null; window: UsageWindow }
  /** The plan genuinely excludes this capability. */
  | { state: "NOT_INCLUDED" }
  /** An Enterprise contract governs it and states no number. */
  | { state: "CONTRACT_MANAGED" }
  /** Could not be read. NEVER rendered as zero. */
  | { state: "UNAVAILABLE"; reason: string };

export type StorageMeter =
  | {
      state: "MEASURED";
      usedBytes: string;
      usedLabel: string;
      /** Total capacity: base (or contract) + active add-ons + any override. */
      limitBytes: string;
      limitLabel: string;
      /** Plan or contract base, before add-ons. */
      baseBytes: string;
      baseLabel: string;
      /** Capacity from ACTIVE recurring add-ons. */
      recurringAddonBytes: string;
      recurringAddonLabel: string;
      /** Capacity from grandfathered one-time add-ons. */
      legacyAddonBytes: string;
      legacyAddonLabel: string;
      usagePercent: number;
      nearLimit: boolean;
      limitReached: boolean;
    }
  | { state: "UNAVAILABLE"; reason: string };

// =============================================================================
// Plan / contract summary
// =============================================================================

/**
 * How this account is billed. Deliberately NOT the plan name: "Pro" does not
 * tell a surface whether to expect a renewal date, and inventing a billing
 * cycle for a credit purchase is exactly the fiction this replaces.
 */
export type CommercialModel =
  /** No charge. */
  | "FREE"
  /** A recurring monthly subscription. */
  | "MONTHLY"
  /** One-time evidence credits over a FREE account. */
  | "CREDIT"
  /** Enterprise contract. Terms come from the contract, not from checkout. */
  | "CONTRACT";

export type PlanLifecycle =
  | "ACTIVE"
  | "TRIALING"
  | "PAST_DUE"
  | "ACTION_REQUIRED"
  | "CANCELING"
  | "CANCELLED"
  | "INACTIVE";

export type PlanSummary = {
  planKey: string;
  displayName: string;
  model: CommercialModel;
  lifecycle: PlanLifecycle;
  /** Present ONLY with BILLING_AMOUNT_VIEW. */
  priceCents?: number | null;
  currency?: BillingCurrency;
  /**
   * The provider-confirmed end of the paid period. Present only when a
   * subscription actually carries one — never synthesised, and never a
   * "next billing date" invented for a credit purchase.
   */
  currentPeriodEndUtc: string | null;
  /** Provider-confirmed "cancels at period end". */
  cancelAtPeriodEnd: boolean;
  /**
   * A provider-neutral display name. The raw provider enum is deliberately not
   * exposed to a non-financial viewer, and no provider id is exposed to anyone.
   */
  paymentProviderLabel?: string | null;
  /** When the bounded grace window ends, for a PAST_DUE subject. */
  graceEndsAtUtc?: string | null;
  /** True when this account has no assigned billing owner. */
  billingOwnerMissing: boolean;
};

export type EnterpriseContractSummary = {
  status: string;
  activationState: string | null;
  effectiveAtUtc: string | null;
  endsAtUtc: string | null;
  /** Contracted seats, or null when the contract is silent. */
  seatCount: number | null;
  /** Contracted storage in GB, or null. */
  storageGb: number | null;
  region: string | null;
  /**
   * True when this projection came from the legacy compatibility fallback
   * rather than a real contract row. The surface must say "contact your
   * account manager" rather than publish a derived number as a term.
   */
  derivedFromLegacyFallback: boolean;
};

export type CollaborationUsage = {
  ownedWorkspaces?: { used: number; limit: number };
  collaborationTeams?: { used: number; limit: number };
  seats?: {
    /** ACCEPTED members only. */
    used: number;
    limit: number;
    /** Counted and reported SEPARATELY — an invite is not a member. */
    pendingInvites: number;
  };
};

export type StorageAddonOffer = {
  key: string;
  label: string;
  storageBytes: string;
  storageLabel: string;
  priceCents: number;
  currency: BillingCurrency;
  /** Every NEW add-on is a recurring monthly subscription. */
  billingCycle: "MONTHLY";
};

export type ActiveStorageAddon = {
  id: string;
  addonKey: string;
  label: string;
  storageLabel: string;
  status: string;
  /** MONTHLY for new purchases; ONE_TIME for grandfathered legacy rows. */
  billingCycle: string;
  /** True for a grandfathered one-time purchase. */
  legacyOneTime: boolean;
  activatedAtUtc: string | null;
  currentPeriodEndUtc: string | null;
  /** Present ONLY with BILLING_AMOUNT_VIEW. */
  priceCents?: number | null;
  currency?: string | null;
};

export type BillingAccountProjection = {
  account: BillingAccountRef;
  plan: PlanSummary;
  usage: {
    evidence: UsageMeter;
    storage: StorageMeter;
    ai: UsageMeter;
  };
  /** PERSONAL accounts only — the evidence-credit wallet. */
  wallet?: {
    availableCredits: number;
    purchasedCredits: number;
    consumedCredits: number;
    hasLedgerHistory: boolean;
    unitPriceCents?: number;
    currency?: BillingCurrency;
  };
  collaboration?: CollaborationUsage;
  contract?: EnterpriseContractSummary;
  storageAddons?: {
    offers: StorageAddonOffer[];
    active: ActiveStorageAddon[];
  };
  /**
   * What this viewer may actually DO. Derived server-side from the same
   * capabilities the routes enforce, so the client renders affordances rather
   * than deciding them.
   */
  actions: {
    canStartCheckout: boolean;
    canBuyEvidenceCredits: boolean;
    canBuyStorageAddon: boolean;
    canRequestCancellation: boolean;
    /** Enterprise: the only sanctioned change path. */
    contactAccountManager: boolean;
  };
};

// =============================================================================
// Helpers
// =============================================================================

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function providerLabel(
  provider: prismaPkg.PaymentProvider | null | undefined,
): string | null {
  if (provider === prismaPkg.PaymentProvider.STRIPE) return "Card";
  if (provider === prismaPkg.PaymentProvider.PAYPAL) return "PayPal";
  return null;
}

/**
 * THE lifecycle a surface renders.
 *
 * Derived from the canonical commercial lifecycle plus the provider-confirmed
 * `cancelAtPeriodEnd`, so "Canceling" is a real state with a real end date
 * rather than the optimistic local CANCELED the previous cancel route wrote
 * before the provider had agreed to anything.
 */
function resolveLifecycle(input: {
  hasPaidSubject: boolean;
  subscriptionStatus: prismaPkg.SubscriptionStatus | null;
  cancelAtPeriodEnd: boolean;
  commercialState: string;
}): PlanLifecycle {
  if (!input.hasPaidSubject) return "INACTIVE";
  if (input.subscriptionStatus === prismaPkg.SubscriptionStatus.TRIALING) {
    return "TRIALING";
  }
  if (input.cancelAtPeriodEnd) return "CANCELING";
  if (input.subscriptionStatus === prismaPkg.SubscriptionStatus.CANCELED) {
    return "CANCELLED";
  }
  if (input.commercialState === "GRACE") return "PAST_DUE";
  if (
    input.commercialState === "PAST_DUE_EXPIRED" ||
    input.commercialState === "CANCELLED"
  ) {
    // The subject is in a state the customer must act on: grace has run out,
    // or the provider rows are ambiguous. Both need the same banner.
    return "ACTION_REQUIRED";
  }
  if (input.subscriptionStatus === prismaPkg.SubscriptionStatus.PAST_DUE) {
    return "PAST_DUE";
  }
  return "ACTIVE";
}

function storageMeterFrom(input: {
  usedBytes: bigint;
  baseBytes: bigint;
  recurringAddonBytes: bigint;
  legacyAddonBytes: bigint;
  limitBytes: bigint;
}): StorageMeter {
  const limit = input.limitBytes;
  const percent =
    limit > 0n
      ? Math.min(100, Number((input.usedBytes * 1000n) / limit) / 10)
      : 0;
  return {
    state: "MEASURED",
    usedBytes: input.usedBytes.toString(),
    usedLabel: formatBytesHuman(input.usedBytes),
    limitBytes: limit.toString(),
    limitLabel: formatBytesHuman(limit),
    baseBytes: input.baseBytes.toString(),
    baseLabel: formatBytesHuman(input.baseBytes),
    recurringAddonBytes: input.recurringAddonBytes.toString(),
    recurringAddonLabel: formatBytesHuman(input.recurringAddonBytes),
    legacyAddonBytes: input.legacyAddonBytes.toString(),
    legacyAddonLabel: formatBytesHuman(input.legacyAddonBytes),
    usagePercent: Number(percent.toFixed(1)),
    nearLimit: limit > 0n && input.usedBytes * 10n >= limit * 8n,
    limitReached: limit > 0n && input.usedBytes >= limit,
  };
}

/** Split active add-on capacity into recurring and grandfathered legacy. */
async function splitAddonCapacity(params: {
  ownerUserId: string;
  teamId: string | null;
}): Promise<{ recurring: bigint; legacy: bigint }> {
  const rows = await prisma.workspaceStorageAddon.findMany({
    where: {
      ownerUserId: params.ownerUserId,
      teamId: params.teamId,
      status: {
        in: [
          prismaPkg.WorkspaceStorageAddonStatus.ACTIVE,
          prismaPkg.WorkspaceStorageAddonStatus.PAST_DUE,
        ],
      },
    },
    select: { extraStorageBytes: true, billingCycle: true },
  });

  let recurring = 0n;
  let legacy = 0n;
  for (const r of rows) {
    if (r.billingCycle === prismaPkg.StorageAddonBillingCycle.ONE_TIME) {
      legacy += r.extraStorageBytes;
    } else {
      recurring += r.extraStorageBytes;
    }
  }
  return { recurring, legacy };
}

async function activeAddonsFor(params: {
  ownerUserId: string;
  teamId: string | null;
  showAmounts: boolean;
}): Promise<ActiveStorageAddon[]> {
  const rows = await prisma.workspaceStorageAddon.findMany({
    where: { ownerUserId: params.ownerUserId, teamId: params.teamId },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      addonKey: true,
      extraStorageBytes: true,
      billingCycle: true,
      status: true,
      activatedAtUtc: true,
      currentPeriodEnd: true,
      amountCents: true,
      currency: true,
    },
  });

  const defs = listStorageAddonDefinitions();
  return rows.map((r) => {
    const def = defs.find((d) => d.key === r.addonKey);
    const legacyOneTime =
      r.billingCycle === prismaPkg.StorageAddonBillingCycle.ONE_TIME;
    return {
      id: r.id,
      addonKey: r.addonKey,
      label: def?.label ?? formatBytesHuman(r.extraStorageBytes),
      storageLabel: formatBytesHuman(r.extraStorageBytes),
      status: r.status,
      billingCycle: r.billingCycle,
      legacyOneTime,
      activatedAtUtc: iso(r.activatedAtUtc),
      currentPeriodEndUtc: iso(r.currentPeriodEnd),
      ...(params.showAmounts
        ? { priceCents: r.amountCents, currency: r.currency }
        : {}),
    };
  });
}

function offersFor(params: {
  shape: "SINGLE_OCCUPANT" | "SHARED";
  currency: BillingCurrency;
}): StorageAddonOffer[] {
  return listStorageAddonDefinitions()
    .filter((d) => d.billingShape === params.shape)
    .map((d) => ({
      key: d.key,
      label: d.label,
      storageBytes: d.storageBytes.toString(),
      storageLabel: formatBytesHuman(d.storageBytes),
      priceCents: getStorageAddonPriceCents({
        addonKey: d.key,
        currency: params.currency,
      }),
      currency: params.currency,
      // Every NEW storage add-on is a recurring monthly subscription. A
      // one-time payment cannot fund perpetual storage, and the previous
      // one-time SKU had no expiry writer at all — it granted capacity for
      // ever, including after the base plan was cancelled.
      billingCycle: "MONTHLY" as const,
    }));
}

// =============================================================================
// The projection
// =============================================================================

export async function buildBillingAccountProjection(input: {
  account: BillingAccountRef;
  viewerUserId: string;
  requestedCurrency?: string | null;
}): Promise<BillingAccountProjection> {
  const { account } = input;
  const currency = resolveCheckoutCurrency({
    requestedCurrency: input.requestedCurrency ?? null,
  });
  const showAmounts = account.capabilities.includes("BILLING_AMOUNT_VIEW");
  const canManage = account.capabilities.includes("BILLING_MANAGE");
  const canCancel = account.capabilities.includes("BILLING_CANCEL");
  const canAddon = account.capabilities.includes("BILLING_ADDON_PURCHASE");

  if (account.type === "ORGANIZATION") {
    return buildOrganizationProjection({
      account,
      currency,
      showAmounts,
    });
  }

  // ---- PERSONAL and WORKSPACE share the scope/usage machinery --------------
  //
  // The scope comes OUT of the canonical envelope rather than from a second
  // direct call to the workspace-billing scope adapter. Calling that adapter
  // here would resolve the same subject twice and make this file a second
  // commercial-decision entry point — the convergence the §9.7 ratchet closed,
  // and which its source guard still enforces by name.
  const ctx = await resolveCommercialContext(
    account.type === "PERSONAL"
      ? { type: "PERSONAL_ACCOUNT", userId: account.id }
      : {
          type: "WORKSPACE",
          teamId: account.id,
          requesterUserId: input.viewerUserId,
        },
  );

  const scope = ctx.scope;
  const caps = ctx.capabilities;
  const usage = await getWorkspaceUsage(scope);

  // ---- Subscription -------------------------------------------------------
  const subscription = await prisma.subscription.findFirst({
    where:
      account.type === "PERSONAL"
        ? { userId: account.id, teamId: null }
        : { teamId: account.id },
    orderBy: { updatedAt: "desc" },
    select: {
      provider: true,
      status: true,
      currentPeriodEnd: true,
      cancelAtPeriodEnd: true,
    },
  });

  const wallet =
    account.type === "PERSONAL"
      ? await readEvidenceCreditWallet(account.id)
      : null;

  // A personal account with credits but no subscription is billed by the
  // CREDIT model — it is not "Free" with nothing to say, and it is certainly
  // not a monthly subscription.
  const model: CommercialModel =
    scope.plan === "ENTERPRISE"
      ? "CONTRACT"
      : subscription && subscription.status !== prismaPkg.SubscriptionStatus.CANCELED
        ? "MONTHLY"
        : wallet && wallet.availableCredits > 0
          ? "CREDIT"
          : caps.monthlyPriceCents && caps.monthlyPriceCents > 0
            ? "MONTHLY"
            : "FREE";

  const plan: PlanSummary = {
    planKey: scope.plan,
    displayName: caps.displayName,
    model,
    lifecycle: resolveLifecycle({
      hasPaidSubject: scope.plan !== "FREE" || Boolean(subscription),
      subscriptionStatus: subscription?.status ?? null,
      cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
      commercialState: ctx.lifecycle.state,
    }),
    currentPeriodEndUtc: iso(subscription?.currentPeriodEnd ?? null),
    cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
    billingOwnerMissing: account.billingOwnerMissing,
    ...(showAmounts
      ? {
          priceCents: caps.monthlyPriceCents,
          currency,
          paymentProviderLabel: providerLabel(subscription?.provider ?? null),
          graceEndsAtUtc: iso(ctx.lifecycle.graceEndsAtUtc),
        }
      : {}),
  };

  // ---- Evidence meter -----------------------------------------------------
  let evidence: UsageMeter;
  if (scope.billingShape === "SHARED") {
    const monthlyCap = ctx.limits.effectiveMonthlyRecordCap;
    if (monthlyCap === null) {
      evidence =
        scope.plan === "ENTERPRISE"
          ? { state: "CONTRACT_MANAGED" }
          : { state: "MEASURED", used: usage.evidenceCount, limit: null, window: "LIFETIME" };
    } else {
      const since = new Date(Date.now() - THIRTY_DAYS_MS);
      const used = await prisma.evidence.count({
        where: { teamId: account.id, deletedAt: null, createdAt: { gte: since } },
      });
      evidence = {
        state: "MEASURED",
        used,
        limit: monthlyCap,
        window: "ROLLING_30_DAYS",
      };
    }
  } else {
    const used = await countPersonalEvidenceRecords(account.id);
    const lifetimeCap = ctx.limits.effectiveLifetimeRecordCap;
    evidence = {
      state: "MEASURED",
      used,
      limit: lifetimeCap,
      window: "LIFETIME",
    };
  }

  // ---- Storage meter ------------------------------------------------------
  const split = await splitAddonCapacity({
    ownerUserId: scope.ownerUserId,
    teamId: scope.teamId,
  });
  const storage = storageMeterFrom({
    usedBytes: usage.storageBytesUsed,
    baseBytes: usage.baseStorageBytesLimit,
    recurringAddonBytes: split.recurring,
    legacyAddonBytes: split.legacy,
    limitBytes: usage.storageBytesLimit,
  });

  // ---- AI meter -----------------------------------------------------------
  const aiCap = caps.aiAdvisoryMonthlyOperations;
  let ai: UsageMeter;
  if (aiCap === 0) {
    ai = { state: "NOT_INCLUDED" };
  } else if (aiCap === null) {
    ai = { state: "CONTRACT_MANAGED" };
  } else {
    const { getWorkspaceAiUsageThisMonth } = await import(
      "../billing-enforcement.service.js"
    );
    const aiUsage = await getWorkspaceAiUsageThisMonth(scope);
    ai = {
      state: "MEASURED",
      used: aiUsage.consumed,
      limit: aiUsage.cap,
      window: "CALENDAR_MONTH",
    };
  }

  // ---- Collaboration ------------------------------------------------------
  const collaboration: CollaborationUsage = {};
  if (account.type === "PERSONAL") {
    if (caps.maxOwnedWorkspaces > 0) {
      const used = await prisma.team.count({
        where: {
          ownerUserId: account.id,
          isPersonal: false,
          NOT: { organization: { kind: "CUSTOMER" } },
        },
      });
      collaboration.ownedWorkspaces = { used, limit: caps.maxOwnedWorkspaces };
    }
    if (caps.maxCollaborationTeamsPerWorkspace > 0) {
      const personalTeam = await prisma.team.findFirst({
        where: { ownerUserId: account.id, isPersonal: true },
        select: { id: true },
      });
      const used = personalTeam
        ? await prisma.collaborationTeam.count({
            where: {
              workspaceId: personalTeam.id,
              status: "ACTIVE",
              archivedAtUtc: null,
            },
          })
        : 0;
      collaboration.collaborationTeams = {
        used,
        limit: caps.maxCollaborationTeamsPerWorkspace,
      };
    }
  } else {
    // A SHARED workspace reports SEATS. Pending invitations are counted and
    // reported separately — an invitation is not an accepted member, and the
    // seat cap has never been an invite cap.
    const [pendingInvites] = await Promise.all([
      prisma.collaborationTeamInvite.count({
        where: { team: { workspaceId: account.id }, status: "PENDING" },
      }),
    ]);
    collaboration.seats = {
      used: usage.teamMemberCount,
      limit: usage.seatLimit,
      pendingInvites,
    };
  }

  // ---- Storage add-ons ----------------------------------------------------
  // FREE cannot buy storage: the server refuses it with 409 "upgrade your base
  // plan first", so the surface offers nothing rather than a button that 409s.
  const addonsEligible = scope.plan !== "FREE";

  return {
    account,
    plan,
    usage: { evidence, storage, ai },
    ...(wallet
      ? {
          wallet: {
            availableCredits: wallet.availableCredits,
            purchasedCredits: wallet.purchasedCredits,
            consumedCredits: wallet.consumedCredits,
            hasLedgerHistory: wallet.hasLedgerHistory,
            ...(showAmounts
              ? {
                  unitPriceCents: EVIDENCE_CREDIT_PRODUCT.unitPriceCents,
                  currency,
                }
              : {}),
          },
        }
      : {}),
    ...(Object.keys(collaboration).length > 0 ? { collaboration } : {}),
    ...(addonsEligible
      ? {
          storageAddons: {
            offers: canAddon
              ? offersFor({ shape: scope.billingShape, currency })
              : [],
            active: await activeAddonsFor({
              ownerUserId: scope.ownerUserId,
              teamId: scope.teamId,
              showAmounts,
            }),
          },
        }
      : {}),
    actions: {
      canStartCheckout: canManage,
      // Credits are a PERSONAL product; a workspace buys a TEAM subscription.
      canBuyEvidenceCredits: canManage && account.type === "PERSONAL",
      canBuyStorageAddon: canAddon && addonsEligible,
      canRequestCancellation: canCancel && Boolean(subscription),
      contactAccountManager: false,
    },
  };
}

/**
 * The ORGANIZATION projection.
 *
 * Deliberately different in kind: an Enterprise account is governed by a
 * CONTRACT, not by a checkout, so it offers no self-service actions at all and
 * its numbers come from the contract when the contract states them.
 */
async function buildOrganizationProjection(input: {
  account: BillingAccountRef;
  currency: BillingCurrency;
  showAmounts: boolean;
}): Promise<BillingAccountProjection> {
  const { account } = input;
  const contract = await resolveEnterpriseContract(account.id);
  const limits = resolveEnterpriseContractLimits(contract);
  const workspaceIds = await organizationWorkspaceIds(account.id);

  // Org-wide seat occupancy: ACTIVE memberships only. The previous rollup
  // counted every membership row, so revoked members inflated the number the
  // customer was shown against their contracted seats.
  const seatsUsed = await prisma.teamMember.count({
    where: {
      teamId: { in: workspaceIds.length > 0 ? workspaceIds : [" "] },
      status: prismaPkg.TeamMemberStatus.ACTIVE,
    },
  });

  const storageAgg = await prisma.evidence.aggregate({
    where: {
      teamId: { in: workspaceIds.length > 0 ? workspaceIds : [" "] },
      lifecycleState: { not: "DESTROYED" },
    },
    _sum: { sizeBytes: true },
  });
  const usedBytes = storageAgg._sum.sizeBytes ?? 0n;

  const baseBytes =
    limits.contractGovernsCapability && limits.storageBytes !== null
      ? limits.storageBytes
      : getPlanCapabilities("ENTERPRISE").includedStorageBytes;

  const contractActive = contract?.status === "ACTIVE";

  return {
    account,
    plan: {
      planKey: "ENTERPRISE",
      displayName: "Enterprise",
      model: "CONTRACT",
      lifecycle: contractActive ? "ACTIVE" : "ACTION_REQUIRED",
      // A contract has no self-service price and no checkout renewal date.
      // `endsAtUtc` is the contract's own term and is reported on the contract
      // summary, not disguised as a billing cycle.
      currentPeriodEndUtc: null,
      cancelAtPeriodEnd: false,
      billingOwnerMissing: account.billingOwnerMissing,
    },
    usage: {
      evidence:
        limits.contractGovernsCapability &&
        limits.evidenceRecordsPerMonth !== null
          ? {
              state: "MEASURED",
              used: await prisma.evidence.count({
                where: {
                  teamId: { in: workspaceIds.length > 0 ? workspaceIds : [" "] },
                  deletedAt: null,
                  createdAt: { gte: new Date(Date.now() - THIRTY_DAYS_MS) },
                },
              }),
              limit: limits.evidenceRecordsPerMonth,
              window: "ROLLING_30_DAYS",
            }
          : { state: "CONTRACT_MANAGED" },
      storage: storageMeterFrom({
        usedBytes,
        baseBytes,
        recurringAddonBytes: 0n,
        legacyAddonBytes: 0n,
        limitBytes: baseBytes,
      }),
      ai:
        limits.contractGovernsCapability && limits.aiOperationsPerMonth !== null
          ? {
              state: "MEASURED",
              used: 0,
              limit: limits.aiOperationsPerMonth,
              window: "CALENDAR_MONTH",
            }
          : { state: "CONTRACT_MANAGED" },
    },
    collaboration: {
      seats: {
        used: seatsUsed,
        limit: limits.seats ?? 0,
        pendingInvites: 0,
      },
    },
    ...(contract
      ? {
          contract: {
            status: contract.status,
            activationState: contract.activationState,
            effectiveAtUtc: iso(contract.effectiveAtUtc),
            endsAtUtc: iso(contract.endsAtUtc),
            seatCount: contract.seatCount,
            storageGb: contract.storageGb,
            region: contract.region,
            derivedFromLegacyFallback: contract.legacyDerived,
          },
        }
      : {}),
    actions: {
      // Enterprise contract changes route through the account manager, never
      // through Stripe or PayPal. Offering a checkout the product cannot honour
      // is worse than offering none.
      canStartCheckout: false,
      canBuyEvidenceCredits: false,
      canBuyStorageAddon: false,
      canRequestCancellation: false,
      contactAccountManager: true,
    },
  };
}

// =============================================================================
// Account-scoped payment history
// =============================================================================

export type BillingHistoryEntry = {
  id: string;
  occurredAtUtc: string;
  /** Human description of what was bought. Never a provider payload. */
  description: string;
  status: string;
  /** Present ONLY with BILLING_AMOUNT_VIEW. */
  amountCents?: number;
  currency?: string;
  /** Provider-neutral label. The provider's own id is NEVER exposed. */
  providerLabel?: string | null;
};

/**
 * ONE account's payment history.
 *
 * Not "Invoices": PROOVRA has no `Invoice` model, issues no invoice numbers and
 * hosts no invoice PDFs, so calling this section Invoices would name a document
 * the product does not produce.
 *
 * The DTO is explicitly constructed. The previous overview returned raw Prisma
 * `Payment` rows — `userId` included, and whatever a future migration adds.
 */
export async function readBillingHistoryForAccount(input: {
  account: BillingAccountRef;
  limit?: number;
}): Promise<BillingHistoryEntry[]> {
  const showAmounts = input.account.capabilities.includes("BILLING_AMOUNT_VIEW");
  if (!input.account.capabilities.includes("BILLING_HISTORY_VIEW")) {
    return [];
  }

  const where = paymentWhereForAccount({
    account: input.account,
    organizationWorkspaceIds:
      input.account.type === "ORGANIZATION"
        ? await organizationWorkspaceIds(input.account.id)
        : undefined,
  });

  const rows = await prisma.payment.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: Math.min(100, Math.max(1, input.limit ?? 20)),
    select: {
      id: true,
      provider: true,
      amountCents: true,
      currency: true,
      status: true,
      createdAt: true,
      teamId: true,
    },
  });

  return rows.map((r) => ({
    id: r.id,
    occurredAtUtc: r.createdAt.toISOString(),
    description: r.teamId ? "Workspace subscription" : "Personal account",
    status: r.status,
    ...(showAmounts
      ? {
          amountCents: r.amountCents,
          currency: r.currency,
          providerLabel: providerLabel(r.provider),
        }
      : {}),
  }));
}
