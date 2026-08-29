"use client";

/**
 * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — the plan summary, the
 * action-required banner, and the three usage meters.
 *
 * What was removed from the surface these replace, and why:
 *   * "Workspace plan view" / "Effective capability view" / "Billing status" —
 *     three internal resolver outputs printed as customer copy.
 *   * "This workspace is currently operating under the owner's PRO
 *     entitlement" — factually wrong since §9.4: an Owned Workspace never
 *     inherits its owner's Personal plan.
 *   * "Billing ownership: Assigned / Not assigned" — a nullable foreign key
 *     rendered as prose, for a field that authorized nothing.
 *   * "Workspace health: Near limit: No / Limit reached: No" — two booleans a
 *     customer cannot act on.
 *   * Storage shown five different ways on one card.
 *   * "Projects" — a metric PROOVRA has no concept of.
 *
 * The meters are Evidence, Storage and AI, and nothing else. Each renders the
 * SERVER's state: a plan that excludes a capability says "Not included", a
 * contract that governs one says "Contract-managed", and a value that could not
 * be read says "Unavailable" — never a zero standing in for any of them.
 */

import Link from "next/link";

import { Badge } from "../../../../components/ui/Badge";
import { Button } from "../../../../components/ui/Button";
import { Card } from "../../../../components/ui/Card";
import type {
  BillingAccountProjection,
  PlanOffer,
  StorageMeter,
  UsageMeter,
} from "../../../../lib/api/billing-accounts";
import {
  describeEvidenceAdmission,
  describeMeter,
  describeModel,
  formatDate,
  formatMoney,
  presentLifecycle,
} from "./format";

/** A bar that only fills when there is a real denominator to fill. */
function Meter({
  label,
  headline,
  detail,
  ratio,
  tone = "neutral",
  action,
  testId,
}: {
  label: string;
  headline: string;
  detail: string | null;
  ratio: number | null;
  tone?: "neutral" | "pending" | "risk";
  /** The offer that answers the detail copy. Rendered under it. */
  action?: React.ReactNode;
  testId?: string;
}) {
  // The meter's colour is the route's tone token, never a literal — so a
  // warning here is the same amber as a warning anywhere else in the product.
  const fill =
    tone === "risk"
      ? "var(--status-risk-solid, #dc2626)"
      : tone === "pending"
        ? "var(--status-pending-solid, #f59e0b)"
        : "var(--status-info-solid, #2563eb)";

  return (
    <div data-testid={testId} className="bill-meter">
      <div className="bill-meter__label">{label}</div>
      {/*
        Bidi-isolated for the same reason money is: "176 of 500 records in the
        last 30 days" is one self-contained phrase, and without isolation the
        bidi algorithm reorders its leading numeral to the far end when the
        surrounding paragraph runs right-to-left. The reader then sees
        "of 500 records in the last 30 days 176".
      */}
      <bdi className="bill-meter__headline">{headline}</bdi>
      {ratio !== null ? (
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(ratio * 100)}
          aria-label={`${label}: ${headline}`}
          className="bill-meter__track"
        >
          <div
            className="bill-meter__fill"
            style={{ width: `${Math.round(ratio * 100)}%`, background: fill }}
          />
        </div>
      ) : null}
      {detail ? <div className="bill-meter__detail">{detail}</div> : null}
      {action ? <div className="bill-meter__action">{action}</div> : null}
    </div>
  );
}

function storageMeterProps(meter: StorageMeter) {
  if (meter.state === "UNAVAILABLE") {
    return {
      headline: "Unavailable",
      detail: meter.reason,
      ratio: null,
      tone: "neutral" as const,
    };
  }
  const extras: string[] = [];
  if (meter.recurringAddonBytes !== "0") {
    extras.push(`${meter.recurringAddonLabel} from add-ons`);
  }
  if (meter.legacyAddonBytes !== "0") {
    // Named, because it is a different commercial object: a one-time purchase
    // that is grandfathered and never renews.
    extras.push(`${meter.legacyAddonLabel} from earlier one-time purchases`);
  }
  return {
    headline: `${meter.usedLabel} of ${meter.limitLabel}`,
    detail: [`${meter.baseLabel} included`, ...extras].join(" · "),
    ratio: Math.min(1, meter.usagePercent / 100),
    tone: meter.limitReached
      ? ("risk" as const)
      : meter.nearLimit
        ? ("pending" as const)
        : ("neutral" as const),
  };
}

