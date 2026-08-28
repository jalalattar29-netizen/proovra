"use client";

/**
 * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — checkout, in a drawer.
 *
 * What this replaces: an always-expanded "Checkout Console" that occupied a
 * third of the Billing page whether or not anyone was buying anything. It
 * carried three separate workspace target pickers, a plan picker, a provider
 * picker, a non-editable "Preferred currency" line, and four paragraphs of
 * commercial rules ("PRO allows you to own up to 2 workspaces…") that belong on
 * Pricing.
 *
 * The target is no longer a choice made here: the page already has a selected
 * BILLING ACCOUNT, and that is what is being bought for. Choosing a target
 * inside checkout was how a customer could buy the wrong workspace a plan.
 */

import { useState } from "react";

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

export type CheckoutIntent = "PLAN" | "CREDITS" | "STORAGE";

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
  const [selectedAddon, setSelectedAddon] = useState<string | null>(null);

  const workspaceId =
    // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — a checkout has no
    // workspace target. A subscription is bought for the person, and the
    // server refuses a body that names a workspace at all.
    null;
  const currency = projection.plan.currency ?? "USD";
  const offers = projection.storageAddons?.offers ?? [];
  const planOffers = projection.planOffers ?? [];

  /**
   * Send the caller to the provider's hosted checkout.
   *
   * `send` takes an already-resolved literal path from its call site rather
   * than composing one, so the repository's route-consumer analyzer can bind
   * each request to a registered route WITH its method. A ternary that picks
   * the path at the call site leaves the analyzer able to see the path but not
   * the verb, and it then records a GET that does not exist.
   */
  async function send(
    request: () => Promise<unknown>,
  ) {
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
        ((data as { subscription?: { links?: Array<{ rel: string; href: string }> } })
          ?.subscription?.links) ??
        ((data as { order?: { links?: Array<{ rel: string; href: string }> } })?.order
          ?.links);
      const approve = links?.find((l) => l.rel === "approve");
      if (approve?.href) {
        window.location.href = approve.href;
        return;
      }
      throw new Error("Checkout did not return an approval destination");
    } catch (err) {
      captureException(err, { feature: "billing_checkout_drawer", intent });
      // Never a raw provider or internal message. The panel this replaces
      // surfaced `err.message` directly in two places.
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
    const planKey = planOffers[0]?.planKey ?? "PRO";
    const teamPart = workspaceId ? { teamId: workspaceId } : {};

    if (intent === "CREDITS") {
      // BILLING PRODUCTION CLOSURE (2026-08-27) — credits have their own route
      // and take no commercial input. This used to POST `{ plan: "PAYG" }` to
      // the plan checkout, which made a legacy recurring-plan row the identity
      // of a one-time product and put a plan name for it on the wire. Quantity
      // and price are resolved server-side; the body carries a display currency
      // and nothing else.
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

    if (intent === "STORAGE") {
      const addonBody = JSON.stringify({
        addonKey: selectedAddon,
        billingCycle: "MONTHLY",
        currency,
        ...teamPart,
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

    const planBody = JSON.stringify({ plan: planKey, currency, ...teamPart });
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
    intent === "CREDITS"
      ? "Buy evidence credits"
      : intent === "STORAGE"
        ? "Add storage"
        : "Change plan";

  const description =
    intent === "CREDITS"
      ? "Each credit records one more evidence item once your included allowance is used. Credits do not expire."
      : intent === "STORAGE"
        ? "Extra capacity, billed monthly alongside your plan. You can cancel it at any time."
        : `This applies to ${projection.account.displayName}.`;

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
            loading={busy}
            disabled={busy || (intent === "STORAGE" && !selectedAddon)}
            data-billing-checkout-continue
            onClick={() => void startCheckout()}
          >
            Continue to payment
          </Button>
        </>
      }
    >
      <div style={{ display: "grid", gap: 22 }}>
        {intent === "PLAN" ? (
          <section>
            <h3 style={sectionHeading}>Plan</h3>
            {planOffers.map((p: PlanOffer) => (
              <div key={p.planKey} style={optionBox}>
                <div style={{ fontWeight: 600, color: "var(--text-strong, #172033)" }}>
                  {p.displayName}
                  {p.priceCents !== undefined ? (
                    <>
                      {" — "}
                      <bdi>{formatMoney(p.priceCents, p.currency ?? currency)}</bdi>
                      {" / month"}
                    </>
                  ) : null}
                </div>
                {/* Server-composed from the canonical catalog. The browser has
                    no plan table of its own to fall out of date. */}
                <p style={optionBlurb}>{p.summary}</p>
              </div>
            ))}
          </section>
        ) : null}

        {intent === "CREDITS" && projection.wallet ? (
          /*
           * BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — the BALANCE and
           * the PURCHASE are two separate statements, in that order.
           *
           * They used to be one box headed "Your credits" showing "3
           * available" and a unit price, directly above a Buy button — so the
           * only quantity on screen was the one the customer already had, and
           * how many this purchase would add was not stated anywhere. Someone
           * reading "3 available" above "Buy" has every reason to think they
           * are buying three.
           */
          <>
            <section>
              <h3 style={sectionHeading}>What you have now</h3>
              <div style={optionBox}>
                <div
                  style={{ fontWeight: 600, color: "var(--text-strong, #172033)" }}
                  data-billing-credit-balance
                >
                  <bdi>{projection.wallet.availableCredits}</bdi>{" "}
                  {projection.wallet.availableCredits === 1 ? "credit" : "credits"} available
                </div>
                <p style={optionBlurb}>
                  Each credit records one more evidence item once your included
                  allowance is used. Credits do not expire.
                </p>
              </div>
            </section>

            <section>
              <h3 style={sectionHeading}>What you are buying</h3>
              <div style={optionBox} data-billing-credit-purchase>
                <div style={{ fontWeight: 600, color: "var(--text-strong, #172033)" }}>
                  <bdi>{projection.wallet.creditsPerPurchase}</bdi>{" "}
                  {projection.wallet.creditsPerPurchase === 1 ? "credit" : "credits"}
                  {projection.wallet.unitPriceCents
                    ? ` — ${formatMoney(
                        projection.wallet.unitPriceCents *
                          projection.wallet.creditsPerPurchase,
                        projection.wallet.currency ?? currency,
                      )}`
                    : ""}
                </div>
                <p style={optionBlurb}>
                  {/* The balance AFTER, said plainly, so the two numbers on
                      screen cannot be mistaken for each other. */}
                  You will have{" "}
                  <bdi>
                    {projection.wallet.availableCredits +
                      projection.wallet.creditsPerPurchase}
                  </bdi>{" "}
                  once this payment settles. This is a one-time payment, not a
                  subscription.
                </p>
              </div>
            </section>
          </>
        ) : null}

        {intent === "STORAGE" ? (
          <section>
            <h3 style={sectionHeading}>Capacity</h3>
            <div role="radiogroup" aria-label="Storage add-on" style={{ display: "grid", gap: 8 }}>
              {offers.map((offer: StorageAddonOffer) => {
                const price = formatMoney(offer.priceCents, offer.currency);
                const checked = selectedAddon === offer.key;
                return (
                  <label
                    key={offer.key}
                    style={{
                      ...optionBox,
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      cursor: "pointer",
                      borderColor: checked
                        ? "var(--status-info-solid, #2563eb)"
                        : "var(--border-default, rgba(15,23,42,0.09))",
                    }}
                    data-billing-addon-option={offer.key}
                  >
                    <input
                      type="radio"
                      name="storage-addon"
                      value={offer.key}
                      checked={checked}
                      onChange={() => setSelectedAddon(offer.key)}
                      style={{ width: 18, height: 18 }}
                    />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span
                        style={{ display: "block", fontWeight: 600, color: "var(--text-strong, #172033)" }}
                      >
                        {offer.storageLabel}
                      </span>
                      <span style={{ fontSize: "0.85rem", color: "var(--text-muted, #5F6878)" }}>
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

        <section>
          <h3 style={sectionHeading}>Payment method</h3>
          <div role="radiogroup" aria-label="Payment method" style={{ display: "grid", gap: 8 }}>
            {(["STRIPE", "PAYPAL"] as const).map((p) => (
              <label
                key={p}
                style={{
                  ...optionBox,
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  cursor: "pointer",
                  borderColor:
                    provider === p
                      ? "var(--status-info-solid, #2563eb)"
                      : "var(--border-default, rgba(15,23,42,0.09))",
                }}
                data-billing-provider-option={p}
              >
                <input
                  type="radio"
                  name="provider"
                  value={p}
                  checked={provider === p}
                  onChange={() => setProvider(p)}
                  style={{ width: 18, height: 18 }}
                />
                <span style={{ fontWeight: 600, color: "var(--text-strong, #172033)" }}>
                  {p === "STRIPE" ? "Card" : "PayPal"}
                </span>
              </label>
            ))}
          </div>
          <p style={{ ...optionBlurb, marginTop: 10 }}>
            {/* Legally cautious, and true: no tax engine, no billing address and
                no VAT-id authority exists, so the product does not claim to
                calculate or collect VAT. */}
            Displayed prices exclude any taxes that may be handled by the payment
            provider where applicable.
          </p>
        </section>
      </div>
    </BillingDrawer>
  );
}

const sectionHeading: React.CSSProperties = {
  margin: "0 0 10px",
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: "var(--text-muted, #5F6878)",
};

const optionBox: React.CSSProperties = {
  padding: "12px 14px",
  borderRadius: 10,
  border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
  background: "var(--surface-card, #ffffff)",
};

const optionBlurb: React.CSSProperties = {
  margin: "6px 0 0",
  fontSize: "0.86rem",
  lineHeight: 1.6,
  color: "var(--text-muted, #475569)",
};
