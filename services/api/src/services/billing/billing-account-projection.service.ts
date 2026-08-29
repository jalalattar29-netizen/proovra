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
  // BILLING SURFACE CORRECTION (2026-08-29) — the SAME admission policy the
  // enforcement chokepoint calls, so what the page says about the next record
  // is what the gate will do with it.
  resolvePersonalEvidenceAdmission,
} from "@proovra/shared-billing";

import {
  paymentRowActions,
  type PaymentRowActions,
} from "./pending-payments.service.js";
import { prisma } from "../../db.js";
import {
  organizationWorkspaceIds,
  paymentWhereForAccount,
  type BillingAccountRef,
} from "./billing-accounts.service.js";
import { readEvidenceCreditWallet } from "./evidence-credits.service.js";
import {
  summarizeDependentCancellations,
  type DependentCancellationSummary,
} from "./dependent-cancellation.service.js";
import { resolveEnterpriseContract } from "../organization/enterprise-contract.service.js";
import {
  resolveEffectiveContractEvidenceCap,
  resolveEnterpriseContractLimits,
} from "./enterprise-contract-limits.js";
import {
  AI_USAGE_KEY,
  countPersonalEvidenceRecords,
  startOfCurrentMonthUtc,
} from "../billing-enforcement.service.js";
import { getWorkspaceUsage } from "../workspace-usage.service.js";
import { resolveCommercialContext } from "./commercial-context.service.js";
import { listStorageAddonDefinitions } from "../billing.service.js";
// BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — the ONE plan -> storage
// catalogue decision, and the ONE personal-evidence counter, both shared with
// the enforcement path so the meter cannot disagree with the gate.
import { storageAddonOffersForPlan } from "../workspace-usage.service.js";
import {
  getPlanPriceCents,
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

/**
 * BILLING SURFACE CORRECTION (2026-08-29) — what the NEXT evidence record
 * actually needs, decided by the same policy the gate enforces.
 *
 * The page was rendering "49 over the 127 your plan includes" from a single
 * number, and every part of that sentence was doing something wrong:
 *
 *   * 127 is not what the plan includes. PRO includes 100. 127 is a
 *     GRANDFATHERED per-payer override (`legacyRecordCapOverride`), which
 *     `resolveCommercialContext` substitutes for the plan cap. Calling it
 *     "your plan" told a customer their plan was something it is not.
 *   * The 49 read as a debt to clear. It is not. Admission does not compare
 *     the deficit against anything — once the lifetime allowance is used up,
 *     each further record is authorised by ONE credit, whether the account is
 *     one over or fifty.
 *   * "buying an evidence credit is what makes room for the next record" was
 *     true, and unbelievable beside a number that implied 49 were needed.
 *
 * So the projection now carries the parts separately, and the page states
 * them. `resolvePersonalEvidenceAdmission` is the SAME pure policy
 * `billing-enforcement` calls, given the same inputs — so what the page says
 * about the next record is what the gate will do with it, by construction.
 */
export type EvidenceAdmission = {
  /** What the PLAN includes, before any grandfather substitution. */
  planIncludedLifetime: number | null;
  /**
   * The cap actually enforced. Differs from `planIncludedLifetime` only for a
   * grandfathered account, and `capSource` says which it is.
   */
  effectiveLifetimeCap: number | null;
  capSource: "PLAN_DEFAULT" | "LEGACY_RECORD_CAP_OVERRIDE";
  /** Non-destroyed records the account holds. */
  recordsHeld: number;
  /** Unspent purchased credits. */
  creditsAvailable: number;
  /** Plan capacity left, floored at zero. Null when the plan is uncapped. */
  planCapacityRemaining: number | null;
  /** True once `recordsHeld` has passed the enforced cap. */
  overCap: boolean;
  /** How the NEXT record would be funded, or why it would be refused. */
  next:
    | { allowed: true; funding: "PLAN" | "EVIDENCE_CREDIT" }
    | {
        allowed: false;
        reason: "PLAN_ALLOWANCE_EXHAUSTED_NO_CREDITS" | "CREDIT_REQUIRED_NONE_AVAILABLE";
      };
};

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
  /**
   * BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — a PROVIDER-ACCEPTED
   * change that has not taken effect yet.
   *
   * Present only while one is outstanding, so its absence means "nothing
   * scheduled" rather than "we did not look". Without it the plan card would
   * show TEAM to a customer who scheduled a downgrade last week and has no way
   * to tell whether we heard them.
   */
  scheduledChange?: {
    planKey: string;
    displayName: string;
    effectiveAtUtc: string | null;
  };
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
  // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — `ownedWorkspaces` was
  // REMOVED from the DTO, not merely left unset, so no client can render a
  // workspace allowance that no plan grants.
  collaborationTeams?: { used: number; limit: number };
  seats?: {
    /** ACCEPTED members only. */
    used: number;
    /**
     * BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — NULLABLE, because an
     * Enterprise agreement is allowed to be silent about seats.
     *
     * It was `number`, and the organization projection passed
     * `contract.seatCount ?? 0` into it — so a contract that simply does not
     * name a seat count rendered "12 of 0 accepted members". That is the
     * fabricated zero this projection already learned not to publish on the AI
     * meter, in a place nobody had looked: it reads as a breach, it is not one,
     * and no number we could substitute would be the agreement's.
     */
    limit: number | null;
    /** Counted and reported SEPARATELY — an invite is not a member. */
    pendingInvites: number;
  };
};

