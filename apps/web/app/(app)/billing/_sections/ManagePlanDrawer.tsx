"use client";

/**
 * MANAGE PLAN — everything a customer can do about a subscription they have.
 *
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * A paying customer had two top-level buttons that opened the same drawer
 * ("Subscribe to Pro", "Subscribe to Team") and, beside them, a cancellation
 * that looked like one more option of equal weight. Both problems are the same
 * problem: the page never said "this is your subscription, here is what you can
 * do with it", so the one thing people came looking for — how to stop paying —
 * was the hardest thing to find, and the words on offer described buying rather
 * than changing.
 *
 * WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 * It is NOT a provider customer portal, and it does not need one. Every action
 * here is an existing PROOVRA authority reached through the existing routes:
 * the plan-transition service moves the tier, and the provider-first
 * cancellation service ends the subscription. Nothing new is integrated, and
 * nothing here is a link out to Stripe.
 *
 * WHAT THE BROWSER DECIDES
 * ---------------------------------------------------------------------------
 * Nothing. Which moves exist, what each is called, what it will do and when —
 * all of that is `projection.planOffers` and `projection.actions`, composed by
 * the side that can see the subscription. This file renders them.
 */

import { Button } from "../../../../components/ui/Button";
import type {
  BillingAccountProjection,
  PlanOffer,
} from "../../../../lib/api/billing-accounts";
import { BillingDrawer } from "./BillingDrawer";
import { formatDate, formatMoney, presentLifecycle } from "./format";

