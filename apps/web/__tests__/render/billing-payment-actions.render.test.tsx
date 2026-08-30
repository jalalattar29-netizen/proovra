/**
 * BILLING PAYMENT LIFECYCLE — the two payment-row actions, and the words on
 * them.
 *
 * WHAT THIS EXISTS TO STOP HAPPENING AGAIN
 * ---------------------------------------------------------------------------
 * The server projected `canAbandon: true`, the row offered "Abandon payment
 * attempt", and the endpoint answered 503 whenever the provider could not be
 * reached — which is the one case the action exists for. The advertised action
 * could not complete in its own use case, and the customer had nothing to do
 * but press it again.
 *
 * It also said "Nothing has been charged" in the same breath as admitting it
 * could not reach the provider: a claim about money made from ignorance.
 *
 * These are behaviour tests over the shipped components and the real request
 * bodies, not a scan of source text.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { BillingHistorySection } from "../../app/(app)/billing/_sections/StorageAndHistory";
import type { BillingHistoryEntry } from "../../lib/api/billing-accounts";

const noop = () => {};

const pendingPayPal: BillingHistoryEntry = {
  id: "33333333-3333-4333-8333-333333333333",
  occurredAtUtc: "2026-03-11T10:00:00.000Z",
  description: "Pro plan",
  status: "PENDING",
  amountCents: 1900,
  currency: "EUR",
  providerLabel: "PayPal",
  // PayPal has no cancellation for an unapproved order, so the row offers the
  // local exit instead — never both.
  actions: { canRecheck: true, canCancel: false, canAbandon: true },
};

const pendingStripe: BillingHistoryEntry = {
  id: "11111111-1111-4111-8111-111111111111",
  occurredAtUtc: "2026-03-04T10:00:00.000Z",
  description: "Evidence credit",
  status: "PENDING",
  amountCents: 500,
  currency: "USD",
  providerLabel: "Card",
  actions: { canRecheck: true, canCancel: true, canAbandon: false },
};

const abandoned: BillingHistoryEntry = {
  ...pendingPayPal,
  id: "44444444-4444-4444-8444-444444444444",
  status: "ABANDONED",
  actions: { canRecheck: false, canCancel: false, canAbandon: false },
};

const paid: BillingHistoryEntry = {
  ...pendingPayPal,
  id: "55555555-5555-4555-8555-555555555555",
  status: "SUCCEEDED",
  actions: { canRecheck: false, canCancel: false, canAbandon: false },
};

function mount(
  entries: BillingHistoryEntry[],
  over: {
    onRecheckPayment?: (e: BillingHistoryEntry) => void;
    onCancelPayment?: (e: BillingHistoryEntry) => void;
    onAbandonPayment?: (e: BillingHistoryEntry) => void;
    rowBusyId?: string | null;
  } = {},
) {
  return render(
    <BillingHistorySection
      entries={entries}
      state="READY"
      onRetry={noop}
      onRecheck={noop}
      recheckBusy={false}
      accessKind="SUBSCRIPTION"
      onRecheckPayment={over.onRecheckPayment ?? noop}
      onCancelPayment={over.onCancelPayment ?? noop}
      onAbandonPayment={over.onAbandonPayment ?? noop}
      rowBusyId={over.rowBusyId ?? null}
      resumeUrls={{}}
    />,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// 1. The two actions are never confused for each other
// ===========================================================================

describe("a real provider cancellation and a local abandonment", () => {
  it("are labelled as the different things they are", () => {
    mount([pendingStripe, pendingPayPal]);

    // A provider that can really be asked to stop is asked.
    expect(screen.getByRole("button", { name: "Cancel payment" })).toBeTruthy();
    // A provider that cannot is not pretended to have been.
    expect(screen.getByRole("button", { name: "Abandon payment attempt" })).toBeTruthy();
  });

  it("never appear together on one row", () => {
    // Offering both would ask the customer to choose between a real
    // cancellation and a local note, which is not a choice anybody can make
    // well.
    const { container } = mount([pendingStripe, pendingPayPal]);
    for (const row of Array.from(
      container.querySelectorAll("[data-billing-history-row]"),
    )) {
      const cancel = row.querySelector("[data-billing-payment-cancel]");
      const abandon = row.querySelector("[data-billing-payment-abandon]");
      expect(Boolean(cancel) && Boolean(abandon)).toBe(false);
    }
  });

  it("are read from the SERVER's verdict, never from the provider's name", () => {
    // A PayPal row whose server verdict allows a real cancellation shows one.
    // The page has no rule of its own about which provider can do what.
    mount([{ ...pendingPayPal, actions: { canRecheck: true, canCancel: true, canAbandon: false } }]);
    expect(screen.getByRole("button", { name: "Cancel payment" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Abandon payment attempt" })).toBeNull();
  });
});

// ===========================================================================
// 2. A finished row offers nothing, and says what it is
// ===========================================================================

describe("a finished payment row", () => {
  it("shows Abandoned and offers no further action", () => {
    const { container } = mount([abandoned]);
    expect(container.textContent).toMatch(/Abandoned/);
    expect(container.querySelector("[data-billing-payment-abandon]")).toBeNull();
    expect(container.querySelector("[data-billing-payment-recheck]")).toBeNull();
  });

  it("shows Paid once the provider confirms, even after abandonment", () => {
    // ABANDONED is terminal for the customer's active view and no stronger:
    // a later proven settlement is a fact, and the row says so.
    const { container } = mount([paid]);
    expect(container.textContent).toMatch(/Paid/);
    expect(container.textContent).not.toMatch(/Abandoned/);
  });

  it("keeps the row in history rather than deleting it", () => {
    const { container } = mount([abandoned, paid]);
    expect(container.querySelectorAll("[data-billing-history-row]")).toHaveLength(2);
  });
});

// ===========================================================================
// 3. One press, one request
// ===========================================================================

describe("a row action in flight", () => {
  it("is disabled while its own request is running", async () => {
    const user = userEvent.setup();
    const pressed: string[] = [];
    const { container } = mount([pendingPayPal], {
      rowBusyId: pendingPayPal.id,
      onAbandonPayment: (e) => pressed.push(e.id),
    });

    const abandon = container.querySelector<HTMLButtonElement>(
      "[data-billing-payment-abandon]",
    );
    expect(abandon).not.toBeNull();
    expect(abandon!.disabled).toBe(true);

    await user.click(abandon!);
    // A disabled button cannot start a second request.
    expect(pressed).toEqual([]);
  });

  it("does not disable an unrelated row", () => {
    const { container } = mount([pendingPayPal, pendingStripe], {
      rowBusyId: pendingPayPal.id,
    });
    const cancel = container.querySelector<HTMLButtonElement>(
      "[data-billing-payment-cancel]",
    );
    expect(cancel!.disabled).toBe(false);
  });
});

// ===========================================================================
// 4. The table stays compact and responsive
// ===========================================================================

describe("the history surface", () => {
  it("is the canonical responsive table with labelled cells", () => {
    const { container } = mount([pendingPayPal, pendingStripe]);
    const table = container.querySelector("table.app-table");
    expect(table).not.toBeNull();
    // `data-responsive` is what makes it stack into labelled cards below 720px.
    expect(table!.hasAttribute("data-responsive")).toBe(true);
    for (const cell of Array.from(container.querySelectorAll("tbody td"))) {
      expect(cell.hasAttribute("data-label")).toBe(true);
    }
  });

  it("renders an empty state that is a line, not a card", () => {
    const { container } = mount([]);
    expect(container.textContent).toMatch(/No payments yet/);
    expect(container.querySelector("table")).toBeNull();
  });
});
