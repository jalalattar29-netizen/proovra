/**
 * FREE-AUDIT REMEDIATION (2026-11-13, F-13 / F-14) — the return from Stripe.
 *
 * Stripe sends the buyer back to /billing with the checkout ATTEMPT the server put
 * on the return URL. On success the page asks the server to re-check that attempt
 * (which reads Stripe and applies it with the webhook's own writer), a bounded
 * number of times, and reports the attempt's persisted state. On cancel it asks the
 * server to abandon the attempt provider-first. The query string grants nothing.
 *
 * These run the shipped hook through the REAL apiFetch over a stubbed fetch, with
 * the bodies the attempt routes really send.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

vi.mock("../../lib/sentry", () => ({ captureException: vi.fn() }));

import { usePayPalReturn } from "../../app/(app)/billing/_sections/usePayPalReturn";
import { parseStripeReturn, stripPayPalReturnParams } from "../../lib/billing/paypal-return";
import type { BillingAccountRef } from "../../lib/api/billing-accounts";

const ATTEMPT = "3f2b8c1e-4a5d-4e6f-8a9b-0c1d2e3f4a5b";
const ACCOUNT: BillingAccountRef = {
  type: "PERSONAL",
  id: "user-1",
  displayName: "Jamie",
  capabilities: ["BILLING_MANAGE", "BILLING_HISTORY_VIEW"],
  billingOwnerMissing: false,
} as unknown as BillingAccountRef;

type Reply = { status: number; body: unknown };
let replies: Reply[] = [];
let calls: Array<{ url: string; method: string; body: string | null }> = [];

beforeEach(() => {
  replies = [];
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, method: init?.method ?? "GET", body: init?.body == null ? null : String(init.body) });
      const next = replies.shift() ?? { status: 500, body: { message: "unrouted" } };
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { "content-type": "application/json", "x-request-id": "req-stripe-1" },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function run(qs: string, account: BillingAccountRef | null = ACCOUNT) {
  const notify = vi.fn();
  const onSettled = vi.fn();
  const replaceUrl = vi.fn();
  const hook = renderHook(
    ({ acct }: { acct: BillingAccountRef | null }) =>
      usePayPalReturn({
        searchParams: new URLSearchParams(qs),
        notify,
        onSettled,
        replaceUrl,
        retryDelayMs: 1,
        personalAccount: acct,
      }),
    { initialProps: { acct: account } },
  );
  return { notify, onSettled, replaceUrl, hook };
}

const attemptCalls = () => calls.filter((c) => c.url.includes("/checkout-attempts/"));
const pending = { outcome: "STILL_PENDING", currentStatus: "PENDING", waitingFor: "PAYMENT_PROCESSING" };

describe("parseStripeReturn", () => {
  it("reads the attempt id, refuses a malformed one, and strips it from the URL", () => {
    expect(parseStripeReturn(new URLSearchParams(`success=1&attempt=${ATTEMPT}`))).toEqual({
      kind: "RETURNED",
      product: "plan",
      attemptId: ATTEMPT,
    });
    expect(parseStripeReturn(new URLSearchParams("canceled=1&kind=credits&attempt=../../x"))).toEqual({
      kind: "CANCELED",
      product: "credits",
      attemptId: null,
    });
    expect(stripPayPalReturnParams(`workspace=personal&success=1&attempt=${ATTEMPT}`)).toBe("?workspace=personal");
  });
});

describe("Stripe success return — the server re-checks the attempt", () => {
  it("asks again while Stripe settles, then reports the persisted confirmation", async () => {
    replies = [
      { status: 200, body: pending },
      { status: 200, body: { outcome: "UPDATED", currentStatus: "COMPLETED" } },
    ];
    const { hook, onSettled, replaceUrl } = run(`success=1&kind=storage-addon&attempt=${ATTEMPT}`);
    await waitFor(() => expect(hook.result.current.returnNotice?.tone).toBe("success"));
    expect(hook.result.current.returnNotice!.message).toMatch(/Stripe confirmed your payment and your storage add-on is applied/);
    expect(attemptCalls()).toHaveLength(2);
    expect(attemptCalls()[0]!.url).toContain(`/v1/billing/accounts/PERSONAL/user-1/checkout-attempts/${ATTEMPT}/recheck`);
    expect(attemptCalls()[0]!.method).toBe("POST");
    expect(replaceUrl).toHaveBeenCalledWith("");
    expect(onSettled).toHaveBeenCalled();
    expect(hook.result.current.confirming).toBe(false);
  });

  it("a return before the webhook that never settles stays 'waiting' and claims nothing", async () => {
    replies = [
      { status: 200, body: pending },
      { status: 200, body: pending },
      { status: 200, body: pending },
      { status: 200, body: pending },
    ];
    const { hook } = run(`success=1&attempt=${ATTEMPT}`);
    await waitFor(() => expect(attemptCalls()).toHaveLength(4));
    await waitFor(() => expect(hook.result.current.confirming).toBe(false));
    const notice = hook.result.current.returnNotice!;
    expect(notice.tone).toBe("pending");
    expect(notice.message).toMatch(/keeps checking automatically/);
    expect(notice.message).not.toMatch(/is applied\.|confirmed your payment|thank you/i);
  });

  it("a failed or closed attempt is reported as such, never as a success", async () => {
    replies = [{ status: 200, body: { outcome: "UPDATED", currentStatus: "EXPIRED" } }];
    const { hook } = run(`success=1&kind=credits&attempt=${ATTEMPT}`);
    await waitFor(() => expect(hook.result.current.returnNotice?.tone).toBe("info"));
    expect(hook.result.current.returnNotice!.message).toMatch(/closed before payment, so nothing was charged/);
    expect(attemptCalls()).toHaveLength(1);
  });

  it("an attempt that is not this account's (404) is a refusal with a support reference", async () => {
    replies = [{ status: 404, body: { message: "Checkout attempt not found" } }];
    const { hook } = run(`success=1&attempt=${ATTEMPT}`);
    await waitFor(() => expect(hook.result.current.returnNotice?.tone).toBe("error"));
    expect(hook.result.current.returnNotice!.message).toMatch(/could not match this Stripe checkout to your account/);
    expect(attemptCalls()).toHaveLength(1);
  });

  it("a rate-limited re-check says to wait", async () => {
    replies = [{ status: 429, body: { error: { code: "RATE_LIMIT_EXCEEDED", message: "slow" } } }];
    const { hook } = run(`success=1&attempt=${ATTEMPT}`);
    await waitFor(() => expect(hook.result.current.returnNotice?.title).toMatch(/Checked several times/));
  });

  it("waits for the account list before asking, then asks once", async () => {
    replies = [{ status: 200, body: { outcome: "UPDATED", currentStatus: "COMPLETED" } }];
    const { hook } = run(`success=1&attempt=${ATTEMPT}`, null);
    expect(hook.result.current.returnNotice?.title).toBe("Waiting for Stripe to confirm");
    expect(attemptCalls()).toHaveLength(0);
    hook.rerender({ acct: ACCOUNT });
    hook.rerender({ acct: { ...ACCOUNT } as BillingAccountRef });
    await waitFor(() => expect(hook.result.current.returnNotice?.tone).toBe("success"));
    expect(attemptCalls()).toHaveLength(1);
  });

  it("an older return without an attempt asks nothing and keeps the waiting notice", async () => {
    const { hook, onSettled } = run("success=1&kind=plan");
    await waitFor(() => expect(hook.result.current.returnNotice).not.toBeNull());
    expect(hook.result.current.returnNotice!.message).toMatch(/only after Stripe confirms/);
    expect(calls).toHaveLength(0);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });
});

describe("Stripe cancel return — the attempt is abandoned provider-first", () => {
  it("closes the checkout so the next one can start", async () => {
    replies = [{ status: 200, body: { attemptId: ATTEMPT, outcome: "ABANDONED", cancelsAtProvider: true } }];
    const { hook } = run(`canceled=1&attempt=${ATTEMPT}`);
    await waitFor(() => expect(hook.result.current.returnNotice?.message).toMatch(/That checkout is closed/));
    const call = attemptCalls()[0]!;
    expect(call.url).toContain(`/checkout-attempts/${ATTEMPT}/abandon`);
    expect(JSON.parse(call.body!)).toEqual({ confirmed: true });
    expect(hook.result.current.returnNotice!.message).not.toMatch(/charged/i);
  });

  it("a stale cancel link on a paid checkout changes nothing and says so", async () => {
    replies = [{ status: 200, body: { attemptId: ATTEMPT, outcome: "ALREADY_RESOLVED", cancelsAtProvider: false } }];
    const { hook } = run(`canceled=1&attempt=${ATTEMPT}`);
    await waitFor(() => expect(hook.result.current.returnNotice?.title).toBe("This checkout already ended"));
    expect(hook.result.current.returnNotice!.message).toMatch(/changed nothing/);
    expect(hook.result.current.returnNotice!.message).not.toMatch(/was not applied/);
  });

  it("a payment Stripe is still processing is left open", async () => {
    replies = [
      {
        status: 200,
        body: { attemptId: ATTEMPT, outcome: "ABANDON_NOT_ALLOWED", cancelsAtProvider: false, warning: "Stripe shows this purchase as approved and being processed, so it cannot be abandoned." },
      },
    ];
    const { hook } = run(`canceled=1&attempt=${ATTEMPT}`);
    await waitFor(() => expect(hook.result.current.returnNotice?.title).toBe("Payment is being processed"));
  });

  it("a webhook that already settled it wins over the cancel", async () => {
    replies = [{ status: 200, body: { attemptId: ATTEMPT, outcome: "UPDATED", currentStatus: "COMPLETED" } }];
    const { hook } = run(`canceled=1&kind=credits&attempt=${ATTEMPT}`);
    await waitFor(() => expect(hook.result.current.returnNotice?.tone).toBe("success"));
    expect(hook.result.current.returnNotice!.message).toMatch(/evidence credit is applied/);
  });
});