/**
 * The banner. Rendered ONLY when the SERVER says something needs doing.
 *
 * This used to branch on the raw lifecycle value and re-read the storage
 * meter to decide whether to appear and what to say. Both are
 * commercial judgements — the grace clock especially — and the server holds
 * every input to them. It now renders a decision rather than making one.
 */
export function ActionRequiredBanner({
  projection,
  onRetryStorageCancellation,
  retryBusy = false,
}: {
  projection: BillingAccountProjection;
  /**
   * BILLING DEPENDENT-CANCELLATION CONVERGENCE (2026-08-27) — retry the
   * outstanding storage add-on cancellations.
   *
   * Passed in rather than derived here: whether there is anything to retry is
   * the server's `dependentStorageCancellation`, and what pressing it does is
   * the page's. This component renders a decision, as it already did for the
   * banner itself.
   */
  onRetryStorageCancellation?: () => void;
  retryBusy?: boolean;
}) {
  const banner = projection.actionRequired;
  const outstanding = projection.dependentStorageCancellation;
  if (!banner) return null;

  return (
    <Card
      variant="status"
      tone={banner.severity === "CRITICAL" ? "risk" : "pending"}
      role="alert"
      data-billing-action-required
      title={banner.title}
    >
      <div style={{ display: "grid", gap: 6 }}>
        {banner.messages.map((m) => (
          <p
            key={m}
            style={{
              margin: 0,
              fontSize: "0.9rem",
              lineHeight: 1.65,
              color: "var(--text-muted, #475569)",
            }}
          >
            {m}
          </p>
        ))}
      </div>
      {banner.reassurance ? (
        <p
          style={{
            margin: "12px 0 0",
            fontSize: "0.85rem",
            color: "var(--text-muted, #5F6878)",
          }}
        >
          {banner.reassurance}
        </p>
      ) : null}

      {outstanding && outstanding.actionAvailable && onRetryStorageCancellation ? (
        <div
          style={{ marginTop: 14, display: "flex", gap: 10, flexWrap: "wrap" }}
          data-billing-addon-retry
        >
          <Button
            variant="secondary"
            size="sm"
            onClick={onRetryStorageCancellation}
            loading={retryBusy}
            disabled={retryBusy}
            data-billing-addon-retry-action
          >
            Retry stopping storage add-ons
          </Button>
          {outstanding.supportRequired ? (
            // MANUAL_INTERVENTION. The automatic retries are spent and the
            // add-on may still be charging, so the customer is given a real
            // next step rather than being asked to keep pressing a button.
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                window.location.href = "/settings/support";
              }}
              data-billing-addon-support
            >
              Contact support
            </Button>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

export function PlanSummaryCard({
  projection,
  onManage,
  onChangePlan,
  onCancel,
  cancelBusy,
  changeBusyPlan,
}: {
  projection: BillingAccountProjection;
  /**
   * Opens the checkout drawer ON THE PLAN THAT WAS PRESSED.
   *
   * It took no argument, so both purchase buttons opened an identical drawer
   * and the drawer guessed which plan was meant.
   */
  onManage: (offer: PlanOffer) => void;
  /**
   * BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — moving between tiers on
   * the subscription that already exists.
   *
   * Distinct from `onManage` because they are different acts, not two ways of
   * doing one. A checkout creates a subscription; this changes one. Collapsing
   * them is how a PRO customer wanting TEAM ended up with two live
   * subscriptions and two monthly charges.
   */
  onChangePlan: (offer: PlanOffer) => void;
  onCancel: () => void;
  cancelBusy: boolean;
  /** The plan key currently being changed to, so only that button spins. */
  changeBusyPlan: string | null;
}) {
  const { plan, account, actions, contract, planOffers } = projection;
  const lifecycle = presentLifecycle(plan.lifecycle, {
    periodEndUtc: plan.currentPeriodEndUtc,
    graceEndsAtUtc: plan.graceEndsAtUtc,
  });
  const price = formatMoney(plan.priceCents ?? null, plan.currency ?? null);
  const renews = formatDate(plan.currentPeriodEndUtc);

  return (
    <Card
      variant="summary"
      data-billing-plan-summary
    >
      {/*
        BILLING SURFACE CORRECTION (2026-08-29) — the current plan is the HERO.
        It was a header strip and a stack of same-sized lines, so the price of
        the plan read at the same weight as the name of the payment provider,
        and the actions sat below three paragraphs of small print.

        The hierarchy now matches the question the page exists to answer: what
        am I on, what does it cost, what can I do about it. The actions are
        last in source order as well as in space, so a screen reader reaches
        the facts before it reaches "Cancel subscription".
      */}
      <div className="bill-hero" data-billing-hero>
        <div className="bill-hero__facts">
          <div className="bill-hero__eyebrow">Current plan</div>
          <h2 className="bill-hero__name" data-billing-plan-name>
            {contract ? "Enterprise agreement" : plan.displayName}
          </h2>
          <div className="bill-hero__line">
            {account.displayName} · {describeModel(plan.model)}
          </div>

          {price ? (
            <div className="bill-hero__price">
              {/* Isolated so the currency symbol cannot reorder in RTL. */}
              <bdi className="bill-hero__amount">{price}</bdi>
              {plan.model === "MONTHLY" ? (
                <span className="bill-hero__cadence">per month</span>
              ) : null}
            </div>
          ) : null}

          {/* A renewal date is shown only when the provider gave one. A credit
              purchase has none, and inventing one was how the old card implied
              a subscription that did not exist. */}
          {renews && plan.model === "MONTHLY" ? (
            <div className="bill-hero__line">
              {plan.cancelAtPeriodEnd
                ? `Access continues until ${renews}.`
                : `Renews on ${renews}.`}
            </div>
          ) : null}

          {lifecycle.detail && plan.lifecycle !== "PAST_DUE" ? (
            <div className="bill-hero__line">{lifecycle.detail}</div>
          ) : null}

        {/* A scheduled change is stated BEFORE the price and the actions are
            read, because it changes what both of them mean. Without it the
            card shows Team to someone who asked for Pro last week and has no
            way to tell whether we heard them. */}
          {plan.scheduledChange ? (
            <div className="bill-hero__line" data-billing-scheduled-change>
            {plan.scheduledChange.effectiveAtUtc
              ? `Moving to ${plan.scheduledChange.displayName} on ${formatDate(
                  plan.scheduledChange.effectiveAtUtc,
                )}. You keep everything you have now until then.`
                : `Moving to ${plan.scheduledChange.displayName} at the end of this billing period. You keep everything you have now until then.`}
            </div>
          ) : null}

          {plan.paymentProviderLabel ? (
            <div className="bill-hero__line">
              Paid by {plan.paymentProviderLabel}
            </div>
          ) : null}
        </div>

        <div className="bill-hero__aside">
          <Badge tone={lifecycle.tone} dot data-billing-plan-status>
            {lifecycle.label}
          </Badge>
          <div className="bill-actions">
        {/* One button per move the SERVER says this account may make, in the
            order the server listed them — which is the ladder, so a downgrade
            reads below an upgrade rather than beside it.

            Every word comes from the server. "Upgrade to Team", "Switch to
            Pro" and "Subscribe to Pro" are three different claims about the
            account's commercial state, and only the side that can see the
            subscription knows which is true.

            A scheduled change hides them all: offering a second move while the
            first has not landed would let a customer queue two changes the
            provider holds one schedule for. */}
        {actions.canStartCheckout && !plan.scheduledChange
          ? (planOffers ?? []).map((offer) => (
              <Button
                key={offer.planKey}
                variant={offer.action === "DOWNGRADE" ? "secondary" : "primary"}
                size="sm"
                loading={changeBusyPlan === offer.planKey}
                disabled={changeBusyPlan !== null}
                onClick={() =>
                  offer.action === "CHECKOUT" ? onManage(offer) : onChangePlan(offer)
                }
                data-billing-plan-offer={offer.planKey}
                data-billing-plan-offer-action={offer.action}
              >
                {offer.actionLabel}
              </Button>
            ))
          : null}

        {actions.canRequestCancellation && !plan.cancelAtPeriodEnd ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={onCancel}
            loading={cancelBusy}
            disabled={cancelBusy}
            data-billing-cancel-plan
          >
            Cancel subscription
          </Button>
        ) : null}

            {actions.contactAccountManager ? (
              <Link
                href="/contact-sales"
                className="app-header-primary-action"
                data-billing-contact-account-manager
              >
                <span>Contact your account manager</span>
              </Link>
            ) : null}
          </div>
        </div>
      </div>
    </Card>
  );
}

export function UsageAndLimits({
  projection,
  onBuyCredits,
  onUpgrade,
}: {
  projection: BillingAccountProjection;
  /** Opens the credit purchase. Only offered when the server allows it. */
  onBuyCredits?: () => void;
  onUpgrade?: (planKey: "PRO" | "TEAM") => void;
}) {
  const evidence = describeMeter(projection.usage.evidence);
  const ai = describeMeter(projection.usage.ai);
  const storage = storageMeterProps(projection.usage.storage);
  const wallet = projection.wallet;

  /*
   * BILLING SURFACE CORRECTION (2026-08-29) — the evidence meter reads the
   * SERVER's admission projection when there is one.
   *
   * `describeMeter` gets a used/limit pair, which is all it can say; the pair
   * cannot distinguish "what your plan includes" from "the higher limit this
   * grandfathered account keeps", and the copy it produced asserted the first
   * while displaying the second. `evidenceAdmission` carries the parts and
   * the gate's own answer for the next record.
   *
   * Absent for a rolling-window plan (TEAM) and for a contract-managed
   * Organization, which `describeMeter` already describes correctly.
   */
  const upgradeOffer = projection.planOffers?.find(
    (o) => o.planKey === "PRO" || o.planKey === "TEAM",
  );
  const admission = projection.evidenceAdmission
    ? describeEvidenceAdmission(projection.evidenceAdmission, {
        canBuyCredits: projection.actions.canBuyEvidenceCredits === true,
        hasPlanOffer: Boolean(upgradeOffer),
      })
    : null;

  return (
    <Card variant="summary" title="Usage and limits" data-billing-usage>
      <div className="bill-usage-grid">
        <Meter
          label="Evidence"
          headline={admission ? admission.headline : evidence.headline}
          detail={
            admission
              ? [admission.breakdown, admission.next].filter(Boolean).join(" ")
              : // Credits are shown WITH the meter, because they are what
                // continues the same activity once the allowance is gone.
                wallet && wallet.availableCredits > 0
                ? `${wallet.availableCredits} evidence credit${
                    wallet.availableCredits === 1 ? "" : "s"
                  } available after that.`
                : evidence.detail
          }
          ratio={admission ? admission.ratio : evidence.ratio}
          /*
           * A full bar was painted `risk` — the destructive red the product
           * reserves for deletion — for a customer whose account is working
           * exactly as sold. Past the allowance is a WARNING with a remedy,
           * and the remedy is written next to it rather than left to colour.
           */
          tone={
            admission
              ? admission.tone
              : evidence.ratio !== null && evidence.ratio >= 1
                ? "pending"
                : "neutral"
          }
          action={
            admission?.action === "BUY_CREDITS" && onBuyCredits ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={onBuyCredits}
                data-billing-evidence-action="BUY_CREDITS"
              >
                Buy evidence credits
              </Button>
            ) : admission?.action === "SEE_PLANS" && onUpgrade && upgradeOffer ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onUpgrade(upgradeOffer.planKey)}
                data-billing-evidence-action="SEE_PLANS"
              >
                See plans
              </Button>
            ) : null
          }
          testId="billing-meter-evidence"
        />
        <Meter
          label="Storage"
          headline={storage.headline}
          detail={storage.detail}
          ratio={storage.ratio}
          tone={storage.tone}
          testId="billing-meter-storage"
        />
        <Meter
          label="AI operations"
          headline={ai.headline}
          detail={
            ai.detail ??
            (projection.usage.ai.state === "MEASURED" &&
            projection.usage.ai.window === "CALENDAR_MONTH"
              ? "Resets at the start of each month."
              : null)
          }
          ratio={ai.ratio}
          tone={ai.ratio !== null && ai.ratio >= 1 ? "risk" : "neutral"}
          testId="billing-meter-ai"
        />
      </div>
    </Card>
  );
}

