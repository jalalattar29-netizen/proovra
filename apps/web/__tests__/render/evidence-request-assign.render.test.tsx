import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const requestId = "11111111-1111-4111-8111-111111111111";
const teamId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const dana = "22222222-2222-4222-8222-222222222222";
const sam = "33333333-3333-4333-8333-333333333333";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), confirm: vi.fn(), eventsMounts: 0 }));
vi.mock("../../lib/api", () => ({ apiFetch: mocks.fetch }));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: mocks.confirm }) }));
vi.mock("../../components/navigation/PageRouteGate", () => ({ PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("../../components/navigation/OperationalBreadcrumb", () => ({ OperationalBreadcrumb: () => null }));
vi.mock("../../components/notifications/ContextualDeliveryStatus", () => ({ ContextualDeliveryStatus: () => null }));
vi.mock("../../components/hidden-feature-panels/HiddenFeaturePanels", () => ({
  EvidenceRequestEventsTab: () => {
    React.useEffect(() => { mocks.eventsMounts += 1; }, []);
    return null;
  },
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "11111111-1111-4111-8111-111111111111" }),
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
}));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

import EvidenceRequestInspectorPage from "../../app/(app)/evidence-requests/[id]/page";

type Req = Record<string, unknown> & { status: string; recipientMode: string; assignedReviewerUserId: string | null };
let server: { request: Req; failAssign: unknown; failReread: boolean; wrote: boolean; applyWrites: boolean };

function makeRequest(over: Partial<Req> = {}): Req {
  return {
    id: requestId, teamId, evidenceId: null, caseId: null, workflowTemplateSlug: null, workflowStepId: null,
    requestType: "DOCUMENT_REQUEST", status: "DRAFT", priority: "NORMAL", title: "Bank statements", instructions: "",
    dueAtUtc: null, recipientMode: "INTERNAL_USER", recipientLabel: null, requestedByUserId: dana,
    assignedReviewerUserId: null, intakeLinkId: null, reviewerNote: null, sentAtUtc: null, firstOpenedAtUtc: null,
    closedAtUtc: null, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
    deliverables: [], responses: [], ...over,
  };
}

async function route(path: string, init?: RequestInit): Promise<unknown> {
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  if (path.startsWith(`/v1/teams/${teamId}/members?`)) {
    return { members: [
      { userId: dana, label: "Dana Reyes", role: "ADMIN", status: "ACTIVE" },
      { userId: sam, label: "Sam Ortiz", role: "MEMBER", status: "ACTIVE" },
    ], nextCursor: null };
  }
  if (method === "POST") {
    if (path.endsWith("/assign")) {
      if (server.failAssign) throw server.failAssign;
      server.wrote = true;
      if (server.applyWrites) server.request = { ...server.request, assignedReviewerUserId: body.assignedReviewerUserId };
      return { request: server.request };
    }
    if (path.endsWith("/send")) {
      if (!server.request.assignedReviewerUserId) throw { statusCode: 422, code: "internal_recipient_requires_assignee" };
      server.wrote = true;
      server.request = { ...server.request, status: "SENT" };
      return { request: server.request, rawToken: null, intakeUrl: null };
    }
  }
  if (path === `/v1/evidence-requests/${requestId}`) {
    if (server.wrote && server.failReread) throw { statusCode: 503 };
    return { request: server.request };
  }
  throw new Error("unexpected " + method + " " + path);
}

beforeEach(() => {
  server = { request: makeRequest(), failAssign: null, failReread: false, wrote: false, applyWrites: true };
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(route);
  mocks.confirm.mockReset();
  mocks.confirm.mockResolvedValue(true);
  mocks.eventsMounts = 0;
});

const assignWrites = () => mocks.fetch.mock.calls.filter(([p, init]) => init?.method === "POST" && String(p).endsWith("/assign"));
const describedBy = (el: HTMLElement) => document.getElementById(el.getAttribute("aria-describedby")!)?.textContent;

async function pick(name: string) {
  fireEvent.click(await screen.findByRole("combobox"));
  fireEvent.click(await screen.findByRole("option", { name: new RegExp(name) }));
}

describe("evidence request reviewer assignment", () => {
  it("explains that an internal request cannot be sent until a reviewer is assigned", async () => {
    render(<EvidenceRequestInspectorPage />);
    const assignee = await waitFor(() => {
      const el = document.querySelector("[data-evidence-request-assignee]");
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    expect(assignee.textContent).toBe("Unassigned");
    const send = screen.getByRole("button", { name: "Send to assigned reviewer" });
    expect(send.hasAttribute("disabled")).toBe(true);
    expect(describedBy(send)).toMatch(/Assign a reviewer first/);
    expect(document.querySelector("[data-evidence-request-send-prerequisite]")?.textContent).toMatch(/cannot be sent without an assigned reviewer/);
  });

  it("assigns a workspace member and announces it only after rereading the request", async () => {
    render(<EvidenceRequestInspectorPage />);
    const toggle = await screen.findByRole("button", { name: "Assign reviewer" });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const save = screen.getByRole("button", { name: "Save reviewer" });
    expect(describedBy(save)).toBe("Choose a workspace member to assign.");
    await pick("Sam Ortiz");
    expect(save.hasAttribute("disabled")).toBe(false);
    const eventsBefore = mocks.eventsMounts;
    fireEvent.click(save);
    await screen.findByText("Sam Ortiz is now the assigned reviewer. The saved request was reloaded.");
    const calls = mocks.fetch.mock.calls;
    const write = calls.findIndex(([p, init]) => init?.method === "POST" && String(p).endsWith("/assign"));
    expect(calls[write][0]).toBe(`/v1/evidence-requests/${requestId}/assign`);
    expect(JSON.parse(calls[write][1].body)).toEqual({ assignedReviewerUserId: sam });
    expect(calls.slice(write + 1).some(([p]) => p === `/v1/evidence-requests/${requestId}`)).toBe(true);
    expect(document.querySelector("[data-evidence-request-assignee]")?.textContent).toBe("Sam Ortiz");
    expect(mocks.eventsMounts).toBeGreaterThan(eventsBefore);
    const send = screen.getByRole("button", { name: "Send to assigned reviewer" });
    expect(send.hasAttribute("disabled")).toBe(false);
  });

  it("does not offer a no-op reassignment", async () => {
    server.request = makeRequest({ assignedReviewerUserId: dana });
    render(<EvidenceRequestInspectorPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Change reviewer" }));
    await pick("Dana Reyes");
    const save = screen.getByRole("button", { name: "Save reviewer" });
    expect(save.hasAttribute("disabled")).toBe(true);
    expect(describedBy(save)).toBe("This member is already the assigned reviewer.");
  });

  it("cancelling the form makes no write and restores focus", async () => {
    render(<EvidenceRequestInspectorPage />);
    const toggle = await screen.findByRole("button", { name: "Assign reviewer" });
    fireEvent.click(toggle);
    await pick("Sam Ortiz");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(toggle);
    expect(assignWrites()).toHaveLength(0);
  });

  it("removes the reviewer after confirmation with a null payload; cancelling writes nothing", async () => {
    server.request = makeRequest({ assignedReviewerUserId: dana });
    mocks.confirm.mockResolvedValueOnce(false);
    render(<EvidenceRequestInspectorPage />);
    await waitFor(() => expect(document.querySelector("[data-evidence-request-assignee]")?.textContent).toBe("Dana Reyes"));
    fireEvent.click(screen.getByRole("button", { name: "Remove reviewer" }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    expect(assignWrites()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Remove reviewer" }));
    await screen.findByText("The request is now unassigned. The saved request was reloaded.");
    expect(JSON.parse(String(assignWrites()[0]![1].body))).toEqual({ assignedReviewerUserId: null });
    expect(document.querySelector("[data-evidence-request-assignee]")?.textContent).toBe("Unassigned");
  });

  it("maps a non-member refusal to operator language without claiming success", async () => {
    server.failAssign = { statusCode: 400, code: "assignee_not_workspace_member" };
    render(<EvidenceRequestInspectorPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Assign reviewer" }));
    await pick("Sam Ortiz");
    fireEvent.click(screen.getByRole("button", { name: "Save reviewer" }));
    await screen.findByText("That person is no longer a member of this workspace. Choose someone else.");
    expect(document.querySelector("[data-evidence-request-assignment-notice]")).toBeNull();
  });

  it("does not claim success when the confirming reread fails", async () => {
    server.failReread = true;
    render(<EvidenceRequestInspectorPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Assign reviewer" }));
    await pick("Sam Ortiz");
    fireEvent.click(screen.getByRole("button", { name: "Save reviewer" }));
    await screen.findByText(/could not be reloaded to confirm it/);
    expect(document.querySelector("[data-evidence-request-assignment-notice]")).toBeNull();
    expect(screen.getByRole("button", { name: "Assign reviewer" }).hasAttribute("disabled")).toBe(true);
  });

  it("does not claim success when the reread does not show the change", async () => {
    server.applyWrites = false;
    render(<EvidenceRequestInspectorPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Assign reviewer" }));
    await pick("Sam Ortiz");
    fireEvent.click(screen.getByRole("button", { name: "Save reviewer" }));
    await screen.findByText(/reloaded request does not show the change/);
    expect(document.querySelector("[data-evidence-request-assignment-notice]")).toBeNull();
  });

  it("a refused member list is an error, never an empty list", async () => {
    mocks.fetch.mockImplementation(async (p: string, init?: RequestInit) => {
      if (p.startsWith("/v1/teams/")) throw { statusCode: 403, code: "FORBIDDEN" };
      return route(p, init);
    });
    render(<EvidenceRequestInspectorPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Assign reviewer" }));
    await waitFor(() => expect(document.querySelector("[data-workspace-member-select-error]")).toBeTruthy());
    expect(document.querySelector("[data-workspace-member-select-empty]")).toBeNull();
    expect(screen.getByRole("button", { name: "Save reviewer" }).hasAttribute("disabled")).toBe(true);
  });

  it("sends an assigned internal request after confirmation and rereads it", async () => {
    server.request = makeRequest({ assignedReviewerUserId: dana });
    render(<EvidenceRequestInspectorPage />);
    await waitFor(() => expect(document.querySelector("[data-evidence-request-assignee]")?.textContent).toBe("Dana Reyes"));
    fireEvent.click(screen.getByRole("button", { name: "Send to assigned reviewer" }));
    await screen.findByText("Request sent to the assigned reviewer. The saved request was reloaded.");
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Send this request to the assigned reviewer?" }));
    expect(mocks.fetch.mock.calls.some(([p, init]) => init?.method === "POST" && p === `/v1/evidence-requests/${requestId}/send`)).toBe(true);
    expect(screen.queryByRole("button", { name: "Send to assigned reviewer" })).toBeNull();
  });

  it("offers no assignment change on a closed request", async () => {
    server.request = makeRequest({ status: "CLOSED", assignedReviewerUserId: dana });
    render(<EvidenceRequestInspectorPage />);
    await screen.findByText("The reviewer cannot change on a closed or cancelled request.");
    expect(screen.queryByRole("button", { name: "Change reviewer" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove reviewer" })).toBeNull();
  });
});
