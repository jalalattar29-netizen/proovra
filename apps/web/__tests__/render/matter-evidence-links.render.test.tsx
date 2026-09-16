import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const caseId = "c1000000-0000-4000-8000-000000000001";
const teamId = "44444444-4444-4444-8444-444444444444";
const evA = "e0000000-0000-4000-8000-00000000000a";
const evB = "e0000000-0000-4000-8000-00000000000b";
const linkA = "10000000-0000-4000-8000-00000000000a";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), confirm: vi.fn() }));
vi.mock("../../lib/api", () => ({ apiFetch: mocks.fetch }));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: mocks.confirm }) }));
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
  usePathname: () => "/cases/c1000000-0000-4000-8000-000000000001",
  useParams: () => ({ id: "c1000000-0000-4000-8000-000000000001" }),
}));

import { MatterWorkspace } from "../../components/cases-experience/MatterWorkspace";
import { ToastProvider } from "../../components/ui";

type Row = Record<string, unknown> & { id: string; linkId: string | null; linkRole: string | null };
let server: {
  items: Row[];
  viewer: Record<string, unknown>;
  failLink: unknown;
  failUnlink: unknown;
  failReread: boolean;
  wrote: boolean;
  applyWrites: boolean;
};

function row(id: string, over: Partial<Row> = {}): Row {
  return {
    id, title: id === evA ? "Dashcam clip" : "Invoice scan", displayFileName: null, originalFileName: null, mimeType: null,
    itemCount: 1, type: "VIDEO", status: "SIGNED", verificationStatus: "RECORDED_INTEGRITY_VERIFIED", lifecycleState: "ACTIVE",
    createdAt: "2026-09-01T00:00:00.000Z", reportReady: false, packageReady: false, linkId: null, linkRole: null, linkSource: null, ...over,
  };
}

