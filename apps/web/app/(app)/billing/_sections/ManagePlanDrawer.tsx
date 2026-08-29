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
            {/*
              ONE line for the thing itself.

              This was a four-row definition list — Plan, Price, Status,
              Renews — which spent a quarter of a drawer restating a heading
              the customer had just read. "Pro · $19 / month" is the same two
              facts in the shape a person already reads them.
            */}
            <p className="bill-panel__lead" data-billing-manage-plan-name>
              <bdi>{plan.displayName}</bdi>
              {price ? (
                <>
                  {" · "}
                  <bdi>{price}</bdi>
                  {plan.model === "MONTHLY" ? " / month" : null}
                </>
              ) : null}
            </p>

            <p className="bill-summary__note" data-billing-manage-meta>
              {[
                lifecycle.label,
                periodEnd && plan.model === "MONTHLY"
                  ? `${plan.cancelAtPeriodEnd ? "Access until" : "Renews"} ${periodEnd}`
                  : null,
                plan.paymentProviderLabel ? `Paid by ${plan.paymentProviderLabel}` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>

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

        {/* ---- Moving between tiers ---------------------------------------
            Each move is a BUTTON and one line about that move — never a
            paragraph repeated under every option. The paragraph this replaces
            ended with "nothing you have already recorded changes" beneath each
            offer in turn, so the one reassurance that matters was read twice
            and believed less each time. It is said ONCE now, where the
            consequence is real: cancellation.

            GRANTED access is excluded. There is no provider relationship
            behind it, so a tier move here would be a purchase dressed as a
            change, and the matrix says access information only. -------- */}
        {offers.length > 0 &&
        !plan.scheduledChange &&
        plan.accessKind === "SUBSCRIPTION" ? (
          <section>
            <h3 className="bill-section__heading">Change plan</h3>
            <ul className="bill-move-list">
              {offers.map((offer) => (
                <li
                  key={offer.planKey}
                  className="bill-move"
                  data-billing-manage-move={offer.planKey}
                >
                  <Button
                    /*
                     * The plan action inside the plan drawer. `variant` stays
                     * "primary" so every state the primitive owns — loading,
                     * disabled, focus ring, 44px target — is unchanged; the
                     * drawer-scoped class repaints it near-black. A new global
                     * variant would have changed buttons on pages that have
                     * nothing to do with this decision.
                     */
                    variant="primary"
                    size="sm"
                    className="bill-plan-action"
                    loading={changeBusyPlan === offer.planKey}
                    disabled={busy}
                    onClick={() => onChangePlan(offer)}
                    data-billing-manage-offer={offer.planKey}
                    data-billing-manage-offer-action={offer.action}
                  >
                    {/* The SERVER's words. Only the side that can see the
                        subscription knows whether this is a move or a
                        purchase. */}
                    {offer.actionLabel}
                  </Button>
                  <p
                    className="bill-move__meta"
                    data-billing-manage-effect={offer.planKey}
                  >
                    {offer.effectSummary}{" "}
                    <span data-billing-manage-timing={offer.planKey}>
                      {/*
                       * The TIMING is read from the server's `effect`, never
                       * asserted here — and it is the only thing said about
                       * when money moves. The sentence this replaces claimed
                       * the provider "charges the difference for the rest of
                       * this period", which is a proration nothing in this
                       * product calculates and no provider had told us.
                       */}
                      {offer.effect === "IMMEDIATE"
                        ? "Starts immediately."
                        : periodEnd
                          ? `Takes effect on ${periodEnd}.`
                          : "Takes effect at the end of the period you have already paid for."}
                    </span>
                  </p>
                </li>
              ))}
            </ul>
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
        ) : plan.accessKind !== "SUBSCRIPTION" ? (
          /*
           * FREE, and the grandfathered credit overlay that sits on a FREE
           * account, have NO cancellation section at all.
           *
           * They used to fall into the branch below and be shown "End
           * subscription" — for a subscription that does not exist — or, when
           * no row could be found, a message telling them to contact support
           * about a missing subscription they never had. Neither is a thing
           * that has happened to them. The page they belong on is the chooser,
           * and the projection sends them there.
           */
          null
        ) : (
          <section>
            {/*
              "Cancel subscription", not "End subscription".

              "End" is a word for something finishing on its own. What this is
              is a request to a payment provider to stop, made by the customer
              — and the heading, the button and the confirmation now all use
              the same verb, so nobody has to work out whether three different
              words mean three different things.
            */}
            <h3 className="bill-section__heading">Cancel subscription</h3>

            {plan.cancelAtPeriodEnd ? (
              <p className="bill-choice__meta" data-billing-manage-cancelling>
                {periodEnd
                  ? `Cancels on ${periodEnd}. You keep ${plan.displayName} until then, and nothing is charged again.`
                  : "This subscription is cancelling at the end of the period you have paid for. Nothing is charged again."}
              </p>
            ) : actions.canRequestCancellation ? (
              <>
                <p className="bill-choice__meta" data-billing-manage-cancel-copy>
                  {/*
                   * The ONE place the evidence reassurance is given, because
                   * this is the only action in the drawer where losing it is
                   * the thing a customer is actually afraid of. Under a
                   * purchase it was noise; here it is the answer.
                   *
                   * The timing is the server's paid-through date when there is
                   * one, and is otherwise left as a promise we can keep —
                   * whether a provider stops immediately or at period end is
                   * the provider's answer, and it is confirmed after they give
                   * it rather than predicted here.
                   */}
                  {periodEnd
                    ? `Your plan will move to Free at the end of the period you have paid for, on ${periodEnd}.`
                    : "Your plan will move to Free once your payment provider confirms; we will tell you the exact date then."}{" "}
                  Your existing evidence and custody records remain available
                  under the applicable retention and access rules.
                </p>
                <div className="bill-stacked-actions" style={{ marginBlockStart: 12 }}>
                  <Button
                    /*
                     * Outlined red, scoped to the drawer: this is the entry
                     * point, not the confirmation. The filled destructive
                     * treatment belongs to the dialog that follows, where the
                     * customer actually decides — and keeping them different
                     * is what stops the last press looking like the first.
                     */
                    variant="secondary"
                    size="sm"
                    className="bill-cancel-action"
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
