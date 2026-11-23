/**
 * TEAM-SPEC R4 / §2.11 — the record/case External Review panel offers Issue
 * and Revoke only where the API says it would accept them (`viewerCanIssue`,
 * per-grant `viewerCanRevoke`), falls back to the envelope role (OWNER/ADMIN)
 * on an API that predates the fields, and explains a record of another
 * workspace without claiming a role gap. Real apiFetch, stubbed transport.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("../../lib/platform-context/useServerProjectionGates", () => ({
  usePlanFeature: () => true,
}));
vi.mock("../../components/identity-security/StepUpModal", () => ({
  StepUpModal: () => null,
  useStepUpAction: () => ({
    runStepUpAction: async (fn: (headers?: Record<string, string>) => Promise<unknown>) => fn(),
  }),
}));
vi.mock("../../components/ui/ConfirmActionModal", () => ({
  useConfirmAction: () => ({ confirm: async () => true }),
}));

import { ExternalReviewSubjectPanel } from "../../components/external-review/ExternalReviewSubjectPanel";
import { PlatformContextProvider } from "../../lib/platform-context";
import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
} from "../../lib/platform-context/types";

const TEAM = "team-1";
const grant = (over: Record<string, unknown> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  reviewerEmail: "reviewer@outside.test",
  reviewerDisplayName: null,
  state: "ACTIVE",
  expiresAtUtc: "2030-01-01T00:00:00.000Z",
  acceptedAtUtc: null,
  lastAccessedAtUtc: null,
  ...over,
});

let listBody: Record<string, unknown> = {};
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify(listBody), { status: 200, headers: { "content-type": "application/json" } }),
    ),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function envelope(roleLabel: string): unknown {
  return {
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    capabilities: {},
    diagnostics: { requestId: "test" },
    workspace: { id: TEAM, name: "W", status: "active", scope: "PERSONAL" },
    account: { userId: "u-1", accountPlan: "PRO", accountStatus: "active" },
    activeSpace: { type: "PERSONAL", id: TEAM, displayName: "Dana's workspace", roleLabel, shared: true, plan: "PRO" },
    contextOptions: {
      personalSpace: null,
      ownedWorkspaces: [],
      organizations: [],
      activeContext: { workspaceId: TEAM, kind: "PERSONAL", organizationId: null, displayName: "W" },
    },
    flags: { isEnterpriseWorkspace: false },
    platform: { isPlatformAdmin: false },
    planFeatures: { externalReviewIncluded: true },
  };
}

function mount(roleLabel?: string) {
  const panel = <ExternalReviewSubjectPanel teamId={TEAM} subject={{ kind: "EVIDENCE", evidenceId: "ev-1" }} />;
  return render(
    roleLabel ? <PlatformContextProvider testEnvelope={envelope(roleLabel) as never}>{panel}</PlatformContextProvider> : panel,
  );
}

describe("External Review panel — issue / revoke follow the API's answer", () => {
  it("MEMBER / VIEWER (viewerCanIssue false, viewerCanRevoke false) see no Issue form and no Revoke, with the reason", async () => {
    listBody = {
      grants: [grant({ viewerCanRevoke: false })],
      viewerCanIssue: false,
      viewerActions: { workspaceId: TEAM, sameWorkspace: true },
    };
    mount();
    await screen.findByText("reviewer@outside.test");
    expect(document.querySelector("[data-external-review-issue]")).toBeNull();
    expect(document.querySelector("[data-external-review-revoke]")).toBeNull();
    expect(screen.getByText("Issuing and revoking invitations needs an owner or admin of this workspace.")).toBeTruthy();
  });

  it("an OWNER (viewerCanIssue true, viewerCanRevoke true) sees Issue and Revoke", async () => {
    listBody = {
      grants: [grant({ viewerCanRevoke: true })],
      viewerCanIssue: true,
      viewerActions: { workspaceId: TEAM, sameWorkspace: true },
    };
    mount();
    await screen.findByText("reviewer@outside.test");
    expect(document.querySelector("[data-external-review-issue]")).toBeTruthy();
    expect(document.querySelector("[data-external-review-revoke]")).toBeTruthy();
  });

  it("an API without the fields falls back to the envelope role: MEMBER gets neither", async () => {
    listBody = { grants: [grant()] };
    mount("MEMBER");
    await screen.findByText("reviewer@outside.test");
    expect(document.querySelector("[data-external-review-issue]")).toBeNull();
    expect(document.querySelector("[data-external-review-revoke]")).toBeNull();
  });

  it("an API without the fields falls back to the envelope role: ADMIN gets both", async () => {
    listBody = { grants: [grant()] };
    mount("ADMIN");
    await screen.findByText("reviewer@outside.test");
    expect(document.querySelector("[data-external-review-issue]")).toBeTruthy();
    expect(document.querySelector("[data-external-review-revoke]")).toBeTruthy();
  });

  it("a record of another workspace says so, never 'Your role does not include…'", async () => {
    listBody = {
      grants: [grant({ viewerCanRevoke: false })],
      viewerCanIssue: false,
      viewerActions: { workspaceId: "other-ws", sameWorkspace: false },
    };
    mount();
    await waitFor(() => expect(document.querySelector("[data-external-review-other-workspace]")).toBeTruthy());
    expect(screen.queryByText(/Your role does not include/)).toBeNull();
    expect(document.querySelector("[data-external-review-issue]")).toBeNull();
  });

  it("a record with no workspace is explained, not reported as a role refusal", async () => {
    render(<ExternalReviewSubjectPanel teamId={null} subject={{ kind: "CASE", caseId: "c-1" }} />);
    await waitFor(() => expect(document.querySelector("[data-external-review-other-workspace]")).toBeTruthy());
    expect(document.querySelector("[data-external-review-list-refused]")).toBeNull();
  });
});