/**
 * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — what this account may BUY, and
 * what that costs, decided on the server.
 *
 * The checkout surface used to hold this itself: a client function returned
 * `"PRO"` or `"TEAM"` from the account kind and hard-coded the blurb —
 * "500 records, 500 GB" — in the browser. That is a second copy of the
 * commercial catalog, in the one place that cannot be kept in step with it, and
 * it is the same class of defect as the limits the old page rendered from the
 * platform envelope.
 */
export type PlanOffer = {
  /** The plan key the checkout and change routes accept. */
  planKey: "PRO" | "TEAM";
  displayName: string;
  /** Present ONLY with BILLING_AMOUNT_VIEW. */
  priceCents?: number;
  currency?: BillingCurrency;
  /** Server-composed from the canonical catalog. Never written in the client. */
  summary: string;
  /**
   * BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — WHAT this offer does,
   * decided here.
   *
   * The list used to hold only plans ABOVE the current one, and the page
   * turned every one of them into "start a checkout" because that was the only
   * verb it had. Two things were therefore impossible to express: that a
   * customer with a live subscription is CHANGING it rather than buying a
   * second one, and that a lower tier is an offer at all.
   *
   *   CHECKOUT   nothing live — a purchase, through the provider's hosted page
   *   UPGRADE    a live subscription moving UP, effective immediately
   *   DOWNGRADE  a live subscription moving DOWN, effective at period end
   *
   * The client renders the verb; it never derives it by comparing plan names,
   * which is the same comparison the server has already made against a
   * subscription the browser cannot see.
   */
  action: "CHECKOUT" | "UPGRADE" | "DOWNGRADE";
  /** When it takes effect, in the customer's terms. */
  effect: "IMMEDIATE" | "AT_PERIOD_END";
  /**
   * The button's words, composed HERE.
   *
   * "Upgrade to Team", "Switch to Pro" and "Subscribe to Pro" are three
   * different claims about what pressing it will do, and only the server knows
   * which is true — it is the side that can see whether a subscription exists.
   * A browser choosing between them is a browser holding commercial logic.
   */
  actionLabel: string;
  /**
   * What happens, in one sentence, before the customer commits. Shown in the
   * confirmation. Never assembled in the client.
   */
  effectSummary: string;
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
  /**
   * Whether THIS add-on can be cancelled by THIS viewer.
   *
   * Decided here rather than in the browser, because it depends on three
   * server facts at once: the viewer's add-on capability, whether the row is
   * a grandfathered one-time purchase (which has no recurring charge to
   * stop), and whether the subscription is still in a cancellable state. A
   * client re-deriving that from a raw status string is a commercial
   * decision in the one place that must not hold them.
   */
  canCancel: boolean;
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
    /**
     * BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — how many credits ONE
     * purchase grants.
     *
     * The purchase surface showed the BALANCE and the unit price and nothing
     * else, so "3 available" sat directly above a Buy button and the only
     * quantity on screen was the one the customer already had. Whether
     * pressing it bought one credit, three, or topped something up to a round
     * number was not stated anywhere.
     *
     * It comes from the canonical product definition, never from the client:
     * a quantity a browser could choose is a quantity a browser could get
     * wrong, and this product sells a fixed one.
     */
    creditsPerPurchase: number;
  };
  /**
   * PERSONAL accounts only. Absent for a contract-managed Organization, whose
   * allowance is a term of the agreement rather than a wallet plus a cap.
   */
  evidenceAdmission?: EvidenceAdmission;
  collaboration?: CollaborationUsage;
  contract?: EnterpriseContractSummary;
  /** Plans this account may purchase. Empty when it may purchase none. */
  planOffers?: PlanOffer[];
  /**
   * What needs doing, if anything.
   *
   * Composed HERE because every input is a server fact — the bounded grace
   * clock, whether a billing owner is assigned, whether storage is really
   * exhausted. The client used to branch on the lifecycle value to decide
   * whether to show a banner at all, which is a commercial judgement wearing
   * presentation clothes. `null` means nothing needs doing.
   */
  actionRequired: {
    severity: "CRITICAL" | "WARNING";
    title: string;
    messages: string[];
    /** Self-serve reassurance. Null where there is no card to reassure about. */
    reassurance: string | null;
  } | null;
  storageAddons?: {
    offers: StorageAddonOffer[];
    active: ActiveStorageAddon[];
  };
  /**
   * BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — why storage add-ons are
   * NOT on offer, when a higher tier would put them there.
   *
   * FREE cannot buy storage: the server refuses it, so the surface offered
   * nothing — and said nothing either. A customer looking at a full 250 MB
   * meter with no way to add capacity and no explanation has been left to
   * guess whether the feature is missing, broken, or simply not theirs.
   *
   * Composed HERE because "which tier unlocks this" is a commercial fact. The
   * page renders the sentence and the action; it does not work out either.
   * Absent whenever add-ons ARE available, so its presence is the condition.
   */
  storageAddonsLocked?: {
    reason: string;
    /** The lowest tier that includes them. Null when nothing self-service does. */
    unlockedByPlan: string | null;
  };
  /**
   * BILLING DEPENDENT-CANCELLATION CONVERGENCE (2026-08-27) — storage add-ons
   * whose cancellation the provider has not confirmed.
   *
   * Present ONLY while something is still owed, so its absence means "nothing
   * outstanding" rather than "we did not look". Counts, timestamps and two
   * booleans: no add-on id, no provider id, no reason code, no error text —
   * the page renders this verbatim.
   */
  dependentStorageCancellation?: DependentCancellationSummary;
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
    /**
     * The label for the manage-plan control.
     *
     * Decided HERE because "is this an upgrade or a change?" is a commercial
     * question about the account's current model, and a client branching on
     * that model to pick a word is a client holding commercial logic. Null
     * when there is no manage action to render.
     */
    manageLabel: string | null;
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
  canPurchaseAddons: boolean;
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
      canCancel:
        params.canPurchaseAddons &&
        !legacyOneTime &&
        (r.status === prismaPkg.WorkspaceStorageAddonStatus.ACTIVE ||
          r.status === prismaPkg.WorkspaceStorageAddonStatus.PAST_DUE),
      activatedAtUtc: iso(r.activatedAtUtc),
      currentPeriodEndUtc: iso(r.currentPeriodEnd),
      ...(params.showAmounts
        ? { priceCents: r.amountCents, currency: r.currency }
        : {}),
    };
  });
}

