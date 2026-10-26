/**
 * MEMBERS RE-AUDIT ENT-05 — the Organization billing page renders the ONE seat
 * authority's answer. Capacity is per Collaboration Team; only an ACTIVE
 * Enterprise contract sets a workspace-wide seat count. A workspace with no
 * ceiling (`seatLimit: null`) must never read "N / 0 seats".
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../lib/api", () => ({ apiFetch: mocks.fetch, ApiError: class ApiError extends Error {} }));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: "org-1" }), useRouter: () => ({ push: () => {} }) }));
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import OrganizationAdminBillingPage from "../../app/(app)/organizations/[id]/admin/billing/page";

function rollup(workspaces: Array<Record<string, unknown>>) {
  return {
    organizationId: "org-1",
    workspaceCount: workspaces.length,
    activeWorkspaceCount: workspaces.length,
    totalIncludedSeats: 4,
    totalUsedSeats: 7,
    overSeatWorkspaceCount: 0,
    planCounts: { ENTERPRISE: workspaces.length },
    statusCounts: { ACTIVE: workspaces.length },
    billingOwner: null,
    workspaces,
  };
}

describe("Organization billing — seats per the one seat authority", () => {
  beforeEach(() => {
    mocks.fetch.mockReset();
  });
  afterEach(() => {
    cleanup();
  });

  it("no workspace-wide ceiling reads as members with no ceiling, never 'N / 0 seats'", async () => {
    mocks.fetch.mockResolvedValue(
      rollup([
        { id: "w1", name: "Casework", billingPlan: "ENTERPRISE", billingStatus: "ACTIVE", includedSeats: 0, seatLimit: null, usedSeats: 3, overSeat: false },
      ]),
    );
    render(<OrganizationAdminBillingPage />);
    expect(await screen.findByText("3 members · no workspace ceiling")).toBeTruthy();
    expect(screen.queryByText(/3 \/ 0 seats/)).toBeNull();
  });

  it("a contract ceiling reads used / limit (positive control)", async () => {
    mocks.fetch.mockResolvedValue(
      rollup([
        { id: "w1", name: "Casework", billingPlan: "ENTERPRISE", billingStatus: "ACTIVE", includedSeats: 4, seatLimit: 4, usedSeats: 4, overSeat: false },
      ]),
    );
    render(<OrganizationAdminBillingPage />);
    expect(await screen.findByText("4 / 4 seats")).toBeTruthy();
  });
});
