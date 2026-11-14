"use client";

/**
 * Runs the server-side confirmation for a PayPal return exactly once per page
 * load, reports the outcome, refreshes the account and removes PayPal's query
 * parameters from the URL (so a reload does not re-run it — although the
 * server call is idempotent if it does).
 *
 * See `lib/billing/paypal-return.ts` for why the browser grants nothing here.
 *
 * It also reads Stripe's return.
 *
 * FREE-AUDIT REMEDIATION (2026-11-13, F-13 / F-14) — a Stripe return names its
 * checkout attempt. On success the page asks the server to RE-CHECK that attempt
 * (the server reads the session from Stripe and applies it with the webhook's own
 * writer), a few times, and reports the attempt's persisted state: confirmed,
 * still processing, failed or closed. On cancel it asks the server to abandon the
 * attempt provider-first (Stripe expires the session; a paid or processing one is
 * never touched), so an abandoned card checkout no longer blocks the next one.
 * An older return without an attempt id keeps the notice-only behaviour.
 * `returnNotice` stays on the page until dismissed.
 */

import { useEffect, useRef, useState } from "react";

import { apiFetch } from "../../../../lib/api";
import {
  abandonCheckoutAttempt,
  recheckCheckoutAttempt,
  reportPayPalReturnCanceled,
  type BillingAccountRef,
} from "../../../../lib/api/billing-accounts";
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
  stripeAttemptNotice,
  stripeCancelNotice,
  stripeReturnFailureNotice,
  stripeReturnNotice,
  stripeReturnSettled,
  STRIPE_RETURN_MAX_CHECKS,
  type CheckoutReturnNotice,
  type PayPalReturnMessage,
  type StripeAttemptAnswer,
  type StripeReturn,
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
  /**
   * The viewer's PERSONAL billing account, once the server has listed it. Every
   * self-service purchase belongs to it; a Stripe return waits for it.
   */
  personalAccount?: BillingAccountRef | null;
}): { confirming: boolean; returnNotice: CheckoutReturnNotice | null; dismissReturnNotice: () => void } {
  const handled = useRef(false);
  const latest = useRef(input);
  latest.current = input;
  const [confirming, setConfirming] = useState(false);
  const [returnNotice, setReturnNotice] = useState<CheckoutReturnNotice | null>(null);
  // A Stripe return that names its attempt, waiting for the account list.
  const [stripePending, setStripePending] = useState<StripeReturn | null>(null);
  const stripeHandled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    const search = input.searchParams.toString();

    const stripe = parseStripeReturn(input.searchParams);
    if (stripe) {
      handled.current = true;
      latest.current.replaceUrl(stripPayPalReturnParams(search));
      setReturnNotice(stripeReturnNotice(stripe));
      if (stripe.attemptId) setStripePending(stripe);
      else latest.current.onSettled();
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

  const account = input.personalAccount ?? null;
  useEffect(() => {
    const ret = stripePending;
    if (!ret || !ret.attemptId || !account || stripeHandled.current) return;
    stripeHandled.current = true;
    const attemptId = ret.attemptId;
    const delay = latest.current.retryDelayMs ?? PAYPAL_RETURN_RETRY_MS;
    setConfirming(true);
    (async () => {
      try {
        if (ret.kind !== "RETURNED") {
          // Leaving Stripe is the customer's own act of abandoning THIS checkout.
          // Provider-first on the server: an open session is expired at Stripe; a
          // paid, processing or already-ended one is reported, never overwritten.
          const answer = (await abandonCheckoutAttempt(account, attemptId, true)) as StripeAttemptAnswer;
          setReturnNotice(stripeCancelNotice(ret, answer));
          return;
        }
        let answer: StripeAttemptAnswer = {};
        for (let check = 1; check <= STRIPE_RETURN_MAX_CHECKS; check++) {
          answer = (await recheckCheckoutAttempt(account, attemptId)) as StripeAttemptAnswer;
          if (stripeReturnSettled(answer) || check === STRIPE_RETURN_MAX_CHECKS) break;
          latest.current.onSettled();
          await new Promise((r) => setTimeout(r, delay));
        }
        setReturnNotice(stripeAttemptNotice(ret, answer));
      } catch (err) {
        captureException(err, { feature: "billing_stripe_return", kind: ret.kind });
        setReturnNotice(
          stripeReturnFailureNotice(ret, {
            statusCode: (err as { statusCode?: unknown }).statusCode,
            requestId: (err as { requestId?: unknown }).requestId,
          }),
        );
      } finally {
        setConfirming(false);
        latest.current.onSettled();
      }
    })();
  }, [stripePending, account]);

  return { confirming, returnNotice, dismissReturnNotice: () => setReturnNotice(null) };
}