/**
 * BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — the tiers ABOVE the one
 * the customer is on.
 *
 * This used to return exactly one offer, chosen by account type: a WORKSPACE
 * was offered TEAM and a PERSONAL account was offered PRO. That is the
 * obsolete model stated as a function — TEAM was not something a person could
 * buy for the workspace they work in, so a PRO customer wanting more capacity
 * was told to create a second workspace.
 *
 * The self-service progression is FREE → PRO → TEAM on ONE Personal Workspace,
 * so the offers are simply the tiers above the current one:
 *
 *   FREE  →  PRO, TEAM      (either, directly)
 *   PRO   →  TEAM           (never PRO again — it is already active)
 *   TEAM  →  nothing        (the top self-service tier)
 *
 * An ORGANIZATION is contract-managed and reaches this with no offers at all.
 */
/**
 * The plan moves this account may make, and what each one WOULD do.
 *
 * BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — this returned only the
 * tiers ABOVE the current one, which encoded two assumptions that are no
 * longer true: that the only direction is up, and that every offer is bought
 * through a checkout. Both came from the old model, where TEAM was a different
 * WORKSPACE's plan rather than the next tier of this one — there was no "down"
 * to offer and nothing to change, only more things to buy.
 *
 * A customer on TEAM who needs less should be able to say so and keep what
 * they paid for until the period ends. That is a first-class offer here, not
 * an absence they have to work around by cancelling and re-buying.
 */
