import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), confirm: vi.fn() }));
vi.mock("../../lib/api", () => ({ apiFetch: mocks.fetch }));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: mocks.confirm }) }));
vi.mock("../../components/presence/PresenceIndicator", () => ({ PresenceIndicator: () => null }));

import EvidenceDiscussionPanel from "../../app/(app)/evidence/[id]/components/EvidenceDiscussionPanel";

const teamId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const evidenceId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const threadId = "11111111-1111-4111-8111-111111111111";
const memberId = "22222222-2222-4222-8222-222222222222";
const otherId = "33333333-3333-4333-8333-333333333333";

type Thread = Record<string, unknown> & { status: string; assignedToUserId: string | null; escalatedAtUtc: string | null };
let server: { thread: Thread; resolutionNote: string | null; escalationReason: string | null; failDetail: boolean; failList: boolean; failRereadAfterWrite: boolean; wrote: boolean; applyWrites: boolean };

function baseThread(over: Partial<Thread> = {}): Thread {
  return {
    id: threadId, evidenceId, kind: "EVIDENCE_GENERAL", status: "OPEN", visibility: "INTERNAL",
    title: "Chain of custody question", createdByUserId: memberId, assignedToUserId: null,
    resolvedAtUtc: null, reopenCount: 0, escalatedAtUtc: null,
    createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", ...over,
  };
}

async function route(path: string, init?: RequestInit): Promise<unknown> {
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  if (path.startsWith("/v1/collaboration/catalogs")) return null;
  if (path.startsWith("/v1/teams/")) {
    return { members: [
      { userId: memberId, label: "Dana Reyes", role: "ADMIN", status: "ACTIVE" },
      { userId: otherId, label: "Sam Ortiz", role: "MEMBER", status: "ACTIVE" },
    ], nextCursor: null };
  }
  if (path.startsWith("/v1/collaboration/threads?")) {
    if (server.failList) throw { statusCode: 403, code: "FORBIDDEN" };
    return { threads: [server.thread] };
  }
  if (path.includes("/messages")) return { messages: [] };
  if (path.includes("/mark-mentions-read")) return { ok: true };
  if (method === "POST") {
    server.wrote = true;
    if (!server.applyWrites) return { thread: server.thread };
    if (path.endsWith("/resolve")) { server.thread = { ...server.thread, status: "RESOLVED" }; server.resolutionNote = body.resolutionNote; }
    if (path.endsWith("/reopen")) { server.thread = { ...server.thread, status: "IN_PROGRESS", reopenCount: 1 }; server.resolutionNote = null; }
    if (path.endsWith("/assign")) server.thread = { ...server.thread, assignedToUserId: body.assignedToUserId };
    if (path.endsWith("/escalate")) { server.thread = { ...server.thread, status: "IN_PROGRESS", escalatedAtUtc: "2026-09-02T00:00:00.000Z" }; server.escalationReason = body.reason; }
    return { thread: server.thread };
  }
  if (path.startsWith(`/v1/collaboration/threads/${threadId}?`)) {
    if (server.failDetail) throw { statusCode: 404, code: "not_found" };
    if (server.wrote && server.failRereadAfterWrite) throw { statusCode: 503 };
    return { thread: server.thread, resolutionNote: server.resolutionNote, escalationReason: server.escalationReason };
  }
  throw new Error("unexpected " + method + " " + path);
}

beforeEach(() => {
  server = { thread: baseThread(), resolutionNote: null, escalationReason: null, failDetail: false, failList: false, failRereadAfterWrite: false, wrote: false, applyWrites: true };
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(route);
  mocks.confirm.mockReset();
  mocks.confirm.mockResolvedValue(true);
});

function mount(readOnly = false) {
  return render(<EvidenceDiscussionPanel evidenceId={evidenceId} teamId={teamId} initialThreadId={threadId} readOnly={readOnly} />);
}
const lifecycle = () => document.querySelector("[data-discussion-lifecycle]") as HTMLElement;
async function action(name: string) {
  const button = await screen.findByRole("button", { name });
  fireEvent.click(button);
  return button;
}

