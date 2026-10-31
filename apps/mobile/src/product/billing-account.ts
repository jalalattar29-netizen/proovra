/**
 * BILLING ACCOUNT — the account projection the web Billing page is built on
 * (`GET /v1/billing/accounts/:type/:id`, billing-account-projection.service.ts),
 * and the web's presentation of it (apps/web/app/(app)/billing/_sections/*,
 * format.ts), as pure functions.
 *
 * The page renders; it does not decide. Every capability, limit, price and
 * lifecycle state here was resolved by the server for this viewer on this
 * account. Nothing below recomputes one — it chooses words for what the server
 * sent, the same words the web chooses.
 *
 * PURCHASING IS NOT HERE. Starting a subscription, changing a plan, buying
 * storage, buying credits and resuming a provider checkout are the pending
 * distribution-policy decision (see ./billing PURCHASE_TRANSACTIONS). The
 * projection's purchase affordances (`secondaryPlanAction`, `canBuy*`,
 * `planOffers` moves) are read only to decide what NOT to offer.
 *
 * Pure: no React, no react-native, no fetch.
 */
import { planLapseCopy, recordsInTrashAllowanceCopy, PLAN_LAPSE_STATES, type PlanLapseState } from "@proovra/shared";
import type { ProovraStatusTone } from "@proovra/ui";

import { verifiedCheckoutUrl } from "./billing-purchase";

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export type UsageWindow = "LIFETIME" | "ROLLING_30_DAYS" | "CALENDAR_MONTH";
export type UsageMeter =
  | { state: "MEASURED"; used: number; limit: number | null; window: UsageWindow }
  | { state: "NOT_INCLUDED" }
  | { state: "CONTRACT_MANAGED" }
  | { state: "UNAVAILABLE"; reason: string };

export type StorageMeter =
  | {
      state: "MEASURED";
      usedLabel: string;
      limitLabel: string;
      baseLabel: string;
      recurringAddonBytes: string;
      recurringAddonLabel: string;
      legacyAddonBytes: string;
      legacyAddonLabel: string;
      usagePercent: number;
      nearLimit: boolean;
      limitReached: boolean;
    }
  | { state: "UNAVAILABLE"; reason: string };

export interface EvidenceAdmissionModel {
  planIncludedLifetime: number | null;
  effectiveLifetimeCap: number | null;
  capSource: string;
  recordsHeld: number;
  /** ET-COM-02 — of `recordsHeld`, how many are in Trash (null when the API omits it). */
  recordsInTrash: number | null;
  /** ET-COM-04 — present only while the paid plan has lapsed (null otherwise). */
  planLapse: { lapsedPlan: string; lapsedPlanLabel: string; state: PlanLapseState } | null;
  creditsAvailable: number;
  planCapacityRemaining: number | null;
  overCap: boolean;
  next: { allowed: true; funding: string } | { allowed: false; reason: string };
}

export interface ActiveAddonModel {
  id: string;
  addonKey: string;
  storageLabel: string;
  status: string;
  legacyOneTime: boolean;
  /** Cancelling the base plan also cancels this add-on (its SKU needs a paid plan). */
  endsWithPlan: boolean;
  canCancel: boolean;
  currentPeriodEndUtc: string | null;
  priceCents: number | null;
  currency: string | null;
}

export interface BillingProjection {
  accountDisplayName: string;
  plan: {
    planKey: string;
    displayName: string;
    model: string;
    accessKind: string;
    lifecycle: string;
    priceCents: number | null;
    currency: string | null;
    currentPeriodEndUtc: string | null;
    cancelAtPeriodEnd: boolean;
    paymentProviderLabel: string | null;
    graceEndsAtUtc: string | null;
    scheduledChange: { displayName: string; effectiveAtUtc: string | null; awaitingApproval: boolean } | null;
    providerTransition: { displayName: string; providerLabel: string | null; effectiveAtUtc: string | null } | null;
  };
  usage: { evidence: UsageMeter; storage: StorageMeter; ai: UsageMeter };
  walletCredits: number | null;
  evidenceAdmission: EvidenceAdmissionModel | null;
  historicalEligible: number;
  historicalReviewHref: string | null;
  collaboration: {
    teams: { used: number; limit: number } | null;
    seats: { used: number; limit: number | null; pendingInvites: number } | null;
  };
  contract: {
    status: string | null;
    activationState: string | null;
    effectiveAtUtc: string | null;
    endsAtUtc: string | null;
    seatCount: number | null;
    storageGb: number | null;
    region: string | null;
    derivedFromLegacyFallback: boolean;
  } | null;
  hasPlanOffers: boolean;
  planOffers: Array<{ planKey: string }>;
  actionRequired: { severity: string; title: string; messages: string[]; reassurance: string | null } | null;
  dependentStorageCancellation: { actionAvailable: boolean; supportRequired: boolean } | null;
  storageAddons: {
    offerCount: number;
    /** Each offer's OWN price and currency, as the server projected them. */
    offers: Array<{ key: string; label: string; priceCents: number | null; currency: string | null }>;
    active: ActiveAddonModel[];
    /** Older workspaces, each with its own quota. Never part of the meter. */
    legacyWorkspaces: Array<{
      name: string | null;
      countedByNoQuota: boolean;
      addonLabel: string;
      usedLabel: string | null;
      limitLabel: string | null;
      planLabel: string | null;
    }>;
  } | null;
  storageAddonsLocked: { reason: string; unlockedByPlan: string | null } | null;
  actions: {
    canBuyEvidenceCredits: boolean;
    canBuyStorageAddons: boolean;
    canManageBilling: boolean;
    canRequestCancellation: boolean;
    contactAccountManager: boolean;
    planManagement: { label: string; mode: string; enabled: boolean };
    cancellationUnavailableReason: string | null;
  };
}

function parseMeter(raw: unknown): UsageMeter {
  const m = obj(raw);
  switch (m.state) {
    case "MEASURED": {
      const w = m.window === "ROLLING_30_DAYS" || m.window === "CALENDAR_MONTH" ? m.window : "LIFETIME";
      return { state: "MEASURED", used: num(m.used) ?? 0, limit: num(m.limit), window: w };
    }
    case "NOT_INCLUDED":
      return { state: "NOT_INCLUDED" };
    case "CONTRACT_MANAGED":
      return { state: "CONTRACT_MANAGED" };
    default:
      return { state: "UNAVAILABLE", reason: str(m.reason) ?? "Not available right now." };
  }
}

function parseStorage(raw: unknown): StorageMeter {
  const m = obj(raw);
  if (m.state !== "MEASURED") return { state: "UNAVAILABLE", reason: str(m.reason) ?? "Not available right now." };
  return {
    state: "MEASURED",
    usedLabel: str(m.usedLabel) ?? "—",
    limitLabel: str(m.limitLabel) ?? "—",
    baseLabel: str(m.baseLabel) ?? "",
    recurringAddonBytes: str(m.recurringAddonBytes) ?? "0",
    recurringAddonLabel: str(m.recurringAddonLabel) ?? "",
    legacyAddonBytes: str(m.legacyAddonBytes) ?? "0",
    legacyAddonLabel: str(m.legacyAddonLabel) ?? "",
    usagePercent: num(m.usagePercent) ?? 0,
    nearLimit: m.nearLimit === true,
    limitReached: m.limitReached === true,
  };
}