function planOffersFor(params: {
  currentPlan: prismaPkg.PlanType;
  /**
   * True when the account has a live subscription. It decides the VERB, not
   * the list: with one, a move is a change on that subscription; without one,
   * it is a purchase. Deriving this from the plan instead would be wrong in
   * exactly the case that matters — a FREE account whose subscription is
   * PAST_DUE still has one, and must not be sent to buy a second.
   */
  hasLiveSubscription: boolean;
  currency: BillingCurrency;
  showAmounts: boolean;
}): PlanOffer[] {
  const LADDER: ReadonlyArray<"PRO" | "TEAM"> = ["PRO", "TEAM"];

  const rank = (plan: prismaPkg.PlanType): number => {
    switch (plan) {
      case prismaPkg.PlanType.PRO:
        return 1;
      case prismaPkg.PlanType.TEAM:
        return 2;
      // FREE, and the grandfathered PAYG credit overlay, which sits ON a FREE
      // account. Credits are a wallet; they are not a tier.
      default:
        return 0;
    }
  };

  // ENTERPRISE is contracted. Offering it a self-service move would offer to
  // replace a signed agreement with a card payment.
  if (params.currentPlan === prismaPkg.PlanType.ENTERPRISE) return [];

  const current = rank(params.currentPlan);

  return LADDER.filter((planKey) => rank(planKey) !== current).map((planKey) => {
    const up = rank(planKey) > current;
    const action = !params.hasLiveSubscription
      ? ("CHECKOUT" as const)
      : up
        ? ("UPGRADE" as const)
        : ("DOWNGRADE" as const);

    const described = describeOffer(planKey, params.currency, params.showAmounts);

    return {
      ...described,
      action,
      // A purchase and an upgrade both start now. Only a downgrade waits, and
      // it waits because the current period is already paid for.
      effect: action === "DOWNGRADE" ? ("AT_PERIOD_END" as const) : ("IMMEDIATE" as const),
      actionLabel:
        action === "CHECKOUT"
          ? `Subscribe to ${described.displayName}`
          : action === "UPGRADE"
            ? `Upgrade to ${described.displayName}`
            : `Switch to ${described.displayName}`,
      effectSummary:
        action === "CHECKOUT"
          ? `You will be taken to your payment provider to subscribe to ${described.displayName}.`
          : action === "UPGRADE"
            ? `${described.displayName} starts straight away. Your provider charges the difference for the rest of this period, and nothing you have already recorded changes.`
            : `You keep ${
                params.currentPlan === prismaPkg.PlanType.TEAM ? "Team" : "your current plan"
              } until the end of the period you have already paid for, then move to ${
                described.displayName
              }. Nothing is deleted — your evidence, teams and members all stay.`,
    };
  });
}

function describeOffer(
  planKey: "PRO" | "TEAM",
  currency: BillingCurrency,
  showAmounts: boolean,
): Omit<PlanOffer, "action" | "effect" | "actionLabel" | "effectSummary"> {
  const caps = getPlanCapabilities(planKey);

  const records =
    caps.maxEvidenceRecordsPerMonth !== null
      ? `${caps.maxEvidenceRecordsPerMonth} evidence records in any 30 days`
      : caps.maxEvidenceRecords !== null
        ? `${caps.maxEvidenceRecords} lifetime evidence records`
        : "no evidence-record limit";
  const storage = `${formatBytesHuman(caps.includedStorageBytes)} of cumulative storage`;
  const ai =
    caps.aiAdvisoryMonthlyOperations === null
      ? null
      : caps.aiAdvisoryMonthlyOperations > 0
        ? `${caps.aiAdvisoryMonthlyOperations} AI operations a month`
        : null;

  return {
    planKey,
    displayName: caps.displayName,
    summary: [records, storage, ai].filter(Boolean).join(", "),
    ...(showAmounts
      ? {
          priceCents: getPlanPriceCents(planKey as prismaPkg.PlanType, currency),
          currency,
        }
      : {}),
  };
}

