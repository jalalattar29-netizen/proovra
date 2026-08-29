"use client";

/**
 * The BUY drawer: a plan, an evidence credit, or a storage add-on.
 *
 * WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 * It is not where an existing subscription is MANAGED. A customer who already
 * pays for something is changing it, not buying it again, and the two read
 * differently and end differently — see `ManagePlanDrawer`. Collapsing them is
 * how "Subscribe to Team" ended up in front of a customer who was already on
 * Pro, which is an upgrade of the subscription they have.
 *
 * WHAT THE BROWSER DECIDES HERE
 * ---------------------------------------------------------------------------
 * Which option the customer picked, and nothing else. Every price, allowance,
 * currency and quantity is the server's, rendered as given. The request body
 * carries the CHOICE and the display currency; there is no field in it that a
 * browser could be wrong about.
 */

import { useEffect, useState } from "react";

import { Button } from "../../../../components/ui/Button";
import { apiFetch } from "../../../../lib/api";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { captureException } from "../../../../lib/sentry";
import type {
  BillingAccountProjection,
  PlanOffer,
  StorageAddonOffer,
} from "../../../../lib/api/billing-accounts";
import { formatMoney } from "./format";
import { BillingDrawer } from "./BillingDrawer";

export type PlanKey = "PRO" | "TEAM";

/**
 * WHAT the drawer was opened to buy.
 *
 * A discriminated union rather than a bare string, so a PLAN intent must carry
 * the plan. The version this replaces was `"PLAN" | "CREDITS" | "STORAGE"`,
 * which could not say WHICH plan — so the drawer guessed, and guessed wrong.
 * `planKey` is optional here because the FREE chooser legitimately opens with
 * nothing selected; what is not optional is that checkout refuses without one.
 */
export type CheckoutIntent =
  | { kind: "PLAN"; planKey?: PlanKey }
  | { kind: "CREDITS" }
  | { kind: "STORAGE"; addonKey?: string };

type Provider = "STRIPE" | "PAYPAL";