export function parseBillingProjection(payload: unknown): BillingProjection {
  const p = obj(payload);
  const plan = obj(p.plan);
  const usage = obj(p.usage);
  const adm = p.evidenceAdmission && typeof p.evidenceAdmission === "object" ? obj(p.evidenceAdmission) : null;
  const next = obj(adm?.next);
  const collab = obj(p.collaboration);
  const teams = obj(collab.collaborationTeams);
  const seats = obj(collab.seats);
  const contract = p.contract && typeof p.contract === "object" ? obj(p.contract) : null;
  const ar = p.actionRequired && typeof p.actionRequired === "object" ? obj(p.actionRequired) : null;
  const dep = p.dependentStorageCancellation && typeof p.dependentStorageCancellation === "object" ? obj(p.dependentStorageCancellation) : null;
  const addons = p.storageAddons && typeof p.storageAddons === "object" ? obj(p.storageAddons) : null;
  const locked = p.storageAddonsLocked && typeof p.storageAddonsLocked === "object" ? obj(p.storageAddonsLocked) : null;
  const actions = obj(p.actions);
  const pm = obj(actions.planManagement);
  const sched = plan.scheduledChange && typeof plan.scheduledChange === "object" ? obj(plan.scheduledChange) : null;
  const trans = plan.providerTransition && typeof plan.providerTransition === "object" ? obj(plan.providerTransition) : null;
  const planKey = str(plan.planKey) ?? "";
  return {
    accountDisplayName: str(obj(p.account).displayName) ?? "",
    plan: {
      planKey,
      displayName: str(plan.displayName) ?? planKey,
      model: str(plan.model) ?? "",
      accessKind: str(plan.accessKind) ?? "",
      lifecycle: str(plan.lifecycle) ?? "",
      priceCents: num(plan.priceCents),
      currency: str(plan.currency),
      currentPeriodEndUtc: str(plan.currentPeriodEndUtc),
      cancelAtPeriodEnd: plan.cancelAtPeriodEnd === true,
      paymentProviderLabel: str(plan.paymentProviderLabel),
      graceEndsAtUtc: str(plan.graceEndsAtUtc),
      scheduledChange: sched
        ? {
            displayName: str(sched.displayName) ?? str(sched.planKey) ?? "",
            effectiveAtUtc: str(sched.effectiveAtUtc),
            awaitingApproval: sched.awaitingApproval === true,
          }
        : null,
      providerTransition: trans
        ? { displayName: str(trans.displayName) ?? str(trans.targetPlanKey) ?? "", providerLabel: str(trans.providerLabel), effectiveAtUtc: str(trans.effectiveAtUtc) }
        : null,
    },
    usage: { evidence: parseMeter(usage.evidence), storage: parseStorage(usage.storage), ai: parseMeter(usage.ai) },
    walletCredits: num(obj(p.wallet).availableCredits),
    evidenceAdmission: adm
      ? {
          planIncludedLifetime: num(adm.planIncludedLifetime),
          effectiveLifetimeCap: num(adm.effectiveLifetimeCap),
          capSource: str(adm.capSource) ?? "PLAN_DEFAULT",
          recordsHeld: num(adm.recordsHeld) ?? 0,
          recordsInTrash: num(adm.recordsInTrash),
          planLapse: parsePlanLapse(adm.planLapse),
          creditsAvailable: num(adm.creditsAvailable) ?? 0,
          planCapacityRemaining: num(adm.planCapacityRemaining),
          overCap: adm.overCap === true,
          next: next.allowed === true ? { allowed: true, funding: str(next.funding) ?? "PLAN" } : { allowed: false, reason: str(next.reason) ?? "" },
        }
      : null,
    historicalEligible: num(obj(p.historicalOutputEligibility).eligibleWithoutOutputs) ?? 0,
    historicalReviewHref: str(obj(p.historicalOutputEligibility).reviewHref),
    collaboration: {
      teams: num(teams.used) !== null && num(teams.limit) !== null ? { used: num(teams.used) as number, limit: num(teams.limit) as number } : null,
      seats: num(seats.used) !== null ? { used: num(seats.used) as number, limit: num(seats.limit), pendingInvites: num(seats.pendingInvites) ?? 0 } : null,
    },
    contract: contract
      ? {
          status: str(contract.status),
          activationState: str(contract.activationState),
          effectiveAtUtc: str(contract.effectiveAtUtc),
          endsAtUtc: str(contract.endsAtUtc),
          seatCount: num(contract.seatCount),
          storageGb: num(contract.storageGb),
          region: str(contract.region),
          derivedFromLegacyFallback: contract.derivedFromLegacyFallback === true,
        }
      : null,
    hasPlanOffers: rows(p.planOffers).length > 0,
    planOffers: rows(p.planOffers)
      .map((item) => str(obj(item).planKey))
      .filter((key): key is string => key !== null)
      .map((planKey) => ({ planKey })),
    actionRequired: ar
      ? {
          severity: str(ar.severity) ?? "WARNING",
          title: str(ar.title) ?? "",
          messages: rows(ar.messages).filter((m): m is string => typeof m === "string"),
          reassurance: str(ar.reassurance),
        }
      : null,
    dependentStorageCancellation: dep ? { actionAvailable: dep.actionAvailable === true, supportRequired: dep.supportRequired === true } : null,
    storageAddons: addons
      ? {
          offerCount: rows(addons.offers).length,
          offers: rows(addons.offers).map(raw => {
            const offer = obj(raw);
            return {
              key: str(offer.key) ?? str(offer.addonKey) ?? "",
              label: str(offer.label) ?? str(offer.storageLabel) ?? "Storage",
              priceCents: typeof offer.priceCents === "number" ? offer.priceCents : null,
              currency: str(offer.currency),
            };
          }).filter(offer => offer.key.length > 0),
          legacyWorkspaces: rows(addons.legacyWorkspaces).map((raw) => {
            const w = obj(raw);
            return {
              name: str(w.name),
              countedByNoQuota: w.countedByNoQuota === true,
              addonLabel: str(w.addonLabel) ?? "Storage add-ons",
              usedLabel: str(w.usedLabel),
              limitLabel: str(w.limitLabel),
              planLabel: str(w.planLabel),
            };
          }),
          active: rows(addons.active)
            .map((raw): ActiveAddonModel | null => {
              const a = obj(raw);
              const id = str(a.id);
              if (!id) return null;
              return {
                id,
                addonKey: str(a.addonKey) ?? id,
                storageLabel: str(a.storageLabel) ?? str(a.label) ?? "Storage add-on",
                status: str(a.status) ?? "",
                legacyOneTime: a.legacyOneTime === true,
                // An older API omits it: then every recurring add-on was cascaded.
                endsWithPlan: a.endsWithPlan !== false,
                canCancel: a.canCancel === true,
                currentPeriodEndUtc: str(a.currentPeriodEndUtc),
                priceCents: num(a.priceCents),
                currency: str(a.currency),
              };
            })
            .filter((a): a is ActiveAddonModel => a !== null),
        }
      : null,
    storageAddonsLocked: locked ? { reason: str(locked.reason) ?? "", unlockedByPlan: str(locked.unlockedByPlan) } : null,
    actions: {
      canBuyEvidenceCredits: actions.canBuyEvidenceCredits === true,
      canBuyStorageAddons: actions.canBuyStorageAddons === true || actions.canBuyStorage === true || rows(addons?.offers).length > 0,
      canManageBilling: actions.canManageBilling === true || pm.enabled === true,
      canRequestCancellation: actions.canRequestCancellation === true,
      contactAccountManager: actions.contactAccountManager === true,
      planManagement: { label: str(pm.label) ?? "Manage plan", mode: str(pm.mode) ?? "MANAGE", enabled: pm.enabled !== false },
      cancellationUnavailableReason: str(actions.cancellationUnavailableReason),
    },
  };
}

