/**
 * D56 — the Matter Workspace header's leading breadcrumb crumb names the
 * workspace that OWNS the case.
 *
 * The crumb used to test `case.scope === "TEAM"`, a value the server never
 * sends (matter-workspace.service.ts classifies SHARED / SINGLE_OCCUPANT), so
 * every case read "Personal Space". The server's scope is also not the owner:
 * a Personal Space case carries its personal Team id and is SHARED too. These
 * tests feed the REAL server vocabulary and prove both outcomes.
 */
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";

const caseId = "c1000000-0000-4000-8000-000000000056";
const orgWs = "44444444-4444-4444-8444-444444444444";
const personalWs = "55555555-5555-4555-8555-555555555555";

const H = vi.hoisted(() => ({ fetch: vi.fn(), teamId: null as string | null, ctx: null as unknown }));
vi.mock("../../lib/api", () => ({ apiFetch: H.fetch }));
vi.mock("../../lib/platform-context", async (orig) => ({
  ...(await orig<typeof import("../../lib/platform-context")>()),
  usePlatformContext: () => ({ envelope: H.ctx }),
}));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: async () => true }) }));
vi.mock("../../components/presence/PresenceIndicator", () => ({ PresenceIndicator: () => null }));
vi.mock("../../components/collaboration/TeamResponsibilityPanel", () => ({ TeamResponsibilityPanel: () => null }));
vi.mock("../../components/hidden-feature-panels/HiddenFeaturePanels", () => ({ CaseRiskPanel: () => null }));
vi.mock("../../components/governance/GovernanceSummary", () => ({ GovernanceSummary: () => null }));
vi.mock("../../app/(app)/cases/components/SiuPanel", () => ({ SiuPanel: () => null }));
vi.mock("../../app/(app)/cases/components/SiuWorklistPanel", () => ({ SiuWorklistPanel: () => null }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/cases/" + caseId,
  useParams: () => ({ id: caseId }),
}));

import { MatterWorkspace } from "../../components/cases-experience/MatterWorkspace";
import { ToastProvider } from "../../components/ui";

function envelope(): unknown {
  const iso = "2026-09-01T00:00:00.000Z";
  const ok = <T,>(extra: T) => ({ status: "ok", ...extra });
  return {
    generatedAt: iso,
    // The server's real vocabulary: any case with a teamId is SHARED.
    case: { id: caseId, name: "Harbor claim", referenceNumber: null, description: null, status: "OPEN", priority: "P2", scope: H.teamId ? "SHARED" : "SINGLE_OCCUPANT", ownerUserId: "u-1", teamId: H.teamId, closedAtUtc: null, closureReason: null, createdAt: iso, updatedAt: iso },
    viewer: { userId: "u-1", role: "MEMBER", canManage: false, canMutate: false, canLinkEvidence: false, disabledReasons: {} },
    risk: { status: "ok", data: null, sampledAtUtc: iso },
    sections: {
      commandSummary: ok({ data: { linkedEvidenceCount: 0, recentlyLinkedCount: 0, activeCaseHoldsCount: 0, affectedEvidenceHoldsCount: 0, pendingReviewCount: 0, openEscalationsCount: 0, activeAssignmentCount: 0 } }),
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
    assignments: [],
    statusHistory: [],
  };
}

function platformEnvelope(active: string): unknown {
  return {
    personalSpace: { status: "active", id: personalWs, label: "Personal Space", ownerUserId: "u-1", plan: null },
    workspace: { status: "active", id: active, name: active === orgWs ? "Northgate Claims" : "Personal Space", scope: null, workspaceKind: active === orgWs ? "ORGANIZATION" : "PERSONAL", plan: null, membership: {} },
    contextOptions: {
      personalSpace: { workspaceId: personalWs, name: "Personal Space", kind: "PERSONAL", role: "OWNER", lifecycleStatus: "active" },
      ownedWorkspaces: [],
      organizations: [{ organizationId: "o-1", organizationName: "Northgate", workspaces: [{ workspaceId: orgWs, workspaceName: "Northgate Claims", kind: "ORGANIZATION", workspaceRole: "MEMBER", lifecycleStatus: "active" }] }],
      activeContext: { workspaceId: active, kind: active === orgWs ? "ORGANIZATION" : "PERSONAL", organizationId: null, displayName: null },
    },
  };
}

beforeEach(() => {
  H.fetch.mockReset();
  H.fetch.mockImplementation(async (path: string) => {
    if (path === `/v1/cases/${caseId}/matter-workspace`) return envelope();
    if (path === `/v1/cases/${caseId}/evidence-requests`) return { requests: [], counts: { needsMoreInfo: 0 } };
    return {};
  });
});

async function crumb(): Promise<string> {
  render(<ToastProvider><MatterWorkspace caseId={caseId} /></ToastProvider>);
  const nav = await waitFor(() => {
    const el = document.querySelector("[data-simple-case-breadcrumb]");
    if (!el) throw new Error("breadcrumb not rendered");
    return el as HTMLElement;
  });
  expect(within(nav).getByRole("link", { name: "Cases" })).toBeTruthy();
  return (nav.firstElementChild as HTMLElement).textContent ?? "";
}

describe("D56 matter breadcrumb scope crumb", () => {
  it("D56 a workspace-owned case names its workspace, not Personal Space", async () => {
    H.teamId = orgWs;
    H.ctx = platformEnvelope(orgWs);
    expect(await crumb()).toBe("Northgate Claims");
    expect(screen.queryByText("Personal Space")).toBeNull();
  });

  it("D56 a Personal Space case (SHARED, personal Team id) reads Personal Space", async () => {
    H.teamId = personalWs;
    H.ctx = platformEnvelope(personalWs);
    expect(await crumb()).toBe("Personal Space");
  });

  it("D56 a case with no team reads Personal Space", async () => {
    H.teamId = null;
    H.ctx = platformEnvelope(personalWs);
    expect(await crumb()).toBe("Personal Space");
  });
});
