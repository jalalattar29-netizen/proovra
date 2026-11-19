/**
 * PRO-BL1-04 (WS-BILL) — the ONE reader of a PayPal base plan's paid fact,
 * shared by the webhook/return settlement and the reconciliation sweep's
 * adapter. A status label or the provider's next billing time is never a paid
 * fact.
 */
import { describe, expect, it } from "vitest";

import { addOneMonthUtc, readPayPalSubscriptionPaidFact } from "../src/services/paypal.service.js";

describe("PRO-BL1-04 — readPayPalSubscriptionPaidFact", () => {
  it("paid-through is the last completed payment plus one cycle, never next_billing_time", () => {
    const fact = readPayPalSubscriptionPaidFact({
      next_billing_time: "2027-03-01T00:00:00Z",
      last_payment: { amount: { value: "19.00", currency_code: "USD" }, time: "2026-01-31T09:00:00Z" },
    });
    expect(fact.paymentFailing).toBe(false);
    expect(fact.paidThroughUtc?.toISOString()).toBe("2026-02-28T09:00:00.000Z");
  });

  it("no completed payment states no paid-through date", () => {
    expect(readPayPalSubscriptionPaidFact({ next_billing_time: "2027-03-01T00:00:00Z" })).toEqual({
      paymentFailing: false,
      paidThroughUtc: null,
    });
    expect(readPayPalSubscriptionPaidFact(null)).toEqual({ paymentFailing: false, paidThroughUtc: null });
    expect(readPayPalSubscriptionPaidFact({ last_payment: { time: "not a date" } }).paidThroughUtc).toBeNull();
  });

  it("failed payments or an outstanding balance mean the payment is failing", () => {
    expect(readPayPalSubscriptionPaidFact({ failed_payments_count: 1 }).paymentFailing).toBe(true);
    expect(
      readPayPalSubscriptionPaidFact({ outstanding_balance: { value: "19.00", currency_code: "USD" } }).paymentFailing,
    ).toBe(true);
    expect(
      readPayPalSubscriptionPaidFact({ failed_payments_count: 0, outstanding_balance: { value: "0.00" } }).paymentFailing,
    ).toBe(false);
  });

  it("one month is clamped to the target month's last day", () => {
    expect(addOneMonthUtc(new Date("2026-12-31T10:00:00Z")).toISOString()).toBe("2027-01-31T10:00:00.000Z");
    expect(addOneMonthUtc(new Date("2028-01-30T10:00:00Z")).toISOString()).toBe("2028-02-29T10:00:00.000Z");
  });
});