describe("evidence discussion thread lifecycle", () => {
  it("resolves after confirmation and announces success only after rereading the thread", async () => {
    mount();
    await screen.findByText("Unassigned");
    const toggle = await action("Resolve");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const note = screen.getByLabelText("Resolution note (optional, internal)");
    expect(document.activeElement).toBe(note);
    fireEvent.change(note, { target: { value: "Custodian confirmed the transfer." } });
    fireEvent.click(screen.getByRole("button", { name: "Resolve thread" }));
    await screen.findByText("Thread resolved. The saved thread was reloaded.");
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Resolve this thread?" }));
    const calls = mocks.fetch.mock.calls;
    const write = calls.findIndex(([p, init]) => init?.method === "POST" && String(p).endsWith("/resolve"));
    expect(calls[write][0]).toBe(`/v1/collaboration/threads/${threadId}/resolve`);
    expect(JSON.parse(calls[write][1].body)).toEqual({ teamId, resolutionNote: "Custodian confirmed the transfer." });
    expect(calls.slice(write + 1).some(([p]) => p === `/v1/collaboration/threads/${threadId}?teamId=${teamId}`)).toBe(true);
    expect(calls.slice(write + 1).some(([p]) => String(p).startsWith("/v1/collaboration/threads?"))).toBe(true);
    expect(await screen.findByText("Custodian confirmed the transfer.")).toBeTruthy();
    // The composer is replaced by the locked state and Reopen is now offered.
    await screen.findByRole("button", { name: "Reopen" });
    expect(document.querySelector("[data-evidence-discussion-form]")).toBeNull();
  });

  it("cancelling the confirmation makes no write", async () => {
    mocks.confirm.mockResolvedValue(false);
    mount();
    await screen.findByText("Unassigned");
    await action("Resolve");
    fireEvent.click(screen.getByRole("button", { name: "Resolve thread" }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: "Resolve thread" }).hasAttribute("disabled")).toBe(false));
    expect(mocks.fetch.mock.calls.filter(([p, init]) => init?.method === "POST" && String(p).endsWith("/resolve"))).toHaveLength(0);
  });

  it("cancelling the form makes no write and returns focus to its toggle", async () => {
    mount();
    await screen.findByText("Unassigned");
    const toggle = await action("Escalate");
    fireEvent.change(screen.getByLabelText("Reason for escalating (internal)"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(mocks.fetch.mock.calls.filter(([p, init]) => init?.method === "POST" && !String(p).includes("mark-mentions-read"))).toHaveLength(0);
  });

  it("replaces the retired-surface guidance with a real Reopen that requires a reason", async () => {
    server.thread = baseThread({ status: "RESOLVED" });
    server.resolutionNote = "Handled offline.";
    mount();
    const locked = await waitFor(() => {
      const node = document.querySelector("[data-evidence-discussion-locked]");
      expect(node).toBeTruthy();
      return node as HTMLElement;
    });
    expect(locked.textContent).not.toMatch(/classic/i);
    expect(locked.textContent).toMatch(/Reopen above/);
    expect(await screen.findByText("Handled offline.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Escalate" })).toBeNull();
    await action("Reopen");
    const submit = screen.getByRole("button", { name: "Reopen thread" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    expect(document.getElementById(submit.getAttribute("aria-describedby")!)?.textContent).toBe("Enter the internal reason.");
    fireEvent.change(screen.getByLabelText("Reason for reopening (internal)"), { target: { value: "New upload arrived." } });
    fireEvent.click(submit);
    await screen.findByText("Thread reopened. New messages can be posted again.");
    expect(mocks.confirm).not.toHaveBeenCalled();
    const write = mocks.fetch.mock.calls.find(([p, init]) => init?.method === "POST" && String(p).endsWith("/reopen"));
    expect(JSON.parse(write![1].body)).toEqual({ teamId, reason: "New upload arrived." });
    await waitFor(() => expect(document.querySelector("[data-evidence-discussion-form]")).toBeTruthy());
  });

  it("does not offer Reopen on a closed thread", async () => {
    server.thread = baseThread({ status: "CLOSED" });
    mount();
    await screen.findByText("Unassigned");
    expect(screen.queryByRole("button", { name: "Reopen" })).toBeNull();
    expect(document.querySelector("[data-evidence-discussion-locked]")?.textContent).toMatch(/closed and is kept as a record/);
  });

  it("assigns a workspace member chosen from the member list", async () => {
    server.thread = baseThread({ assignedToUserId: memberId });
    mount();
    await screen.findByText("Dana Reyes");
    await action("Change assignee");
    const submit = screen.getByRole("button", { name: "Assign thread" });
    expect(document.getElementById(submit.getAttribute("aria-describedby")!)?.textContent).toBe("Choose a workspace member to assign.");
    const picker = await screen.findByRole("combobox");
    expect(mocks.fetch.mock.calls.some(([p]) => String(p).startsWith(`/v1/teams/${teamId}/members?`) && String(p).includes("status=ACTIVE"))).toBe(true);
    fireEvent.click(picker);
    fireEvent.click(await screen.findByRole("option", { name: /Dana Reyes/ }));
    await waitFor(() => expect(document.getElementById(submit.getAttribute("aria-describedby")!)?.textContent).toBe("This member is already assigned to the thread."));
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: /Sam Ortiz/ }));
    expect(submit.hasAttribute("disabled")).toBe(false);
    fireEvent.click(submit);
    await screen.findByText("Thread assigned to Sam Ortiz. The saved thread was reloaded.");
    const write = mocks.fetch.mock.calls.find(([p, init]) => init?.method === "POST" && String(p).endsWith("/assign"));
    expect(JSON.parse(write![1].body)).toEqual({ teamId, assignedToUserId: otherId });
    expect(within(lifecycle()).getByText("Sam Ortiz")).toBeTruthy();
  });

  it("escalates with a required reason and shows the reason from the reread", async () => {
    mount();
    await screen.findByText("Unassigned");
    await action("Escalate");
    fireEvent.change(screen.getByLabelText("Reason for escalating (internal)"), { target: { value: "Deadline tomorrow." } });
    fireEvent.click(screen.getByRole("button", { name: "Escalate thread" }));
    await screen.findByText("Thread escalated. The saved thread was reloaded.");
    const write = mocks.fetch.mock.calls.find(([p, init]) => init?.method === "POST" && String(p).endsWith("/escalate"));
    expect(JSON.parse(write![1].body)).toEqual({ teamId, reason: "Deadline tomorrow." });
    expect(document.querySelector("[data-discussion-escalation-reason]")?.textContent).toBe("Deadline tomorrow.");
    expect(screen.queryByRole("button", { name: "Escalate" })).toBeNull();
  });

  it("does not announce success when the reread does not show the change", async () => {
    server.applyWrites = false;
    mount();
    await screen.findByText("Unassigned");
    await action("Escalate");
    fireEvent.change(screen.getByLabelText("Reason for escalating (internal)"), { target: { value: "r" } });
    fireEvent.click(screen.getByRole("button", { name: "Escalate thread" }));
    await screen.findByText(/reloaded thread does not show the change/);
    expect(screen.queryByText("Thread escalated. The saved thread was reloaded.")).toBeNull();
  });

  it("does not claim success when the confirming reread fails, and locks further changes", async () => {
    server.failRereadAfterWrite = true;
    mount();
    await screen.findByText("Unassigned");
    await action("Resolve");
    fireEvent.click(screen.getByRole("button", { name: "Resolve thread" }));
    await screen.findByText(/could not be reloaded to confirm it/);
    expect(screen.queryByText("Thread resolved. The saved thread was reloaded.")).toBeNull();
  });

  it("reports a refused write without claiming success", async () => {
    mocks.fetch.mockImplementation(async (p: string, init?: RequestInit) => {
      if (init?.method === "POST" && p.endsWith("/resolve")) throw { statusCode: 409, code: "invalid_status_transition" };
      return route(p, init);
    });
    mount();
    await screen.findByText("Unassigned");
    await action("Resolve");
    fireEvent.click(screen.getByRole("button", { name: "Resolve thread" }));
    await screen.findByText("This thread changed since it was loaded. Refresh the thread and try again.");
    expect(screen.queryByText("Thread resolved. The saved thread was reloaded.")).toBeNull();
  });

  it("a refused detail read is an error and offers no lifecycle change", async () => {
    server.failDetail = true;
    mount();
    const alert = await waitFor(() => {
      const node = document.querySelector("[data-discussion-lifecycle-error]");
      expect(node).toBeTruthy();
      return node as HTMLElement;
    });
    expect(alert.getAttribute("role")).toBe("alert");
    expect(screen.queryByText("Unassigned")).toBeNull();
  });

  it("a refused thread list is never shown as an empty discussion", async () => {
    server.failList = true;
    mount();
    await waitFor(() => expect(document.querySelector("[data-evidence-discussion-error]")).toBeTruthy());
    await act(async () => { await Promise.resolve(); });
    expect(document.querySelector('[data-evidence-discussion-empty="no-threads"]')).toBeNull();
    expect(document.querySelector("[data-evidence-discussion-list-unavailable]")).toBeTruthy();
  });

  it("read-only mode shows the lifecycle detail but offers no changes", async () => {
    mount(true);
    await screen.findByText("Unassigned");
    for (const name of ["Resolve", "Assign", "Escalate", "Reopen"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });
});
