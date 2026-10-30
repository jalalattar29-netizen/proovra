/**
 * BILLING — the return from PayPal.
 *
 * PayPal sends the buyer back to /billing with its own `token` (order id) or
 * `subscription_id`. Nothing read them, so an approved evidence-credit order
 * was never captured and the buyer came back to an unchanged page. These tests
 * run the shipped hook and the shipped parser over real return URLs.
 *
 * The browser never grants anything: every assertion below is about WHICH
 * server confirmation is requested, and how its answer is reported.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("../../lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock("../../lib/sentry", () => ({ captureException: vi.fn() }));

import { usePayPalReturn } from "../../app/(app)/billing/_sections/usePayPalReturn";
import {
  parsePayPalReturn,
  stripPayPalReturnParams,
} from "../../lib/billing/paypal-return";

function params(qs: string) {
  return new URLSearchParams(qs);
}

function run(qs: string) {
  const notify = vi.fn();
  const onSettled = vi.fn();
  const replaceUrl = vi.fn();
  const hook = renderHook(() =>
    usePayPalReturn({
      searchParams: params(qs),
      notify,
      onSettled,
      replaceUrl,
      retryDelayMs: 1,
    }),
  );
  return { notify, onSettled, replaceUrl, hook };
}

beforeEach(() => {
  apiFetch.mockReset();
});

describe("parsePayPalReturn — the real PayPal return URLs", () => {
  it("an evidence-credit order return names the order to capture", () => {
    expect(
      parsePayPalReturn(params("success=1&provider=paypal&kind=credits&token=5O190127TN364715T&PayerID=ABC")),
    ).toEqual({ kind: "ORDER_CAPTURE", orderId: "5O190127TN364715T" });
  });

  it("a plan subscription return names the subscription (its `token` is ignored)", () => {
    expect(
      parsePayPalReturn(
        params("success=1&provider=paypal&kind=plan&subscription_id=I-BW452GLLEP1G&ba_token=BA-1&token=EC-1"),
      ),
    ).toEqual({ kind: "SUBSCRIPTION_CONFIRM", subscriptionId: "I-BW452GLLEP1G", product: "plan" });
  });

  it("a storage add-on return is a subscription confirmation for the add-on", () => {
    expect(
      parsePayPalReturn(params("success=1&provider=paypal&kind=storage-addon&subscription_id=I-STORAGE01")),
    ).toEqual({ kind: "SUBSCRIPTION_CONFIRM", subscriptionId: "I-STORAGE01", product: "storage-addon" });
  });

  it("a customer cancellation is recognised", () => {
    expect(parsePayPalReturn(params("canceled=1&provider=paypal&kind=credits&token=5O190127TN364715T"))).toEqual({
      kind: "BUYER_CANCELED",
      product: "credits",
      subscriptionId: null,
      orderId: "5O190127TN364715T",
    });
    expect(parsePayPalReturn(params("canceled=1&provider=paypal&kind=plan&subscription_id=I-BW452GLLEP1G&ba_token=BA-1"))).toMatchObject({
      kind: "BUYER_CANCELED",
      subscriptionId: "I-BW452GLLEP1G",
      orderId: null,
    });
  });

  it("ignores Stripe returns, missing ids and malformed ids", () => {
    expect(parsePayPalReturn(params("success=1"))).toBeNull();
    expect(parsePayPalReturn(params("success=1&provider=paypal&kind=credits"))).toBeNull();
    expect(parsePayPalReturn(params("success=1&provider=paypal&kind=credits&token=../../admin"))).toBeNull();
    expect(parsePayPalReturn(params("success=1&provider=paypal&subscription_id=%3Cscript%3E"))).toBeNull();
  });

  it("strips every PayPal parameter but keeps the workspace locator", () => {
    expect(
      stripPayPalReturnParams("workspace=personal&success=1&provider=paypal&kind=credits&token=ABCDEF1&PayerID=X"),
    ).toBe("?workspace=personal");
  });
});

describe("usePayPalReturn — server confirmation on return", () => {
  it("asks the server to capture the order, reports the credit and refreshes", async () => {
    apiFetch.mockResolvedValueOnce({ outcome: "GRANTED", credits: 1 });
    const { notify, onSettled, replaceUrl } = run(
      "success=1&provider=paypal&kind=credits&token=5O190127TN364715T&PayerID=ABC",
    );

    await waitFor(() => expect(notify).toHaveBeenCalled());
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith(
      "/v1/billing/credits/checkout/paypal/5O190127TN364715T/capture",
      expect.objectContaining({ method: "POST" }),
    );
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/credit has been added/), "success");
    expect(onSettled).toHaveBeenCalled();
    expect(replaceUrl).toHaveBeenCalledWith("");
  });

  it("confirms a subscription and keeps asking while PayPal is still activating it", async () => {
    apiFetch
      .mockResolvedValueOnce({ outcome: "PENDING" })
      .mockResolvedValueOnce({ outcome: "ACTIVE", kind: "PLAN", plan: "PRO" });
    const { notify } = run("success=1&provider=paypal&kind=plan&subscription_id=I-BW452GLLEP1G&ba_token=BA-1&token=EC-1");

    await waitFor(() => expect(notify).toHaveBeenCalled());
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(apiFetch.mock.calls[0]![0]).toBe("/v1/billing/checkout/paypal/subscriptions/I-BW452GLLEP1G/confirm");
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/plan is active/), "success");
  });

  it("a payment PayPal is still settling is reported as pending, never as success", async () => {
    apiFetch.mockResolvedValue({ outcome: "PENDING", reason: "CAPTURE_PENDING" });
    const { notify } = run("success=1&provider=paypal&kind=credits&token=5O190127TN364715T");

    await waitFor(() => expect(notify).toHaveBeenCalled());
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/still processing/), "info");
    expect(notify).not.toHaveBeenCalledWith(expect.anything(), "success");
  });

  it("a declined payment is reported as an error", async () => {
    apiFetch.mockResolvedValueOnce({ outcome: "FAILED", reason: "CAPTURE_REJECTED" });
    const { notify } = run("success=1&provider=paypal&kind=credits&token=5O190127TN364715T");
    await waitFor(() => expect(notify).toHaveBeenCalled());
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/declined/), "error");
  });

  it("a server refusal (e.g. someone else's order) grants nothing and says so", async () => {
    apiFetch.mockRejectedValueOnce(Object.assign(new Error("not found"), { statusCode: 404 }));
    const { notify } = run("success=1&provider=paypal&kind=credits&token=5O190127TN364715T");
    await waitFor(() => expect(notify).toHaveBeenCalled());
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/could not confirm/), "error");
  });

  it("a customer cancellation that names its PayPal subscription closes it on the server (so it stops blocking checkout)", async () => {
    apiFetch.mockResolvedValueOnce({ outcome: "ABANDONED" });
    const { notify } = run("canceled=1&provider=paypal&kind=plan&subscription_id=I-BW452GLLEP1G");
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(apiFetch.mock.calls[0]![0]).toBe("/v1/billing/checkout/paypal/returns/canceled");
    expect(JSON.parse(String((apiFetch.mock.calls[0]![1] as { body: string }).body))).toEqual({ subscriptionId: "I-BW452GLLEP1G" });
    // Copy changed deliberately (AUD-19): the browser reports this before the
    // server has answered, so it says nothing about money.
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/You left PayPal before finishing/), "info");
    expect(notify).not.toHaveBeenCalledWith(expect.stringMatching(/charged/i), "info");
  });

  it("a server failure after approval is not reported as a refusal: PROOVRA keeps checking", async () => {
    apiFetch.mockRejectedValueOnce(Object.assign(new Error("gateway"), { statusCode: 502 }));
    const { notify } = run("success=1&provider=paypal&kind=credits&token=5O190127TN364715T");
    await waitFor(() => expect(notify).toHaveBeenCalled());
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/keeps checking/), "info");
  });

  it("a customer cancellation PayPal does not identify calls nothing and says so honestly", async () => {
    const { notify, replaceUrl } = run("canceled=1&provider=paypal&kind=storage-addon");
    await waitFor(() => expect(notify).toHaveBeenCalled());
    expect(apiFetch).not.toHaveBeenCalled();
    // Copy changed deliberately (AUD-19): no id means the checkout may still be
    // open, and the browser cannot speak for the money.
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/did not say which checkout this was/), "info");
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/may still show as open/), "info");
    expect(notify).not.toHaveBeenCalledWith(expect.stringMatching(/charged/i), "info");
    expect(replaceUrl).toHaveBeenCalledWith("");
  });

  it("a subscription the server refuses to confirm never promises to update by itself", async () => {
    apiFetch.mockRejectedValueOnce(
      Object.assign(new Error("not found"), { statusCode: 404, code: "PAYPAL_SUBSCRIPTION_NOT_FOUND", requestId: "req-9" }),
    );
    const { notify } = run("success=1&provider=paypal&kind=storage-addon&subscription_id=I-STORAGE01");
    await waitFor(() => expect(notify).toHaveBeenCalled());
    const [message, tone, reference] = notify.mock.calls[0]!;
    expect(message).toMatch(/could not match this PayPal storage add-on to your account/);
    expect(message).not.toMatch(/automatically/);
    expect(tone).toBe("error");
    expect(reference).toBe("req-9");
  });

  it("a refused order confirmation carries the support reference too", async () => {
    apiFetch.mockRejectedValueOnce(Object.assign(new Error("conflict"), { statusCode: 409, requestId: "req-10" }));
    const { notify } = run("success=1&provider=paypal&kind=credits&token=5O190127TN364715T");
    await waitFor(() => expect(notify).toHaveBeenCalled());
    expect(notify.mock.calls[0]![2]).toBe("req-10");
  });

  it("a rate-limited confirmation says to wait, and does not read as a refusal", async () => {
    apiFetch.mockRejectedValueOnce(
      Object.assign(new Error("slow down"), { statusCode: 429, code: "RATE_LIMIT_EXCEEDED" }),
    );
    const { notify } = run("success=1&provider=paypal&kind=plan&subscription_id=I-BW452GLLEP1G");
    await waitFor(() => expect(notify).toHaveBeenCalled());
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/tried several times/), "info");
  });

  it("a success return that names nothing says so, and asks the server nothing", async () => {
    const { notify, replaceUrl } = run("success=1&provider=paypal&kind=plan");
    await waitFor(() => expect(notify).toHaveBeenCalled());
    expect(apiFetch).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/has not been confirmed/), "info");
    expect(replaceUrl).toHaveBeenCalledWith("");
  });

  it("a Stripe return leaves a pending notice, refreshes once and asks PayPal nothing", async () => {
    const { notify, onSettled, replaceUrl, hook } = run("success=1&kind=storage-addon");
    await waitFor(() => expect(hook.result.current.returnNotice).not.toBeNull());
    expect(hook.result.current.returnNotice!.message).toMatch(/only after Stripe confirms/);
    expect(hook.result.current.returnNotice!.message).toMatch(/storage add-on/);
    expect(apiFetch).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(replaceUrl).toHaveBeenCalledWith("");
  });

  it("an ordinary Billing visit does nothing", () => {
    const { notify, replaceUrl } = run("workspace=personal");
    expect(apiFetch).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(replaceUrl).not.toHaveBeenCalled();
  });

  it("confirms once even when re-rendered", async () => {
    apiFetch.mockResolvedValue({ outcome: "GRANTED" });
    const { hook, notify } = run("success=1&provider=paypal&kind=credits&token=5O190127TN364715T");
    hook.rerender();
    hook.rerender();
    await waitFor(() => expect(notify).toHaveBeenCalled());
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });
});