// ---------------------------------------------------------------------------
// format.ts
// ---------------------------------------------------------------------------

/** format.ts `formatMoney`: USD unless the server said EUR; null when there is no figure. */
export function formatMoney(amountCents: number | null | undefined, currency: string | null | undefined): string | null {
  if (typeof amountCents !== "number" || !Number.isFinite(amountCents)) return null;
  const safe = String(currency ?? "").trim().toUpperCase() === "EUR" ? "EUR" : "USD";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: safe }).format(amountCents / 100);
  } catch {
    return `${(amountCents / 100).toFixed(2)} ${safe}`;
  }
}

export interface LifecyclePresentation {
  label: string;
  tone: ProovraStatusTone;
  detail: string | null;
}

/** format.ts `presentLifecycle`; dates are pre-formatted by the caller. */
export function presentLifecycle(lifecycle: string, end: string | null, grace: string | null): LifecyclePresentation {
  switch (lifecycle) {
    case "ACTIVE":
      return { label: "Active", tone: "verified", detail: null };
    case "TRIALING":
      return { label: "Trial", tone: "info", detail: end ? `Trial ends ${end}.` : null };
    case "PAST_DUE":
      return { label: "Payment failed", tone: "pending", detail: grace ? `Access continues until ${grace} while we retry.` : "We could not take the last payment." };
    case "ACTION_REQUIRED":
      return { label: "Action required", tone: "risk", detail: "Billing needs attention before paid features continue." };
    case "CANCELING":
      return { label: "Canceling", tone: "pending", detail: end ? `You keep access until ${end}.` : "Access continues until the end of the paid period." };
    case "CANCELLED":
      return { label: "Cancelled", tone: "neutral", detail: "This subscription has ended." };
    default:
      return { label: "No subscription", tone: "neutral", detail: null };
  }
}

/** format.ts `statusLabel` — a provider value is never printed raw at a customer. */
export function billingStatusLabel(status: string): string {
  const s = String(status ?? "").trim().toUpperCase();
  if (!s) return "Not configured";
  const map: Record<string, string> = {
    SUCCEEDED: "Paid",
    FAILED: "Failed",
    REFUNDED: "Refunded",
    PENDING: "Pending",
    ACTIVE: "Active",
    PAST_DUE: "Payment failed",
    CANCELED: "Cancelled",
    CANCELLED: "Cancelled",
    EXPIRED: "Expired",
    ABANDONED: "Abandoned",
  };
  return map[s] ?? "Status pending";
}

/** format.ts `statusTone`. */
export function billingStatusTone(status: string): ProovraStatusTone {
  const s = String(status ?? "").trim().toUpperCase();
  if (s === "SUCCEEDED" || s === "ACTIVE") return "verified";
  if (s === "PENDING" || s === "PAST_DUE") return "pending";
  if (s === "FAILED") return "risk";
  return "neutral";
}

const WINDOW_SUFFIX: Record<UsageWindow, string> = {
  LIFETIME: "lifetime records",
  ROLLING_30_DAYS: "records in the last 30 days",
  CALENDAR_MONTH: "this month",
};

/** format.ts `describeMeter`. */
export function describeMeter(meter: UsageMeter): { headline: string; detail: string | null } {
  switch (meter.state) {
    case "NOT_INCLUDED":
      return { headline: "Not included", detail: null };
    case "CONTRACT_MANAGED":
      return { headline: "Contract-managed", detail: "Your agreement sets this allowance." };
    case "UNAVAILABLE":
      return { headline: "Unavailable", detail: meter.reason };
    case "MEASURED": {
      const suffix = WINDOW_SUFFIX[meter.window];
      if (meter.limit === null) return { headline: `${meter.used.toLocaleString()} ${suffix}`, detail: "No limit on your plan." };
      if (meter.used > meter.limit) {
        const over = meter.used - meter.limit;
        const resolution =
          meter.window === "ROLLING_30_DAYS"
            ? "Records leave this window as they age, and capacity returns with them."
            : "This allowance does not reset. Moving up a plan, or buying an evidence credit, is what makes room for the next record.";
        return {
          headline: `${meter.used.toLocaleString()} ${suffix}`,
          detail: `${over.toLocaleString()} more than the ${meter.limit.toLocaleString()} allowed here. Nothing has been removed. ${resolution}`,
        };
      }
      return { headline: `${meter.used.toLocaleString()} of ${meter.limit.toLocaleString()} ${suffix}`, detail: null };
    }
  }
}

/** `planLapse` from the wire: an unknown state is no lapse block, never a guessed one. */
function parsePlanLapse(v: unknown): EvidenceAdmissionModel["planLapse"] {
  const o = obj(v);
  const state = str(o.state);
  const lapsedPlan = str(o.lapsedPlan);
  const lapsedPlanLabel = str(o.lapsedPlanLabel);
  if (!state || !lapsedPlan || !lapsedPlanLabel) return null;
  if (!(PLAN_LAPSE_STATES as readonly string[]).includes(state)) return null;
  return { lapsedPlan, lapsedPlanLabel, state: state as PlanLapseState };
}

/** format.ts `describeEvidenceAdmission`. */
export function describeEvidenceAdmission(
  a: EvidenceAdmissionModel,
  options: { canBuyCredits: boolean; hasPlanOffer: boolean },
): { headline: string; breakdown: string | null; next: string; action: "BUY_CREDITS" | "SEE_PLANS" | null } {
  const held = a.recordsHeld.toLocaleString();
  const cap = a.effectiveLifetimeCap;
  const credits = a.creditsAvailable;
  const headline = cap === null || a.overCap ? `${held} lifetime records` : `${held} of ${cap.toLocaleString()} included lifetime records`;
  const parts: string[] = [];
  if (a.capSource === "LEGACY_RECORD_CAP_OVERRIDE" && a.planIncludedLifetime !== null && cap !== null && a.planIncludedLifetime !== cap) {
    parts.push(`Your plan includes ${a.planIncludedLifetime.toLocaleString()} records. This account keeps a higher agreed limit of ${cap.toLocaleString()}.`);
  }
  if (a.overCap && cap !== null) {
    const over = (a.recordsHeld - cap).toLocaleString();
    parts.push(
      a.capSource === "LEGACY_RECORD_CAP_OVERRIDE"
        ? `You hold ${over} more than that. Nothing has been removed.`
        : `That is ${over} more than the ${cap.toLocaleString()} your plan includes. Nothing has been removed.`,
    );
  }
  const inTrash = recordsInTrashAllowanceCopy(a.recordsInTrash);
  if (inTrash) parts.push(inTrash);
  let next: string;
  if (a.next.allowed) {
    if (a.next.funding === "PLAN") {
      next =
        a.planCapacityRemaining === null
          ? "No record limit on your plan."
          : `${a.planCapacityRemaining.toLocaleString()} more record${a.planCapacityRemaining === 1 ? "" : "s"} included.`;
    } else {
      next = `Your included records are used up. The next record uses 1 of your ${credits.toLocaleString()} credit${credits === 1 ? "" : "s"} — one credit per record.`;
    }
  } else if (a.next.reason === "CREDIT_REQUIRED_NONE_AVAILABLE") {
    next = "This account records with credits. One evidence credit covers the next record.";
  } else {
    next = "Your included records are used up. One evidence credit covers the next record; a larger plan raises the included allowance.";
  }
  if (a.planLapse) {
    const lapse = planLapseCopy({
      state: a.planLapse.state,
      lapsedPlanLabel: a.planLapse.lapsedPlanLabel,
      freeAllowanceRemaining: a.planCapacityRemaining ?? 0,
      creditsAvailable: credits,
    });
    parts.unshift(lapse.headline);
    parts.push(lapse.outputs);
    next = lapse.nextRecord;
  }
  const needsAction = !a.next.allowed || a.next.funding === "EVIDENCE_CREDIT";
  const action = !needsAction ? null : options.canBuyCredits ? "BUY_CREDITS" : options.hasPlanOffer ? "SEE_PLANS" : null;
  return { headline, breakdown: parts.length > 0 ? parts.join(" ") : null, next, action };
}

