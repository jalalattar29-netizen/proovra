/**
 * PRO-K1-09 — the Enterprise case page (MatterWorkspace) offers rename and
 * status change, and the cases row menu's Rename / Change status open it on
 * both branches. Real `apiFetch` over a stubbed network.
 *
 * Acceptance: positive — Rename opens Settings with the name field focused in
 * both branches and the rename / status change are written and re-read;
 * refusal — a viewer whose per-case projection allows none of the actions has
 * no Settings tab, and a VIEWER (read-only list) sees neither menu item.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const nav = vi.hoisted(() => ({ push: vi.fn() }));
const caseId = "c1000000-0000-4000-8000-000000000001";
const teamId = "44444444-4444-4444-8444-444444444444";

vi.mock("../../lib/platform-context", async (orig) => ({
  ...(await orig<typeof import("../../lib/platform-context")>()),
  usePlatformContext: () => ({ envelope: null }),
}));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: async () => true }) }));
vi.mock("../../components/identity-security/StepUpModal", () => ({
  StepUpModal: () => null,
  useStepUpAction: () => ({ runStepUpAction: async (fn: (h?: Record<string, string>) => Promise<unknown>) => fn() }),
}));
vi.mock("../../components/presence/PresenceIndicator", () => ({ PresenceIndicator: () => null }));
vi.mock("../../components/collaboration/TeamResponsibilityPanel", () => ({ TeamResponsibilityPanel: () => null }));
vi.mock("../../components/hidden-feature-panels/HiddenFeaturePanels", () => ({ CaseRiskPanel: () => null }));
vi.mock("../../components/governance/GovernanceSummary", () => ({ GovernanceSummary: () => null }));
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
  useRouter: () => ({ push: nav.push, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => `/cases/${caseId}`,
  useParams: () => ({ id: caseId }),
}));

import { MatterWorkspace } from "../../components/cases-experience/MatterWorkspace";
import { ToastProvider } from "../../components/ui";

let server: { name: string; status: string; viewer: Record<string, unknown> };
const fetchMock = vi.fn();

const ownerViewer = {
  userId: "u-1", role: "ADMIN", canManage: true, canMutate: true, canAssign: true, canChangeStatus: true,
  canLinkEvidence: true, canUnlinkEvidence: true, canUnlinkLegacyEvidence: true, canComment: true, canResolveComment: true,
  canRename: true, canDelete: true, canManageAccess: true, disabledReasons: {}, activeAssignmentRoles: [],
};
const readerViewer = {
  userId: "u-2", role: "VIEWER", canManage: false, canMutate: false, canAssign: false, canChangeStatus: false,
  canLinkEvidence: false, canUnlinkEvidence: false, canUnlinkLegacyEvidence: false, canComment: false, canResolveComment: false,
  canRename: false, canDelete: false, canManageAccess: false,
  disabledReasons: { rename: "Only a workspace owner or admin can rename this case." }, activeAssignmentRoles: [],
};

function envelope(): unknown {
  const iso = "2026-09-01T00:00:00.000Z";
  const ok = <T,>(extra: T) => ({ status: "ok", ...extra });
  return {
    generatedAt: iso,
    case: { id: caseId, name: server.name, referenceNumber: null, description: null, status: server.status, priority: "P2", scope: "SHARED", ownerUserId: "u-1", teamId, closedAtUtc: null, closureReason: null, createdAt: iso, updatedAt: iso },
    viewer: server.viewer,
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

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  server = { name: "Harbor claim", status: "OPEN", viewer: ownerViewer };
  nav.push.mockReset();
  window.history.replaceState(null, "", `/cases/${caseId}`);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
    const u = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (u === `/v1/cases/${caseId}/matter-workspace`) return json(200, envelope());
    if (method === "PATCH" && u === `/v1/cases/${caseId}`) {
      server.name = body.name;
      return json(200, { case: { id: caseId, name: body.name } });
    }
    if (method === "POST" && u === `/v1/cases/${caseId}/status`) {
      server.status = body.toStatus;
      return json(200, { ok: true });
    }
    return json(200, {});
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const writes = () => fetchMock.mock.calls.filter(([, init]) => ((init as RequestInit)?.method ?? "GET") !== "GET");

async function mount() {
  render(
    <ToastProvider>
      <MatterWorkspace caseId={caseId} />
    </ToastProvider>,
  );
  await screen.findByRole("heading", { name: server.name });
}

describe("PRO-K1-09 Enterprise case Settings", () => {
  it("the row menu's Rename deep link opens Settings with the name field focused, and the rename is written and re-read", async () => {
    window.history.replaceState(null, "", `/cases/${caseId}?tab=settings&focus=name`);
    await mount();
    const input = (await screen.findByLabelText("Case name")) as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.change(input, { target: { value: "Harbor claim (renamed)" } });
    const panel = document.querySelector("[data-simple-case-settings-rename]") as HTMLElement;
    fireEvent.click(within(panel).getByRole("button", { name: "Save" }));
    await screen.findByRole("heading", { name: "Harbor claim (renamed)" });
    const patch = writes().find(([, init]) => (init as RequestInit).method === "PATCH");
    expect(JSON.parse(String((patch![1] as RequestInit).body))).toEqual({ name: "Harbor claim (renamed)" });
    // Access stays on its own tab here; Settings does not repeat it.
    expect(document.querySelector("[data-simple-case-settings-access]")).toBeNull();
  });

  it("Change status opens Settings, and a confirmed status change is written and re-read", async () => {
    window.history.replaceState(null, "", `/cases/${caseId}?tab=settings`);
    await mount();
    await screen.findByLabelText("Case name");
    const tab = screen.getByRole("tab", { name: "Settings" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    // Not focused without focus=name.
    expect(document.activeElement).not.toBe(screen.getByLabelText("Case name"));
    const trigger = within(document.querySelector("[data-simple-case-settings-status-select]") as HTMLElement).getByRole("button");
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("option", { name: /Closed/ }));
    await waitFor(() => expect(writes().some(([u]) => String(u).endsWith(`/v1/cases/${caseId}/status`))).toBe(true));
    const post = writes().find(([u]) => String(u).endsWith("/status"));
    expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({ toStatus: "CLOSED" });
    await waitFor(() =>
      expect(document.querySelector("[data-simple-case-settings-status-current]")?.getAttribute("data-simple-case-settings-status-current")).toBe("CLOSED"),
    );
  });

  it("a viewer the server allows none of the actions has no Settings tab, even when deep-linked", async () => {
    server.viewer = readerViewer;
    window.history.replaceState(null, "", `/cases/${caseId}?tab=settings&focus=name`);
    await mount();
    expect(screen.queryByRole("tab", { name: "Settings" })).toBeNull();
    expect(screen.queryByLabelText("Case name")).toBeNull();
    expect(writes()).toHaveLength(0);
  });
});