function envelope(): unknown {
  const iso = "2026-09-01T00:00:00.000Z";
  const ok = <T,>(extra: T) => ({ status: "ok", ...extra });
  return {
    generatedAt: iso,
    case: { id: caseId, name: "Harbor claim", referenceNumber: null, description: null, status: "OPEN", priority: "P2", scope: "TEAM", ownerUserId: "u-1", teamId, closedAtUtc: null, closureReason: null, createdAt: iso, updatedAt: iso },
    viewer: server.viewer,
    risk: { status: "ok", data: null, sampledAtUtc: iso },
    sections: {
      commandSummary: ok({ data: { linkedEvidenceCount: server.items.length, recentlyLinkedCount: 0, activeCaseHoldsCount: 0, affectedEvidenceHoldsCount: 0, pendingReviewCount: 0, openEscalationsCount: 0, activeAssignmentCount: 0 } }),
      evidence: ok({ items: server.items.map((r) => ({ ...r })) }),
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

const allowedViewer = {
  userId: "u-1", role: "MEMBER", canManage: false, canMutate: true, canAssign: false, canChangeStatus: false,
  canLinkEvidence: true, canUnlinkEvidence: true, canUnlinkLegacyEvidence: true, canComment: true, canResolveComment: false,
  disabledReasons: { assign: "Only case owners can assign." }, activeAssignmentRoles: ["INVESTIGATOR"],
};

async function route(path: string, init?: RequestInit): Promise<unknown> {
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  if (path === `/v1/cases/${caseId}/matter-workspace`) {
    if (server.wrote && server.failReread) throw { statusCode: 503 };
    return envelope();
  }
  if (path === `/v1/cases/${caseId}/evidence-requests`) return { requests: [], counts: { needsMoreInfo: 0 } };
  if (path.startsWith(`/v1/cases/${caseId}/linkable-evidence?`)) {
    return { items: [
      { id: evA, title: "Dashcam clip", type: "VIDEO", status: "SIGNED", verificationStatus: null, lifecycleState: "ACTIVE", createdAt: "2026-09-01T00:00:00.000Z", reportReady: false, packageReady: false, alreadyLinked: server.items.some((r) => r.id === evA), existingLinkRole: server.items.find((r) => r.id === evA)?.linkRole ?? null },
      { id: evB, title: "Invoice scan", type: "DOCUMENT", status: "SIGNED", verificationStatus: null, lifecycleState: "ACTIVE", createdAt: "2026-09-01T00:00:00.000Z", reportReady: false, packageReady: false, alreadyLinked: false, existingLinkRole: null },
    ], nextCursor: null };
  }
  if (method === "POST" && path === `/v1/cases/${caseId}/evidence-links`) {
    if (server.failLink) throw server.failLink;
    server.wrote = true;
    if (server.applyWrites) server.items = [...server.items, row(body.evidenceId, { linkId: "10000000-0000-4000-8000-0000000000bb", linkRole: body.role ?? "SUPPORTING" })];
    return { link: { id: "l" } };
  }
  if (method === "DELETE" && path.startsWith(`/v1/cases/${caseId}/evidence-links/`)) {
    if (server.failUnlink) throw server.failUnlink;
    server.wrote = true;
    const linkId = path.split("/").pop();
    if (server.applyWrites) server.items = server.items.filter((r) => r.linkId !== linkId);
    return { ok: true };
  }
  throw new Error("unexpected " + method + " " + path);
}

beforeEach(() => {
  server = { items: [], viewer: allowedViewer, failLink: null, failUnlink: null, failReread: false, wrote: false, applyWrites: true };
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(route);
  mocks.confirm.mockReset();
  mocks.confirm.mockResolvedValue(true);
});

const linkWrites = () => mocks.fetch.mock.calls.filter(([p, init]) => init?.method === "POST" && String(p).endsWith("/evidence-links"));
const unlinkWrites = () => mocks.fetch.mock.calls.filter(([, init]) => init?.method === "DELETE");
const dialog = () => document.querySelector("[data-matter-modal='evidence-link-modal']") as HTMLElement | null;
const describedBy = (el: Element) => document.getElementById(el.getAttribute("aria-describedby")!)?.textContent;

async function mount() {
  render(<ToastProvider><MatterWorkspace caseId={caseId} /></ToastProvider>);
  await screen.findByRole("heading", { name: "Harbor claim" });
}

async function openFromHeader() {
  const add = screen.getAllByRole("button").find((b) => (b.textContent ?? "").trim() === "Add evidence")!;
  expect(add).toBeTruthy();
  fireEvent.click(add);
  await screen.findByRole("dialog");
}

async function chooseRow(title: string) {
  const dlg = await screen.findByRole("dialog");
  const option = await within(dlg).findByRole("option", { name: new RegExp(title) });
  fireEvent.click(option);
  return dlg;
}

describe("matter workspace evidence links", () => {
  it("Add evidence opens the link picker and links with the chosen role after rereading the matter", async () => {
    await mount();
    await openFromHeader();
    const dlg = await chooseRow("Invoice scan");
    const role = dlg.querySelector("[data-matter-evidence-link-role]") as HTMLSelectElement;
    expect(role.value).toBe("SUPPORTING");
    expect(within(dlg).getByRole("option", { name: "Supporting evidence" })).toBeTruthy();
    fireEvent.change(role, { target: { value: "PRIMARY" } });
    fireEvent.change(dlg.querySelector("[data-matter-evidence-link-reason]")!, { target: { value: "Shows the invoice date." } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Link evidence" }));
    await screen.findByText("Evidence linked as primary. The matter was reloaded.");
    const calls = mocks.fetch.mock.calls;
    const write = calls.findIndex(([, init]) => init?.method === "POST");
    expect(JSON.parse(calls[write][1].body)).toEqual({ evidenceId: evB, role: "PRIMARY", reason: "Shows the invoice date." });
    expect(calls.slice(write + 1).some(([p]) => p === `/v1/cases/${caseId}/matter-workspace`)).toBe(true);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const table = await screen.findByRole("grid");
    expect(within(table).getByText("Invoice scan")).toBeTruthy();
    expect(within(table).getByText("Primary")).toBeTruthy();
  });

  it("omits an empty reason, which the route would reject", async () => {
    await mount();
    await openFromHeader();
    const dlg = await chooseRow("Invoice scan");
    fireEvent.click(within(dlg).getByRole("button", { name: "Link evidence" }));
    await screen.findByText("Evidence linked as supporting. The matter was reloaded.");
    expect(JSON.parse(String(linkWrites()[0]![1].body))).toEqual({ evidenceId: evB, role: "SUPPORTING" });
  });

  it("states why linking is unavailable: nothing selected, or already linked", async () => {
    server.items = [row(evA, { linkId: linkA, linkRole: "PRIMARY" })];
    await mount();
    await openFromHeader();
    const dlg = await screen.findByRole("dialog");
    const submit = within(dlg).getByRole("button", { name: "Link evidence" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    expect(describedBy(submit)).toBe("Select the evidence to link.");
    await chooseRow("Dashcam clip");
    expect(within(dlg).getByText(/Already linked \(primary evidence\)/)).toBeTruthy();
    expect(describedBy(submit)).toBe("This evidence is already linked to the matter.");
    expect(linkWrites()).toHaveLength(0);
  });

  it("cancelling the picker makes no write", async () => {
    await mount();
    await openFromHeader();
    const dlg = await chooseRow("Invoice scan");
    fireEvent.click(within(dlg).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(linkWrites()).toHaveLength(0);
  });

  it("disables linking with the server's reason when the viewer may not link", async () => {
    server.viewer = { ...allowedViewer, canLinkEvidence: false, canUnlinkEvidence: false, disabledReasons: { linkEvidence: "Only assigned investigators can link evidence.", unlinkEvidence: "Only assigned investigators can link evidence." } };
    server.items = [row(evA, { linkId: linkA, linkRole: "PRIMARY" })];
    await mount();
    fireEvent.click(screen.getByRole("tab", { name: /Evidence/ }));
    const link = await screen.findByRole("button", { name: "Link evidence" });
    expect(link.hasAttribute("disabled")).toBe(true);
    expect(describedBy(link)).toBe("Only assigned investigators can link evidence.");
    const unlink = screen.getByRole("button", { name: "Unlink Dashcam clip" });
    expect(unlink.hasAttribute("disabled")).toBe(true);
    expect(describedBy(unlink)).toBe("Only assigned investigators can link evidence.");
    const add = screen.getAllByRole("button").find((b) => (b.textContent ?? "").trim() === "Add evidence")!;
    expect(add.hasAttribute("disabled")).toBe(true);
  });

  it("maps a refused link without claiming success and keeps the picker open", async () => {
    server.failLink = { statusCode: 409, code: "evidence_link_exists" };
    await mount();
    await openFromHeader();
    const dlg = await chooseRow("Invoice scan");
    fireEvent.click(within(dlg).getByRole("button", { name: "Link evidence" }));
    await screen.findByText("This evidence is already linked to the matter.", { selector: "[role='alert']" });
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.queryByText(/The matter was reloaded/)).toBeNull();
  });

  it("does not claim success when the confirming reread fails", async () => {
    server.failReread = true;
    await mount();
    await openFromHeader();
    const dlg = await chooseRow("Invoice scan");
    fireEvent.click(within(dlg).getByRole("button", { name: "Link evidence" }));
    await screen.findByText(/could not be reloaded to confirm it/);
    expect(screen.queryByText(/The matter was reloaded/)).toBeNull();
  });

  it("unlinks a row after a danger confirmation that says the record is kept, then rereads", async () => {
    server.items = [row(evA, { linkId: linkA, linkRole: "PRIMARY" })];
    await mount();
    fireEvent.click(screen.getByRole("tab", { name: /Evidence/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Unlink Dashcam clip" }));
    await screen.findByText("Evidence unlinked from the matter. The matter was reloaded.");
    const request = mocks.confirm.mock.calls[0]![0];
    expect(request).toEqual(expect.objectContaining({ title: "Unlink this evidence from the matter?", tone: "danger" }));
    expect(request.description).toMatch(/evidence record itself.*kept/);
    const calls = mocks.fetch.mock.calls;
    const write = calls.findIndex(([, init]) => init?.method === "DELETE");
    expect(calls[write][0]).toBe(`/v1/cases/${caseId}/evidence-links/${linkA}`);
    expect(calls.slice(write + 1).some(([p]) => p === `/v1/cases/${caseId}/matter-workspace`)).toBe(true);
    expect(screen.queryByRole("button", { name: "Unlink Dashcam clip" })).toBeNull();
  });

  it("cancelling the unlink confirmation makes no write", async () => {
    mocks.confirm.mockResolvedValue(false);
    server.items = [row(evA, { linkId: linkA, linkRole: "PRIMARY" })];
    await mount();
    fireEvent.click(screen.getByRole("tab", { name: /Evidence/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Unlink Dashcam clip" }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(unlinkWrites()).toHaveLength(0);
  });

  it("does not claim an unlink the reread does not show", async () => {
    server.applyWrites = false;
    server.items = [row(evA, { linkId: linkA, linkRole: "PRIMARY" })];
    await mount();
    fireEvent.click(screen.getByRole("tab", { name: /Evidence/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Unlink Dashcam clip" }));
    await screen.findByText(/still lists the evidence/);
    expect(screen.queryByText("Evidence unlinked from the matter. The matter was reloaded.")).toBeNull();
  });

  it("reports a refused unlink without claiming success", async () => {
    server.failUnlink = { statusCode: 403, code: "FORBIDDEN" };
    server.items = [row(evA, { linkId: linkA, linkRole: "PRIMARY" })];
    await mount();
    fireEvent.click(screen.getByRole("tab", { name: /Evidence/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Unlink Dashcam clip" }));
    await waitFor(() => expect(document.querySelector("[data-matter-evidence-link-feedback] [role='alert']")).toBeTruthy());
    expect(screen.queryByText("Evidence unlinked from the matter. The matter was reloaded.")).toBeNull();
  });

  it("a failed picker read is an error, never 'no matches'", async () => {
    mocks.fetch.mockImplementation(async (p: string, init?: RequestInit) => {
      if (p.includes("/linkable-evidence")) throw { statusCode: 403, code: "FORBIDDEN" };
      return route(p, init);
    });
    await mount();
    await openFromHeader();
    await waitFor(() => expect(document.querySelector("[data-matter-evidence-link-error]")).toBeTruthy());
    expect(screen.queryByText("No evidence matches the search.")).toBeNull();
    expect(dialog()).toBeTruthy();
  });
});
