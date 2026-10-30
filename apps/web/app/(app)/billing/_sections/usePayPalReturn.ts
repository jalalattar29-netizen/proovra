"use client";

/**
 * Runs the server-side confirmation for a PayPal return exactly once per page
 * load, reports the outcome, refreshes the account and removes PayPal's query
 * parameters from the URL (so a reload does not re-run it — although the
 * server call is idempotent if it does).
 *
 * See `lib/billing/paypal-return.ts` for why the browser grants nothing here.
 *
 * It also reads Stripe's return. Stripe's own webhook settles that purchase, so
 * there is nothing to ask: `returnNotice` says the customer is back and what
 * happens next, and stays on the page until they dismiss it.
 */

import { useEffect, useRef, useState } from "react";

import { apiFetch } from "../../../../lib/api";
import { reportPayPalReturnCanceled } from "../../../../lib/api/billing-accounts";
import { captureException } from "../../../../lib/sentry";
import {
  parsePayPalReturn,
  parseStripeReturn,
  payPalCanceledMessage,
  payPalReturnMessage,
  payPalOrderCapturePath,
  payPalSubscriptionConfirmPath,
  payPalUnidentifiedReturn,
  stripPayPalReturnParams,
  stripeReturnNotice,
  type CheckoutReturnNotice,
  type PayPalReturnMessage,
} from "../../../../lib/billing/paypal-return";

type ParamReader = { get(name: string): string | null; toString(): string };

/** How many times a still-settling PayPal payment is re-asked, and how far apart. */
export const PAYPAL_RETURN_MAX_ATTEMPTS = 4;
export const PAYPAL_RETURN_RETRY_MS = 3000;

export function usePayPalReturn(input: {
  searchParams: ParamReader;
  notify: (message: string, tone: PayPalReturnMessage["tone"], supportReference?: string) => void;
  onSettled: () => void;
  replaceUrl: (search: string) => void;
  retryDelayMs?: number;
}): { confirming: boolean; returnNotice: CheckoutReturnNotice | null; dismissReturnNotice: () => void } {
  const handled = useRef(false);
  const latest = useRef(input);
  latest.current = input;
  const [confirming, setConfirming] = useState(false);
  const [returnNotice, setReturnNotice] = useState<CheckoutReturnNotice | null>(null);

  useEffect(() => {
    if (handled.current) return;
    const search = input.searchParams.toString();

    const stripe = parseStripeReturn(input.searchParams);
    if (stripe) {
      handled.current = true;
      latest.current.replaceUrl(stripPayPalReturnParams(search));
      setReturnNotice(stripeReturnNotice(stripe));
      latest.current.onSettled();
      return;
    }

    const unidentified = payPalUnidentifiedReturn(input.searchParams);
    if (unidentified) {
      handled.current = true;
      latest.current.replaceUrl(stripPayPalReturnParams(search));
      latest.current.notify(unidentified.message, unidentified.tone);
      return;
    }

    const ret = parsePayPalReturn(input.searchParams);
    if (!ret) return;
    handled.current = true;

    latest.current.replaceUrl(stripPayPalReturnParams(search));

    if (ret.kind === "BUYER_CANCELED") {
      const msg = payPalCanceledMessage(ret.product, { subscriptionId: ret.subscriptionId, orderId: ret.orderId });
      latest.current.notify(msg.message, msg.tone);
      // BILLING PAYPAL INTEGRITY (2026-09-28) — the buyer's cancel closes the
      // checkout on the server (provider-first), so it no longer blocks the
      // next one. Best effort: a failure leaves it to Billing activity.
      if (ret.subscriptionId || ret.orderId) {
        void reportPayPalReturnCanceled({ subscriptionId: ret.subscriptionId, orderId: ret.orderId })
          .then(() => latest.current.onSettled())
          .catch((err) => captureException(err, { feature: "billing_paypal_return_canceled" }));
      }
      return;
    }

    const delay = input.retryDelayMs ?? PAYPAL_RETURN_RETRY_MS;
    setConfirming(true);

    (async () => {
      let last: PayPalReturnMessage | null = null;
      for (let attempt = 1; attempt <= PAYPAL_RETURN_MAX_ATTEMPTS; attempt++) {
        try {
          // One explicit request per return kind, so each route is named at
          // its call site.
          const response =
            ret.kind === "ORDER_CAPTURE"
              ? await apiFetch(payPalOrderCapturePath(ret.orderId), { method: "POST", body: "{}" })
              : await apiFetch(payPalSubscriptionConfirmPath(ret.subscriptionId), { method: "POST", body: "{}" });
          last = payPalReturnMessage(ret, response);
        } catch (err) {
          captureException(err, { feature: "billing_paypal_return", kind: ret.kind });
          last = payPalReturnMessage(ret, {
            code: (err as { code?: unknown }).code ?? null,
            statusCode: (err as { statusCode?: unknown }).statusCode ?? null,
            requestId: (err as { requestId?: unknown }).requestId ?? null,
          });
          break;
        }
        if (!last.retry || attempt === PAYPAL_RETURN_MAX_ATTEMPTS) break;
        latest.current.onSettled();
        await new Promise((r) => setTimeout(r, delay));
      }
      setConfirming(false);
      if (last) {
        if (last.supportReference) latest.current.notify(last.message, last.tone, last.supportReference);
        else latest.current.notify(last.message, last.tone);
      }
      latest.current.onSettled();
    })();
    // Deliberately no cleanup cancel: under StrictMode the effect is run,
    // cleaned up and re-run, and the `handled` guard makes the re-run a no-op —
    // cancelling here would drop the only confirmation.
    // Runs once, on the params present when the page first loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { confirming, returnNotice, dismissReturnNotice: () => setReturnNotice(null) };
}
