/**
 * Team review inspector (/reviewer-ops/[reviewId]) — actions, outcomes,
 * refusals, record response, adjudication and panel refresh.
 *
 * Real `apiFetch` over a stubbed network, so refusals arrive as the real
 * ApiError (nested error.code + details.reason) and a lost answer as
 * NETWORK_ERROR.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { chooseListbox, listboxValues } from "./_listbox";

const teamId = "44444444-4444-4444-8444-444444444444";
const workflowId = "22222222-2222-4222-8222-222222222222";
const evidenceId = "e1000000-0000-4000-8000-0000000000c1";

const mocks = vi.hoisted(() => ({ confirm: vi.fn() }));

vi.mock("../../lib/platform-context", async (orig) => ({
  ...(await orig<typeof import("../../lib/platform-context")>()),
  useActiveSpaceId: () => "44444444-4444-4444-8444-444444444444",
}));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: mocks.confirm }) }));
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../components/presence/PresenceIndicator", () => ({ PresenceIndicator: () => null }));
vi.mock("../../components/presence/CollisionWarning", () => ({ CollisionWarning: () => null }));
vi.mock("../../components/ai-copilot/ReviewerCopilotPanel", () => ({ ReviewerCopilotPanel: () => null }));
vi.mock("../../app/(app)/reviewer-ops/components/CodingSchemaBindingPanel", () => ({ CodingSchemaBindingPanel: () => null }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/reviewer-ops/22222222-2222-4222-8222-222222222222",
  useParams: () => ({ reviewId: "22222222-2222-4222-8222-222222222222" }),
}));

import ReviewWorkspacePage from "../../app/(app)/reviewer-ops/[reviewId]/page";
import {
  FIRST_ONLY_MESSAGE,
  describeRefusal,
} from "../../app/(app)/reviewer-ops/[reviewId]/_components/inspector-model";

type Action = { action: string; allowed: boolean; reason?: string };

const ALL = ["start", "pause", "resume", "request_info", "record_response", "approve", "reject", "reassign", "adjudicate", "archive"];

function viewerWith(allowed: string[], reasons: Record<string, string> = {}, isAssignee = true) {
  const actions: Action[] = ALL.map((a) =>
    allowed.includes(a) ? { action: a, allowed: true } : { action: a, allowed: false, reason: reasons[a] ?? reasons["*"] },
  );
  return { userId: "u-1", isAssignee, actions };
}

let workspace: Record<string, unknown>;
let decisions: Record<string, unknown>;
let postResponses: Record<string, () => Response | Promise<Response>>;
const calls: Array<{ method: string; path: string; body: unknown }> = [];
const fetchMock = vi.fn();

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function workspaceBody(opts: { lifecycle?: string; sla?: string; viewer?: unknown; paused?: boolean; assigned?: boolean } = {}) {
  return {
    projection: {
      workflowId,
      evidenceId,
      lifecycleState: opts.lifecycle ?? "IN_REVIEW",
      assignedToUserId: opts.assigned === false ? null : "u-1",
      assignedAtUtc: "2026-11-20T10:00:00.000Z",
      priority: "NORMAL",
      slaPausedAtUtc: opts.paused ? "2026-11-21T10:00:00.000Z" : null,
      pausedReason: null,
      slaRollupState: opts.sla ?? "HEALTHY",
      slaDimensions: [{ dimension: "RESOLUTION", dueAtUtc: null, state: opts.sla ?? "HEALTHY" }],
    },
    openEscalation: null,
    allowedLifecycleTransitions: ["APPROVED", "REJECTED"],
    ...(opts.viewer !== undefined ? { viewer: opts.viewer } : {}),
  };
}

function decisionsBody(state: string, nextAction: string, rows: unknown[] = [], required = false) {
  return {
    workflowId,
    evidenceId,
    state,
    secondReviewRequirement: { required, reason: required ? "workflow_escalated" : null },
    callerContext: { userId: "u-1", teamRole: "OWNER", isAdjudicator: true, callerIsFirstReviewer: false, nextAction },
    decisions: rows,
  };
}

const row = (id: string, stage: string, decision: string, user: string) => ({
  id,
  stage,
  decision,
  reasonCode: null,
  rationale: `${stage} rationale`,
  decidedAt: "2026-11-21T10:00:00.000Z",
  reviewer: { userId: user, email: null, displayName: `Reviewer ${user}` },
});

const wsPath = `/v1/reviewer-ops/workspace/${workflowId}?teamId=${teamId}`;
const decPath = `/v1/reviewer-ops/workspace/${workflowId}/decisions?teamId=${teamId}`;
const notesPath = `/v1/reviewer-ops/workspace/${workflowId}/notes?teamId=${teamId}`;
const actionPath = (a: string) => `/v1/reviewer-ops/reviews/${workflowId}/${a}`;
const decisionsPostPath = `/v1/reviewer-ops/workspace/${workflowId}/decisions`;

const gets = (path: string) => calls.filter((c) => c.method === "GET" && c.path === path).length;
const posts = (path: string) => calls.filter((c) => c.method === "POST" && c.path === path);

beforeEach(() => {
  workspace = workspaceBody({ viewer: viewerWith(["approve", "reject", "request_info", "pause"], { "*": "not_started" }) });
  decisions = decisionsBody("first_required", "submit_first");
  postResponses = {};
  calls.length = 0;
  mocks.confirm.mockReset();
  mocks.confirm.mockResolvedValue(true);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "GET" && path === wsPath) return json(200, workspace);
    if (method === "GET" && path === decPath) return json(200, decisions);
    if (method === "GET" && path === notesPath) return json(200, { workflowId, evidenceId, summary: { total: 0 }, items: [] });
    if (method === "POST" && postResponses[path]) return postResponses[path]();
    if (method === "POST") return json(200, { ok: true });
    return json(200, {});
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderPage() {
  render(<ReviewWorkspacePage />);
  await screen.findByRole("heading", { name: "What you can do now" });
  await waitFor(() => expect(gets(decPath)).toBeGreaterThan(0));
}

const button = (name: string) => document.querySelector(`[data-reviewer-action="${name}"]`) as HTMLButtonElement | null;
const reasonOf = (name: string) => document.querySelector(`[data-reviewer-action-reason="${name}"]`)?.textContent ?? null;

describe("viewer.actions drive the inspector controls", () => {
  it("the assignee may decide: Approve and Reject are enabled and listed", async () => {
    await renderPage();
    expect(button("approve")?.disabled).toBe(false);
    expect(button("reject")?.disabled).toBe(false);
    const list = document.querySelector("[data-reviewer-allowed-actions]") as HTMLElement;
    expect(within(list).getByText("Approve (internal)")).toBeTruthy();
    expect(within(list).getByText("Reject (internal)")).toBeTruthy();
    // The old lifecycle chip list is gone.
    expect(screen.queryByText("Allowed lifecycle transitions")).toBeNull();
    expect(document.querySelector("[data-reviewer-actions-source]")?.getAttribute("data-reviewer-actions-source")).toBe("viewer");
  });

  it("a non-assignee sees the decisions closed with the assignee reason", async () => {
    workspace = workspaceBody({ viewer: viewerWith([], { "*": "not_assignee" }, false) });
    await renderPage();
    expect(button("approve")?.disabled).toBe(true);
    expect(button("reject")?.disabled).toBe(true);
    expect(reasonOf("approve")).toBe("Only the assigned reviewer can decide.");
    expect(document.querySelector("[data-reviewer-main-blocked-reason]")?.textContent).toBe(
      "Only the assigned reviewer can decide.",
    );
    expect(button("approve")?.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByText("There is nothing for you to do on this review right now.")).toBeTruthy();
  });

  it("an owner with assign-only rights is offered reassignment, never a decision", async () => {
    workspace = workspaceBody({ viewer: viewerWith(["reassign"], { "*": "not_assignee" }, false) });
    await renderPage();
    expect(button("approve")?.disabled).toBe(true);
    expect(button("start")?.disabled).toBe(true);
    const list = document.querySelector("[data-reviewer-allowed-actions]") as HTMLElement;
    expect(list.textContent).toContain("Reassign — from the review queue");
    expect(list.textContent).not.toContain("Approve");
  });

  it("an unassigned review says to assign it, using the engine's codes", async () => {
    workspace = workspaceBody({
      lifecycle: "QUEUED",
      assigned: false,
      viewer: viewerWith(["reassign"], { start: "invalid_transition", "*": "not_assignee" }, false),
    });
    await renderPage();
    expect(reasonOf("start")).toBe("Assign the review to start.");
    expect(reasonOf("approve")).toBe("Assign the review to start.");
    expect(screen.getByText("Unassigned")).toBeTruthy();
  });

  it("a second decision by the first reviewer explains the reassignment", async () => {
    workspace = workspaceBody({
      viewer: viewerWith([], { approve: "second_stage_needs_reassignment", reject: "second_stage_needs_reassignment", "*": "not_started" }),
    });
    await renderPage();
    expect(reasonOf("approve")).toBe("A different reviewer must make the second decision — reassign it.");
  });

  it("an older API without viewer falls back to the lifecycle rule, with reasons", async () => {
    workspace = workspaceBody({ lifecycle: "NEEDS_INFORMATION" });
    await renderPage();
    expect(document.querySelector("[data-reviewer-actions-source]")?.getAttribute("data-reviewer-actions-source")).toBe("lifecycle");
    expect(button("record_response")?.disabled).toBe(false);
    expect(button("approve")?.disabled).toBe(true);
    expect(reasonOf("approve")).toBe("Waiting for information — record the response to continue.");
  });
});

describe("outcome drives the confirmation and success copy", () => {
  it("a FIRST-only approval says a second reviewer must confirm, never 'approved'", async () => {
    decisions = decisionsBody("first_required", "submit_first", [], true);
    postResponses[actionPath("approve")] = () =>
      json(200, { ok: true, outcome: { stageRecorded: "FIRST", statusChanged: false, reviewState: "second_required", nextRequirement: "second_review", idempotent: false } });
    await renderPage();
    await waitFor(() => expect(document.querySelector('[data-decision-requires-second="true"]')).toBeTruthy());
    const wsBefore = gets(wsPath);
    const decBefore = gets(decPath);
    const notesBefore = gets(notesPath);
    fireEvent.click(button("approve")!);
    await screen.findByText(FIRST_ONLY_MESSAGE);
    const asked = mocks.confirm.mock.calls[0]![0] as { description: string; title: string };
    expect(asked.description).toContain("first review only");
    expect(asked.description).toContain("not a public statement");
    expect(posts(actionPath("approve"))).toHaveLength(1);
    const notice = document.querySelector("[data-reviewer-action-notice]")!.textContent ?? "";
    expect(notice).not.toMatch(/approved/i);
    // Both panels and the workspace reread.
    await waitFor(() => {
      expect(gets(wsPath)).toBeGreaterThan(wsBefore);
      expect(gets(decPath)).toBeGreaterThan(decBefore);
      expect(gets(notesPath)).toBeGreaterThan(notesBefore);
    });
  });

  it("a terminal approval says the review is approved (internal)", async () => {
    postResponses[actionPath("approve")] = () =>
      json(200, { ok: true, outcome: { stageRecorded: "FIRST", statusChanged: true, reviewState: "resolved", nextRequirement: null, idempotent: false } });
    await renderPage();
    fireEvent.click(button("approve")!);
    await screen.findByText("Review approved (internal).");
    const asked = mocks.confirm.mock.calls[0]![0] as { description: string };
    expect(asked.description).toContain("internal review decision");
  });
});

describe("refusals are mapped per reason", () => {
  const reasons: Array<[string, number]> = [
    ["not_assignee", 403],
    ["second_stage_needs_reassignment", 409],
    ["same_reviewer_blocked", 409],
    ["use_adjudication", 409],
    ["adjudicator_role_required", 403],
    ["adjudicator_not_independent", 409],
    ["second_review_pending", 409],
    ["second_reviewer_not_independent", 409],
    ["decision_not_from_stage", 409],
    ["stale_decision", 409],
    ["review_already_resolved", 409],
    ["duplicate_stage_decision", 409],
    ["forbidden_wording", 400],
  ];

  it("every reason has its own message, and only review_already_resolved says 'already resolved'", () => {
    const messages = reasons.map(([reason, status]) => describeRefusal({ status, code: "REVIEW_DECISION_REFUSED", reason }, "fallback"));
    expect(new Set(messages).size).toBe(messages.length);
    messages.forEach((m, i) => {
      expect(m).not.toBe("fallback");
      if (reasons[i]![0] !== "review_already_resolved") expect(m).not.toMatch(/already resolved/i);
    });
  });

  it.each(reasons)("approve refused with %s shows its message on the page", async (reason, status) => {
    postResponses[actionPath("approve")] = () =>
      json(status, { error: { code: "REVIEW_DECISION_REFUSED", message: "refused", details: { reason } } });
    await renderPage();
    fireEvent.click(button("approve")!);
    const expected = describeRefusal({ status, code: "REVIEW_DECISION_REFUSED", reason }, "x");
    await waitFor(() => expect(document.querySelector("[data-reviewer-action-error]")?.textContent).toBe(expected));
  });

  it("a step-up challenge asks the reviewer to re-verify", async () => {
    postResponses[actionPath("approve")] = () => json(401, { error: { code: "STEP_UP_REQUIRED", message: "step up" } });
    await renderPage();
    fireEvent.click(button("approve")!);
    await waitFor(() =>
      expect(document.querySelector("[data-reviewer-action-error]")?.textContent).toContain("confirm your identity again"),
    );
  });

  it("a lost answer says to check before retrying (NETWORK_ERROR)", async () => {
    postResponses[actionPath("approve")] = () => Promise.reject(new TypeError("Failed to fetch"));
    await renderPage();
    fireEvent.click(button("approve")!);
    await waitFor(() =>
      expect(document.querySelector("[data-reviewer-action-error]")?.textContent).toContain("connection dropped"),
    );
  });

  it("the lineage route's 409 decision_not_allowed maps by reason, never to 'already resolved'", async () => {
    postResponses[decisionsPostPath] = () =>
      json(409, { error: { code: "decision_not_allowed", message: "no", details: { reason: "stale_decision" } } });
    await renderPage();
    const form = (await waitFor(() => document.querySelector("[data-decision-form]"))) as HTMLElement;
    chooseListbox(form.querySelector("[data-decision-form-decision]"), "APPROVE");
    fireEvent.change(form.querySelector("[data-decision-form-rationale]")!, { target: { value: "Looks consistent." } });
    const wsBefore = gets(wsPath);
    fireEvent.click(form.querySelector("[data-decision-form-submit]")!);
    const err = await waitFor(() => {
      const el = document.querySelector("[data-decision-form-error]");
      expect(el).toBeTruthy();
      return el!;
    });
    expect(err.textContent).toContain("changed while you were working");
    expect(err.textContent).not.toMatch(/already resolved/i);
    await waitFor(() => expect(gets(wsPath)).toBeGreaterThan(wsBefore));
  });
});

describe("record response", () => {
  it("opens a dialog with an optional note and posts response-received", async () => {
    workspace = workspaceBody({
      lifecycle: "NEEDS_INFORMATION",
      viewer: viewerWith(["record_response", "pause"], { "*": "awaiting_response" }),
    });
    postResponses[actionPath("response-received")] = () =>
      json(200, { ok: true, outcome: { stageRecorded: "FIRST", statusChanged: true, reviewState: "first_required", nextRequirement: null, idempotent: false } });
    await renderPage();
    expect(reasonOf("approve")).toBe("Waiting for information — record the response to continue.");
    fireEvent.click(button("record_response")!);
    const dialog = await screen.findByRole("dialog", { name: "Record the response" });
    const submit = within(dialog).getByRole("button", { name: "Record response" }) as HTMLButtonElement;
    // Optional note: submit is available without one.
    expect(submit.disabled).toBe(false);
    fireEvent.change(within(dialog).getByLabelText("Note (optional)"), { target: { value: "Custody log received." } });
    fireEvent.click(submit);
    await screen.findByText("Response recorded. The review can continue.");
    const sent = posts(actionPath("response-received"));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toEqual({ teamId, note: "Custody log received." });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("a refusal stays inside the dialog with the note kept", async () => {
    workspace = workspaceBody({ lifecycle: "NEEDS_INFORMATION", viewer: viewerWith(["record_response"]) });
    postResponses[actionPath("response-received")] = () =>
      json(403, { error: { code: "REVIEW_DECISION_REFUSED", message: "no", details: { reason: "not_assignee" } } });
    await renderPage();
    fireEvent.click(button("record_response")!);
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Note (optional)"), { target: { value: "kept" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Record response" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("Only the assigned reviewer");
    expect((within(dialog).getByLabelText("Note (optional)") as HTMLTextAreaElement).value).toBe("kept");
    expect(document.querySelector("[data-reviewer-action-error]")).toBeNull();
  });
});

describe("adjudication panel", () => {
  it("is absent outside a conflict, and the lineage form never offers adjudication kinds", async () => {
    await renderPage();
    const form = (await waitFor(() => document.querySelector("[data-decision-form]"))) as HTMLElement;
    expect(document.querySelector('[data-section="reviewer-adjudication"]')).toBeNull();
    const values = listboxValues(form.querySelector("[data-decision-form-decision]")!);
    expect(values).not.toContain("UPHOLD_FIRST");
    expect(values).not.toContain("UPHOLD_SECOND");
  });

  it("appears in conflict and posts an adjudication kind through the decisions route", async () => {
    workspace = workspaceBody({ lifecycle: "ESCALATED", sla: "ESCALATED", viewer: viewerWith(["adjudicate"], { "*": "use_adjudication" }) });
    decisions = decisionsBody("conflict_detected", "submit_adjudication", [row("d1", "FIRST", "APPROVE", "a"), row("d2", "SECOND", "REJECT", "b")], true);
    postResponses[decisionsPostPath] = () =>
      json(200, { ok: true, outcome: { stageRecorded: "ADJUDICATION", statusChanged: true, reviewState: "resolved", nextRequirement: null, idempotent: false } });
    await renderPage();
    const panel = (await waitFor(() => {
      const el = document.querySelector('[data-section="reviewer-adjudication"]');
      expect(el).toBeTruthy();
      return el!;
    })) as HTMLElement;
    // Ordinary Approve stays closed with the adjudication reason.
    expect(reasonOf("approve")).toBe("This disagreement needs adjudication by an independent owner or admin.");
    expect(within(panel).getByText(/Approved \(internal\)/)).toBeTruthy();
    chooseListbox(panel.querySelector("[data-adjudication-kind]"), "UPHOLD_FIRST");
    fireEvent.change(within(panel).getByLabelText("Rationale"), { target: { value: "First review is better supported." } });
    const wsBefore = gets(wsPath);
    fireEvent.click(within(panel).getByRole("button", { name: "Record adjudication" }));
    await screen.findByText("Adjudication recorded. The review is resolved.");
    const sent = posts(decisionsPostPath);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({ teamId, decision: "UPHOLD_FIRST", rationale: "First review is better supported." });
    expect(posts(actionPath("approve"))).toHaveLength(0);
    await waitFor(() => expect(gets(wsPath)).toBeGreaterThan(wsBefore));
  });

  it("explains who can adjudicate when the viewer cannot", async () => {
    workspace = workspaceBody({ lifecycle: "ESCALATED", viewer: viewerWith([], { adjudicate: "adjudicator_not_independent", "*": "use_adjudication" }) });
    decisions = decisionsBody("conflict_detected", "blocked_not_adjudicator", [row("d1", "FIRST", "APPROVE", "a"), row("d2", "SECOND", "REJECT", "u-1")], true);
    await renderPage();
    const blocked = await waitFor(() => {
      const el = document.querySelector("[data-adjudication-blocked]");
      expect(el).toBeTruthy();
      return el!;
    });
    expect(blocked.textContent).toBe("Adjudication needs an owner or admin who made neither decision.");
    expect(document.querySelector("[data-adjudication-form]")).toBeNull();
  });
});

describe("header and identifiers", () => {
  it("shows one lifecycle badge and one SLA badge with human labels", async () => {
    workspace = workspaceBody({ lifecycle: "ESCALATED", sla: "ESCALATED", viewer: viewerWith([]) });
    await renderPage();
    const lifecycle = document.querySelectorAll("[data-reviewer-lifecycle-badge]");
    const sla = document.querySelectorAll("[data-reviewer-sla-badge]");
    expect(lifecycle).toHaveLength(1);
    expect(sla).toHaveLength(1);
    expect(lifecycle[0]!.textContent).toContain("Escalated");
    expect(sla[0]!.textContent).toContain("SLA overdue");
    expect(sla[0]!.textContent).not.toMatch(/escalated/i);
    // Readable evidence reference with a copy-full-ID control, not a bare UUID.
    expect(screen.getByText("Evidence ref 0000C1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy full Evidence ID" })).toBeTruthy();
  });

  it("groups linked artifacts into Evidence and Go to, with one primary in Evidence", async () => {
    await renderPage();
    const evidence = document.querySelector('[data-reviewer-links-group="evidence"]') as HTMLElement;
    const goto = document.querySelector('[data-reviewer-links-group="goto"]') as HTMLElement;
    expect(evidence.querySelectorAll(".app-primary-action")).toHaveLength(1);
    expect(goto.querySelectorAll(".app-primary-action")).toHaveLength(0);
    expect(within(goto).getByText("Reports queue")).toBeTruthy();
    expect(within(goto).getByText("Escalations")).toBeTruthy();
  });
});
