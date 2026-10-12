/**
 * Two Billing truths an operator or customer reads:
 *
 *   * The Billing banner says "Your plan cancellation was accepted" only when
 *     every outstanding add-on is a plan-cancellation dependant; an add-on the
 *     provider activated and PROOVRA could not grant is said as exactly that.
 *   * The admin billing detail exposes the OPEN review queue the customer
 *     banner ("being reviewed by support") refers to.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => ({ prisma: {} }));

const { dependentCancellationBannerMessage } = await import(
  "../src/services/billing/billing-account-projection.service.js"
);
const { readOpenBillingReviewQueue } = await import("../src/services/admin/billing.service.js");

describe("dependentCancellationBannerMessage", () => {
  it("plan-cancellation dependants keep the plan-cancellation sentence", () => {
    const m = dependentCancellationBannerMessage({
      affectedCount: 1,
      supportRequired: false,
      ungrantableCount: 0,
    });
    expect(m).toMatch(/^Your plan cancellation was accepted, but a storage add-on is still being stopped\./);
    expect(m).toMatch(/We are retrying automatically\.$/);
  });

  it("an ungrantable add-on is never described as a plan cancellation", () => {
    const one = dependentCancellationBannerMessage({
      affectedCount: 1,
      supportRequired: false,
      ungrantableCount: 1,
    });
    expect(one).not.toMatch(/plan cancellation/);
    expect(one).toMatch(/activated a storage add-on that could not be added to your account, and it is still being stopped/);

    const many = dependentCancellationBannerMessage({
      affectedCount: 2,
      supportRequired: true,
      ungrantableCount: 2,
    });
    expect(many).not.toMatch(/plan cancellation/);
    expect(many).toMatch(/2 storage add-ons that could not be added to your account, and they are/);
    expect(many).toMatch(/please contact support\.$/);
  });

  it("a mix says only what is true of both", () => {
    const m = dependentCancellationBannerMessage({
      affectedCount: 3,
      supportRequired: false,
      ungrantableCount: 1,
    });
    expect(m).not.toMatch(/plan cancellation/);
    expect(m).toMatch(/^3 storage add-ons are still being stopped at your payment provider\./);
  });
});

describe("readOpenBillingReviewQueue", () => {
  it("projects the OPEN queue, counts by reason and says when the list is capped", async () => {
    const createdAt = new Date("2026-10-01T00:00:00.000Z");
    const client = {
      billingReviewItem: {
        groupBy: vi.fn(async () => [
          { reason: "PARTIAL_REFUND", _count: { _all: 1 } },
          { reason: "AMOUNT_MISMATCH", _count: { _all: 2 } },
        ]),
        findMany: vi.fn(async () => [
          {
            id: "r-1",
            userId: "u-1",
            provider: "PAYPAL",
            product: "EVIDENCE_CREDIT",
            reason: "AMOUNT_MISMATCH",
            providerAction: "NONE",
            refundReviewRequired: false,
            createdAt,
          },
        ]),
      },
    };
    const m = await readOpenBillingReviewQueue(client as never, 1);
    expect(m).toMatchObject({
      value: {
        open: 3,
        byReason: [
          { reason: "AMOUNT_MISMATCH", count: 2 },
          { reason: "PARTIAL_REFUND", count: 1 },
        ],
        rows: [
          {
            id: "r-1",
            reason: "AMOUNT_MISMATCH",
            createdAtUtc: createdAt.toISOString(),
          },
        ],
        truncated: true,
      },
    });
    // No provider resource id or detail JSON is ever projected.
    const findArgs = (client.billingReviewItem.findMany.mock.calls[0] as unknown[])[0] as {
      where: unknown;
      select: Record<string, unknown>;
      take: number;
    };
    expect(findArgs.where).toEqual({ status: "OPEN" });
    expect(findArgs.take).toBe(1);
    expect(findArgs.select.providerResourceId).toBeUndefined();
    expect(findArgs.select.detail).toBeUndefined();
  });

  it("an unreadable queue is reported as not measured, never as empty", async () => {
    const client = {
      billingReviewItem: {
        groupBy: vi.fn(async () => {
          throw new Error("down");
        }),
        findMany: vi.fn(async () => []),
      },
    };
    const m = await readOpenBillingReviewQueue(client as never, 10);
    expect(m).not.toHaveProperty("value.open");
    expect(JSON.stringify(m)).toMatch(/could not be read/);
  });
});
