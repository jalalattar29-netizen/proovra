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

  it("a customer cancellation calls nothing and says nothing was charged", async () => {
    const { notify, replaceUrl } = run("canceled=1&provider=paypal&kind=storage-addon");
    await waitFor(() => expect(notify).toHaveBeenCalled());
    expect(apiFetch).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/Nothing was charged/), "info");
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
