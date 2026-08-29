"use client";

/**
 * PAYMENT METHOD — the one selector every Billing purchase uses.
 *
 * WHAT IT REPLACES
 * ---------------------------------------------------------------------------
 * Two radio rows reading "Card" and "PayPal" in the same plain type as
 * everything around them. Nothing about them said "payment": a customer about
 * to hand over money had to read a word to find out where they were being sent,
 * and the two rows ran together into what scanned as one "CardPayPal" control.
 *
 * WHAT THE MARKS ARE, AND WHERE THEY COME FROM
 * ---------------------------------------------------------------------------
 * `react-icons/fa` — the Font Awesome brand set, already a declared dependency
 * of this app and resolved from `node_modules` at build time. They are LOCAL:
 * nothing is fetched at runtime, no remote image is hotlinked, and no mark is
 * drawn out of text, emoji or CSS shapes. They render as inline `<svg>`, so
 * they scale with the row and carry no network cost of their own.
 *
 * WHAT THE MARKS ARE NOT
 * ---------------------------------------------------------------------------
 * They are not the accessible name. Every mark is `aria-hidden`, and each
 * option carries a real, visually-hidden label instead — so a screen reader
 * hears "Credit or debit card" rather than "Visa Mastercard", and nobody is
 * told that only those two networks are accepted. The card option is whatever
 * the card provider accepts; the marks are a signpost, not a claim about
 * coverage.
 *
 * WHAT IT DOES NOT DECIDE
 * ---------------------------------------------------------------------------
 * Routing. `value` is the canonical provider the request body already carried —
 * "STRIPE" or "PAYPAL" — and this component changes how that choice LOOKS and
 * nothing about what it means. Every consumer submits exactly what it did
 * before.
 */

import { FaCcMastercard, FaCcPaypal, FaCcVisa } from "react-icons/fa";

/** The canonical provider values the checkout routes already accept. */
export type PaymentProvider = "STRIPE" | "PAYPAL";

type Option = {
  provider: PaymentProvider;
  /**
   * The ACCESSIBLE name, and the only text in the option.
   *
   * "Credit or debit card" rather than "Visa or Mastercard": the marks beside
   * it are the two most recognisable, not the complete list of what the
   * provider takes, and naming two networks would be a claim about coverage
   * that this surface has no authority to make.
   */
  label: string;
  marks: React.ReactNode;
};

const OPTIONS: Option[] = [
  {
    provider: "STRIPE",
    label: "Credit or debit card",
    marks: (
      <>
        <FaCcVisa className="bill-pay__mark" data-mark="visa" aria-hidden focusable="false" />
        <FaCcMastercard
          className="bill-pay__mark"
          data-mark="mastercard"
          aria-hidden
          focusable="false"
        />
      </>
    ),
  },
  {
    provider: "PAYPAL",
    label: "PayPal",
    marks: (
      <FaCcPaypal className="bill-pay__mark" data-mark="paypal" aria-hidden focusable="false" />
    ),
  },
];

export function PaymentMethodChoice({
  value,
  onChange,
  disabled = false,
  /**
   * The radio GROUP name.
   *
   * Defaulted rather than required, and overridable, because two drawers can
   * be mounted at once in a test render — and two groups sharing a name would
   * make selecting a method in one silently deselect it in the other.
   */
  name = "billing-payment-method",
  headingId = "billing-provider-choice",
}: {
  value: PaymentProvider;
  onChange: (next: PaymentProvider) => void;
  disabled?: boolean;
  name?: string;
  headingId?: string;
}) {
  return (
    <section>
      <h3 className="bill-section__heading" id={headingId}>
        Payment method
      </h3>
      <div
        role="radiogroup"
        aria-labelledby={headingId}
        className="bill-choice bill-choice--payment"
        data-billing-payment-choice
      >
        {OPTIONS.map((option) => {
          const checked = value === option.provider;
          return (
            <label
              key={option.provider}
              className="bill-choice__option bill-pay"
              data-selected={checked ? "true" : "false"}
              data-billing-provider-option={option.provider}
            >
              {/*
                A NATIVE radio inside the label, so the whole row is the hit
                area, arrow keys move within the group, the browser supplies
                the focus ring, and `aria-checked` is the element's own state
                rather than an attribute somebody has to remember to update.
              */}
              <input
                className="bill-choice__input"
                type="radio"
                name={name}
                value={option.provider}
                checked={checked}
                onChange={() => onChange(option.provider)}
                disabled={disabled}
              />
              <span className="bill-choice__body bill-pay__body">
                {/* The accessible name. Visually hidden because the marks are
                    what a paying customer reads — but never absent, because
                    a mark is not a name. */}
                <span className="app-visually-hidden">{option.label}</span>
                <span className="bill-pay__marks">{option.marks}</span>
              </span>
            </label>
          );
        })}
      </div>
      <p className="bill-summary__note">
        {/* Legally cautious, and true: no tax engine, no billing address and
            no VAT-id authority exists, so the product does not claim to
            calculate or collect VAT. */}
        Displayed prices exclude any taxes that may be handled by the payment
        provider where applicable.
      </p>
    </section>
  );
}
