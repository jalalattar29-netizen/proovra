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

import {
  describeBillingError,
  offerAvailabilityNote,
  safeCheckoutResumeUrl,
  safePayPalResumeUrl,
  storageAdditionalPrompt,
  storageStackWarning,
} from "./billingMessages";
import { useEffect, useRef, useState } from "react";

import { Button } from "../../../../components/ui/Button";
import { apiFetch } from "../../../../lib/api";
import { captureException } from "../../../../lib/sentry";
import type {
  BillingAccountProjection,
  PlanOffer,
  StorageAddonOffer,
} from "../../../../lib/api/billing-accounts";
import { formatMoney, holdingQualifiers, summarizeStorageAddons } from "./format";
import { BillingDrawer } from "./BillingDrawer";
import {
  PaymentMethodChoice,
  type PaymentProvider,
} from "./PaymentMethodChoice";
import { StorageRecoveryPanel, type StorageRecovery } from "./StorageRecoveryPanel";

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

/*
 * The provider type is the SHARED one now.
 *
 * It was declared here, and the payment rows were written here, so the credit
 * and storage flows inherited whatever this drawer happened to do. There is
 * one selector and one vocabulary; this file chooses neither.
 */
type Provider = PaymentProvider;

/** Providers that cannot sell this size, by the server's offer. */
function unavailableFor(offer: StorageAddonOffer | null | undefined): Provider[] {
  const availability = offer?.checkoutAvailability;
  if (!availability) return [];
  return [
    ...(availability.stripe ? [] : (["STRIPE"] as const)),
    ...(availability.paypal ? [] : (["PAYPAL"] as const)),
  ];
}

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
  onError: (title: string, message: string, supportReference?: string) => void;
}) {
  // What the customer picked. What is SENT is `provider` below, which steps
  // aside when the selected storage size cannot be sold that way.
  const [chosenProvider, setChosenProvider] = useState<Provider>("STRIPE");
  const [busy, setBusy] = useState(false);
  const [pendingPayPal, setPendingPayPal] = useState<{
    plan: PlanKey;
    warning: string | null;
    confirmationRequired: boolean;
  } | null>(null);

  const openedWithPlan = intent.kind === "PLAN" ? (intent.planKey ?? null) : null;
  const openedWithAddon = intent.kind === "STORAGE" ? (intent.addonKey ?? null) : null;

  const [selectedPlan, setSelectedPlan] = useState<PlanKey | null>(openedWithPlan);
  const [selectedAddon, setSelectedAddon] = useState<string | null>(openedWithAddon);

  // BILLING REMEDIATION (2026-10-30, AUD-18) — a refused storage purchase keeps
  // its answer here, so the refusal is resolved in the drawer rather than
  // flashed in a toast behind it. Stacking stays allowed: `heldPrompt` is the
  // deliberate second press the server asks for.
  const [storageRecovery, setStorageRecovery] = useState<StorageRecovery | null>(null);
  const [storageBlocked, setStorageBlocked] = useState(false);
  const [heldPrompt, setHeldPrompt] = useState<{ addonKey: string; activeCount: number } | null>(null);
  const heldPanel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (heldPrompt) heldPanel.current?.focus();
  }, [heldPrompt]);

  function clearStorageRefusal() {
    setStorageRecovery(null);
    setStorageBlocked(false);
    setHeldPrompt(null);
  }

  // Re-seed whenever the drawer is opened again from a different affordance.
  // Without this, opening on Pro, closing, then opening on Team would keep the
  // stale Pro selection and check out the wrong thing a second time.
  useEffect(() => {
    if (!open) return;
    setSelectedPlan(openedWithPlan);
    setSelectedAddon(openedWithAddon);
    setPendingPayPal(null);
    clearStorageRefusal();
  }, [open, openedWithPlan, openedWithAddon]);

  const currency = projection.plan.currency ?? "USD";
  const offers = projection.storageAddons?.offers ?? [];
  const planOffers = projection.planOffers ?? [];
  const wallet = projection.wallet;

  const selectedOffer = offers.find((offer) => offer.key === selectedAddon) ?? null;
  const unavailableProviders = intent.kind === "STORAGE" ? unavailableFor(selectedOffer) : [];
  const fallbackProvider: Provider = chosenProvider === "STRIPE" ? "PAYPAL" : "STRIPE";
  const provider: Provider =
    unavailableProviders.includes(chosenProvider) && !unavailableProviders.includes(fallbackProvider)
      ? fallbackProvider
      : chosenProvider;
  const noProviderSells = unavailableProviders.length === 2;
  const holdings = summarizeStorageAddons(projection.storageAddons?.active ?? []);
  const selectedHolding = holdings.skus.find((sku) => sku.addonKey === selectedAddon) ?? null;
  const stackWarning =
    selectedHolding && selectedOffer ? storageStackWarning(selectedHolding, selectedOffer) : null;

  function validatedPayPalApprovalHref(href: string): string {
    const url = new URL(href);
    if (
      url.protocol !== "https:" ||
      ![
        "paypal.com",
        "www.paypal.com",
        "sandbox.paypal.com",
        "www.sandbox.paypal.com",
      ].includes(url.hostname)
    ) {
      throw new Error("Unexpected PayPal approval URL");
    }
    // Return PayPal's exact string. Parsing is validation only: serializing the
    // URL again could normalize its opaque approval query.
    return href;
  }

  async function send(request: () => Promise<unknown>) {
    setBusy(true);
    try {
      const data = await request();

      // Stripe returns a hosted session; PayPal returns approval links. Both
      // are provider-hosted — nothing here ever touches card details.
      const transition = data as { outcome?: string; approvalUrl?: string | null };
      if (transition?.outcome === "NO_CHANGE" ||
          transition?.outcome === "PROVIDER_TRANSITION_IN_PROGRESS" ||
          (transition?.outcome && !transition.approvalUrl)) {
        // Reconciliation and webhooks, not browser redirects, confirm entitlement.
        return;
      }
      if (transition?.approvalUrl) {
        window.location.href = validatedPayPalApprovalHref(transition.approvalUrl);
        return;
      }
      const stripeUrl = (data as { session?: { url?: string } })?.session?.url;
      if (stripeUrl) {
        // Only Stripe's own hosted checkout page, never an arbitrary URL.
        const safe = safeCheckoutResumeUrl(stripeUrl);
        if (!safe || safePayPalResumeUrl(stripeUrl)) throw new Error("Unexpected Stripe checkout URL");
        window.location.href = safe;
        return;
      }
      const links =
        (data as { subscription?: { links?: Array<{ rel: string; href: string }> } })
          ?.subscription?.links ??
        (data as { order?: { links?: Array<{ rel: string; href: string }> } })?.order
          ?.links;
      // "approve" for orders and subscriptions created with
      // application_context; "payer-action" when PayPal answers an order with
      // PAYER_ACTION_REQUIRED. Both are the PayPal-hosted approval page.
      const approve =
        links?.find((l) => l.rel === "approve") ??
        links?.find((l) => l.rel === "payer-action");
      if (approve?.href) {
        window.location.href = validatedPayPalApprovalHref(approve.href);
        return;
      }
      throw new Error("Checkout did not return an approval destination");
    } catch (err) {
      captureException(err, { feature: "billing_checkout_drawer", intent: intent.kind });
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code?: unknown }).code ?? "")
          : "";
      const details =
        err && typeof err === "object" && "details" in err
          ? ((err as { details?: Record<string, unknown> }).details ?? {})
          : {};
      const blockedPlan =
        typeof details.plan === "string"
          ? details.plan
          : typeof details.pendingPlan === "string"
            ? details.pendingPlan
            : selectedPlan;
      const blockedOffer = planOffers.find((offer) => offer.planKey === blockedPlan);

      // A storage refusal with a way forward: the panel in the Capacity section
      // says so, and a toast beside it would only say it twice.
      if (intent.kind === "STORAGE" && details.retry === "CONFIRM_ADDITIONAL" && selectedAddon) {
        setHeldPrompt({
          addonKey: selectedAddon,
          activeCount: typeof details.activeCount === "number" ? details.activeCount : 1,
        });
        return;
      }
      if (
        intent.kind === "STORAGE" &&
        details.retry === "RECONCILE_STORAGE_ATTEMPT" &&
        typeof details.attemptId === "string"
      ) {
        setStorageRecovery({
          attemptId: details.attemptId,
          pendingProvider: typeof details.pendingProvider === "string" ? details.pendingProvider : "PAYPAL",
          createdAtUtc: typeof details.createdAtUtc === "string" ? details.createdAtUtc : null,
        });
        setStorageBlocked(true);
        return;
      }

      if (
        provider === "PAYPAL" &&
        intent.kind === "PLAN" &&
        (code === "PAYPAL_APPROVAL_PENDING" ||
          code === "PAYPAL_DIFFERENT_PLAN_PENDING") &&
        blockedOffer
      ) {
        setPendingPayPal({
          plan: blockedOffer.planKey,
          warning: null,
          confirmationRequired: false,
        });
      }
      // Never a raw provider or internal message.
      const safe = describeBillingError(err, {
        message: "We could not start checkout. Please try again in a moment.",
      });
      onError(safe.title, safe.message, safe.supportReference);
    } finally {
      setBusy(false);
      onCompleted();
    }
  }

  async function resolvePendingPayPal(confirmed = false) {
    const plan = pendingPayPal?.plan ?? selectedPlan;
    if (!plan) return;
    setBusy(true);
    try {
      const result = (await apiFetch("/v1/billing/checkout/paypal/pending/resolve", {
        method: "POST",
        body: JSON.stringify({ plan, confirmed }),
      })) as {
        outcome?: string;
        warning?: string;
        confirmation?: { canConfirmAbandon?: boolean };
      };

      if (result.outcome === "ABANDON_CONFIRMATION_REQUIRED") {
        setPendingPayPal({
          plan,
          warning:
            result.warning ??
            "PayPal could not confirm this approval attempt. You can abandon PROOVRA's local blocker, but that does not cancel anything at PayPal.",
          confirmationRequired: Boolean(result.confirmation?.canConfirmAbandon),
        });
        return;
      }

      if (result.outcome === "STILL_PENDING") {
        // BILLING PAYPAL INTEGRITY (2026-09-28) — the server's own reason
        // (e.g. "approved and being processed, so it cannot be abandoned").
        // The old sentence told the customer to "wait for it to expire" — an
        // expiry nothing observed. An unapproved one is now closed
        // automatically after 24 hours, and a processing one completes.
        setPendingPayPal({
          plan,
          warning:
            result.warning ??
            "PayPal shows that checkout as approved and being processed. PROOVRA applies it as soon as PayPal completes it — there is nothing to pay again.",
          confirmationRequired: false,
        });
        return;
      }

      setPendingPayPal(null);
      onCompleted();
      if (selectedPlan) {
        await send(() =>
          apiFetch("/v1/billing/checkout/paypal", {
            method: "POST",
            body: JSON.stringify({ plan: selectedPlan, currency }),
          }),
        );
      }
    } catch (err) {
      captureException(err, {
        feature: "billing_paypal_pending_checkout_resolve",
        intent: intent.kind,
      });
      const safe = describeBillingError(err, {
        message:
          "We could not resolve the pending PayPal approval. Nothing has changed.",
      });
      onError(safe.title, safe.message, safe.supportReference);
    } finally {
      setBusy(false);
    }
  }

  function buyStorage(confirmAdditional: boolean) {
    if (!selectedAddon) {
      onError("Choose a size", "Select the capacity you want before continuing.");
      return;
    }
    if (!selectedOffer) {
      onError("Offer changed", "Refresh Billing and choose the storage offer again.");
      return;
    }
    const addonBody = JSON.stringify({
      addonKey: selectedAddon,
      billingCycle: "MONTHLY",
      currency: selectedOffer.currency,
      // Only ever the customer's second press, after seeing what they already
      // pay for. It is never set on a first attempt. The count is the one they
      // were shown, so a purchase made elsewhere since then asks them again.
      ...(confirmAdditional
        ? { confirmAdditional: true, heldCount: heldPrompt?.activeCount ?? selectedHolding?.activeCount ?? 0 }
        : {}),
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

    if (intent.kind === "STORAGE") return buyStorage(false);

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
          // A stale projection can open BUY for someone who already subscribes.
          // The server then refuses with SUBSCRIPTION_ALREADY_ACTIVE ("Change
          // your plan instead of buying a second one" — a customer-disposition
          // code, so `send` shows exactly that sentence), and `send`'s finally
          // refreshes the account, which reopens Billing in MANAGE mode.
          //
          // This drawer deliberately does NOT retry as a plan change: a change
          // to an existing subscription belongs to ManagePlanDrawer, which
          // states its period-end / proration consequences before anything is
          // committed. Silently converting a purchase into a change skipped
          // that, and is what `the FREE chooser is a purchase` forbids.
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
   * The primary action names the PLAN it is about to buy.
   *
   * BILLING UI REFINEMENT (2026-09-01) — it briefly named the payment method
   * instead, because a summary panel underneath the choice was already
   * repeating the plan. That panel is gone (it duplicated the selected card
   * and made the drawer taller than the decision inside it), so the button is
   * once more the last place a wrong selection can be caught — and the plan is
   * the thing that would be wrong. The method is stated by the marks in the
   * selector directly above it.
   */
  const continueLabel =
    intent.kind === "PLAN" && selectedPlanOffer
      ? `Continue with ${selectedPlanOffer.displayName}`
      : "Continue to payment";

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
              (intent.kind === "STORAGE" &&
                (!selectedAddon || noProviderSells || storageBlocked || heldPrompt !== null)) ||
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
           * empty catalogue for normal FREE storage any more — the FREE
           * storage card opens the personal capacity catalogue — but a drawer
           * that CAN render an
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
            <p className="bill-summary__note" data-billing-plan-terms>
              {/* Said ONCE for the section, before the provider page opens. A
                  recurring charge a customer did not know was recurring is the
                  complaint this sentence exists to prevent — and repeating it
                  under each tier was what made the drawer long. */}
              Plans are billed monthly. You can cancel at any time from this
              page.
            </p>
            {pendingPayPal ? (
              <div className="bill-pending-paypal" data-billing-paypal-pending-resolution>
                <p className="bill-summary__note" role="status" aria-live="polite">
                  {pendingPayPal.warning ??
                    "PayPal approval is already pending for this plan. We can re-check it before starting another checkout."}
                </p>
                <div className="bill-panel__actions">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    loading={busy && !pendingPayPal.confirmationRequired}
                    onClick={() => void resolvePendingPayPal(false)}
                    data-billing-paypal-pending-recheck
                  >
                    Re-check pending approval
                  </Button>
                  {pendingPayPal.confirmationRequired ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      loading={busy}
                      onClick={() => void resolvePendingPayPal(true)}
                      data-billing-paypal-pending-abandon
                    >
                      Abandon local attempt
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </section>
        ) : null}

        {/*
          BILLING UI REFINEMENT (2026-09-01) — the SUMMARY panel that stood
          here is DELETED.

          It restated the selected plan, the cadence, the total and a
          cancellation sentence directly beneath the card that already showed
          the plan, its allowances and its price — so choosing a tier made the
          drawer grow by a block that told the customer nothing new, and on a
          phone it pushed the payment selector and the button below the fold.

          Nothing was lost with it. The selected card carries the plan, the
          allowance line and the price; the price appears exactly once; the
          cadence is in that price ("/ month"); and the recurring-charge
          sentence moved to the plan section's own note, where it is said once
          for the section rather than once per selection.
        */}
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
            {/*
              WHAT THE ACCOUNT ALREADY PAYS FOR, before another monthly charge.

              Stacking is allowed and the capacity really does add up, so this
              never refuses. It exists so that the second purchase of a size is
              a decision, not a surprise on the next statement.
            */}
            {holdings.skus.length > 0 ? (
              <>
                <h3 className="bill-section__heading">What you have now</h3>
                <div className="bill-summary" data-billing-storage-holdings>
                  {projection.usage.storage.state === "MEASURED" ? (
                    <div className="bill-summary__row">
                      <span>Total capacity</span>
                      <span data-billing-storage-capacity>
                        <bdi>{projection.usage.storage.limitLabel}</bdi>
                      </span>
                    </div>
                  ) : null}
                  {holdings.skus.map((sku) => {
                    const monthly = formatMoney(sku.monthlyCents, sku.currency);
                    return (
                      <div
                        key={sku.addonKey}
                        className="bill-summary__row"
                        data-billing-storage-holding={sku.addonKey}
                      >
                        <span>
                          <bdi>{sku.storageLabel}</bdi>
                          {sku.activeCount > 1 ? ` × ${sku.activeCount}` : null}
                          {sku.activeCount === 0 ? " · not completed" : null}
                        </span>
                        <span>
                          {sku.pendingCount > 0 && sku.activeCount > 0
                            ? `${sku.pendingCount} not completed · `
                            : null}
                          {holdingQualifiers(sku).map((part) => `${part} · `).join("")}
                          {sku.activeCount > 0 && monthly ? (
                            <>
                              <bdi>{monthly}</bdi> / month
                            </>
                          ) : null}
                        </span>
                      </div>
                    );
                  })}
                  {projection.storageAddons?.legacyWorkspaceCapacityLabel ? (
                    <div className="bill-summary__row" data-billing-storage-legacy-capacity>
                      <span>In older workspaces, not in this total</span>
                      <span>
                        <bdi>{projection.storageAddons.legacyWorkspaceCapacityLabel}</bdi>
                      </span>
                    </div>
                  ) : null}
                  {holdings.monthlyTotals && holdings.monthlyTotals.length > 0 ? (
                    <div
                      className="bill-summary__row bill-summary__row--total"
                      data-billing-storage-commitment
                    >
                      <span>Add-ons billed monthly</span>
                      <span>
                        <bdi>{holdings.monthlyTotals.join(" + ")}</bdi> / month
                      </span>
                    </div>
                  ) : null}
                </div>
              </>
            ) : null}
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
                const off = unavailableFor(offer);
                const held = holdings.skus.find((sku) => sku.addonKey === offer.key);
                return (
                  <label
                    key={offer.key}
                    className="bill-choice__option"
                    data-selected={checked ? "true" : "false"}
                    data-billing-addon-option={offer.key}
                    data-billing-addon-unavailable={off.length === 2 ? "true" : undefined}
                  >
                    <input
                      className="bill-choice__input"
                      type="radio"
                      name="storage-addon"
                      value={offer.key}
                      checked={checked}
                      onChange={() => {
                        setSelectedAddon(offer.key);
                        clearStorageRefusal();
                      }}
                      disabled={busy || off.length === 2}
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
                      {held && held.activeCount > 0 ? (
                        <span className="bill-choice__meta">
                          {held.activeCount === 1
                            ? "You already have 1 of these"
                            : `You already have ${held.activeCount} of these`}
                        </span>
                      ) : null}
                      {off.length > 0 ? (
                        <span className="bill-choice__meta" data-billing-addon-availability={offer.key}>
                          {off.length === 2
                            ? "Not available to buy right now"
                            : off.includes("STRIPE")
                              ? "PayPal only right now"
                              : "Card only right now"}
                        </span>
                      ) : null}
                    </span>
                  </label>
                );
              })}
            </div>

            {/* Said as soon as the size is selected, before anything is pressed. */}
            <div role="status" aria-live="polite">
              {stackWarning ? (
                <p className="bill-summary__note" data-billing-storage-stack-warning>
                  {stackWarning}
                </p>
              ) : null}
            </div>

            {heldPrompt ? (
              <div
                ref={heldPanel}
                tabIndex={-1}
                className="bill-summary"
                data-billing-storage-additional
              >
                <p className="bill-choice__meta" role="status" aria-live="polite">
                  {storageAdditionalPrompt(heldPrompt.activeCount, selectedOffer)}
                </p>
                {selectedOffer ? (
                  <dl className="bill-summary__note" data-billing-storage-additional-effect>
                    {projection.usage.storage.state === "MEASURED" ? (
                      <div className="bill-summary__row">
                        <dt>Capacity now</dt>
                        <dd>
                          <bdi>{projection.usage.storage.limitLabel}</bdi>
                        </dd>
                      </div>
                    ) : null}
                    {holdings.monthlyTotals && holdings.monthlyTotals.length > 0 ? (
                      <div className="bill-summary__row">
                        <dt>Add-ons billed now</dt>
                        <dd>
                          <bdi>{holdings.monthlyTotals.join(" + ")}</bdi> / month
                        </dd>
                      </div>
                    ) : null}
                    <div className="bill-summary__row">
                      <dt>This adds</dt>
                      <dd>
                        <bdi>{selectedOffer.storageLabel}</bdi>
                        {formatMoney(selectedOffer.priceCents, selectedOffer.currency) ? (
                          <>
                            {" · "}
                            <bdi>{formatMoney(selectedOffer.priceCents, selectedOffer.currency)}</bdi> / month
                          </>
                        ) : null}
                      </dd>
                    </div>
                  </dl>
                ) : null}
                <div className="bill-panel__actions">
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={busy}
                    disabled={busy}
                    onClick={() => void buyStorage(true)}
                    data-billing-storage-confirm-additional
                  >
                    {selectedOffer ? `Add another ${selectedOffer.storageLabel}` : "Add another"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => setHeldPrompt(null)}
                    data-billing-storage-decline-additional
                  >
                    Not now
                  </Button>
                </div>
              </div>
            ) : null}

            {storageRecovery ? (
              <StorageRecoveryPanel
                key={storageRecovery.attemptId}
                recovery={storageRecovery}
                account={projection.account}
                onChanged={onCompleted}
                onUnblocked={() => setStorageBlocked(false)}
              />
            ) : null}
          </section>
        ) : null}

        {!nothingToBuy ? (
          /*
            ONE payment selector, for the plan, the credits and the storage
            add-on alike. The rows were written inline here, so every other
            Billing purchase inherited whatever this drawer happened to do —
            and improving them anywhere meant improving them three times.
          */
          <PaymentMethodChoice
            value={provider}
            onChange={(next) => {
              setChosenProvider(next);
              // Each provider has its own gate, and the other one may reuse an
              // open checkout. A refusal from one says nothing about the other.
              clearStorageRefusal();
            }}
            disabled={busy}
            name={`billing-payment-method-${intent.kind.toLowerCase()}`}
            headingId={`billing-provider-choice-${intent.kind.toLowerCase()}`}
            unavailable={unavailableProviders}
            note={
              intent.kind === "STORAGE" && selectedOffer ? offerAvailabilityNote(selectedOffer) : null
            }
          />
        ) : null}
      </div>
    </BillingDrawer>
  );
}
