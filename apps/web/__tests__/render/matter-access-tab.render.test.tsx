import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const caseId = "c2000000-0000-4000-8000-000000000001";
const teamId = "55555555-5555-4555-8555-555555555555";
const ownerId = "u0000000-0000-4000-8000-000000000001";
const adminId = "u0000000-0000-4000-8000-000000000002";
const aliceId = "u0000000-0000-4000-8000-00000000000a";
const bobId = "u0000000-0000-4000-8000-00000000000b";
const grantA = "a0000000-0000-4000-8000-00000000000a";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), confirm: vi.fn() }));
vi.mock("../../lib/api", () => ({ apiFetch: mocks.fetch }));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: mocks.confirm }) }));
vi.mock("../../components/presence/PresenceIndicator", () => ({ PresenceIndicator: () => null }));
vi.mock("../../components/collaboration/TeamResponsibilityPanel", () => ({ TeamResponsibilityPanel: () => null }));
vi.mock("../../components/hidden-feature-panels/HiddenFeaturePanels", () => ({ CaseRiskPanel: () => null }));
vi.mock("../../components/governance/GovernanceSummary", () => ({ GovernanceSummary: () => null }));
vi.mock("../../app/(app)/cases/components/SiuPanel", () => ({ SiuPanel: () => null }));
vi.mock("../../app/(app)/cases/components/SiuWorklistPanel", () => ({ SiuWorklistPanel: () => null }));
// The member picker has its own coverage; here it is a plain select over the
// same ACTIVE members so the tab's grant flow can be driven.
vi.mock("../../app/(app)/evidence/[id]/components/WorkspaceMemberSelect", () => ({
  WorkspaceMemberSelect: ({ value, onChange, label, disabled }: {
    value: string | null;
    onChange: (m: { userId: string; label: string; role: string }) => void;
    label: string;
    disabled?: boolean;
  }) => (
    <label>
      {label}
      <select
        data-test-member-select
        value={value ?? ""}
        disabled={disabled}
        onChange={(e) => {
          const pick = { [aliceId]: "Alice Analyst", [bobId]: "Bob Reviewer" }[e.target.value];
          if (pick) onChange({ userId: e.target.value, label: pick, role: "MEMBER" });
        }}
      >
        <option value="">Choose</option>
        <option value={aliceId}>Alice Analyst</option>
        <option value={bobId}>Bob Reviewer</option>
      </select>
    </label>
  ),
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/cases/c2000000-0000-4000-8000-000000000001",
  useParams: () => ({ id: "c2000000-0000-4000-8000-000000000001" }),
}));

import { MatterWorkspace } from "../../components/cases-experience/MatterWorkspace";
import { ToastProvider } from "../../components/ui";

type Grant = { id: string; userId: string; createdAt: string; user: { id: string; email: string | null; displayName: string | null } };
const people: Record<string, { email: string; displayName: string }> = {
  [aliceId]: { email: "alice@example.test", displayName: "Alice Analyst" },
  [bobId]: { email: "bob@example.test", displayName: "Bob Reviewer" },
};
const grantFor = (id: string, userId: string): Grant => ({
  id, userId, createdAt: "2026-09-01T00:00:00.000Z", user: { id: userId, ...people[userId] },
});

let server: {
  grants: Grant[];
  viewer: Record<string, unknown>;
  holdGrantRead: boolean;
  failGrantRead: unknown;
  failGrant: unknown;
  failMembers: unknown;
};

const manager = {
  userId: adminId, role: "ADMIN", canManage: true, canAssign: true, canLinkEvidence: true, canUnlinkEvidence: true,
  canManageAccess: true, disabledReasons: {}, activeAssignmentRoles: [],
};
const plainMember = {
  userId: aliceId, role: "MEMBER", canManage: false, canAssign: false, canLinkEvidence: true, canUnlinkEvidence: true,
  canManageAccess: false,
  disabledReasons: {
    assign: "Owner or Admin workspace role (or case OWNER assignment) is required to manage assignments.",
    manageAccess: "Only a workspace Owner or Admin, or the case owner, can change who has access to this case.",
  },
  activeAssignmentRoles: [],
};