export function CheckoutDrawer({
  open,
  intent,
  projection,
  onClose,
  onCompleted,
  onError,
}: {
  open: boolean;
  intent: CheckoutIntent;
  projection: BillingAccountProjection;
  onClose: () => void;
  onCompleted: () => void;
  onError: (title: string, message: string) => void;
}) {
  const [provider, setProvider] = useState<Provider>("STRIPE");
  const [busy, setBusy] = useState(false);

  const openedWithPlan = intent.kind === "PLAN" ? (intent.planKey ?? null) : null;
  const openedWithAddon = intent.kind === "STORAGE" ? (intent.addonKey ?? null) : null;

  const [selectedPlan, setSelectedPlan] = useState<PlanKey | null>(openedWithPlan);
  const [selectedAddon, setSelectedAddon] = useState<string | null>(openedWithAddon);

  // Re-seed whenever the drawer is opened again from a different affordance.
  // Without this, opening on Pro, closing, then opening on Team would keep the
  // stale Pro selection and check out the wrong thing a second time.
  useEffect(() => {
    if (!open) return;
    setSelectedPlan(openedWithPlan);
    setSelectedAddon(openedWithAddon);
  }, [open, openedWithPlan, openedWithAddon]);

  const currency = projection.plan.currency ?? "USD";
  const offers = projection.storageAddons?.offers ?? [];
  const planOffers = projection.planOffers ?? [];
  const wallet = projection.wallet;

  async function send(request: () => Promise<unknown>) {
    setBusy(true);
    try {
      const data = await request();

      // Stripe returns a hosted session; PayPal returns approval links. Both
      // are provider-hosted — nothing here ever touches card details.
      const stripeUrl = (data as { session?: { url?: string } })?.session?.url;
      if (stripeUrl) {
        window.location.href = stripeUrl;
        return;
      }
      const links =
        (data as { subscription?: { links?: Array<{ rel: string; href: string }> } })
          ?.subscription?.links ??
        (data as { order?: { links?: Array<{ rel: string; href: string }> } })?.order
          ?.links;
      const approve = links?.find((l) => l.rel === "approve");
      if (approve?.href) {
        window.location.href = approve.href;
        return;
      }
      throw new Error("Checkout did not return an approval destination");
    } catch (err) {
      captureException(err, { feature: "billing_checkout_drawer", intent: intent.kind });
      // Never a raw provider or internal message.
      const safe = toSafeUserError(err, {
        message: "We could not start checkout. Please try again in a moment.",
      });
      onError(safe.title, safe.message);
    } finally {
      setBusy(false);
      onCompleted();
    }
  }

  function startCheckout() {
    if (intent.kind === "CREDITS") {
      // Credits take no commercial input: quantity and price are resolved
      // server-side from the canonical product, and the body carries a display
      // currency and nothing else.
      const creditBody = JSON.stringify({ currency });
      return provider === "STRIPE"
        ? send(() =>
            apiFetch("/v1/billing/credits/checkout/stripe", {
              method: "POST",
              body: creditBody,
            }),
          )
        : send(() =>
            apiFetch("/v1/billing/credits/checkout/paypal", {
              method: "POST",
              body: creditBody,
            }),
          );
    }

    if (intent.kind === "STORAGE") {
      if (!selectedAddon) {
        onError("Choose a size", "Select the capacity you want before continuing.");
        return;
      }
      const addonBody = JSON.stringify({
        addonKey: selectedAddon,
        billingCycle: "MONTHLY",
        currency,
      });
      return provider === "STRIPE"
        ? send(() =>
            apiFetch("/v1/billing/storage-addons/checkout/stripe", {
              method: "POST",
              body: addonBody,
            }),
          )
        : send(() =>
            apiFetch("/v1/billing/storage-addons/checkout/paypal", {
              method: "POST",
              body: addonBody,
            }),
          );
    }

    // Nothing selected is a bug, not a default. Guessing here is precisely how
    // the previous version charged for the wrong plan.
    if (!selectedPlan) {
      onError("Choose a plan", "Select the plan you want before continuing to payment.");
      return;
    }

    const planBody = JSON.stringify({ plan: selectedPlan, currency });
    return provider === "STRIPE"
      ? send(() =>
          apiFetch("/v1/billing/checkout/stripe", {
            method: "POST",
            body: planBody,
          }),
        )
      : send(() =>
          apiFetch("/v1/billing/checkout/paypal", {
            method: "POST",
            body: planBody,
          }),
        );
  }

  const title =
    intent.kind === "CREDITS"
      ? "Buy evidence credits"
      : intent.kind === "STORAGE"
        ? "Add storage"
        : "Choose your plan";

  /**
   * ONE explanation, in the header.
   *
   * The credit drawer used to carry the same sentence twice — once here and
   * again inside "What you have now" — which made a short drawer read as a
   * long one and left the customer scanning for the difference between two
   * identical paragraphs.
   */
  const description =
    intent.kind === "CREDITS"
      ? "Each credit records one more evidence item once your included allowance is used."
      : intent.kind === "STORAGE"
        ? "Extra capacity, billed monthly alongside your plan. You can cancel it at any time."
        : "Select the plan that fits your evidence and collaboration needs.";

  const selectedPlanOffer = planOffers.find((p) => p.planKey === selectedPlan);

  /**
   * The primary action names the PAYMENT METHOD it is about to hand over to.
   *
   * BILLING PLAN-SELECTION CORRECTION (2026-08-31) — it used to name the plan
   * ("Continue with Pro"), which is the fact the summary directly above the
   * button already states. What a customer cannot otherwise tell at the moment
   * of pressing is WHERE they are about to be sent, and being handed to a
   * provider unannounced is the surprise worth removing.
   */
  const continueLabel =
    intent.kind === "PLAN" && !selectedPlan
      ? "Continue to payment"
      : provider === "STRIPE"
        ? "Continue with Card"
        : "Continue with PayPal";

  const selectedPlanPrice = selectedPlanOffer
    ? formatMoney(selectedPlanOffer.priceCents, selectedPlanOffer.currency ?? currency)
    : null;

  const nothingToBuy =
    (intent.kind === "PLAN" && planOffers.length === 0) ||
    (intent.kind === "STORAGE" && offers.length === 0) ||
    (intent.kind === "CREDITS" && !wallet);

  return (
    <BillingDrawer
      open={open}
      title={title}
      description={description}
      onClose={onClose}
      testId="billing-checkout-drawer"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            /* Drawer-scoped near-black. See `.bill-drawer .bill-plan-action`
               in billing.css: the class cannot reach a button outside a
               Billing drawer, and the primitive keeps every state it owns. */
            className="bill-plan-action"
            loading={busy}
            disabled={
              busy ||
              nothingToBuy ||
              (intent.kind === "STORAGE" && !selectedAddon) ||
              (intent.kind === "PLAN" && !selectedPlan)
            }
            data-billing-checkout-continue
            onClick={() => void startCheckout()}
          >
            {continueLabel}
          </Button>
        </>
      }
    >
      <div className="bill-drawer-body">
        {nothingToBuy ? (
          /*
           * Defence in depth. Nothing on the page opens this drawer with an
           * empty catalogue any more — the FREE storage card offers a plan
           * instead of an empty purchase — but a drawer that CAN render an
           * empty "Capacity" heading above a dead payment button will
           * eventually be opened that way by something.
           */
          <p className="bill-choice__meta" data-billing-nothing-to-buy>
            There is nothing to buy here on your current plan. Close this and
            choose a plan that includes it.
          </p>
        ) : null}

        {intent.kind === "PLAN" && planOffers.length > 0 ? (
          <section>
            <h3 className="bill-section__heading" id="billing-plan-choice">
              Plan
            </h3>
            {/*
              WHICH ACCOUNT this purchase applies to, stated whenever the
              chooser is open.

              This was in the drawer's header sentence ("Pick the plan for
              X") and moved here when the header took the mandate's supporting
              line. It is not decoration: a customer with a personal account
              and an organization must never be able to buy for the wrong one,
              and the drawer has no target picker precisely BECAUSE the page
              has already chosen the subject. Saying which is what makes that
              checkable by the person paying.
            */}
            <p className="bill-choice__meta" data-billing-plan-subject>
              For <bdi>{projection.account.displayName}</bdi>.
            </p>
            <div
              role="radiogroup"
              aria-labelledby="billing-plan-choice"
              className="bill-choice"
              data-billing-plan-choice
            >
              {planOffers.map((p: PlanOffer) => {
                const checked = selectedPlan === p.planKey;
                const price = formatMoney(p.priceCents, p.currency ?? currency);
                return (
                  <label
                    key={p.planKey}
                    className="bill-choice__option"
                    data-selected={checked ? "true" : "false"}
                    data-billing-plan-option={p.planKey}
                    data-billing-plan-selected={checked ? "true" : "false"}
                  >
                    <input
                      className="bill-choice__input"
                      type="radio"
                      name="billing-plan"
                      value={p.planKey}
                      checked={checked}
                      onChange={() => setSelectedPlan(p.planKey)}
                      disabled={busy}
                    />
                    <span className="bill-choice__body">
                      <span className="bill-choice__title">{p.displayName}</span>
                      {/* Server-composed from the canonical catalog, so the
                          allowance beside the price is the one the gate will
                          enforce. Never assembled here. */}
                      <span className="bill-choice__meta">{p.summary}</span>
                      {price ? (
                        <span
                          className="bill-choice__price"
                          data-billing-plan-price={p.planKey}
                        >
                          <bdi>{price}</bdi>
                          {" / month"}
                        </span>
                      ) : null}
                    </span>
                  </label>
                );
              })}
            </div>
          </section>
        ) : null}

        {/*
          WHAT IS ABOUT TO BE BOUGHT, once there is something to say.

          A customer pressing a payment button had no statement of the thing
          they were committing to — the plan was a selected radio somewhere
          above, and the total appeared nowhere at all. Three lines, and only
          after a selection exists: an empty summary is a fourth heading to
          scroll past.

          Every value is the SERVER's. "Monthly" is not a guess either: it is
          the only cadence the plan checkout creates, and the request body says
          so.
        */}
        {intent.kind === "PLAN" && selectedPlanOffer ? (
          <section>
            <h3 className="bill-section__heading">Summary</h3>
            <div className="bill-summary" data-billing-plan-summary>
              <div className="bill-summary__row">
                <span>Selected plan</span>
                <span data-billing-summary-plan>{selectedPlanOffer.displayName}</span>
              </div>
              <div className="bill-summary__row">
                <span>Billing</span>
                <span data-billing-summary-cadence>Monthly</span>
              </div>
              {selectedPlanPrice ? (
                <div className="bill-summary__row bill-summary__row--total">
                  <span>Total</span>
                  <span data-billing-summary-total>
                    <bdi>{selectedPlanPrice}</bdi>
                    {" / month"}
                  </span>
                </div>
              ) : null}
              <p className="bill-summary__note">
                {/* Said once, plainly, before the provider page opens. A
                    recurring charge a customer did not know was recurring is
                    the complaint this sentence exists to prevent. */}
                This creates a monthly subscription. You can cancel it at any
                time from this page.
              </p>
            </div>
          </section>
        ) : null}

        {intent.kind === "CREDITS" && wallet ? (
          /*
           * ONE summary card, in the order a person checks a purchase: what I
           * have, what I am buying, what it costs, what I will have.
           *
           * What this replaces: two full-width boxes headed "What you have
           * now" and "What you are buying", each repeating the drawer's own
           * explanation, with the total never stated at all.
           */
          <section>
            <h3 className="bill-section__heading">Purchase</h3>
            <div className="bill-summary" data-billing-credit-purchase>
              <div className="bill-summary__row">
                <span>Available now</span>
                <span data-billing-credit-balance>
                  <bdi>{wallet.availableCredits}</bdi>{" "}
                  {wallet.availableCredits === 1 ? "credit" : "credits"}
                </span>
              </div>
              <div className="bill-summary__row">
                <span>Buying</span>
                <span data-billing-credit-quantity>
                  <bdi>{wallet.creditsPerPurchase}</bdi>{" "}
                  {wallet.creditsPerPurchase === 1 ? "credit" : "credits"}
                </span>
              </div>
              {wallet.unitPriceCents ? (
                <div className="bill-summary__row">
                  <span>Price per credit</span>
                  <span>
                    <bdi>
                      {formatMoney(wallet.unitPriceCents, wallet.currency ?? currency)}
                    </bdi>
                  </span>
                </div>
              ) : null}
              {wallet.unitPriceCents ? (
                <div className="bill-summary__row bill-summary__row--total">
                  <span>Total</span>
                  <span data-billing-credit-total>
                    <bdi>
                      {formatMoney(
                        wallet.unitPriceCents * wallet.creditsPerPurchase,
                        wallet.currency ?? currency,
                      )}
                    </bdi>
                  </span>
                </div>
              ) : null}
              <div className="bill-summary__row">
                <span>Balance after payment</span>
                <span data-billing-credit-after>
                  <bdi>{wallet.availableCredits + wallet.creditsPerPurchase}</bdi>{" "}
                  {wallet.availableCredits + wallet.creditsPerPurchase === 1
                    ? "credit"
                    : "credits"}
                </span>
              </div>
              <p className="bill-summary__note">
                {/* The quantity is the canonical product's, not a stepper: the
                    credit API grants exactly `creditsPerPurchase` per purchase,
                    and a client-side quantity would be a number the server
                    would then ignore. */}
                One-time payment · Credits do not expire
              </p>
            </div>
          </section>
        ) : null}

        {intent.kind === "STORAGE" && offers.length > 0 ? (
          <section>
            <h3 className="bill-section__heading" id="billing-addon-choice">
              Capacity
            </h3>
            <div
              role="radiogroup"
              aria-labelledby="billing-addon-choice"
              className="bill-choice"
            >
              {offers.map((offer: StorageAddonOffer) => {
                const price = formatMoney(offer.priceCents, offer.currency);
                const checked = selectedAddon === offer.key;
                return (
                  <label
                    key={offer.key}
                    className="bill-choice__option"
                    data-selected={checked ? "true" : "false"}
                    data-billing-addon-option={offer.key}
                  >
                    <input
                      className="bill-choice__input"
                      type="radio"
                      name="storage-addon"
                      value={offer.key}
                      checked={checked}
                      onChange={() => setSelectedAddon(offer.key)}
                      disabled={busy}
                    />
                    <span className="bill-choice__body">
                      <span className="bill-choice__title">{offer.storageLabel}</span>
                      <span className="bill-choice__meta">
                        {price ? (
                          <>
                            <bdi>{price}</bdi> per month
                          </>
                        ) : null}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </section>
        ) : null}

        {!nothingToBuy ? (
          <section>
            <h3 className="bill-section__heading" id="billing-provider-choice">
              Payment method
            </h3>
            <div
              role="radiogroup"
              aria-labelledby="billing-provider-choice"
              className="bill-choice"
            >
              {(["STRIPE", "PAYPAL"] as const).map((p) => (
                <label
                  key={p}
                  className="bill-choice__option"
                  data-selected={provider === p ? "true" : "false"}
                  data-billing-provider-option={p}
                >
                  <input
                    className="bill-choice__input"
                    type="radio"
                    name="provider"
                    value={p}
                    checked={provider === p}
                    onChange={() => setProvider(p)}
                    disabled={busy}
                  />
                  <span className="bill-choice__body">
                    <span className="bill-choice__title">
                      {p === "STRIPE" ? "Card" : "PayPal"}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            <p className="bill-summary__note">
              {/* Legally cautious, and true: no tax engine, no billing address
                  and no VAT-id authority exists, so the product does not claim
                  to calculate or collect VAT. */}
              Displayed prices exclude any taxes that may be handled by the
              payment provider where applicable.
            </p>
          </section>
        ) : null}
      </div>
    </BillingDrawer>
  );
}
