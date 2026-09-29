/**
 * ET-COM-01 — a Stripe subscription observation is ordered by WHEN THE
 * PROVIDER WAS READ, never by current_period_end (a future date that made every
 * later webhook look older and be refused). The Stripe client is stubbed at its
 * module boundary; the provider's mapping is the production code.
 */
import { describe, expect, it, vi } from "vitest";

const PERIOD_END_UNIX = Math.floor(Date.parse("2031-01-01T00:00:00Z") / 1000);

vi.mock("../src/services/stripe.service.js", () => ({
  StripeHttpError: class extends Error {},
  stripeRequestRaw: vi.fn(),
  stripeGet: vi.fn(async (path: string) => {
    if (path.startsWith("/subscriptions/")) {
      return { id: "sub_x", status: "active", current_period_end: PERIOD_END_UNIX, created: 1_700_000_000, cancel_at_period_end: false };
    }
    return { data: [] };
  }),
}));

describe("ET-COM-01 — Stripe observation ordering time", () => {
  it("is the read time, never the (future) period end", async () => {
    const { StripeBillingReconciliationProvider } = await import("../src/services/billing/reconciliation/stripe.provider.js");
    const before = Date.now();
    const obs = await new StripeBillingReconciliationProvider().observeSubscription("sub_x");
    const after = Date.now();
    expect(obs.state).not.toBe("UNKNOWN");
    expect(obs.currentPeriodEndUtc?.getTime()).toBe(PERIOD_END_UNIX * 1000);
    expect(obs.observedAtUtc).not.toBeNull();
    expect(obs.observedAtUtc!.getTime()).toBeGreaterThanOrEqual(before);
    expect(obs.observedAtUtc!.getTime()).toBeLessThanOrEqual(after);
  });
});
