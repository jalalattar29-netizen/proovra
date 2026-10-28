/**
 * MEMBERS EXPERIENCE F — EVERY COLLABORATION TEAM HERO ACTION LEADS SOMEWHERE
 * THE ACTOR IS ADMITTED.
 *
 * Production: a TEAM owner on their Personal Workspace saw "External
 * reviewers" in the Team header and landed on the app's not-found page —
 * `/review/external` is an Enterprise-tier surface on an Organization-only
 * route, and the link checked only the role and the PRO+ entitlement.
 *
 * This mounts the REAL Team detail page under real envelopes and asserts, per
 * plan, which of the four actions render:
 *
 *   External reviewers  only where the console's own gates admit the actor
 *   Create assignment   only where Team tasks are sold and growth is allowed
 *   Add people          only where growth is allowed
 *   Discussion          never for a governor who is not in the group
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";

const TEAM_ID = "77777777-7777-4777-8777-777777777777";
const WORKSPACE_ID = "44444444-4444-4444-8444-444444444444";
const VIEWER_ID = "c1000000-0000-4000-8000-0000000000a1";
const ISO = "2026-09-01T00:00:00.000Z";

const H = vi.hoisted(() => ({
  mutationsAllowed: true as boolean,
  viaWorkspaceGovernance: false as boolean,
  status: "ACTIVE" as "ACTIVE" | "ARCHIVED",
}));

function teamDetail() {
  return {
    id: TEAM_ID,
    workspaceId: WORKSPACE_ID,
    name: "Meridian Incident Response",
    description: null,
    teamType: "INVESTIGATION",
    status: H.status,
    createdAt: ISO,
    updatedAt: ISO,
    archivedAtUtc: H.status === "ARCHIVED" ? ISO : null,
    viewerRole: "LEAD",
    activeMemberCount: 1,
    pendingInviteCount: 0,
    memberPreviewLimit: 25,
    members: [
      {
        id: "m-a1",
        userId: VIEWER_ID,
        role: "LEAD",
        status: "ACTIVE",
        joinedAt: ISO,
        suspendedAt: null,
        removedAt: null,
        user: { id: VIEWER_ID, email: "lead@meridian.test", displayName: "Lead", firstName: null, lastName: null, avatarUrl: null },
      },
    ],
    invites: [],
    assignmentCount: 0,
  };
}

vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string) => {
    if (path.endsWith("/entitlement")) {
      return {
        plan: "TEAM",
        featureIncluded: true,
        mutationsAllowed: H.mutationsAllowed,
        collaborationTeams: { limit: 5, used: 1 },
        collaborationTeamMembers: { limit: 10 },
      };
    }
    if (path.includes("/assignments")) return { assignments: [], nextCursor: null, total: 0 };
    if (path.includes("/activity")) return { items: [], nextCursor: null };
    if (path.includes("/overview")) return { overview: { workload: [], health: [], attention: [], counts: {} } };
    if (path.includes("/comments")) return { items: [], directory: {} };
    if (path.includes("/disposability")) return { disposition: { disposable: false, blockers: [] } };
    return { team: teamDetail(), viaWorkspaceGovernance: H.viaWorkspaceGovernance };
  },
  readApiToken: () => null,
  apiBaseUrl: () => "https://api.test.invalid",
  ApiError: class ApiError extends Error {},
}));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  // The header is the same on every tab; the Work tab needs the least fixture.
  useSearchParams: () => new URLSearchParams("tab=work"),
  usePathname: () => `/collaboration-teams/${TEAM_ID}`,
  useParams: () => ({ teamId: TEAM_ID }),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import { PlatformContextProvider } from "../../lib/platform-context";
import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
} from "../../lib/platform-context/types";
import { ToastProvider } from "../../components/ui";
import { ConfirmActionProvider } from "../../components/ui/ConfirmActionModal";
import TeamDetailPage from "../../app/(app)/collaboration-teams/[teamId]/page";

type Plan = {
  space: "PERSONAL" | "ORGANIZATION";
  enterprise: boolean;
  reviewQueuesIncluded: boolean;
  reviewerOperationsIncluded: boolean;
  externalReviewIncluded: boolean;
};
const PRO_PERSONAL: Plan = { space: "PERSONAL", enterprise: false, reviewQueuesIncluded: false, reviewerOperationsIncluded: false, externalReviewIncluded: true };
const TEAM_PERSONAL: Plan = { space: "PERSONAL", enterprise: false, reviewQueuesIncluded: true, reviewerOperationsIncluded: true, externalReviewIncluded: true };
const ENTERPRISE_ORG: Plan = { space: "ORGANIZATION", enterprise: true, reviewQueuesIncluded: true, reviewerOperationsIncluded: true, externalReviewIncluded: true };

function envelope(plan: Plan): unknown {
  return {
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    // The role holds the console capability in every case: the plan and the
    // Workspace kind are what decide.
    capabilities: { REVIEWER_OPS_VIEW: true },
    diagnostics: { requestId: "hero-actions" },
    user: { id: VIEWER_ID, email: "lead@meridian.test", displayName: "Lead" },
    workspace: { id: WORKSPACE_ID, name: "Meridian", status: "active", scope: plan.space },
    activeSpace: { type: plan.space, id: WORKSPACE_ID, displayName: "Meridian", roleLabel: "Owner" },
    personalSpace: { id: plan.space === "PERSONAL" ? WORKSPACE_ID : "p-1", displayName: "Personal", available: true },
    flags: { isEnterpriseWorkspace: plan.enterprise },
    planFeatures: {
      teamCollaborationIncluded: true,
      reviewQueuesIncluded: plan.reviewQueuesIncluded,
      reviewerOperationsIncluded: plan.reviewerOperationsIncluded,
      externalReviewIncluded: plan.externalReviewIncluded,
      professionalSurfacesIncluded: true,
      intakeIncluded: true,
    },
  };
}

async function mount(plan: Plan) {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <PlatformContextProvider testEnvelope={envelope(plan) as never}>
        <ToastProvider>
          <ConfirmActionProvider>
            <TeamDetailPage />
          </ConfirmActionProvider>
        </ToastProvider>
      </PlatformContextProvider>,
    );
  });
  await waitFor(() => expect(view.getAllByText("Meridian Incident Response").length).toBeGreaterThan(0));
  return view;
}

beforeEach(() => {
  H.mutationsAllowed = true;
  H.viaWorkspaceGovernance = false;
  H.status = "ACTIVE";
});
afterEach(cleanup);

describe("External reviewers — rendered only where /review/external opens", () => {
  it("TEAM on a Personal Workspace: role + PRO+ entitlement, and still no link (the console would 404)", async () => {
    const view = await mount(TEAM_PERSONAL);
    await waitFor(() => expect(view.getByTestId("collaboration-hub-link")).toBeTruthy());
    expect(view.queryByTestId("external-reviewers-link")).toBeNull();
  });

  it("PRO on a Personal Workspace: no link", async () => {
    const view = await mount(PRO_PERSONAL);
    await waitFor(() => expect(view.getByTestId("collaboration-hub-link")).toBeTruthy());
    expect(view.queryByTestId("external-reviewers-link")).toBeNull();
  });

  it("an Enterprise Organization Workspace: the link renders and points at the real console", async () => {
    const view = await mount(ENTERPRISE_ORG);
    const link = await view.findByTestId("external-reviewers-link");
    expect(link.getAttribute("href")).toBe("/review/external");
  });
});

describe("Create assignment and Add people — offered only where the submit is accepted", () => {
  it("PRO: Team tasks are not sold, so Create assignment is not offered; Add people is", async () => {
    const view = await mount(PRO_PERSONAL);
    await waitFor(() => expect(view.getByTestId("collaboration-hub-link")).toBeTruthy());
    expect(view.queryByTestId("header-create-assignment-button")).toBeNull();
    await waitFor(() => expect(view.getByText("Add people")).toBeTruthy());
  });

  it("TEAM: both are offered", async () => {
    const view = await mount(TEAM_PERSONAL);
    await waitFor(() => expect(view.getByTestId("header-create-assignment-button")).toBeTruthy());
    expect(view.getByText("Add people")).toBeTruthy();
  });

  it("a billing restriction keeps the group readable and offers neither growth action", async () => {
    H.mutationsAllowed = false;
    const view = await mount(TEAM_PERSONAL);
    await waitFor(() => expect(view.getByTestId("collaboration-hub-link")).toBeTruthy());
    expect(view.queryByTestId("header-create-assignment-button")).toBeNull();
    expect(view.queryByText("Add people")).toBeNull();
  });
});

describe("Discussion — never a button into a blocked panel", () => {
  it("a governor reading a group they are not in gets no Discussion button", async () => {
    H.viaWorkspaceGovernance = true;
    const view = await mount(TEAM_PERSONAL);
    await waitFor(() => expect(view.getAllByText("Meridian Incident Response").length).toBeGreaterThan(0));
    expect(view.queryByTestId("collaboration-hub-link")).toBeNull();
  });

  it("a participant gets it", async () => {
    const view = await mount(TEAM_PERSONAL);
    await waitFor(() => expect(view.getByTestId("collaboration-hub-link")).toBeTruthy());
  });
});
