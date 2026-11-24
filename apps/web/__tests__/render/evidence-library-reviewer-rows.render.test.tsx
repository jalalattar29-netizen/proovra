/**
 * T-112 (ARCH-04) — the Evidence Library inspector shows the reviewer
 * (assignee) and due-date rows where the plan sells review assignments
 * (`planFeatures.reviewerOperationsIncluded`: Team and Enterprise).
 *
 * They were gated on the Enterprise surface flag, so a Team workspace — a
 * Personal Workspace whose plan includes reviewer operations — never saw who
 * a record was assigned to or when it was due. Pro (no reviewer operations)
 * still hides them; the Enterprise organization envelope still shows them.
 *
 * The REAL page and the REAL platform-context provider run against a
 * transport double.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { PLAN_CAPABILITIES } from "@proovra/shared-billing";

const H = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));

vi.mock("../../lib/api", () => ({
  apiFetch: async (url: string) => {
    const [path] = url.split("?");
    if (path === "/v1/evidence") {
      return { items: H.rows, pageInfo: { hasMore: false, nextCursor: null }, totalCount: H.rows.length };
    }
    if (path === "/v1/evidence/library-summary") return null;
    if (path === "/v1/evidence/saved-views") return { items: [] };
    if (path === "/v1/cases") return { items: [] };
    return {};
  },
  readApiToken: () => null,
  apiBaseUrl: () => "https://api.test.invalid",
  setActiveWorkspaceId: () => {},
  setApiToken: () => {},
  ApiError: class ApiError extends Error {
    statusCode = 500;
    code = "ERR";
  },
}));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/evidence",
}));

import EvidenceLibraryPage from "../../app/(app)/evidence/page";
import { PlatformContextProvider } from "../../lib/platform-context";
import { ToastProvider } from "../../components/ui";
import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
} from "../../lib/platform-context/types";

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

type Plan = "PRO" | "TEAM" | "ENTERPRISE";
const WS = "11111111-1111-4111-8111-111111111111";

function envelope(plan: Plan) {
  const c = PLAN_CAPABILITIES[plan];
  const org = plan === "ENTERPRISE";
  return {
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    workspace: {
      id: WS,
      name: org ? "Northwind Legal" : "Dana's personal workspace",
      status: "active",
      scope: org ? "ORGANIZATION" : "PERSONAL",
      workspaceKind: org ? "ORGANIZATION" : "PERSONAL",
      membership: { role: "OWNER", isOwner: true, isAdmin: true, memberCount: 3 },
    },
    activeSpace: org
      ? { type: "ORGANIZATION", id: WS, displayName: "Northwind Legal", roleLabel: "OWNER", plan }
      : { type: "PERSONAL", id: WS, displayName: "Personal Space", roleLabel: "Owner", plan },
    capabilities: { EVIDENCE_VIEW: true },
    account: { accountPlan: org ? "FREE" : plan, accountStatus: "active" },
    flags: { isEnterpriseWorkspace: org },
    platform: { isPlatformAdmin: false },
    planFeatures: {
      reviewerOperationsIncluded: c.reviewerOperationsIncluded,
      reviewQueuesIncluded: c.reviewQueuesIncluded,
      teamCollaborationIncluded: c.maxCollaborationTeamsPerWorkspace > 0,
    },
    contextOptions: {
      personalSpace: null,
      ownedWorkspaces: [],
      organizations: [],
      activeContext: { workspaceId: WS, kind: org ? "ORGANIZATION" : "PERSONAL", organizationId: null, displayName: "x" },
    },
    diagnostics: { requestId: "t" },
  };
}

const ID = "00000000-0000-4000-8000-000000000001";
beforeEach(() => {
  H.rows = [
    {
      id: ID,
      title: "Harbor photo",
      displayFileName: "harbor.jpg",
      originalFileName: "harbor.jpg",
      mimeType: "image/jpeg",
      sizeBytes: "1000",
      status: "SIGNED",
      createdAt: "2026-08-01T09:00:00.000Z",
      capturedAtUtc: "2026-08-01T08:59:00.000Z",
      archivedAt: null,
      deletedAt: null,
      retentionUntilUtc: null,
      legalHold: false,
      caseIds: [],
      teamId: WS,
      reviewWorkflow: {
        assignedTo: { displayName: "Riley Reviewer", email: "riley@example.test" },
        dueAt: "2026-12-01T00:00:00.000Z",
      },
    },
  ];
});
afterEach(() => cleanup());

async function openInspector(plan: Plan) {
  render(
    <PlatformContextProvider testEnvelope={envelope(plan) as never}>
      <ToastProvider>
        <EvidenceLibraryPage />
      </ToastProvider>
    </PlatformContextProvider>,
  );
  const title = await waitFor(() => {
    const el = document.querySelector<HTMLElement>(`[data-evidence-row-title="${ID}"]`);
    expect(el).not.toBeNull();
    return el!;
  });
  await act(async () => {
    title.click();
  });
  await waitFor(() => expect(document.querySelector("[data-preview-case]")).not.toBeNull());
}

describe("T-112 — reviewer and due rows follow reviewerOperationsIncluded", () => {
  it("TEAM Personal Workspace: the inspector shows the assignee and due date", async () => {
    expect(PLAN_CAPABILITIES.TEAM.reviewerOperationsIncluded).toBe(true);
    await openInspector("TEAM");
    expect(document.querySelector("[data-preview-assigned-reviewer]")?.textContent).toBe("Riley Reviewer");
    expect(document.querySelector("[data-preview-due-date]")?.textContent).toMatch(/^Due /);
  });

  it("PRO: the rows stay hidden (no reviewer operations)", async () => {
    expect(PLAN_CAPABILITIES.PRO.reviewerOperationsIncluded).toBe(false);
    await openInspector("PRO");
    expect(document.querySelector("[data-preview-assigned-reviewer]")).toBeNull();
    expect(document.querySelector("[data-preview-due-date]")).toBeNull();
  });

  it("Enterprise organization: the rows are shown, as before", async () => {
    await openInspector("ENTERPRISE");
    expect(document.querySelector("[data-preview-assigned-reviewer]")?.textContent).toBe("Riley Reviewer");
    expect(document.querySelector("[data-preview-due-date]")).not.toBeNull();
  });
});
