/**
 * MEMBERS RE-AUDIT ENT-05 / DEFECT 14 — the org-admin Seats card shows the
 * CANONICAL seat answer, never the legacy owner-inclusive one.
 *
 * The scenario the re-audit named: an Enterprise workspace whose contract
 * includes 10 seats holds ten members plus its owner. The canonical authority
 * (owner excluded) says 10 used / 10 included — within limit. The legacy
 * formula counted the owner (11 > 10) and persisted `overSeatLimit: true`;
 * the card OR-ed that flag in and compared the organization's member count
 * with the summed `includedSeats`, so it said "over its seat limit".
 *
 * The API response below carries BOTH: the stale legacy fields
 * (`includedSeats`, `overSeatLimit: true`) and the canonical `seats` block.
 * The card must render the canonical one.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

let workspacesReply: () => unknown = () => ({});
const requested: string[] = [];

vi.mock("../../lib/api", () => {
  class ApiError extends Error {
    statusCode: number;
    code: string;
    constructor(statusCode: number, code: string) {
      super(code);
      this.statusCode = statusCode;
      this.code = code;
    }
  }
  return {
    apiFetch: async (path: string) => {
      requested.push(path);
      if (path === "/v1/orgs/org-1/workspaces") return workspacesReply();
      // The legacy card also read the org summary; an org member count that
      // exceeds the contract must not matter.
      if (path === "/v1/orgs/org-1") {
        return { summary: { memberCount: 40, pendingInviteCount: 9 } };
      }
      return {};
    },
    readApiToken: () => null,
    apiBaseUrl: () => "https://api.test.invalid",
    ApiError,
  };
});

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

import { SeatsCard } from "../../app/(app)/organizations/[id]/admin/_lib/SeatsCard";

afterEach(() => {
  cleanup();
  requested.length = 0;
});

function workspace(
  name: string,
  seats: { used: number; limit: number | null; overLimit: boolean },
  legacy: { includedSeats: number; overSeatLimit: boolean },
) {
  return {
    workspaceId: `ws-${name}`,
    name,
    isPersonal: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    billing: {
      plan: "ENTERPRISE",
      status: "ACTIVE",
      includedSeats: legacy.includedSeats,
      overSeatLimit: legacy.overSeatLimit,
      billingOwnerUserId: "owner-1",
      seats: {
        used: seats.used,
        limit: seats.limit,
        remaining: seats.limit === null ? null : Math.max(0, seats.limit - seats.used),
        overLimit: seats.overLimit,
        featureIncluded: true,
        source: seats.limit === null ? "PLAN_CATALOG" : "ENTERPRISE_CONTRACT",
      },
    },
  };
}

describe("ENT-05 — the Seats card renders the canonical seat authority", () => {
  it("10 members + owner on a 10-seat contract is WITHIN limit, whatever the legacy flag says", async () => {
    workspacesReply = () => ({
      organizationId: "org-1",
      callerCanSeeBilling: true,
      workspaces: [
        workspace("Claims desk", { used: 10, limit: 10, overLimit: false }, { includedSeats: 10, overSeatLimit: true }),
      ],
    });
    render(<SeatsCard orgId="org-1" />);

    const body = await screen.findByTestId("seats-body");
    expect(body.getAttribute("data-seat-status")).toBe("ok");
    expect(body.getAttribute("data-over-seat-limit")).toBe("false");
    expect(screen.queryByTestId("seats-over-banner")).toBeNull();
    expect(screen.queryByTestId("seats-contact-sales")).toBeNull();
    expect(screen.getByTestId("seats-used").textContent).toBe("10");
    expect(screen.getByTestId("seats-included").textContent).toBe("10");
    expect(screen.getByTestId("seats-remaining").textContent).toBe("0");
    expect(screen.getByTestId("seats-ok").textContent).toMatch(/Within seat capacity\. 0 seats remaining\./);
    // The organization member count is not a seat figure.
    expect(requested).not.toContain("/v1/orgs/org-1");
  });

  it("a workspace the canonical authority finds over its contract is named, with contact-sales", async () => {
    workspacesReply = () => ({
      organizationId: "org-1",
      callerCanSeeBilling: true,
      workspaces: [
        workspace("Claims desk", { used: 12, limit: 10, overLimit: true }, { includedSeats: 10, overSeatLimit: false }),
        workspace("Litigation", { used: 3, limit: 5, overLimit: false }, { includedSeats: 5, overSeatLimit: false }),
      ],
    });
    render(<SeatsCard orgId="org-1" />);

    const body = await screen.findByTestId("seats-body");
    expect(body.getAttribute("data-seat-status")).toBe("over");
    const over = screen.getAllByTestId("seats-over-workspace");
    expect(over).toHaveLength(1);
    expect(over[0]!.textContent).toMatch(/Claims desk is over its contract seat limit \(\s*12 used \/ 10 included\)/);
    expect(screen.getByTestId("seats-used").textContent).toBe("15");
    expect(screen.getByTestId("seats-included").textContent).toBe("15");
    expect(screen.getByTestId("seats-contact-sales")).toBeTruthy();
  });

  it("with no contract ceiling, capacity is per Collaboration Team — never a fabricated seat count", async () => {
    workspacesReply = () => ({
      organizationId: "org-1",
      callerCanSeeBilling: true,
      workspaces: [
        workspace("Claims desk", { used: 7, limit: null, overLimit: false }, { includedSeats: 5, overSeatLimit: true }),
      ],
    });
    render(<SeatsCard orgId="org-1" />);

    const body = await screen.findByTestId("seats-body");
    expect(body.getAttribute("data-seat-status")).toBe("ok");
    expect(screen.getByTestId("seats-included").textContent).toBe("Not capped");
    expect(screen.queryByTestId("seats-remaining")).toBeNull();
    expect(screen.getByTestId("seats-ok").textContent).toMatch(/per Collaboration Team/);
  });
});