export function CollaborationUsageCard({
  projection,
}: {
  projection: BillingAccountProjection;
}) {
  const c = projection.collaboration;
  if (!c || (!c.collaborationTeams && !c.seats)) {
    return null;
  }

  return (
    <Card
      variant="summary"
      title={projection.account.type === "PERSONAL" ? "Workspaces and teams" : "Members"}
      data-billing-collaboration
    >
      <div
        style={{
          display: "grid",
          gap: 20,
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
        }}
      >
        {/* Two independently-named values. The metric these replace —
            "Teams — Current usage: N of M" — compared a Collaboration Team
            membership count against the account's Owned Workspace cap.

            BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — the third,
            "Owned workspaces", was removed with the allowance it reported. */}
        {c.collaborationTeams ? (
          <Meter
            label="Collaboration teams"
            headline={`${c.collaborationTeams.used} of ${c.collaborationTeams.limit}`}
            detail="In this workspace."
            ratio={
              c.collaborationTeams.limit > 0
                ? Math.min(
                    1,
                    c.collaborationTeams.used / c.collaborationTeams.limit,
                  )
                : null
            }
            testId="billing-meter-collaboration-teams"
          />
        ) : null}

        {c.seats ? (
          <Meter
            label="Accepted members"
            /* A null limit means the agreement does not name one. "12 of 0"
               reads as a breach and is not one; there is no number we could
               put there that would be the agreement's. */
            headline={
              c.seats.limit === null
                ? `${c.seats.used}`
                : `${c.seats.used} of ${c.seats.limit}`
            }
            // Pending invitations are named separately and never folded into
            // the seat count — an invitation is not a member.
            detail={
              c.seats.limit === null
                ? "Your agreement sets this allowance."
                : c.seats.pendingInvites > 0
                  ? `${c.seats.pendingInvites} invitation${
                      c.seats.pendingInvites === 1 ? "" : "s"
                    } pending — not counted here.`
                  : null
            }
            ratio={
              c.seats.limit !== null && c.seats.limit > 0
                ? Math.min(1, c.seats.used / c.seats.limit)
                : null
            }
            testId="billing-meter-seats"
          />
        ) : null}
      </div>
    </Card>
  );
}

