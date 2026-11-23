/**
 * TEAM-SPEC §0/R1 — lowering a Team plan warns, before the move is chosen,
 * that review queues, assignments, escalations and SLA tracking stop, when
 * (and only when) the server says the move ends reviewer operations
 * (`endsReviewerOperations`). Informational; billing behaviour is unchanged.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../../lib/api", () => ({ apiFetch: vi.fn() }));

import { ManagePlanDrawer } from "../../app/(app)/billing/_sections/ManagePlanDrawer";
import {
  readEndsReviewerOperations,
  reviewerOperationsEndingNote,
} from "../../app/(app)/billing/_sections/billingMessages";
import type { BillingAccountProjection, PlanOffer } from "../../lib/api/billing-accounts";

afterEach(() => cleanup());

const MOVE_PRO: PlanOffer = {
  planKey: "PRO",
  displayName: "Pro",
  priceCents: 1900,
  currency: "USD",
  summary: "Pro",
  action: "DOWNGRADE",
  effect: "AT_PERIOD_END",
  actionLabel: "Move to Pro",
  effectSummary: "Lower limits than you have now. Nothing you have recorded is deleted.",
};

function team(offers: PlanOffer[]): BillingAccountProjection {
  return {
    account: {
      type: "PERSONAL",
      id: "user-1",
      displayName: "Jamie",
      capabilities: ["BILLING_ACCOUNT_VIEW", "BILLING_AMOUNT_VIEW", "BILLING_HISTORY_VIEW", "BILLING_MANAGE"],
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
      currentPeriodEndUtc: "2026-12-01T00:00:00.000Z",
      cancelAtPeriodEnd: false,
      billingOwnerMissing: false,
      paymentProviderLabel: "Card",
    },
    planOffers: offers,
    storageAddons: { offers: [], active: [] },
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

function mount(projection: BillingAccountProjection, extra: Partial<React.ComponentProps<typeof ManagePlanDrawer>> = {}) {
  const onChangePlan = vi.fn();
  render(
    <ManagePlanDrawer
      open
      projection={projection}
      onClose={() => {}}
      onChangePlan={onChangePlan}
      onCancel={() => {}}
      changeBusyPlan={null}
      cancelBusy={false}
      {...extra}
    />,
  );
  return onChangePlan;
}

describe("Team → lower: reviewer operations warning", () => {
  it("is shown before the move when the offer carries endsReviewerOperations", () => {
    const onChangePlan = mount(
      team([{ ...MOVE_PRO, endsReviewerOperations: { openWorkflows: 4, activeEscalations: 1 } } as PlanOffer]),
    );
    const note = document.querySelector('[data-billing-manage-review-ops-note="PRO"]');
    expect(note?.textContent).toBe(
      "Review queues, assignments, escalations and SLA tracking stop; 4 open reviews stay readable. 1 active escalation will no longer be tracked. Nothing is deleted.",
    );
    // Billing behaviour unchanged: the move is still the server's offer.
    fireEvent.click(screen.getByText("Move to Pro"));
    expect(onChangePlan).toHaveBeenCalledTimes(1);
  });

  it("is shown when the host passes the server's answer for that plan", () => {
    mount(team([MOVE_PRO]), {
      reviewerOperationsEnding: { PRO: { openWorkflows: 1, activeEscalations: 0 } },
    });
    expect(document.querySelector('[data-billing-manage-review-ops-note="PRO"]')?.textContent).toMatch(
      /^Review queues, assignments, escalations and SLA tracking stop; 1 open review stays readable\./,
    );
  });

  it("is absent without the field", () => {
    mount(team([MOVE_PRO]));
    expect(document.querySelector("[data-billing-manage-review-ops-note]")).toBeNull();
    expect(screen.queryByText(/Review queues, assignments/)).toBeNull();
  });

  it("ignores a malformed field", () => {
    expect(readEndsReviewerOperations({ openWorkflows: "4" })).toBeNull();
    expect(reviewerOperationsEndingNote(readEndsReviewerOperations(null))).toBeNull();
  });
});