export function ManagePlanDrawer({
  open,
  projection,
  onClose,
  onChangePlan,
  onCancel,
  changeBusyPlan,
  cancelBusy,
}: {
  open: boolean;
  projection: BillingAccountProjection;
  onClose: () => void;
  /** Move between tiers on the subscription that already exists. */
  onChangePlan: (offer: PlanOffer) => void;
  /** Provider-first cancellation, ending on FREE. */
  onCancel: () => void;
  changeBusyPlan: string | null;
  cancelBusy: boolean;
}) {
  const { plan, actions, planOffers } = projection;
  const lifecycle = presentLifecycle(plan.lifecycle, {
    periodEndUtc: plan.currentPeriodEndUtc,
    graceEndsAtUtc: plan.graceEndsAtUtc,
  });
  const price = formatMoney(plan.priceCents ?? null, plan.currency ?? null);
  const periodEnd = formatDate(plan.currentPeriodEndUtc);
  const offers = planOffers ?? [];
  const busy = cancelBusy || changeBusyPlan !== null;

  return (
    <BillingDrawer
      open={open}
      title={
        plan.accessKind === "CONTRACT"
          ? "Your agreement"
          : plan.accessKind === "GRANTED"
            ? "Access details"
            : "Manage plan"
      }
      description={
        plan.accessKind === "SUBSCRIPTION"
          ? `Your subscription for ${projection.account.displayName}.`
          : `Your plan for ${projection.account.displayName}.`
      }
      onClose={onClose}
      testId="billing-manage-plan-drawer"
      footer={
        <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
          Close
        </Button>
      }
    >
      <div className="bill-drawer-body">
        {/* ---- What you are on, stated before anything can be done to it --- */}
        <section>
          <h3 className="bill-section__heading">Current plan</h3>
          <div className="bill-summary" data-billing-manage-current>
            <div className="bill-facts__row">
              <span className="bill-facts__label">Plan</span>
              <span className="bill-facts__value" data-billing-manage-plan-name>
                {plan.displayName}
              </span>
            </div>
            {price ? (
              <div className="bill-facts__row">
                <span className="bill-facts__label">Price</span>
                <span className="bill-facts__value">
                  <bdi>{price}</bdi>
                  {plan.model === "MONTHLY" ? " / month" : null}
                </span>
              </div>
            ) : null}
            <div className="bill-facts__row">
              <span className="bill-facts__label">Status</span>
              <span className="bill-facts__value">{lifecycle.label}</span>
            </div>
            {periodEnd && plan.model === "MONTHLY" ? (
              <div className="bill-facts__row">
                <span className="bill-facts__label">
                  {plan.cancelAtPeriodEnd ? "Access until" : "Renews"}
                </span>
                <span className="bill-facts__value">{periodEnd}</span>
              </div>
            ) : null}
            {plan.paymentProviderLabel ? (
              <div className="bill-facts__row">
                <span className="bill-facts__label">Paid by</span>
                <span className="bill-facts__value">{plan.paymentProviderLabel}</span>
              </div>
            ) : null}

            {/* A scheduled change is stated HERE, before the moves, because it
                changes what every one of them means. */}
            {plan.scheduledChange ? (
              <p className="bill-summary__note" data-billing-manage-scheduled>
                {plan.scheduledChange.effectiveAtUtc
                  ? `Moving to ${plan.scheduledChange.displayName} on ${formatDate(
                      plan.scheduledChange.effectiveAtUtc,
                    )}. You keep everything you have now until then.`
                  : `Moving to ${plan.scheduledChange.displayName} at the end of this billing period. You keep everything you have now until then.`}
              </p>
            ) : null}
          </div>
        </section>

        {/* ---- Moving between tiers --------------------------------------- */}
        {offers.length > 0 &&
        !plan.scheduledChange &&
        plan.accessKind !== "CONTRACT" ? (
          <section>
            <h3 className="bill-section__heading">Change plan</h3>
            <div className="bill-stacked-actions">
              {offers.map((offer) => (
                <Button
                  key={offer.planKey}
                  variant={offer.action === "DOWNGRADE" ? "secondary" : "primary"}
                  size="sm"
                  loading={changeBusyPlan === offer.planKey}
                  disabled={busy}
                  onClick={() => onChangePlan(offer)}
                  data-billing-manage-offer={offer.planKey}
                  data-billing-manage-offer-action={offer.action}
                >
                  {/* The SERVER's words. "Upgrade to Team" and "Switch to Pro"
                      are different claims about the subscription, and only the
                      side that can see it knows which is true. */}
                  {offer.actionLabel}
                </Button>
              ))}
            </div>
            {offers.map((offer) => (
              <p
                key={`${offer.planKey}-effect`}
                className="bill-summary__note"
                data-billing-manage-effect={offer.planKey}
              >
                {offer.actionLabel}: {offer.effectSummary}
              </p>
            ))}
          </section>
        ) : null}

        {/*
          A GRANTED tier has no billing relationship to end.

          The page used to describe one anyway — "Billed monthly", a catalogue
          price and a renewal date — because the projection fell back to what
          the TIER costs whenever a paid plan had no subscription row. There is
          nothing to renew, nothing is charged, and there is nothing for a
          provider to cancel, so the section says that rather than offering a
          button with no provider behind it.
        */}
        {plan.accessKind === "GRANTED" ? (
          <section data-billing-granted-access>
            <h3 className="bill-section__heading">How you have this plan</h3>
            <p className="bill-choice__meta">
              {plan.displayName} access was granted to this account. There is no
              active billing subscription behind it: nothing is charged, and it
              does not renew automatically. If you expected to be billed for
              this, contact support and we will look at it with you.
            </p>
          </section>
        ) : plan.accessKind === "CONTRACT" ? (
          <section data-billing-agreement>
            <h3 className="bill-section__heading">Changing your agreement</h3>
            <p className="bill-choice__meta">
              Enterprise terms are set by your agreement. Your account manager
              is the person who can change them — this page cannot, and offering
              a checkout that replaced a signed agreement with a card payment
              would be worse than offering none.
            </p>
          </section>
        ) : (
          <section>
            <h3 className="bill-section__heading">End subscription</h3>

          {plan.cancelAtPeriodEnd ? (
            <p className="bill-choice__meta" data-billing-manage-cancelling>
              {periodEnd
                ? `Cancels on ${periodEnd}. You keep ${plan.displayName} until then, and nothing is charged again.`
                : "This subscription is cancelling at the end of the period you have paid for. Nothing is charged again."}
            </p>
          ) : actions.canRequestCancellation ? (
            <>
              <p className="bill-choice__meta">
                Your account moves to Free on the same workspace. Your evidence,
                custody history and verification packages are not deleted.
              </p>
              <div className="bill-stacked-actions" style={{ marginBlockStart: 12 }}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={onCancel}
                  loading={cancelBusy}
                  disabled={busy}
                  data-billing-manage-cancel
                >
                  Cancel subscription
                </Button>
              </div>
            </>
          ) : (
            /*
             * The SERVER said no, and the page says which no it was.
             *
             * Hiding the section entirely is what made cancellation
             * undiscoverable: a customer who cannot cancel and a customer whose
             * subscription we cannot find looked identical — like a product
             * with no cancellation at all.
             */
            <p className="bill-choice__meta" data-billing-manage-cancel-unavailable>
              {actions.cancellationUnavailableReason === "NO_SUBSCRIPTION_BOUND"
                ? "We cannot find a live subscription for this plan with your payment provider, so there is nothing here for us to stop. Please contact support and we will look at it with you — nothing will be charged again in the meantime without one."
                : "Ending this subscription is done by the account's billing owner."}
              </p>
            )}
          </section>
        )}
      </div>
    </BillingDrawer>
  );
}
