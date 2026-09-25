"use client";

/**
 * Runs the server-side confirmation for a PayPal return exactly once per page
 * load, reports the outcome, refreshes the account and removes PayPal's query
 * parameters from the URL (so a reload does not re-run it — although the
 * server call is idempotent if it does).
 *
 * See `lib/billing/paypal-return.ts` for why the browser grants nothing here.
 */

import { useEffect, useRef, useState } from "react";

import { apiFetch } from "../../../../lib/api";
import { captureException } from "../../../../lib/sentry";
import {
  parsePayPalReturn,
  payPalCanceledMessage,
  payPalReturnMessage,
  payPalOrderCapturePath,
  payPalSubscriptionConfirmPath,
  stripPayPalReturnParams,
  type PayPalReturnMessage,
} from "../../../../lib/billing/paypal-return";

type ParamReader = { get(name: string): string | null; toString(): string };

/** How many times a still-settling PayPal payment is re-asked, and how far apart. */
export const PAYPAL_RETURN_MAX_ATTEMPTS = 4;
export const PAYPAL_RETURN_RETRY_MS = 3000;

export function usePayPalReturn(input: {
  searchParams: ParamReader;
  notify: (message: string, tone: PayPalReturnMessage["tone"]) => void;
  onSettled: () => void;
  replaceUrl: (search: string) => void;
  retryDelayMs?: number;
}): { confirming: boolean } {
  const handled = useRef(false);
  const latest = useRef(input);
  latest.current = input;
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (handled.current) return;
    const ret = parsePayPalReturn(input.searchParams);
    if (!ret) return;
    handled.current = true;

    const search = input.searchParams.toString();
    latest.current.replaceUrl(stripPayPalReturnParams(search));

    if (ret.kind === "BUYER_CANCELED") {
      const msg = payPalCanceledMessage(ret.product);
      latest.current.notify(msg.message, msg.tone);
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
          last = payPalReturnMessage(ret, null);
          break;
        }
        if (!last.retry || attempt === PAYPAL_RETURN_MAX_ATTEMPTS) break;
        latest.current.onSettled();
        await new Promise((r) => setTimeout(r, delay));
      }
      setConfirming(false);
      if (last) latest.current.notify(last.message, last.tone);
      latest.current.onSettled();
    })();
    // Deliberately no cleanup cancel: under StrictMode the effect is run,
    // cleaned up and re-run, and the `handled` guard makes the re-run a no-op —
    // cancelling here would drop the only confirmation.
    // Runs once, on the params present when the page first loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { confirming };
}
