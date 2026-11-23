/**
 * TEAM-SPEC §0/R1 (2026-11-23, cancel disclosure) — cancelling a Team
 * subscription warns BEFORE the cancel button that review queues,
 * assignments, escalations and SLA tracking stop, on the server's effective
 * date (formatted like every other billing date) or "immediately", from the
 * projection's `cancellation.endsReviewerOperations`. Absent when not
 * projected. Informational; cancelling is unchanged.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../../lib/api", () => ({ apiFetch: vi.fn() }));

import { ManagePlanDrawer } from "../../app/(app)/billing/_sections/ManagePlanDrawer";
import {
  cancellationReviewerOperationsNote,
  readCancellationEndsReviewerOperations,
} from "../../app/(app)/billing/_sections/billingMessages";
import { formatDate } from "../../app/(app)/billing/_sections/format";
import type { BillingAccountProjection } from "../../lib/api/billing-accounts";

afterEach(() => cleanup());

const EFFECTIVE_AT = "2031-03-14T09:30:00.000Z";

function team(cancellation?: unknown): BillingAccountProjection {
  return {
    account: {
      type: "PERSONAL",
      id: "user-1",
      displayName: "Jamie",
      capabilities: ["BILLING_ACCOUNT_VIEW", "BILLING_AMOUNT_VIEW", "BILLING_MANAGE", "BILLING_CANCEL"],
      billingOwnerMissing: false,
    },
    plan: {
      planKey: "TEAM",
      accessKind: "SUBSCRIPTION",
      displayName: "Team",
      model: "MONTHLY",
      lifecycle: "ACTIVE",
      currency: "USD",
      priceCents: 7900,
      currentPeriodEndUtc: EFFECTIVE_AT,
      cancelAtPeriodEnd: false,
      cancellationKeepsPaidPeriod: true,
      billingOwnerMissing: false,
      paymentProviderLabel: "Card",
    },
    planOffers: [],
    storageAddons: { offers: [], active: [] },
    ...(cancellation ? { cancellation } : {}),
    actions: {
      canStartCheckout: false,
      planManagement: { label: "Manage plan", mode: "MANAGE", enabled: true },
      canBuyEvidenceCredits: true,
      canBuyStorageAddon: true,
      canRequestCancellation: true,
      contactAccountManager: false,
      manageLabel: null,
    },
  } as unknown as BillingAccountProjection;
}

function mount(projection: BillingAccountProjection) {
  const onCancel = vi.fn();
  render(
    <ManagePlanDrawer
      open
      projection={projection}
      onClose={() => {}}
      onChangePlan={() => {}}
      onCancel={onCancel}
      changeBusyPlan={null}
      cancelBusy={false}
    />,
  );
  return onCancel;
}

describe("Team cancel: reviewer operations disclosure before confirming", () => {
  it("states the formatted effective date and counts before the cancel button", () => {
    const onCancel = mount(
      team({ endsReviewerOperations: { openWorkflows: 2, activeEscalations: 1, effectiveAt: EFFECTIVE_AT, effectiveImmediately: false } }),
    );
    const date = formatDate(EFFECTIVE_AT);
    expect(date).toBeTruthy();
    const note = document.querySelector('[data-billing-manage-review-ops-note="FREE"]');
    expect(note?.textContent).toBe(
      `Review queues, assignments, escalations and SLA tracking stop on ${date} — 2 open reviews and 1 active escalation stay readable. Nothing is deleted.`,
    );
    const button = document.querySelector("[data-billing-manage-cancel]");
    expect(button).not.toBeNull();
    // Before the confirm entry point in document order.
    expect(note!.compareDocumentPosition(button!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Cancelling is unchanged.
    fireEvent.click(screen.getByRole("button", { name: "Cancel subscription" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("says 'stop immediately' when the cancel ends them at once", () => {
    mount(team({ endsReviewerOperations: { openWorkflows: 1, activeEscalations: 0, effectiveAt: null, effectiveImmediately: true } }));
    expect(document.querySelector('[data-billing-manage-review-ops-note="FREE"]')?.textContent).toBe(
      "Review queues, assignments, escalations and SLA tracking stop immediately — 1 open review and 0 active escalations stay readable. Nothing is deleted.",
    );
  });

  it("claims no date the server did not give", () => {
    expect(
      cancellationReviewerOperationsNote(
        readCancellationEndsReviewerOperations(
          team({ endsReviewerOperations: { openWorkflows: 0, activeEscalations: 0, effectiveAt: null, effectiveImmediately: false } }),
        ),
      ),
    ).toBe(
      "Review queues, assignments, escalations and SLA tracking stop when your plan moves to Free — 0 open reviews and 0 active escalations stay readable. Nothing is deleted.",
    );
  });

  it("is absent when not projected, and ignores a malformed field", () => {
    mount(team());
    expect(document.querySelector("[data-billing-manage-review-ops-note]")).toBeNull();
    expect(screen.queryByText(/Review queues, assignments/)).toBeNull();
    expect(readCancellationEndsReviewerOperations(team({ endsReviewerOperations: { openWorkflows: "2" } }))).toBeNull();
    expect(readCancellationEndsReviewerOperations(null)).toBeNull();
  });
});