/**
 * BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — keyed on the PLAN, and
 * the list comes from the ONE authority rather than being re-derived here.
 *
 * This filtered `listStorageAddonDefinitions()` by billing SHAPE. A personal
 * workspace is SINGLE_OCCUPANT on every tier, so a TEAM customer opening the
 * storage drawer was offered the PRO catalogue — +10/+50/+200 GB instead of
 * +100/+500 GB/+1 TB — and could not buy the capacity their plan sells.
 * Measured against the running API, not inferred.
 */
function offersFor(params: {
  plan: prismaPkg.PlanType;
  currency: BillingCurrency;
}): StorageAddonOffer[] {
  return storageAddonOffersForPlan(params.plan)
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
      // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — the scheduled
      // change, so the plan card can say what is coming and when.
      pendingPlan: true,
      pendingPlanEffectiveAtUtc: true,
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
    ...(subscription?.pendingPlan
      ? {
          scheduledChange: {
            planKey: subscription.pendingPlan,
            displayName: getPlanCapabilities(subscription.pendingPlan).displayName,
            effectiveAtUtc: iso(subscription.pendingPlanEffectiveAtUtc ?? null),
          },
        }
      : {}),
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
  let evidenceAdmission: EvidenceAdmission | undefined;
  if (scope.billingShape === "SHARED") {
    // BILLING PRODUCTION CLOSURE (2026-08-27) — the meter resolves its cap the
    // way the gate resolves its cap. `ctx.limits.effectiveMonthlyRecordCap` is
    // the CATALOG value; `assertWorkspaceAllowsEvidenceCreation` asks
    // `resolveEffectiveContractEvidenceCap`. For an ENTERPRISE workspace with a
    // contracted allowance those are different numbers, and a meter that
    // disagrees with the gate is how a customer is refused at a limit the page
    // told them they had not reached.
    const monthlyCap = resolveEffectiveContractEvidenceCap({
      plan: scope.plan,
      contract: scope.contractLimits,
    });
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
    // ========================================================================
    // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — a personal account
    // can now hold a ROLLING allowance, and this branch only knew about
    // lifetime ones.
    // ========================================================================
    //
    // TEAM's allowance is 500 evidence records in any 30 days; it has no
    // lifetime cap at all. This reported the LIFETIME window with
    // `effectiveLifetimeRecordCap`, which is null on TEAM — so the page told a
    // TEAM customer they had NO limit while `billing-enforcement` refused them
    // at 500. A meter disagreeing with the gate is the defect the workspace
    // branch above already carries a comment about; TEAM only became reachable
    // on a personal account in this change, so this branch had never had to
    // handle it.
    //
    // The cap comes from `resolveEffectiveContractEvidenceCap` — the SAME
    // authority the gate calls — and the count is taken over the same window,
    // through the same personal counter, so the two cannot drift.
    const monthlyCap = resolveEffectiveContractEvidenceCap({
      plan: scope.plan,
      contract: scope.contractLimits,
    });

    if (monthlyCap !== null && monthlyCap > 0) {
      const since = new Date(Date.now() - THIRTY_DAYS_MS);
      evidence = {
        state: "MEASURED",
        used: await countPersonalEvidenceRecords(account.id, {
          createdSince: since,
        }),
        limit: monthlyCap,
        window: "ROLLING_30_DAYS",
      };
    } else {
      const held = await countPersonalEvidenceRecords(account.id);
      const cap = ctx.limits.effectiveLifetimeRecordCap;

      // The parts, separately, because the single number they were collapsed
      // into could not be stated truthfully. See `EvidenceAdmission`.
      evidenceAdmission = {
        planIncludedLifetime: caps.maxEvidenceRecords,
        effectiveLifetimeCap: cap,
        capSource: ctx.limits.source,
        recordsHeld: held,
        creditsAvailable: Math.max(0, scope.credits ?? 0),
        planCapacityRemaining: cap === null ? null : Math.max(0, cap - held),
        overCap: cap !== null && held > cap,
        next: resolvePersonalEvidenceAdmission({
          plan: scope.plan,
          currentRecordCount: held,
          effectiveLifetimeRecordCap: cap,
          availableEvidenceCredits: Math.max(0, scope.credits ?? 0),
        }),
      };

      evidence = {
        state: "MEASURED",
        used: held,
        limit: cap,
        window: "LIFETIME",
      };
    }
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
    // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — the "Owned
    // workspaces: 1 of 2" meter was REMOVED from the Billing page.
    //
    // A meter is a promise: it says this is an allowance your plan grants and
    // this is how much of it you have left. No plan grants additional
    // workspaces, so the meter measured an allowance that does not exist and
    // invited people to spend it. The Collaboration Teams meter below is the
    // real collaboration allowance and stays.
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

  // THE banner decision, made once, on the server.
  const storageFull = storage.state === "MEASURED" && storage.limitReached;
  const lifecycleNeedsAction =
    plan.lifecycle === "PAST_DUE" || plan.lifecycle === "ACTION_REQUIRED";
  const bannerMessages: string[] = [];
  if (plan.lifecycle === "PAST_DUE") {
    const until = iso(ctx.lifecycle.graceEndsAtUtc);
    bannerMessages.push(
      until
        ? `We could not take the last payment. Access continues until ${until.slice(0, 10)} while we retry.`
        : "We could not take the last payment.",
    );
  } else if (plan.lifecycle === "ACTION_REQUIRED") {
    bannerMessages.push("Billing needs attention before paid features continue.");
  }
  if (account.billingOwnerMissing) {
    bannerMessages.push(
      "No one is currently assigned to pay for this account. A workspace owner or organization administrator needs to take it on.",
    );
  }
  if (storageFull) {
    bannerMessages.push(
      "Storage is full. New evidence cannot be recorded until space is freed or capacity is added.",
    );
  }

  // BILLING DEPENDENT-CANCELLATION CONVERGENCE (2026-08-27) — the PERSISTENT
  // half of the failure.
  //
  // A cancellation whose add-ons did not all stop used to be told once, in a
  // toast, and then vanish: after a refresh the customer saw an active add-on
  // with no explanation, while it kept billing. It is now a server fact on the
  // projection, so it survives reload and stays until the provider confirms.
  const dependentCancellation = await summarizeDependentCancellations({
    ownerUserId: scope.ownerUserId,
    teamId: scope.teamId,
  });
  if (dependentCancellation) {
    const many = dependentCancellation.affectedCount > 1;
    const subject = many
      ? `${dependentCancellation.affectedCount} storage add-ons are`
      : "a storage add-on is";
    bannerMessages.push(
      dependentCancellation.supportRequired
        ? `Your plan cancellation was accepted, but ${subject} still being stopped and our automatic retries have not succeeded. ${many ? "They" : "It"} may continue billing until your provider confirms the cancellation — please contact support.`
        : `Your plan cancellation was accepted, but ${subject} still being stopped. ${many ? "They" : "It"} may continue billing until your payment provider confirms the cancellation. We are retrying automatically.`,
    );
  }

  return {
    account,
    plan,
    usage: { evidence, storage, ai },
    ...(dependentCancellation
      ? { dependentStorageCancellation: dependentCancellation }
      : {}),
    actionRequired:
      bannerMessages.length > 0
        ? {
            // An add-on that may still be charging is CRITICAL by the same
            // measure as a failed payment: money is moving against the
            // customer's stated intent.
            severity:
              lifecycleNeedsAction || dependentCancellation
                ? "CRITICAL"
                : "WARNING",
            title:
              lifecycleNeedsAction || dependentCancellation
                ? "Action required"
                : "Attention needed",
            messages: bannerMessages,
            reassurance: "Nothing has been charged again.",
          }
        : null,
    ...(wallet
      ? {
          wallet: {
            availableCredits: wallet.availableCredits,
            purchasedCredits: wallet.purchasedCredits,
            consumedCredits: wallet.consumedCredits,
            hasLedgerHistory: wallet.hasLedgerHistory,
            creditsPerPurchase: EVIDENCE_CREDIT_PRODUCT.creditsGrantedPerPurchase,
            ...(showAmounts
              ? {
                  unitPriceCents: EVIDENCE_CREDIT_PRODUCT.unitPriceCents,
                  currency,
                }
              : {}),
          },
        }
      : {}),
    ...(evidenceAdmission ? { evidenceAdmission } : {}),
    ...(Object.keys(collaboration).length > 0 ? { collaboration } : {}),
    ...(canManage
      ? {
          planOffers: planOffersFor({
            // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — a
            // self-service account is always PERSONAL. The ternary that stood
            // here picked a WORKSPACE subject and, with it, a different plan
            // offer set: that is what made TEAM an offer for a DIFFERENT
            // workspace rather than the next tier of this one.
            currentPlan: scope.plan,
            // A subscription that has not reached its terminal state is live —
            // PAST_DUE and TRIALING included. Treating those as "no
            // subscription" would send a customer to buy a second one.
            hasLiveSubscription: Boolean(
              subscription &&
                subscription.status !== prismaPkg.SubscriptionStatus.CANCELED,
            ),
            currency,
            showAmounts,
          }),
        }
      : {}),
    // Not eligible, but a self-service tier would make it so — say so.
    // ENTERPRISE is excluded deliberately: its capacity comes from the
    // contract, and offering an "upgrade" would be offering to replace a
    // signed agreement with a card payment.
    ...(!addonsEligible && account.type === "PERSONAL" && scope.plan === "FREE"
      ? {
          storageAddonsLocked: {
            reason:
              "Extra storage is part of Pro and Team. Your plan includes its own storage, and you can add more once you move up.",
            unlockedByPlan: "PRO",
          },
        }
      : {}),
    ...(addonsEligible
      ? {
          storageAddons: {
            offers: canAddon
              ? offersFor({ plan: scope.plan, currency })
              : [],
            active: await activeAddonsFor({
              ownerUserId: scope.ownerUserId,
              teamId: scope.teamId,
              showAmounts,
              canPurchaseAddons: canAddon,
            }),
          },
        }
      : {}),
    actions: {
      canStartCheckout: canManage,
      // An account paying nothing recurring is UPGRADING; one that already has
      // a subscription is CHANGING it.
      manageLabel: canManage
        ? model === "MONTHLY"
          ? "Change plan"
          : "Upgrade plan"
        : null,
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
      teamId: { in: workspaceIds },
      status: prismaPkg.TeamMemberStatus.ACTIVE,
    },
  });

  const storageAgg = await prisma.evidence.aggregate({
    where: {
      teamId: { in: workspaceIds },
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
    actionRequired: contractActive
      ? null
      : {
          severity: "CRITICAL",
          title: "Action required",
          messages: [
            "This organization's agreement is not currently active. Your account manager can confirm its status.",
          ],
          // Enterprise is invoiced by agreement; there is no card to
          // reassure anyone about.
          reassurance: null,
        },
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
                  teamId: { in: workspaceIds },
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
              // BILLING PRODUCTION CLOSURE (2026-08-27) — measured, not zero.
              // This read `used: 0` unconditionally, which is precisely the
              // fabricated zero the meter model exists to prevent: an
              // organization that had spent its entire contracted AI allowance
              // displayed "0 of 9,000". The sum is taken over the same
              // `EntitlementUsage` rows, key and period the AI gate decrements.
              used: Number(
                (
                  await prisma.entitlementUsage.aggregate({
                    where: {
                      teamId: { in: workspaceIds },
                      key: AI_USAGE_KEY,
                      periodStartUtc: startOfCurrentMonthUtc(),
                    },
                    _sum: { consumed: true },
                  })
                )._sum.consumed ?? 0n,
              ),
              limit: limits.aiOperationsPerMonth,
              window: "CALENDAR_MONTH",
            }
          : { state: "CONTRACT_MANAGED" },
    },
    collaboration: {
      seats: {
        used: seatsUsed,
        // NULL where the agreement is silent — never a substituted zero.
        limit: limits.seats ?? null,
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
      manageLabel: null,
    },
  };
}

// =============================================================================
// Account-scoped payment history
// =============================================================================

export type BillingHistoryEntry = {
  id: string;
  occurredAtUtc: string;
  /**
   * WHAT WAS BOUGHT. Never a provider payload.
   *
   * BILLING SURFACE CORRECTION (2026-08-29) — this was
   * `r.teamId ? "Workspace subscription" : "Personal account"`, which named
   * the PAYER rather than the purchase. Every personal row on the page — a
   * plan, an evidence credit, a storage add-on — read "Personal account", so
   * the history could not tell a customer what any line was for.
   *
   * It is now resolved from the durable rows that record the purchase itself:
   * the credit ledger entry, the storage add-on, or the subscription bound to
   * that provider reference. Where none of them claims it, the description
   * says only what is certain.
   */
  description: string;
  status: string;
  /** Present ONLY with BILLING_AMOUNT_VIEW. */
  amountCents?: number;
  currency?: string;
  /**
   * Provider-neutral label ("Card", "PayPal"). The provider's own id is NEVER
   * exposed.
   *
   * Outside the amount gate: which provider took a payment is not a monetary
   * figure, and a viewer who may see the history may see that a row is a PayPal
   * row. It is also what makes the row's available actions legible — a PayPal
   * row has no "Cancel payment" because PayPal has no such operation.
   */
  providerLabel?: string | null;
  /**
   * What the customer may do with THIS row, decided by the server from the
   * status, the provider's real capabilities and the viewer's own.
   */
  actions: PaymentRowActions;
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
      providerPaymentId: true,
      amountCents: true,
      currency: true,
      status: true,
      createdAt: true,
      teamId: true,
    },
  });

  const describe = await buildPaymentDescriber(rows);
  const viewerMayCancel = input.account.capabilities.includes("BILLING_CANCEL");

  return rows.map((r) => ({
    id: r.id,
    occurredAtUtc: r.createdAt.toISOString(),
    description: describe(r),
    status: r.status,
    providerLabel: providerLabel(r.provider),
    actions: paymentRowActions({
      status: r.status,
      provider: r.provider,
      viewerMayCancel,
    }),
    ...(showAmounts
      ? {
          amountCents: r.amountCents,
          currency: r.currency,
        }
      : {}),
  }));
}

