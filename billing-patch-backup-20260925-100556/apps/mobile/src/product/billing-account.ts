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
import type { ProovraStatusTone } from "@proovra/ui";

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
    scheduledChange: { displayName: string; effectiveAtUtc: string | null } | null;
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
  actionRequired: { severity: string; title: string; messages: string[]; reassurance: string | null } | null;
  dependentStorageCancellation: { actionAvailable: boolean; supportRequired: boolean } | null;
  storageAddons: { offerCount: number; active: ActiveAddonModel[] } | null;
  storageAddonsLocked: { reason: string; unlockedByPlan: string | null } | null;
  actions: {
    canBuyEvidenceCredits: boolean;
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
      scheduledChange: sched ? { displayName: str(sched.displayName) ?? str(sched.planKey) ?? "", effectiveAtUtc: str(sched.effectiveAtUtc) } : null,
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

/** page.tsx `handleAccountRecheck`, by the reconcile route's `outcome`. */
export function reconcileMessage(result: unknown): { message: string; tone: "success" | "info" | "error"; refresh: boolean } {
  switch (str(obj(result).outcome)) {
    case "UPDATED":
      return { message: "Your provider had something we had not recorded. Your billing is now up to date.", tone: "success", refresh: true };
    case "PENDING":
      return { message: "Your provider is still settling a payment. Check again in a few minutes — nothing is charged twice.", tone: "info", refresh: false };
    case "ACTION_REQUIRED":
      return { message: "Something on this account needs our help. Please contact support.", tone: "error", refresh: false };
    case "PROVIDER_UNAVAILABLE":
      return { message: "We could not reach your payment provider just now. Your billing records are unchanged.", tone: "error", refresh: false };
    default:
      return { message: "Everything on this account already matches your payment provider.", tone: "success", refresh: false };
  }
}

/** page.tsx `announceAbandonOutcome`. */
export function abandonMessage(outcome: string | null): { message: string; tone: "success" | "info" } {
  switch (outcome) {
    case "ABANDONED":
    case "ALREADY_ABANDONED":
      return { message: "This payment attempt was removed from your active Billing view. Nothing was canceled or changed at your payment provider.", tone: "success" };
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
  const recurring = (p.storageAddons?.active ?? []).filter((a) => !a.legacyOneTime && a.status === "ACTIVE");
  return [
    `We will ask your payment provider to stop renewing it. ${
      paidUntil
        ? `You have paid through ${paidUntil}; where the provider supports it you keep ${p.plan.displayName} until then, and we will confirm the exact date after they answer.`
        : "Where the provider supports it you keep your current plan until the end of the period you have already paid for, and we will confirm the exact date after they answer."
    } Nothing is charged again.`,
    "Your evidence is not deleted. Records, custody history, hashes, signatures and verification packages all stay exactly as they are.",
    recurring.length > 0
      ? `${recurring.length} recurring storage add-on${recurring.length === 1 ? "" : "s"} will be cancelled with it, so that extra capacity ends too.`
      : "You have no recurring storage add-ons, so nothing else is cancelled.",
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
  historyProviderSubtitle: "Checks your payment provider for anything we have not recorded on this account. Nothing is charged again.",
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
