/**
 * T-113 (ARCH-05) — Team has one documented case-assignment path on the web.
 *
 * Coordinator decision: "case assignments" are CaseAssignment rows
 * (POST /v1/cases/:id/assignments). Every non-Enterprise case opens in
 * SimpleCaseDetail, which had no Assignments surface, so a Team workspace (a
 * Personal Workspace whose plan includes reviewer operations) could not assign
 * a case on the web at all. SimpleCaseDetail now renders the SAME assignments
 * component the Enterprise Matter Workspace uses, where
 * `planFeatures.reviewerOperationsIncluded` is true. Pro stays without it
 * (T-107 is decision-pending: no API or entitlement change).
 *
 * The placement prerequisite's 422 (`REVIEW_ASSIGNEE_NOT_PLACED`) is told in
 * plain words. Real apiFetch over a stubbed transport; the real platform
 * context provider.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PLAN_CAPABILITIES } from "@proovra/shared-billing";

const caseId = "c1000000-0000-4000-8000-000000000001";
const WS = "11111111-1111-4111-8111-111111111111";
const ALICE = "a0000000-0000-4000-8000-00000000000a";

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: async () => true }) }));
vi.mock("../../components/identity-security/StepUpModal", () => ({
  StepUpModal: () => null,
  useStepUpAction: () => ({ runStepUpAction: async (fn: () => Promise<unknown>) => fn() }),
}));
vi.mock("../../components/presence/PresenceIndicator", () => ({ PresenceIndicator: () => null }));
vi.mock("../../components/collaboration/TeamResponsibilityPanel", () => ({ TeamResponsibilityPanel: () => null }));
vi.mock("../../components/hidden-feature-panels/HiddenFeaturePanels", () => ({ CaseRiskPanel: () => null }));
vi.mock("../../components/governance/GovernanceSummary", () => ({ GovernanceSummary: () => null }));
vi.mock("../../components/ai-copilot/CaseCopilotPanel", () => ({ CaseCopilotPanel: () => null }));
vi.mock("../../components/external-review/ExternalReviewSubjectPanel", () => ({ ExternalReviewSubjectPanel: () => null }));
vi.mock("../../app/(app)/cases/components/SiuPanel", () => ({ SiuPanel: () => null }));
vi.mock("../../app/(app)/cases/components/SiuWorklistPanel", () => ({ SiuWorklistPanel: () => null }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => `/cases/${caseId}`,
  useParams: () => ({ id: caseId }),
}));

import { SimpleCaseDetail } from "../../components/cases-experience/simple-case-detail/SimpleCaseDetail";
import { PlatformContextProvider } from "../../lib/platform-context";
import { ToastProvider } from "../../components/ui";
import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
} from "../../lib/platform-context/types";

type Plan = "PRO" | "TEAM";
function envelope(plan: Plan) {
  const c = PLAN_CAPABILITIES[plan];
  return {
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    workspace: {
      id: WS,
      name: "Dana's personal workspace",
      status: "active",
      scope: "PERSONAL",
      workspaceKind: "PERSONAL",
      membership: { role: "OWNER", isOwner: true, isAdmin: true, memberCount: 3 },
    },
    activeSpace: { type: "PERSONAL", id: WS, displayName: "Personal Space", roleLabel: "Owner", plan },
    capabilities: { CASES_VIEW: true },
    account: { accountPlan: plan, accountStatus: "active" },
    flags: { isEnterpriseWorkspace: false },
    platform: { isPlatformAdmin: false },
    planFeatures: {
      casesIncluded: c.casesIncluded,
      reviewerOperationsIncluded: c.reviewerOperationsIncluded,
      reviewQueuesIncluded: c.reviewQueuesIncluded,
      teamCollaborationIncluded: c.maxCollaborationTeamsPerWorkspace > 0,
    },
    contextOptions: {
      personalSpace: { workspaceId: WS, name: "Personal Space", kind: "PERSONAL", role: "OWNER", lifecycleStatus: "active" },
      ownedWorkspaces: [],
      organizations: [],
      activeContext: { workspaceId: WS, kind: "PERSONAL", organizationId: null, displayName: "Personal Space" },
    },
    diagnostics: { requestId: "t" },
  };
}

function matter() {
  const iso = "2026-09-01T00:00:00.000Z";
  const ok = <T,>(extra: T) => ({ status: "ok", ...extra });
  return {
    generatedAt: iso,
    case: {
      id: caseId, name: "Harbor claim", referenceNumber: null, description: null, status: "OPEN", priority: "P2",
      scope: "SHARED", ownerUserId: "u-owner", teamId: WS, closedAtUtc: null, closureReason: null,
      createdAt: iso, updatedAt: iso, accessCount: 0,
    },
    viewer: {
      userId: "u-owner", role: "OWNER", canManage: true, canMutate: true, canAssign: true, canChangeStatus: true,
      canLinkEvidence: true, canUnlinkEvidence: true, canUnlinkLegacyEvidence: true, canComment: true,
      canResolveComment: true, disabledReasons: {}, activeAssignmentRoles: [],
    },
    risk: { status: "ok", data: null, sampledAtUtc: iso },
    sections: {
      commandSummary: ok({ data: { linkedEvidenceCount: 0, recentlyLinkedCount: 0, activeCaseHoldsCount: 0, affectedEvidenceHoldsCount: 0, pendingReviewCount: 0, openEscalationsCount: 0, activeAssignmentCount: 1 } }),
      evidence: ok({ items: [] }),
      relationships: ok({ links: [], relationships: [], counts: { primary: 0, supporting: 0, related: 0, duplicate: 0, derived: 0, context: 0 } }),
      workflows: ok({ items: [] }),
      reviewerCoordination: ok({ data: null, escalations: [] }),
      governance: ok({ caseHolds: [], evidenceHolds: [], auditReadinessScore: null, blockerCount: 0 }),
      custodyAndIntegrity: ok({ lifecycleStateCounts: [], verificationStatusCounts: [], integritySnapshots: [], custodyEventTotals: { eventsLast30d: 0 } }),
      timeline: ok({ items: [] }),
      notes: ok({ caseComments: [], unresolvedReviewerComments: [], unresolvedAnnotations: [] }),
      deliverables: ok({ reports: [], packages: [], externalReviewLinks: [], counts: { reportsReady: 0, packagesReady: 0, deliverablesPending: 0 } }),
    },
    assignments: [
      {
        id: "as-1", assignedToUserId: "u-bob", assignedByUserId: "u-owner", role: "INVESTIGATOR",
        status: "ACTIVE", assignedAtUtc: iso, removedAtUtc: null, note: null,
      },
    ],
    statusHistory: [],
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let assignReply: () => Response;
const posts: Array<{ url: string; body: unknown }> = [];

beforeEach(() => {
  posts.length = 0;
  assignReply = () =>
    json(422, {
      error: { code: "REVIEW_ASSIGNEE_NOT_PLACED", message: "assignee_not_placed", details: { reason: "assignee_not_placed" } },
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes(`/v1/cases/${caseId}/matter-workspace`)) return json(200, matter());
      if (url.includes(`/v1/cases/${caseId}/assignment-candidates`)) {
        return json(200, {
          workspaceScope: "TEAM",
          items: [{ userId: ALICE, displayName: "Alice Analyst", email: "alice@example.test", workspaceRole: "MEMBER", existingAssignmentRoles: [] }],
          nextCursor: null,
        });
      }
      if (method === "POST" && url.endsWith(`/v1/cases/${caseId}/assignments`)) {
        posts.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
        return assignReply();
      }
      return json(200, {});
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function mount(plan: Plan) {
  render(
    <PlatformContextProvider testEnvelope={envelope(plan) as never}>
      <ToastProvider>
        <SimpleCaseDetail caseId={caseId} onOpenEvidence={() => {}} />
      </ToastProvider>
    </PlatformContextProvider>,
  );
  await waitFor(() => expect(document.querySelector("[data-simple-case-tabs]")).not.toBeNull());
}
const tabIds = () =>
  Array.from(document.querySelectorAll("[data-simple-case-tab]")).map((t) => t.getAttribute("data-simple-case-tab"));

describe("T-113 — case assignments in the simple case view", () => {
  it("TEAM: an Assignments tab renders the shared case-assignment surface with its rows", async () => {
    expect(PLAN_CAPABILITIES.TEAM.reviewerOperationsIncluded).toBe(true);
    await mount("TEAM");
    expect(tabIds()).toContain("assignments");
    await act(async () => {
      fireEvent.click(document.querySelector('[data-simple-case-tab="assignments"]')!);
    });
    const section = document.querySelector("[data-simple-case-assignments]");
    expect(section).not.toBeNull();
    expect(section!.querySelector('[data-matter-assignment-row="as-1"]')).not.toBeNull();
    const add = section!.querySelector("[data-matter-assignments-add]") as HTMLButtonElement;
    expect(add.textContent).toContain("Assign teammate");
    expect(add.disabled).toBe(false);
  });

  it("PRO: no Assignments tab (unchanged; T-107 is decision-pending)", async () => {
    expect(PLAN_CAPABILITIES.PRO.reviewerOperationsIncluded).toBe(false);
    await mount("PRO");
    expect(tabIds()).not.toContain("assignments");
    expect(document.querySelector("[data-simple-case-assignments]")).toBeNull();
  });

  it("TEAM: the placement refusal (422 REVIEW_ASSIGNEE_NOT_PLACED) is said in plain words", async () => {
    await mount("TEAM");
    await act(async () => {
      fireEvent.click(document.querySelector('[data-simple-case-tab="assignments"]')!);
    });
    await act(async () => {
      fireEvent.click(document.querySelector("[data-matter-assignments-add]")!);
    });
    const option = await screen.findByRole("option", { name: /Alice Analyst/ });
    await act(async () => {
      fireEvent.click(option);
    });
    await act(async () => {
      fireEvent.click(document.querySelector("[data-matter-assignment-picker-submit]")!);
    });
    const alert = await waitFor(() => {
      const el = document.querySelector("[data-matter-assignments-error]");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({ assignedToUserId: ALICE });
    const text = alert.textContent ?? "";
    expect(text).toMatch(/isn.t in a Collaboration Team yet/);
    expect(text).not.toMatch(/REVIEW_ASSIGNEE_NOT_PLACED|assignee_not_placed/i);
  });

  it("TEAM: the legacy lowercase code is told the same way", async () => {
    assignReply = () => json(422, { error: { code: "assignee_not_placed", message: "assignee_not_placed" } });
    await mount("TEAM");
    await act(async () => {
      fireEvent.click(document.querySelector('[data-simple-case-tab="assignments"]')!);
    });
    await act(async () => {
      fireEvent.click(document.querySelector("[data-matter-assignments-add]")!);
    });
    const option = await screen.findByRole("option", { name: /Alice Analyst/ });
    await act(async () => {
      fireEvent.click(option);
    });
    await act(async () => {
      fireEvent.click(document.querySelector("[data-matter-assignment-picker-submit]")!);
    });
    const alert = await waitFor(() => document.querySelector("[data-matter-assignments-error]")!);
    expect(alert.textContent ?? "").toMatch(/isn.t in a Collaboration Team yet/);
    expect(alert.textContent ?? "").not.toMatch(/assignee_not_placed/i);
  });
});