// ---------------------------------------------------------------------------
// BillingOverview.tsx
// ---------------------------------------------------------------------------

export function planCadence(accessKind: string): string {
  switch (accessKind) {
    case "SUBSCRIPTION":
      return "Billed monthly";
    case "GRANTED":
      return "Granted access — no active billing subscription";
    case "CONTRACT":
      return "Billed by agreement";
    case "CREDIT":
      return "Pay per evidence record";
    default:
      return "No subscription";
  }
}

export function planHeading(p: BillingProjection): string {
  if (p.contract) return "Enterprise agreement";
  return p.plan.accessKind === "GRANTED" ? `${p.plan.displayName} access` : p.plan.displayName;
}

export interface BillingMetric {
  label: string;
  value: string;
  note: string | null;
  /** 0..n; null = no track fill and no progressbar role. */
  ratio: number | null;
  tone: "neutral" | "pending";
}

/** BillingOverview.tsx `buildMetrics`. */
export function buildBillingMetrics(p: BillingProjection): BillingMetric[] {
  const out: BillingMetric[] = [];
  const e = p.usage.evidence;
  if (e.state === "MEASURED") {
    const over = e.limit !== null && e.used > e.limit ? e.used - e.limit : 0;
    out.push({
      label: "Evidence",
      value: e.limit === null || over > 0 ? `${e.used.toLocaleString()} records` : `${e.used.toLocaleString()} of ${e.limit.toLocaleString()}`,
      note:
        over > 0
          ? `${over.toLocaleString()} above the ${(e.limit as number).toLocaleString()} limit`
          : e.window === "ROLLING_30_DAYS"
            ? "In the last 30 days"
            : e.window === "CALENDAR_MONTH"
              ? "This month"
              : "Lifetime",
      ratio: e.limit === null || e.limit === 0 ? null : e.used / e.limit,
      tone: over > 0 || (p.evidenceAdmission && !p.evidenceAdmission.next.allowed) ? "pending" : "neutral",
    });
  } else if (e.state === "CONTRACT_MANAGED") {
    out.push({ label: "Evidence", value: "Contract-defined", note: "Your agreement sets this allowance.", ratio: null, tone: "neutral" });
  } else if (e.state === "NOT_INCLUDED") {
    out.push({ label: "Evidence", value: "Not included", note: null, ratio: null, tone: "neutral" });
  } else {
    out.push({ label: "Evidence", value: "Not available", note: e.reason, ratio: null, tone: "neutral" });
  }

  const s = p.usage.storage;
  out.push(
    s.state === "MEASURED"
      ? {
          label: "Storage",
          value: `${s.usedLabel} of ${s.limitLabel}`,
          note: !s.baseLabel
            ? null
            : s.recurringAddonBytes !== "0" && s.recurringAddonLabel
              ? `${s.baseLabel} included · ${s.recurringAddonLabel} added`
              : `${s.baseLabel} included`,
          ratio: s.usagePercent / 100,
          tone: s.nearLimit || s.limitReached ? "pending" : "neutral",
        }
      : { label: "Storage", value: "Not available", note: s.reason, ratio: null, tone: "neutral" },
  );

  const ai = p.usage.ai;
  out.push(
    ai.state === "MEASURED"
      ? {
          label: "AI operations",
          value: ai.limit === null ? `${ai.used.toLocaleString()}` : `${ai.used.toLocaleString()} of ${ai.limit.toLocaleString()}`,
          note: ai.window === "CALENDAR_MONTH" ? "Resets each month" : null,
          ratio: ai.limit === null || ai.limit === 0 ? null : ai.used / ai.limit,
          tone: ai.limit !== null && ai.used >= ai.limit ? "pending" : "neutral",
        }
      : ai.state === "CONTRACT_MANAGED"
        ? { label: "AI operations", value: "Contract-defined", note: "Your agreement sets this allowance.", ratio: null, tone: "neutral" }
        : ai.state === "NOT_INCLUDED"
          ? { label: "AI operations", value: "Not included", note: "Available on Pro and Team", ratio: null, tone: "neutral" }
          : { label: "AI operations", value: "Not available", note: ai.reason, ratio: null, tone: "neutral" },
  );
  return out;
}

