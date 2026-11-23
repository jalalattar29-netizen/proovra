/**
 * TEAM-SPEC §3 — the SLA_NEAR_BREACH preference controls BOTH evidence
 * integrity alerts and review SLA deadline reminders (REVIEW_DUE_SOON /
 * OVERDUE / INACTIVITY map to it on the server). Its label and help say both.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("../../app/providers", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("../../lib/notifications/useOperationsUiContext", () => ({
  useOperationsUiContext: () => ({
    workspaceId: "team-1",
    isPersonalWorkspace: true,
    hasOrganizations: false,
    canViewAdminAttention: false,
    canReceiveGovernance: false,
    canUseReports: false,
    canUseVerificationPackages: false,
    canUseIntake: false,
    canCollaborate: false,
    hasPendingInvitation: false,
    canOwnTeamCollaboration: false,
    canParticipateInReviews: false,
    canReceiveAssignments: false,
    hasEligibleDeadlineSource: false,
  }),
}));

import { NotificationPreferencesPanel } from "../../components/notifications/NotificationPreferencesPanel";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input).replace(/^https?:\/\/[^/]+/, "");
      const body = path.startsWith("/v1/me/notification-preferences")
        ? {
            teamId: "team-1",
            preferences: [],
            isPersonalWorkspace: true,
            catalog: {
              preferenceTypes: ["SLA_NEAR_BREACH"],
              channels: ["IN_APP", "EMAIL"],
              frequencies: ["IMMEDIATE", "DAILY"],
              defaults: { IN_APP: true, EMAIL: true, frequency: "IMMEDIATE" },
            },
          }
        : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("notification preferences — the SLA_NEAR_BREACH toggle says what it controls", () => {
  it("names both evidence integrity failures and review SLA deadlines", async () => {
    render(<NotificationPreferencesPanel teamId="team-1" />);
    expect(await screen.findByText("Evidence integrity failures & review SLA deadlines")).toBeTruthy();
    expect(screen.getByText(/One setting covers two kinds of alert/)).toBeTruthy();
    expect(screen.getByText(/review SLA deadline reminders/)).toBeTruthy();
    expect(screen.queryByText("Evidence integrity & verification failures")).toBeNull();
  });
});