function envelope(): unknown {
  const iso = "2026-09-01T00:00:00.000Z";
  const ok = <T,>(extra: T) => ({ status: "ok", ...extra });
  return {
    generatedAt: iso,
    // The server's scope vocabulary (matter-workspace.service.ts).
    case: { id: caseId, name: "Harbor claim", referenceNumber: null, description: null, status: "OPEN", priority: "P2", scope: "SHARED", ownerUserId: ownerId, teamId, closedAtUtc: null, closureReason: null, createdAt: iso, updatedAt: iso },
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

async function route(path: string, init?: RequestInit): Promise<unknown> {
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  if (path === `/v1/cases/${caseId}/matter-workspace`) return envelope();
  if (method === "GET" && path === `/v1/cases/${caseId}`) {
    if (server.holdGrantRead) return new Promise(() => {});
    if (server.failGrantRead) throw server.failGrantRead;
    return { case: { id: caseId, ownerUserId: ownerId, access: server.grants.map((g) => ({ ...g })) } };
  }
  if (method === "GET" && path === `/v1/cases/${caseId}/team-members`) {
    if (server.failMembers) throw server.failMembers;
    return { items: [
      { userId: ownerId, email: "owner@example.test", displayName: "Olivia Owner", label: "Olivia Owner", role: "OWNER" },
      { userId: aliceId, email: "alice@example.test", displayName: "Alice Analyst", label: "Alice Analyst", role: "MEMBER" },
    ] };
  }
  if (method === "POST" && path === `/v1/cases/${caseId}/access`) {
    if (server.failGrant) throw server.failGrant;
    const g = grantFor(`b0000000-0000-4000-8000-${String(server.grants.length).padStart(12, "0")}`, body.userId);
    server.grants = [...server.grants, g];
    return { access: g };
  }
  if (method === "DELETE" && path.startsWith(`/v1/cases/${caseId}/access/`)) {
    const id = path.split("/").pop();
    server.grants = server.grants.filter((g) => g.id !== id);
    return undefined;
  }
  throw new Error("unexpected " + method + " " + path);
}

beforeEach(() => {
  server = { grants: [], viewer: manager, holdGrantRead: false, failGrantRead: null, failGrant: null, failMembers: null };
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(route);
  mocks.confirm.mockReset();
  mocks.confirm.mockResolvedValue(true);
});

const writes = (method: string) => mocks.fetch.mock.calls.filter(([, init]) => init?.method === method);
const describedBy = (el: Element) => document.getElementById(el.getAttribute("aria-describedby")!)?.textContent;
const panel = () => document.querySelector("[data-matter-access-tab]") as HTMLElement;

async function openAccessTab() {
  render(<ToastProvider><MatterWorkspace caseId={caseId} /></ToastProvider>);
  await screen.findByRole("heading", { name: "Harbor claim" });
  fireEvent.click(screen.getByRole("tab", { name: "Access" }));
  await waitFor(() => expect(panel()).toBeTruthy());
}

describe("matter workspace Access tab", () => {
  it("shows a loading state while the access list is read", async () => {
    server.holdGrantRead = true;
    await openAccessTab();
    expect(within(panel()).getByText("Loading who has access…")).toBeTruthy();
    const give = within(panel()).getByRole("button", { name: "Give access" });
    expect(give.hasAttribute("disabled")).toBe(true);
    expect(describedBy(give)).toBe("Wait for the current access list to load.");
  });

  it("empty: says the case is open to the whole workspace and lists the active members", async () => {
    await openAccessTab();
    expect(await within(panel()).findByText("Open to the whole workspace")).toBeTruthy();
    const members = panel().querySelector("[data-matter-access-members]") as HTMLElement;
    expect(await within(members).findByText("Olivia Owner")).toBeTruthy();
    expect(within(members).getByText("Alice Analyst")).toBeTruthy();
    expect(within(members).getByText(/Owner/, { selector: "small" })).toBeTruthy();
    expect(within(panel()).queryByRole("button", { name: "Remove access" })).toBeNull();
    const give = within(panel()).getByRole("button", { name: "Give access" });
    expect(describedBy(give)).toBe("Choose a workspace member first.");
  });

  it("list: shows each individual grant with a remove control for a manager", async () => {
    server.grants = [grantFor(grantA, aliceId)];
    await openAccessTab();
    const row = await waitFor(() => {
      const el = panel().querySelector(`[data-matter-access-grant="${grantA}"]`) as HTMLElement | null;
      expect(el).toBeTruthy();
      return el!;
    });
    expect(within(row).getByText("Alice Analyst")).toBeTruthy();
    expect(within(row).getByText(/alice@example\.test/)).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Remove access" })).toBeTruthy();
    expect(within(panel()).getByText("Only the case owner and the people below can open this case.")).toBeTruthy();
    // The workspace-wide member list only describes an unrestricted case.
    expect(panel().querySelector("[data-matter-access-members]")).toBeNull();
  });

  it("grant: the first grant is confirmed as a restriction, posted, and announced only after the reread shows it", async () => {
    await openAccessTab();
    await within(panel()).findByText("Open to the whole workspace");
    fireEvent.change(panel().querySelector("[data-test-member-select]")!, { target: { value: bobId } });
    fireEvent.click(within(panel()).getByRole("button", { name: "Give access" }));
    await within(panel()).findByText("Bob Reviewer now has access to this case. The list was reloaded.");

    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    const opts = mocks.confirm.mock.calls[0][0];
    expect(opts.tone).toBe("warning");
    expect(opts.description).toMatch(/only the case owner and the people listed here can open it/);
    // The viewer is an ADMIN, not the case owner: told they lose access.
    expect(opts.description).toMatch(/you will no longer be able to open this case/);

    const posts = writes("POST");
    expect(posts).toHaveLength(1);
    expect(posts[0][0]).toBe(`/v1/cases/${caseId}/access`);
    expect(JSON.parse(String(posts[0][1].body))).toEqual({ userId: bobId });
    const postIndex = mocks.fetch.mock.calls.indexOf(posts[0]);
    expect(mocks.fetch.mock.calls.slice(postIndex + 1).some(([p, i]) => p === `/v1/cases/${caseId}` && (i?.method ?? "GET") === "GET")).toBe(true);
    expect(panel().querySelector("[data-matter-access-grants]")?.textContent).toMatch(/Bob Reviewer/);
  });

  it("grant: a cancelled restriction confirm writes nothing, and the next attempt asks again", async () => {
    mocks.confirm.mockResolvedValueOnce(false);
    await openAccessTab();
    await within(panel()).findByText("Open to the whole workspace");
    fireEvent.change(panel().querySelector("[data-test-member-select]")!, { target: { value: bobId } });
    fireEvent.click(within(panel()).getByRole("button", { name: "Give access" }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    expect(writes("POST")).toHaveLength(0);

    fireEvent.click(within(panel()).getByRole("button", { name: "Give access" }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(2));
    await within(panel()).findByText(/Bob Reviewer now has access/);
    expect(writes("POST")).toHaveLength(1);
  });

  it("revoke: asks first, names the reopening on the last grant, and makes no write when cancelled", async () => {
    server.grants = [grantFor(grantA, aliceId)];
    mocks.confirm.mockResolvedValueOnce(false);
    await openAccessTab();
    const remove = await within(panel()).findByRole("button", { name: "Remove access" });
    fireEvent.click(remove);
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    const opts = mocks.confirm.mock.calls[0][0];
    expect(opts.tone).toBe("danger");
    expect(opts.title).toBe("Remove Alice Analyst's access?");
    expect(opts.description).toMatch(/every active member of the workspace will be able to open the case again/);
    expect(writes("DELETE")).toHaveLength(0);

    fireEvent.click(within(panel()).getByRole("button", { name: "Remove access" }));
    await within(panel()).findByText("Alice Analyst no longer has individual access. The list was reloaded.");
    const dels = writes("DELETE");
    expect(dels).toHaveLength(1);
    expect(dels[0][0]).toBe(`/v1/cases/${caseId}/access/${grantA}`);
    expect(within(panel()).getByText("Open to the whole workspace")).toBeTruthy();
  });

  it("permission: a non-manager sees the list, no remove control, and the server's reason on a disabled grant", async () => {
    server.viewer = plainMember;
    server.grants = [grantFor(grantA, aliceId)];
    await openAccessTab();
    await waitFor(() => expect(panel().querySelector(`[data-matter-access-grant="${grantA}"]`)).toBeTruthy());
    expect(within(panel()).queryByRole("button", { name: "Remove access" })).toBeNull();
    expect(panel().querySelector("[data-test-member-select]")).toBeNull();
    const give = within(panel()).getByRole("button", { name: "Give access" });
    expect(give.hasAttribute("disabled")).toBe(true);
    const reason = "Only a workspace Owner or Admin, or the case owner, can change who has access to this case.";
    expect(describedBy(give)).toBe(reason);
    // Visible text, not only a hover title.
    expect(within(panel()).getByText(reason)).toBeTruthy();
    // The manager-only member read is never attempted.
    expect(mocks.fetch.mock.calls.some(([p]) => String(p).endsWith("/team-members"))).toBe(false);
  });

  it("server error: a failed list read is an error with a retry, never an empty list", async () => {
    server.failGrantRead = { statusCode: 503 };
    await openAccessTab();
    const alert = await waitFor(() => {
      const el = panel().querySelector("[data-matter-access-error]") as HTMLElement | null;
      expect(el).toBeTruthy();
      return el!;
    });
    expect(alert.getAttribute("role")).toBe("alert");
    expect(within(panel()).queryByText("Open to the whole workspace")).toBeNull();
    server.failGrantRead = null;
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await within(panel()).findByText("Open to the whole workspace")).toBeTruthy();
  });

  it("server error: a refused grant shows the safe message for its code and claims nothing", async () => {
    server.failGrant = { statusCode: 400, code: "CASE_ACCESS_TARGET_NOT_MEMBER", message: "User is not in this team" };
    server.grants = [grantFor(grantA, aliceId)];
    await openAccessTab();
    await within(panel()).findByRole("button", { name: "Remove access" });
    fireEvent.change(panel().querySelector("[data-test-member-select]")!, { target: { value: bobId } });
    fireEvent.click(within(panel()).getByRole("button", { name: "Give access" }));
    const alert = await within(panel()).findByText(
      "Only active members of the workspace that owns this case can be given access to it.",
      { selector: "[role='alert']" },
    );
    expect(alert).toBeTruthy();
    expect(within(panel()).queryByText(/now has access/)).toBeNull();
    expect(within(panel()).queryByText("User is not in this team")).toBeNull();
    // A restricted case is not re-confirmed as a restriction.
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it("server error: a failed member read is stated as a failure", async () => {
    server.failMembers = { statusCode: 500 };
    await openAccessTab();
    await within(panel()).findByText("Open to the whole workspace");
    const section = panel().querySelector("[data-matter-access-members]") as HTMLElement;
    await waitFor(() => expect(within(section).getByRole("alert")).toBeTruthy());
    expect(within(section).queryByText("This workspace has no active members.")).toBeNull();
  });
});

describe("matter workspace Assignments tab (D37)", () => {
  it("the header Add evidence button shows its disabled reason as visible text", async () => {
    const reason = "Only assigned investigators can link evidence.";
    server.viewer = { ...plainMember, canLinkEvidence: false, disabledReasons: { ...plainMember.disabledReasons, linkEvidence: reason } };
    render(<ToastProvider><MatterWorkspace caseId={caseId} /></ToastProvider>);
    await screen.findByRole("heading", { name: "Harbor claim" });
    const add = document.querySelector("[data-simple-case-action='add-evidence']") as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(describedBy(add)).toBe(reason);
    const hint = document.getElementById(add.getAttribute("aria-describedby")!)!;
    expect(hint.className).toBe("app-hint");
    expect(hint.closest("header")).toBeTruthy();
  });

  it("enables assignment for an allowed viewer on a workspace case", async () => {
    render(<ToastProvider><MatterWorkspace caseId={caseId} /></ToastProvider>);
    await screen.findByRole("heading", { name: "Harbor claim" });
    fireEvent.click(screen.getByRole("tab", { name: "Assignments" }));
    const add = await waitFor(() => document.querySelector("[data-matter-assignments-add]") as HTMLButtonElement);
    expect(add.disabled).toBe(false);
  });

  it("shows the server's assign reason as visible text", async () => {
    server.viewer = plainMember;
    render(<ToastProvider><MatterWorkspace caseId={caseId} /></ToastProvider>);
    await screen.findByRole("heading", { name: "Harbor claim" });
    fireEvent.click(screen.getByRole("tab", { name: "Assignments" }));
    const add = await waitFor(() => document.querySelector("[data-matter-assignments-add]") as HTMLButtonElement);
    expect(add.disabled).toBe(true);
    const reason = "Owner or Admin workspace role (or case OWNER assignment) is required to manage assignments.";
    expect(describedBy(add)).toBe(reason);
    expect(screen.getByText(reason)).toBeTruthy();
  });
});