/**
 * WHAT each payment bought, resolved from the durable rows that record it.
 *
 * BILLING SURFACE CORRECTION (2026-08-29). Three lookups, each keyed on the
 * SAME provider reference the payment stores, batched so a page of history
 * costs three queries rather than three per row:
 *
 *   1. an evidence-credit PURCHASE ledger entry  -> "Evidence credit"
 *   2. a storage add-on bound to that payment    -> "<label> storage add-on"
 *   3. a subscription bound to that reference    -> "<Plan> plan"
 *
 * Nothing is guessed from the amount. Two products can cost the same, and a
 * history that inferred the product from the price would eventually tell a
 * customer they bought something they did not.
 */
async function buildPaymentDescriber(
  rows: readonly {
    providerPaymentId: string;
    provider: prismaPkg.PaymentProvider;
    teamId: string | null;
  }[],
): Promise<
  (row: { providerPaymentId: string; teamId: string | null }) => string
> {
  const refs = [...new Set(rows.map((r) => r.providerPaymentId).filter(Boolean))];
  if (refs.length === 0) {
    return (row) => (row.teamId ? "Workspace subscription" : "Subscription payment");
  }

  const [creditPurchases, addons, subscriptions] = await Promise.all([
    prisma.evidenceCreditLedgerEntry.findMany({
      where: {
        entryType: prismaPkg.EvidenceCreditEntryType.PURCHASE,
        providerRef: { in: refs },
      },
      select: { providerRef: true, creditsDelta: true },
    }),
    prisma.workspaceStorageAddon.findMany({
      where: {
        OR: [
          { externalPaymentId: { in: refs } },
          { externalSubscriptionId: { in: refs } },
        ],
      },
      select: {
        externalPaymentId: true,
        externalSubscriptionId: true,
        addonKey: true,
        extraStorageBytes: true,
      },
    }),
    prisma.subscription.findMany({
      where: { providerSubId: { in: refs } },
      select: { providerSubId: true, plan: true },
    }),
  ]);

  const defs = listStorageAddonDefinitions();
  const byRef = new Map<string, string>();

  // Least specific first: a later, more specific match overwrites.
  for (const sub of subscriptions) {
    byRef.set(
      sub.providerSubId,
      `${getPlanCapabilities(sub.plan).displayName} plan`,
    );
  }
  for (const addon of addons) {
    const def = defs.find((d) => d.key === addon.addonKey);
    const label = def?.label ?? formatBytesHuman(addon.extraStorageBytes);
    for (const ref of [addon.externalPaymentId, addon.externalSubscriptionId]) {
      if (ref) byRef.set(ref, `${label} storage add-on`);
    }
  }
  for (const purchase of creditPurchases) {
    if (!purchase.providerRef) continue;
    const credits = Math.max(1, purchase.creditsDelta);
    byRef.set(
      purchase.providerRef,
      credits === 1 ? "Evidence credit" : `${credits} evidence credits`,
    );
  }

  return (row) =>
    byRef.get(row.providerPaymentId) ??
    (row.teamId ? "Workspace subscription" : "Subscription payment");
}