export function EnterpriseContractCard({
  projection,
}: {
  projection: BillingAccountProjection;
}) {
  const contract = projection.contract;
  if (!contract) return null;

  const rows: Array<[string, string]> = [];
  const effective = formatDate(contract.effectiveAtUtc);
  const ends = formatDate(contract.endsAtUtc);
  if (effective) rows.push(["Effective from", effective]);
  if (ends) rows.push(["Term ends", ends]);
  if (contract.seatCount !== null) {
    rows.push(["Contracted seats", String(contract.seatCount)]);
  }
  if (contract.storageGb !== null) {
    rows.push(["Contracted storage", `${contract.storageGb} GB`]);
  }
  if (contract.region) rows.push(["Region", contract.region]);

  return (
    <Card variant="summary" title="Agreement" data-billing-contract>
      {contract.derivedFromLegacyFallback ? (
        // Honest rather than confident: this projection was derived, not read
        // from a contract record, so no number here is published as a term.
        <p
          style={{
            margin: "0 0 12px",
            fontSize: "0.9rem",
            lineHeight: 1.65,
            color: "var(--text-muted, #475569)",
          }}
          data-billing-contract-legacy
        >
          We do not have your full agreement on file here. Your account manager
          holds the authoritative terms.
        </p>
      ) : null}

      {rows.length > 0 ? (
        <dl
          style={{
            display: "grid",
            gap: 10,
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            margin: 0,
          }}
        >
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  color: "var(--text-muted, #5F6878)",
                }}
              >
                {label}
              </dt>
              <dd
                style={{
                  margin: "4px 0 0",
                  fontSize: "0.95rem",
                  color: "var(--text-strong, #172033)",
                }}
              >
                {value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </Card>
  );
}

export type { UsageMeter };