/** PlanCapabilitiesCard rows. */
export function capabilityRows(p: BillingProjection): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  const c = p.collaboration;
  if (c.teams) out.push({ label: "Collaboration teams", value: `${c.teams.used} of ${c.teams.limit}` });
  if (c.seats) {
    out.push({ label: "Members", value: c.seats.limit === null ? `${c.seats.used} accepted` : `${c.seats.used} of ${c.seats.limit}` });
    if (c.seats.pendingInvites > 0) out.push({ label: "Pending invites", value: String(c.seats.pendingInvites) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// PlanAndUsage.tsx — the agreement card
// ---------------------------------------------------------------------------

export function contractStatusPresentation(status: string | null): { label: string; tone: ProovraStatusTone } | null {
  switch (status) {
    case "ACTIVE":
      return { label: "Active", tone: "verified" };
    case "DRAFT":
      return { label: "Draft", tone: "pending" };
    case "PENDING_ACTIVATION":
      return { label: "Pending activation", tone: "pending" };
    case "SUSPENDED":
      return { label: "Suspended", tone: "risk" };
    case "TERMINATED":
      return { label: "Ended", tone: "risk" };
    default:
      return null;
  }
}

export function contractActivationPresentation(state: string | null): { label: string; tone: ProovraStatusTone; detail: string | null } | null {
  switch (state) {
    case "ACTIVATED":
      return { label: "Activated", tone: "verified", detail: null };
    case "OWNER_INVITED":
      return { label: "Owner invitation pending", tone: "pending", detail: "An organization owner has been invited and has not completed setup yet." };
    case "PENDING_OWNER":
      return { label: "Owner setup required", tone: "pending", detail: "The agreement is waiting for an organization owner to complete activation." };
    default:
      return null;
  }
}

/** The agreement's label/value rows; dates are formatted by the caller. */
export function contractRows(
  c: NonNullable<BillingProjection["contract"]>,
  fmt: (iso: string | null) => string | null,
): Array<[string, string]> {
  const historical = c.status === "TERMINATED" || c.status === "SUSPENDED";
  const out: Array<[string, string]> = [];
  const effective = fmt(c.effectiveAtUtc);
  const ends = fmt(c.endsAtUtc);
  if (effective) out.push(["Effective from", effective]);
  if (ends) out.push([historical ? "Term ended" : "Term ends", ends]);
  if (c.seatCount !== null) out.push([historical ? "Seats covered" : "Contracted seats", String(c.seatCount)]);
  if (c.storageGb !== null) out.push([historical ? "Storage covered" : "Contracted storage", `${c.storageGb} GB`]);
  if (c.region) out.push(["Region", c.region]);
  return out;
}

// ---------------------------------------------------------------------------
// Actions: account re-check, abandon, cancellation, add-on cancel
// ---------------------------------------------------------------------------

export function buildReconcilePath(type: string, id: string): string {
  return `/v1/billing/accounts/${encodeURIComponent(type)}/${encodeURIComponent(id)}/reconcile`;
}
export function buildPaymentAbandonPath(type: string, id: string, paymentId: string): string {
  return `/v1/billing/accounts/${encodeURIComponent(type)}/${encodeURIComponent(id)}/payments/${encodeURIComponent(paymentId)}/abandon`;
}
/** The route's body schema: `{ confirmed?: boolean }` (billing.routes.ts abandon). */
export function buildAbandonBody(confirmed: boolean) {
  return { confirmed };
}

/**
 * The account-wide re-check result, in words.
 *
 * BILLING ACTIVITY (2026-09-28) — the same rule as the web's
 * `describeReconciliation`: "waiting" is said ONLY for an attempt the provider
 * itself reported as awaiting approval. This used to answer every PENDING
 * outcome with "Your provider is still settling a payment", which a customer
 * read about two PayPal attempts PayPal had answered 404 for.
 */
const UNVERIFIED_ATTEMPT = new Set([
  "NOT_PROVIDER_BOUND",
  "PROVIDER_REFERENCE_NOT_FOUND",
  "PROVIDER_REFERENCE_INVALID",
  "PROVIDER_AUTHORIZATION_FAILED",
  "PROVIDER_MALFORMED",
]);

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function reconcileMessage(result: unknown): { message: string; tone: "success" | "info" | "error"; refresh: boolean } {
  const outcome = str(obj(result).outcome);
  const s = obj(obj(result).summary);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  if (!obj(result).summary) {
    // BILLING PAYPAL INTEGRITY (2026-09-28) — a refused re-check checked
    // nothing and says so; it never claims a check ran.
    if (outcome === "BUSY") {
      return { message: "A check is already running for this account. Nothing new was checked — wait a moment, then look again.", tone: "info", refresh: false };
    }
    if (outcome === "RATE_LIMITED") {
      return { message: "Billing was re-checked several times just now. Nothing new was checked — please try again in a few minutes.", tone: "info", refresh: false };
    }
    return outcome === "PROVIDER_UNAVAILABLE"
      ? { message: "We could not reach your payment provider. Nothing was changed.", tone: "error", refresh: false }
      : { message: "The check did not run. Nothing was changed — please try again.", tone: "info", refresh: false };
  }
  const attempts = (Array.isArray(s.attempts) ? s.attempts : [])
    .map(obj)
    .filter((a) => a.locallyAbandoned !== true);
  const stillPending = attempts.filter((a) => str(a.outcome) === "STILL_PENDING");
  // "Waiting for your approval at PayPal" only for what waits for the buyer.
  const awaiting = stillPending.filter(
    (a) => str(a.provider) === "PAYPAL" && (str(a.waitingFor) ?? "APPROVAL") === "APPROVAL",
  ).length;
  const inProgress = stillPending.filter((a) => ["ACTIVATION", "PAYMENT_PROCESSING"].includes(str(a.waitingFor) ?? "")).length;
  // An open card page is unpaid, so it is not "approved".
  const openPage = stillPending.filter((a) => str(a.waitingFor) === "PAYMENT_PAGE").length;
  // PROOVRA's own close of an unapproved attempt counts as an update on the
  // server, but it is not something a provider confirmed.
  const closedLocally = attempts.filter((a) => str(a.outcome) === "UPDATED" && str(a.currentStatus) === "ABANDONED").length;
  const unverified = attempts.filter((a) => UNVERIFIED_ATTEMPT.has(str(a.outcome) ?? "")).length;
  const unreachable = num(s.unavailable);
  const credits = num(s.creditsRestored);
  const changed = credits + num(s.paymentsRecorded) + num(s.subscriptionsUpdated) + Math.max(0, num(s.attemptsUpdated) - closedLocally);
  const discrepancies = num(s.discrepancies);
  const otherAction = Math.max(0, num(s.actionRequired) - unverified);

  // Not "Nothing was charged": an attempt check can capture an order the buyer
  // already approved.
  const parts = [`Checked ${count(num(s.checked), "item", "items")} with your payment provider.`];
  if (changed > 0) parts.push(`${count(changed, "record was", "records were")} updated from what the provider confirmed.`);
  if (credits > 0) parts.push(`${count(credits, "evidence credit was", "evidence credits were")} added.`);
  if (closedLocally > 0) parts.push(`${count(closedLocally, "purchase was", "purchases were")} not approved within 24 hours, so PROOVRA closed ${closedLocally === 1 ? "it" : "them"} here. PayPal did not confirm this.`);
  if (awaiting > 0) parts.push(`${count(awaiting, "purchase is", "purchases are")} still waiting for your approval at PayPal.`);
  if (inProgress > 0) parts.push(`${count(inProgress, "purchase is", "purchases are")} approved and still being completed by the provider; PROOVRA keeps checking.`);
  if (openPage > 0) parts.push(`${count(openPage, "card payment page is", "card payment pages are")} still open and unpaid.`);
  if (unverified > 0) parts.push(`${count(unverified, "purchase", "purchases")} could not be confirmed by the provider — see Billing activity for what that means and what you can do.`);
  if (unreachable > 0) parts.push(`The provider could not be reached for ${count(unreachable, "item", "items")}; those were left unchanged.`);
  if (discrepancies > 0) parts.push("Something the provider reported did not match our prices, so nothing was applied for it. Please contact support.");
  if (otherAction > 0) parts.push("Some storage cancellations are still outstanding; we keep retrying them.");
  if (parts.length === 1) parts.push("Everything on this account already matches your payment provider.");

  const tone =
    unreachable > 0 && changed === 0 && closedLocally === 0 && awaiting === 0 && openPage === 0 && unverified === 0
      ? "error"
      : changed > 0 && closedLocally + awaiting + openPage + unverified + unreachable + discrepancies === 0
        ? "success"
        : "info";
  return { message: parts.join(" "), tone, refresh: changed > 0 };
}

/** page.tsx `announceAbandonOutcome`. */
export function abandonMessage(outcome: string | null): { message: string; tone: "success" | "info" } {
  switch (outcome) {
    case "ABANDONED":
    case "ALREADY_ABANDONED":
      return { message: "This payment attempt was removed from your active Billing view. This did not cancel anything at your payment provider. If your provider later confirms a payment, PROOVRA still applies it.", tone: "success" };
    case "ABANDON_NOT_ALLOWED":
      return { message: "Your provider has this payment and is still settling it, so it cannot be abandoned. PROOVRA keeps checking.", tone: "info" };
    case "PROVIDER_ANSWERED":
      return { message: "Your payment provider told us what actually happened to this payment, so we recorded that instead.", tone: "info" };
    case "ALREADY_FINISHED":
      return { message: "This payment had already finished. Nothing was changed.", tone: "info" };
    default:
      return { message: "This payment attempt is unchanged.", tone: "info" };
  }
}

export function abandonConfirmation(result: unknown): string {
  const warning =
    str(obj(result).warning) ??
    "Your payment provider could not be reached. This will remove the attempt from your active Billing view only.";
  return `${warning} If your provider later confirms a completed payment, PROOVRA will record it.`;
}

/** page.tsx `handleCancel` confirmation — the whole consequence, not just the plan's. */
export function subscriptionCancelConsequence(p: BillingProjection, paidUntil: string | null): string[] {
  // Only add-ons whose SKU needs a paid plan end with it (storage a Free
  // account may hold is kept); PayPal ends a subscription immediately.
  const recurring = (p.storageAddons?.active ?? []).filter((a) => !a.legacyOneTime && a.status === "ACTIVE" && a.endsWithPlan);
  const kept = (p.storageAddons?.active ?? []).filter((a) => !a.legacyOneTime && a.status === "ACTIVE" && !a.endsWithPlan);
  const paypal = p.plan.paymentProviderLabel === "PayPal";
  return [
    `We will ask your payment provider to stop renewing it. ${
      paypal
        ? `PayPal ends a subscription immediately: ${p.plan.displayName} ends when PayPal confirms the cancellation, and it cannot be restarted.`
        : paidUntil
        ? `You have paid through ${paidUntil}; where the provider supports it you keep ${p.plan.displayName} until then, and we will confirm the exact date after they answer.`
        : "Where the provider supports it you keep your current plan until the end of the period you have already paid for, and we will confirm the exact date after they answer."
    } Nothing is charged again.`,
    "Your evidence is not deleted. Records, custody history, hashes, signatures and verification packages all stay exactly as they are.",
    recurring.length > 0
      ? `${recurring.length} recurring storage add-on${recurring.length === 1 ? "" : "s"} will be cancelled with it, so that extra capacity ends too.`
      : "No storage add-on depends on this plan, so no storage is cancelled.",
    ...(kept.length > 0
      ? [`${kept.length} storage add-on${kept.length === 1 ? "" : "s"} you can keep on Free ${kept.length === 1 ? "stays" : "stay"} active and keep${kept.length === 1 ? "s" : ""} renewing. Cancel ${kept.length === 1 ? "it" : "them"} separately if you no longer want the capacity.`]
      : []),
    "Your account moves to Free. You can subscribe again at any time.",
  ];
}

/** page.tsx `handleCancel` toast, from `{ cancellation }` (billing.routes.ts subscription/cancel). */
export function subscriptionCancelMessage(payload: unknown, fmt: (iso: string | null) => string | null): { message: string; tone: "success" | "error" } {
  const c = obj(obj(payload).cancellation);
  if (c.result === "ACTION_REQUIRED") {
    return { message: "Your plan is cancelled, but a storage add-on could not be stopped. Please contact support — it may still be charging.", tone: "error" };
  }
  const ends = fmt(str(c.accessEndsAtUtc));
  return { message: c.mode === "PERIOD_END" && ends ? `Cancelled. You keep access until ${ends}.` : "Cancelled with your payment provider.", tone: "success" };
}

/** page.tsx `handleRetryStorageCancellation`. */
export function retryStorageMessage(result: unknown): { message: string; tone: "success" | "info" } {
  const r = obj(result);
  if (r.outcome === "UPDATED") return { message: "Your storage add-ons are stopped. Nothing further will be charged for them.", tone: "success" };
  return {
    message: r.supportRequired === true
      ? "We still could not stop every add-on. Support has been notified and is looking at it."
      : "We asked your payment provider again. We will keep retrying until it confirms.",
    tone: "info",
  };
}

export const ADDON_CANCEL_COPY = {
  title: "Cancel this storage add-on?",
  body: "It stops renewing at your provider. Evidence already stored is never deleted by cancelling an add-on — but if you are over your remaining capacity you will not be able to record new evidence until you free space or add capacity back.",
  confirm: "Cancel add-on",
  cancel: "Keep add-on",
  done: "Storage add-on cancelled",
  failed: "We could not cancel that add-on. Nothing has changed.",
} as const;

export const BILLING_PAGE_COPY = {
  title: "Billing",
  subtitle: "Your plan, what you have used, and what you have paid.",
  viewPricing: "View pricing",
  historyTitle: "Billing history",
  historyProviderSubtitle: "Checks your payment provider for anything we have not recorded on this account, and completes a purchase you already approved.",
  historyContractSubtitle: "Payments recorded against your organization's agreement.",
  recheck: "Re-check purchases and billing",
  rechecking: "Re-checking…",
  capabilitiesNote: "Collaboration teams are part of your plan. They are not separately billed workspaces.",
  contractLegacy: "We do not have your full agreement on file here. Your account manager holds the authoritative terms.",
  supportAgreement: "Changes to your agreement go through your account manager.",
  supportGeneral: "Something here not matching what you expected? We can look at it with you.",
  noExtraStorage: "No extra storage yet.",
  grantedAccess: (plan: string) =>
    `${plan} access was granted to this account. There is no active billing subscription behind it: nothing is charged, and it does not renew automatically. If you expected to be billed for this, contact support and we will look at it with you.`,
  agreement:
    "Enterprise terms are set by your agreement. Your account manager is the person who can change them — this page cannot, and offering a checkout that replaced a signed agreement with a card payment would be worse than offering none.",
  cancelEvidenceNote: "Your existing evidence and custody records remain available under the applicable retention and access rules.",
  noSubscriptionBound:
    "We cannot find a live subscription for this plan with your payment provider, so there is nothing here for us to stop. Please contact support and we will look at it with you — nothing will be charged again in the meantime without one.",
  notAuthorized: "Ending this subscription is done by the account's billing owner.",
  taxNote: "Displayed prices exclude any taxes that may be handled by the payment provider where applicable.",
} as const;

/** ManagePlanDrawer title by access kind. */
export function managePlanTitle(accessKind: string): string {
  return accessKind === "CONTRACT" ? "Your agreement" : accessKind === "GRANTED" ? "Access details" : "Manage plan";
}

/**
 * BILLING REMEDIATION (2026-10-30, AUD-13) — the provider gave no answer to a
 * cancellation. A timeout can follow one it accepted, so "nothing has changed"
 * would be a guess, and repeating the request before looking is the wrong advice.
 */
export const CANCELLATION_UNCONFIRMED_COPY =
  "We could not confirm this cancellation with your payment provider. Check Billing in a few minutes before trying again.";

export function cancellationOutcomeUnknown(err: unknown): boolean {
  return str(obj(err).code)?.toUpperCase() === "PROVIDER_CANCELLATION_OUTCOME_UNKNOWN";
}

/**
 * BILLING ACTIVITY (2026-09-28) — the purchases on this account that have not
 * produced a payment, from the same history response as the payments. Only
 * the server's own words are kept; no id beyond the opaque attempt handle.
 */
export type OpenPurchaseRow = {
  id: string;
  /** The server's activity state. Words come from `statusLabel`; this only picks a way forward. */
  state: string | null;
  description: string;
  statusLabel: string;
  explanation: string;
  providerLabel: string | null;
  createdAtUtc: string | null;
  /** The server's own affordances for this purchase. */
  canRecheck: boolean;
  canAbandon: boolean;
};

export function parseBillingActivity(body: unknown): OpenPurchaseRow[] {
  const list = obj(body).activity;
  if (!Array.isArray(list)) return [];
  return list
    .map(obj)
    .filter((a) => str(a.id) && str(a.description) && str(a.statusLabel))
    .map((a) => ({
      id: str(a.id)!,
      state: str(a.state),
      description: str(a.description)!,
      statusLabel: str(a.statusLabel)!,
      explanation: str(a.explanation) ?? "",
      providerLabel: str(a.providerLabel),
      createdAtUtc: str(a.createdAtUtc),
      canRecheck: obj(a.actions).canRecheck === true,
      canAbandon: obj(a.actions).canAbandon === true,
    }));
}

// ---------------------------------------------------------------------------
// BillingActivity + StorageRecoveryPanel — one open purchase, resolved here
// ---------------------------------------------------------------------------

/**
 * BILLING REMEDIATION (2026-10-31, AUD-19) — the same endpoints and the same
 * words as the web (billingMessages.ts). Check status and Abandon start nothing,
 * so they are on every build. Continue hands the customer back to a provider
 * checkout, so it stays behind `externalCheckoutEnabled()`; `resumeAllowed`
 * carries that answer in, and a build without it is told where to finish.
 */
export function buildAttemptRecheckPath(type: string, id: string, attemptId: string): string {
  return `/v1/billing/accounts/${encodeURIComponent(type)}/${encodeURIComponent(id)}/checkout-attempts/${encodeURIComponent(attemptId)}/recheck`;
}
export function buildAttemptAbandonPath(type: string, id: string, attemptId: string): string {
  return `/v1/billing/accounts/${encodeURIComponent(type)}/${encodeURIComponent(id)}/checkout-attempts/${encodeURIComponent(attemptId)}/abandon`;
}

export type AttemptState =
  | "WAITING_APPROVAL"
  | "ACTIVATING"
  | "PROCESSING"
  | "PAYMENT_PAGE"
  | "PAID"
  | "FAILED"
  | "CLOSED"
  /** PROOVRA closed it. The provider did not, and may still complete it. */
  | "CLOSED_LOCALLY"
  | "UNRESOLVED";

/** billingMessages.ts `attemptStateOf`. */
export function attemptStateOf(result: unknown): AttemptState {
  const r = obj(result);
  const outcome = str(r.outcome);
  if (outcome === "STILL_PENDING") {
    switch (str(r.waitingFor)) {
      case "ACTIVATION":
        return "ACTIVATING";
      case "PAYMENT_PROCESSING":
        return "PROCESSING";
      case "PAYMENT_PAGE":
        return "PAYMENT_PAGE";
      default:
        return "WAITING_APPROVAL";
    }
  }
  if (outcome === "UPDATED" || outcome === "NO_CHANGE" || outcome === "STALE_IGNORED") {
    switch ((str(r.currentStatus) ?? "").toUpperCase()) {
      case "ACTIVE":
      case "COMPLETED":
      case "SUCCEEDED":
        return "PAID";
      case "FAILED":
        return "FAILED";
      case "CANCELED":
      case "CANCELLED":
      case "EXPIRED":
        return "CLOSED";
      case "ABANDONED":
        return "CLOSED_LOCALLY";
    }
  }
  return "UNRESOLVED";
}

export type AttemptCheck = {
  message: string;
  tone: "success" | "info" | "error";
  state: AttemptState;
  /** Still open, so another purchase of this size would risk a second charge. */
  blocked: boolean;
  /** Abandon is refused once the buyer has approved, so it is not offered. */
  canAbandon: boolean;
  /** The provider's own payment page, only on a build that may hand one over. */
  resumeUrl: string | null;
};

const SETTLED_ATTEMPTS: ReadonlySet<AttemptState> = new Set(["PAID", "FAILED", "CLOSED", "CLOSED_LOCALLY"]);

function pendingWords(provider: string, stripe: boolean, waitingFor: string | null, hasResume: boolean, resumeOffered: boolean): string {
  if (stripe) {
    if (!hasResume) return "Stripe shows this payment as still settling. Nothing more is needed from you right now.";
    return resumeOffered
      ? "The Stripe payment page is still open and unpaid. You can continue checkout, or abandon it."
      : "The Stripe payment page is still open and unpaid. To finish it, use Billing on the web, or abandon it here.";
  }
  if (waitingFor === "ACTIVATION") return `You approved this at ${provider} and ${provider} is activating it. PROOVRA keeps checking automatically; nothing more is needed from you.`;
  if (waitingFor === "PAYMENT_PROCESSING") return `${provider} is still processing this payment. PROOVRA keeps checking automatically; nothing more is needed from you.`;
  if (hasResume && resumeOffered) return `${provider} still shows this waiting for your approval. You can continue at ${provider}, or abandon it.`;
  if (hasResume) return `${provider} still shows this waiting for your approval. To finish it, use Billing on the web, or abandon it here.`;
  return `${provider} still shows this waiting for your approval. Nothing is charged unless you approve it; you can abandon it. Approvals not completed within 24 hours are closed automatically.`;
}

/** ONE attempt's "Check status" result, and what may happen next. */
export function describeAttemptCheck(result: unknown, options: { resumeAllowed: boolean }): AttemptCheck {
  const r = obj(result);
  const stripe = str(r.provider) === "STRIPE";
  const provider = stripe ? "Stripe" : "PayPal";
  const state = attemptStateOf(result);
  const outcome = str(r.outcome);
  const providerResume = outcome === "STILL_PENDING" ? verifiedCheckoutUrl(r.resumeUrl) : null;
  const resumeUrl = options.resumeAllowed ? providerResume : null;

  let message: string;
  let tone: AttemptCheck["tone"] = "info";
  if (state === "PAID") {
    message = `${provider} confirmed this purchase. Billing is updated.`;
    tone = "success";
  } else if (state === "FAILED") {
    message = `${provider} reports this purchase failed, so nothing was added to your account.`;
    tone = "error";
  } else if (state === "CLOSED") {
    message = `${provider} reports this purchase was cancelled or expired, so nothing was added to your account.`;
  } else if (state === "CLOSED_LOCALLY") {
    message = `This was not approved within 24 hours, so PROOVRA closed it here. ${provider} did not confirm this and nothing was cancelled there. If ${provider} later confirms a payment, PROOVRA still applies it.`;
  } else if (outcome === "STILL_PENDING") {
    message = pendingWords(provider, stripe, str(r.waitingFor), providerResume !== null, options.resumeAllowed);
  } else if (outcome === "UPDATED") {
    message = `${provider} confirmed a new status for this purchase. Billing is updated.`;
    tone = "success";
  } else if (outcome === "NO_CHANGE" || outcome === "STALE_IGNORED") {
    message = `${provider} confirmed nothing has changed for this purchase.`;
  } else if (outcome === "NOT_PROVIDER_BOUND") {
    message = stripe
      ? "Stripe never confirmed this checkout was created, so there is nothing to pay. You can abandon it."
      : "PayPal never confirmed this checkout was created, so there is nothing to approve. Nothing can be charged without your approval. You can abandon it.";
  } else if (outcome === "PROVIDER_REFERENCE_NOT_FOUND") {
    message = stripe
      ? "Stripe has no record of this checkout any more. You can abandon it."
      : "PayPal has no record of this checkout any more. It was not approved through PROOVRA. You can abandon it.";
  } else if (outcome === "PROVIDER_UNAVAILABLE") {
    message = `${provider} could not be reached, so this purchase's status is unknown. Billing here is unchanged — try again later.`;
    tone = "error";
  } else {
    message = `${provider} could not confirm this checkout. Billing here is unchanged. If this continues, contact support.`;
    tone = "error";
  }

  const settled = SETTLED_ATTEMPTS.has(state);
  return {
    message,
    tone,
    state,
    blocked: !settled,
    canAbandon: !settled && state !== "ACTIVATING" && state !== "PROCESSING",
    resumeUrl,
  };
}

/**
 * What abandoning ONE attempt did. Never "nothing was charged" for a local
 * abandon: PROOVRA did not ask the provider to stop anything, so it cannot speak
 * for the provider. `resolved` means the attempt no longer blocks a purchase.
 */
export function describeAttemptAbandon(result: unknown): {
  message: string;
  tone: "success" | "info" | "error";
  resolved: boolean;
  canAbandon: boolean;
  state: AttemptState | null;
} {
  const r = obj(result);
  switch (str(r.outcome)) {
    case "PROVIDER_CANCEL_FAILED":
      return { message: str(r.warning) ?? "The payment provider could not confirm this was closed, so it is still shown as open.", tone: "error", resolved: false, canAbandon: true, state: "UNRESOLVED" };
    case "ABANDONED":
      return {
        message: r.cancelsAtProvider === true
          ? "Closed at the payment provider, so this checkout can no longer be paid."
          : "Removed from your open purchases in PROOVRA. This did not cancel anything at the payment provider. If the provider later confirms a payment, PROOVRA still applies it.",
        tone: "success",
        resolved: true,
        canAbandon: false,
        state: null,
      };
    case "ABANDON_NOT_ALLOWED":
      return { message: str(r.warning) ?? "This purchase is being processed and cannot be abandoned.", tone: "info", resolved: false, canAbandon: false, state: "PROCESSING" };
    case "PROVIDER_STATE_RECORDED":
      return { message: "The provider had already settled this purchase, so its answer was recorded instead.", tone: "info", resolved: true, canAbandon: false, state: null };
    default:
      return { message: "This purchase had already been resolved; nothing was changed.", tone: "info", resolved: true, canAbandon: false, state: null };
  }
}

export const ATTEMPT_ABANDON_FALLBACK_WARNING =
  "Abandoning only removes this from PROOVRA's open purchases. It does not cancel anything at the payment provider.";

/** The server's confirmation, as the two facts the sheet needs. */
export function attemptAbandonConfirmation(result: unknown): { warning: string; cancelsAtProvider: boolean } {
  const r = obj(result);
  return { warning: str(r.warning) ?? ATTEMPT_ABANDON_FALLBACK_WARNING, cancelsAtProvider: r.cancelsAtProvider === true };
}

/** The line above the activity rows, by what this build may do. */
export function billingActivityNote(resumeAllowed: boolean): string {
  return resumeAllowed
    ? "Purchases that have not produced a completed payment. Check where each one stands, continue one that is still open, or abandon it."
    : "Purchases that have not produced a completed payment. Check where each one stands or abandon it here. To finish an open purchase, use Billing on the web.";
}

/** States only a person can move on from: the row offers Support, not a dead end. */
export function attemptNeedsSupport(state: string | null): boolean {
  return state === "NEEDS_REVIEW" || state === "REFUSED" || state === "PROVIDER_UNVERIFIED" || state === "UNRESOLVED";
}

/** The refusal's way forward (CheckoutDrawer.tsx), read from its details only. */
export type StorageRefusalAction =
  | { kind: "CONFIRM_ADDITIONAL"; activeCount: number }
  | { kind: "RECOVER"; attemptId: string; pendingProvider: string; createdAtUtc: string | null };

export function storageRefusalAction(err: unknown): StorageRefusalAction | null {
  const details = obj(obj(err).details);
  if (details.retry === "CONFIRM_ADDITIONAL") return { kind: "CONFIRM_ADDITIONAL", activeCount: num(details.activeCount) ?? 1 };
  const attemptId = str(details.attemptId);
  if (details.retry === "RECONCILE_STORAGE_ATTEMPT" && attemptId) {
    return { kind: "RECOVER", attemptId, pendingProvider: str(details.pendingProvider) ?? "PAYPAL", createdAtUtc: str(details.createdAtUtc) };
  }
  return null;
}

/** "Open", never "waiting for your approval": the refusal does not say which. */
export function storageRecoveryIntroduction(pendingProvider: string, started: string | null): string {
  const where = pendingProvider === "STRIPE" ? "by card" : pendingProvider === "PAYPAL" ? "with PayPal" : "with your payment provider";
  return `A storage purchase is already open ${where}${started ? ` (started ${started})` : ""}. Check it before buying again, so you are not billed twice.`;
}

export function storageAdditionalPrompt(activeCount: number, price: string | null): string {
  return `You already have ${activeCount} of this size. Adding another starts a separate recurring charge${price ? ` of ${price} per month` : ""} on top of what you pay now, and adds more storage.`;
}

/**
 * billingMessages.ts REFUSAL_COPY: each of these is a state of the account, not
 * a mistake in what the customer entered, and the OUTCOME_UNKNOWN ones must
 * never read "nothing changed".
 */
const REFUSAL_COPY: Readonly<Record<string, string>> = {
  PAYPAL_APPROVAL_PENDING: "A PayPal checkout for this plan is already open. Finish it at PayPal, or check it under Billing activity before starting another.",
  PAYPAL_DIFFERENT_PLAN_PENDING: "A PayPal checkout for a different plan is already open. Check it under Billing activity before choosing another plan.",
  PLAN_CHECKOUT_ALREADY_OPEN: "A checkout for a plan is already open. Finish it, or resolve it under Billing activity before starting another.",
  CHECKOUT_IN_PROGRESS: "This checkout is already starting. Wait a moment, then look at Billing activity before trying again.",
  PLAN_ALREADY_ACTIVE: "We found your active subscription and updated this account. Nothing was started, and you have not been charged for a new plan.",
  STORAGE_ADDON_ALREADY_HELD: "You already pay for this storage size. Buying it again adds another recurring charge and more storage.",
  STORAGE_PURCHASE_PENDING: "This storage size already has a purchase open with your other payment method. Check that purchase before starting another, so you are not billed twice.",
  PAYPAL_STORAGE_APPROVAL_PENDING: "A PayPal storage purchase is already open on this account. Check its status under Billing activity before starting another.",
  PLAN_CHANGE_ENDS_STORAGE: "This plan does not include some of your storage. It stays until its paid date and then stops renewing. Nothing was changed. Review and confirm this change under Billing on the web.",
  PLAN_CHANGE_STORAGE_MUST_END_FIRST: "This plan does not include your Team storage, and we cannot stop that add-on from here. Nothing was changed. Contact support to end the add-on, then change your plan.",
  STORAGE_ADDON_PREREQUISITE_ENDING: "Your plan is set to end, so this storage add-on cannot be added. Restart your plan first, then add storage.",
  STORAGE_ADDON_NOT_INCLUDED: "Extra storage is not available for this account.",
  STORAGE_ADDON_NOT_OFFERED: "This storage size is not available on your current plan. Choose from the sizes shown here.",
  CHECKOUT_TARGET_NOT_SUPPORTED: "Subscriptions and storage add-ons are bought for your Personal Workspace, not for another workspace.",
  PLAN_CHANGE_OUTCOME_UNKNOWN: "We did not get an answer from your payment provider, so we cannot say yet whether this plan change went through. Check Billing in a few minutes before trying again.",
  BILLING_ATTEMPT_BUSY: "This purchase is being checked right now. Wait a moment, then look again.",
  RATE_LIMIT_EXCEEDED: "That was tried several times just now. Please wait a few minutes, then check Billing before trying again.",
};

/** The sentence for a billing refusal, or null when the code has none of its own. */
export function billingRefusalMessage(err: unknown): string | null {
  const code = str(obj(err).code)?.toUpperCase();
  return (code ? REFUSAL_COPY[code] : undefined) ?? null;
}
