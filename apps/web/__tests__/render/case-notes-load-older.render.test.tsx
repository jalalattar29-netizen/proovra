/**
 * PRO-K1-07 — "Load older notes". The matter workspace sends the newest page of
 * case notes with `caseCommentsNextCursor`; both case pages offer a control
 * that follows GET /v1/cases/:id/comments?cursor= and append the older page,
 * until the API says there is none. A failed load says so and keeps what was
 * shown. Real `apiFetch` over a stubbed network.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const caseId = "c1000000-0000-4000-8000-000000000001";
const teamId = "44444444-4444-4444-8444-444444444444";

vi.mock("../../lib/platform-context", async (orig) => ({
  ...(await orig<typeof import("../../lib/platform-context")>()),
  usePlatformContext: () => ({ envelope: null }),
}));
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

import { MatterWorkspace } from "../../components/cases-experience/MatterWorkspace";
import { SimpleCaseDetail } from "../../components/cases-experience/simple-case-detail/SimpleCaseDetail";
import { ToastProvider } from "../../components/ui";

let notes: Record<string, unknown>;
const fetchMock = vi.fn();

function comments(from: number, to: number) {
  return Array.from({ length: to - from }, (_, k) => {
    const i = from + k;
    return {
      id: `n${i}`, authorUserId: "u-1", body: `note ${i}`, visibility: "INTERNAL",
      resolvedAtUtc: null, resolvedByUserId: null, createdAt: "2026-09-01T00:00:00.000Z",
    };
  });
}

function envelope(): unknown {
  const iso = "2026-09-01T00:00:00.000Z";
  const ok = <T,>(extra: T) => ({ status: "ok", ...extra });
  return {
    generatedAt: iso,
    case: { id: caseId, name: "Harbor claim", referenceNumber: null, description: null, status: "OPEN", priority: "P2", scope: "SHARED", ownerUserId: "u-1", teamId, closedAtUtc: null, closureReason: null, createdAt: iso, updatedAt: iso },
    viewer: {
      userId: "u-1", role: "OWNER", canManage: true, canMutate: true, canAssign: true, canChangeStatus: true,
      canLinkEvidence: true, canUnlinkEvidence: true, canUnlinkLegacyEvidence: true, canComment: true, canResolveComment: true,
      disabledReasons: {}, activeAssignmentRoles: [],
    },
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
      notes: ok({ unresolvedReviewerComments: [], unresolvedAnnotations: [], ...notes }),
      deliverables: ok({ reports: [], packages: [], externalReviewLinks: [], counts: { reportsReady: 0, packagesReady: 0, deliverablesPending: 0 } }),
    },
    assignments: [],
    statusHistory: [],
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let olderStatus = 200;
const olderCalls: string[] = [];

beforeEach(() => {
  notes = { caseComments: comments(0, 25), caseCommentsTotal: 31, caseCommentsTruncated: true, caseCommentsNextCursor: "cursor-page-2" };
  olderStatus = 200;
  olderCalls.length = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: unknown) => {
    const u = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (u === `/v1/cases/${caseId}/matter-workspace`) return json(200, envelope());
    if (u.includes("/discussion-threads")) return json(200, { threads: [], counts: { escalated: 0 } });
    if (u.startsWith(`/v1/cases/${caseId}/comments?`)) {
      olderCalls.push(u);
      if (olderStatus !== 200) return json(olderStatus, { error: { code: "INTERNAL", message: "boom" } });
      return json(200, { comments: comments(25, 31), nextCursor: null, hasMore: false });
    }
    return json(200, {});
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("PRO-K1-07 case notes: load older notes", () => {
  it("SimpleCaseDetail Notes: the control loads the older page and disappears at the end", async () => {
    window.history.replaceState(null, "", `/cases/${caseId}?tab=notes`);
    render(
      <ToastProvider>
        <SimpleCaseDetail caseId={caseId} onOpenEvidence={() => {}} />
      </ToastProvider>,
    );
    expect((await screen.findByRole("note")).textContent).toBe("Showing the newest 25 of 31 notes on this case.");
    expect(document.querySelectorAll("[data-simple-case-notes-item]")).toHaveLength(25);
    fireEvent.click(screen.getByRole("button", { name: "Load older notes" }));
    await waitFor(() => expect(document.querySelectorAll("[data-simple-case-notes-item]")).toHaveLength(31));
    expect(olderCalls).toEqual([`/v1/cases/${caseId}/comments?cursor=cursor-page-2`]);
    expect(document.querySelector("[data-simple-case-notes-item=\"n30\"]")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Load older notes" })).toBeNull();
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("MatterWorkspace Discussion: the control appends the older notes under the case total", async () => {
    window.history.replaceState(null, "", `/cases/${caseId}?tab=communications`);
    render(
      <ToastProvider>
        <MatterWorkspace caseId={caseId} />
      </ToastProvider>,
    );
    await screen.findByRole("heading", { name: /Case-level comments \(31\)/ });
    expect(screen.getAllByText(/^note \d+$/)).toHaveLength(25);
    fireEvent.click(screen.getByRole("button", { name: "Load older notes" }));
    await waitFor(() => expect(screen.getAllByText(/^note \d+$/)).toHaveLength(31));
    expect(screen.getByText("note 30")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load older notes" })).toBeNull();
    expect(document.querySelector("[data-matter-case-comments-truncated]")).toBeNull();
  });

  it("a failed load is stated, keeps the newest page, and leaves the control to retry", async () => {
    olderStatus = 500;
    window.history.replaceState(null, "", `/cases/${caseId}?tab=notes`);
    render(
      <ToastProvider>
        <SimpleCaseDetail caseId={caseId} onOpenEvidence={() => {}} />
      </ToastProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Load older notes" }));
    expect((await screen.findByRole("alert")).textContent).toBeTruthy();
    expect(document.querySelector("[data-simple-case-notes-load-older-error]")).not.toBeNull();
    expect(document.querySelectorAll("[data-simple-case-notes-item]")).toHaveLength(25);
    expect(screen.getByRole("button", { name: "Load older notes" })).toBeTruthy();
  });
});
