/**
 * Team review inspector (/reviewer-ops/[reviewId]) — TEAM-UI-SPEC §2 round 3.
 *
 *   - ONE decision-entry flow: the "Record decision" panel is the only verdict
 *     entry (no Approve / Reject / Request information buttons anywhere); each
 *     choice posts the decisions route with its kind; the step-up challenge is
 *     answered through the shared StepUpModal; in conflict the same panel is
 *     the adjudication form;
 *   - the "Next step" panel: one contextual primary per state, secondary
 *     actions only where allowed, Escalate posts the escalations route, the
 *     Archive confirm uses app-danger-action;
 *   - canonical controls only: no `ui-button`, every button carries a
 *     canonical class.
 *
 * Real `apiFetch` over a stubbed network, so refusals arrive as the real
 * ApiError (nested error.code + details.reason) and a lost answer as
 * NETWORK_ERROR.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { chooseListbox } from "./_listbox";

import ReviewWorkspacePage from "../../app/(app)/reviewer-ops/[reviewId]/page";
import {
  FIRST_ONLY_MESSAGE,
  describeRefusal,
} from "../../app/(app)/reviewer-ops/[reviewId]/_components/inspector-model";

const teamId = "44444444-4444-4444-8444-444444444444";
const workflowId = "22222222-2222-4222-8222-222222222222";
const evidenceId = "e1000000-0000-4000-8000-0000000000c1";
const PEER = "a2222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({ canEscalate: true,
  canBulk: true }));

vi.mock("../../lib/platform-context", async (orig) => ({
  ...(await orig<typeof import("../../lib/platform-context")>()),
  useActiveSpaceId: () => "44444444-4444-4444-8444-444444444444",
  useOptionalPlatformContext: () => ({
    envelope: { capabilities: { REVIEW_ESCALATE: mocks.canEscalate, BULK_ACTIONS: mocks.canBulk } },
  }),
}));
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

type Action = { action: string; allowed: boolean; reason?: string };

const ALL = ["start", "pause", "resume", "request_info", "record_response", "approve", "reject", "reassign", "adjudicate", "archive", "reopen", "escalate"];

function viewerWith(allowed: string[], reasons: Record<string, string> = {}, isAssignee = true) {
  const actions: Action[] = ALL.map((a) =>
    allowed.includes(a) ? { action: a, allowed: true } : { action: a, allowed: false, reason: reasons[a] ?? reasons["*"] },
  );
  return { userId: "u-1", isAssignee, actions };
}

let workspace: Record<string, unknown>;
let decisions: Record<string, unknown>;
let postResponses: Record<string, (init?: RequestInit) => Response | Promise<Response>>;
const calls: Array<{ method: string; path: string; body: unknown; headers: Record<string, string> }> = [];
const fetchMock = vi.fn();

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function workspaceBody(
  opts: { lifecycle?: string; sla?: string; viewer?: unknown; paused?: boolean; assigned?: boolean; handoff?: unknown; escalation?: unknown } = {},
) {
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
    openEscalation: opts.escalation ?? null,
    allowedLifecycleTransitions: ["APPROVED", "REJECTED"],
    ...(opts.viewer !== undefined ? { viewer: opts.viewer } : {}),
    ...(opts.handoff !== undefined ? { handoff: opts.handoff } : {}),
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

const outcome = (o: Record<string, unknown>) => ({
  stageRecorded: "FIRST",
  statusChanged: true,
  reviewState: "resolved",
  nextRequirement: null,
  idempotent: false,
  ...o,
});

const wsPath = `/v1/reviewer-ops/workspace/${workflowId}?teamId=${teamId}`;
const decPath = `/v1/reviewer-ops/workspace/${workflowId}/decisions?teamId=${teamId}`;
const notesPath = `/v1/reviewer-ops/workspace/${workflowId}/notes?teamId=${teamId}`;
const actionPath = (a: string) => `/v1/reviewer-ops/reviews/${workflowId}/${a}`;
const decisionsPostPath = `/v1/reviewer-ops/workspace/${workflowId}/decisions`;
const escalationsPath = "/v1/reviewer-ops/escalations";
// Team remediation T-161 — a single Archive has its own route (never the bulk door).
const archivePath = `/v1/reviewer-ops/reviews/${workflowId}/archive`;
const stepUpStartPath = "/v1/identity-security/step-up/start";

const gets = (path: string) => calls.filter((c) => c.method === "GET" && c.path === path).length;
const posts = (path: string) => calls.filter((c) => c.method === "POST" && c.path === path);

beforeEach(() => {
  mocks.canEscalate = true;
  mocks.canBulk = true;
  // T-019 — Escalate is offered where the server's viewer.actions says so.
  workspace = workspaceBody({ viewer: viewerWith(["approve", "reject", "request_info", "pause", "escalate"], { "*": "not_started" }) });
  decisions = decisionsBody("first_required", "submit_first");
  postResponses = {};
  calls.length = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((v, k) => {
      headers[k] = v;
    });
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers });
    if (method === "GET" && path === wsPath) return json(200, workspace);
    if (method === "GET" && path === decPath) return json(200, decisions);
    if (method === "GET" && path === notesPath) return json(200, { workflowId, evidenceId, summary: { total: 0 }, items: [] });
    if (method === "GET" && path.startsWith("/v1/reviewer-ops/assignable-reviewers")) {
      return json(200, {
        reviewers: [
          { userId: "u-1", displayName: "Current Reviewer" },
          { userId: PEER, displayName: "Sam Peer" },
        ],
      });
    }
    if (method === "POST" && postResponses[path]) return postResponses[path]!(init);
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
  await screen.findByRole("heading", { name: "Next step" });
  await waitFor(() => expect(gets(decPath)).toBeGreaterThan(0));
  await waitFor(() => expect(document.querySelector('[data-section="reviewer-decision-lineage"]')?.getAttribute("data-decision-state")).not.toBe("loading"));
}

const action = (name: string) => document.querySelector(`[data-reviewer-action="${name}"]`) as HTMLButtonElement | null;
const form = () => document.querySelector("[data-decision-form]") as HTMLFormElement | null;
const choice = (kind: string) => document.querySelector(`[data-decision-choice="${kind}"]`) as HTMLButtonElement | null;
const formError = () => document.querySelector("[data-decision-form-error]")?.textContent ?? null;

/** Choose a verdict, type a rationale and submit through the ONE panel. */
async function decide(kind: string, rationale = "Looks consistent.") {
  const f = (await waitFor(() => {
    const el = form();
    expect(el).toBeTruthy();
    return el!;
  })) as HTMLFormElement;
  fireEvent.click(f.querySelector(`[data-decision-choice="${kind}"]`)!);
  fireEvent.change(f.querySelector("[data-decision-form-rationale]")!, { target: { value: rationale } });
  const submit = f.querySelector("[data-decision-form-submit]") as HTMLButtonElement;
  await waitFor(() => expect(submit.disabled).toBe(false));
  fireEvent.click(submit);
}

describe("one decision-entry flow", () => {
  it("the decision panel is the only verdict entry: no Approve / Reject / Request information buttons anywhere", async () => {
    await renderPage();
    expect(form()).toBeTruthy();
    for (const name of ["approve", "reject", "request_info"]) {
      expect(document.querySelector(`[data-reviewer-action="${name}"]`)).toBeNull();
    }
    expect(document.querySelector("[data-reviewer-action-reject]")).toBeNull();
    expect(document.querySelector("[data-reviewer-action-request-info]")).toBeNull();
    // Outside the decision form no button reads as a verdict.
    const outside = Array.from(document.querySelectorAll("button, a")).filter((el) => !form()!.contains(el));
    for (const el of outside) {
      expect(el.textContent ?? "").not.toMatch(/^(Approve|Reject|Request information|Request more information)/);
    }
    // The old grid and list are gone.
    expect(screen.queryByText("What you can do now")).toBeNull();
    expect(screen.queryByText("Reviewer actions")).toBeNull();
    expect(document.querySelector('[data-section="reviewer-adjudication"]')).toBeNull();
    // The choice is a radiogroup of canonical tabs.
    const group = form()!.querySelector('[role="radiogroup"]') as HTMLElement;
    expect(group.classList.contains("app-tabs")).toBe(true);
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual(["Approve (internal)", "Reject (internal)", "Request information"]);
    radios.forEach((r) => expect(r.classList.contains("app-tab")).toBe(true));
  });

  it.each([
    ["APPROVE", "Record approval", "Review approved (internal)."],
    ["REJECT", "Record rejection", "Review rejected (internal)."],
    ["REQUEST_INFO", "Request information", "Information requested. The review waits for a response."],
  ])("choosing %s posts the decisions route with that kind and one primary labelled by the choice", async (kind, label, success) => {
    postResponses[decisionsPostPath] = () => json(201, { ok: true, outcome: outcome({}) });
    await renderPage();
    fireEvent.click(choice(kind)!);
    const submit = form()!.querySelector("[data-decision-form-submit]") as HTMLButtonElement;
    expect(submit.textContent).toBe(label);
    expect(submit.classList.contains("app-primary-action")).toBe(true);
    expect(choice(kind)!.getAttribute("aria-checked")).toBe("true");
    await decide(kind, "Checked the custody log.");
    await screen.findByText(success);
    const sent = posts(decisionsPostPath);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toEqual({ teamId, decision: kind, rationale: "Checked the custody log." });
    for (const legacy of ["approve", "reject", "request-info"]) expect(posts(actionPath(legacy))).toHaveLength(0);
  });

  it("sends the chosen reason code and shows the lineage consequence before submit", async () => {
    decisions = decisionsBody("first_required", "submit_first", [], true);
    postResponses[decisionsPostPath] = () =>
      json(201, { ok: true, outcome: outcome({ statusChanged: false, reviewState: "second_required", nextRequirement: "second_review" }) });
    await renderPage();
    fireEvent.click(choice("APPROVE")!);
    expect(document.querySelector("[data-decision-consequence]")?.textContent).toBe(
      "Records the first review; an independent second reviewer must confirm.",
    );
    chooseListbox(form()!.querySelector("[data-decision-form-reason]"), "MISSING_CONTEXT");
    const wsBefore = gets(wsPath);
    const notesBefore = gets(notesPath);
    await decide("APPROVE");
    // A FIRST-only approval never reads as "approved".
    await screen.findByText(FIRST_ONLY_MESSAGE);
    expect(document.querySelector("[data-reviewer-action-notice]")!.textContent).not.toMatch(/approved/i);
    expect(posts(decisionsPostPath)[0]!.body).toMatchObject({ decision: "APPROVE", reasonCode: "MISSING_CONTEXT" });
    await waitFor(() => {
      expect(gets(wsPath)).toBeGreaterThan(wsBefore);
      expect(gets(notesPath)).toBeGreaterThan(notesBefore);
    });
  });

  it("a single-review final approval states the internal-only consequence", async () => {
    await renderPage();
    fireEvent.click(choice("APPROVE")!);
    expect(document.querySelector("[data-decision-consequence]")?.textContent).toBe(
      "Final decision — approved (internal), not a public authenticity statement.",
    );
  });

  it("a closed verdict kind is a disabled radio with its reason as help text", async () => {
    workspace = workspaceBody({ viewer: viewerWith(["request_info"], { approve: "second_stage_needs_reassignment", reject: "second_stage_needs_reassignment", "*": "not_started" }) });
    await renderPage();
    expect(choice("APPROVE")!.disabled).toBe(true);
    expect(choice("REJECT")!.disabled).toBe(true);
    expect(choice("REQUEST_INFO")!.disabled).toBe(false);
    expect(document.querySelector("[data-decision-choice-reasons]")?.textContent).toBe(
      "A different reviewer must make the second decision — reassign it.",
    );
  });

  it("a non-assignee sees no decision form, the blocked reason, and nothing to do", async () => {
    mocks.canEscalate = false;
    workspace = workspaceBody({ viewer: viewerWith([], { "*": "not_assignee" }, false) });
    await renderPage();
    expect(form()).toBeNull();
    expect(document.querySelector("[data-decision-blocked-banner]")?.textContent).toBe("Only the assigned reviewer can decide.");
    expect(document.querySelector("[data-reviewer-main-blocked-reason]")?.textContent).toBe("Only the assigned reviewer can decide.");
    expect(screen.getByText("There is nothing for you to do on this review right now.")).toBeTruthy();
  });

  it("the step-up challenge is answered through the shared modal and the decision is retried once with the challenge", async () => {
    let attempt = 0;
    postResponses[decisionsPostPath] = () => {
      attempt += 1;
      return attempt === 1
        ? json(401, { error: { code: "STEP_UP_REQUIRED", message: "step up", details: { purpose: "review.approve", resourceKind: "review_workflow", resourceId: workflowId } } })
        : json(201, { ok: true, outcome: outcome({}) });
    };
    postResponses[stepUpStartPath] = () => json(200, { challenge: { id: "challenge-1", status: "APPROVED" } });
    await renderPage();
    await decide("APPROVE");
    await screen.findByText("Review approved (internal).");
    const sent = posts(decisionsPostPath);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.headers["x-proovra-step-up-challenge-id"]).toBe("challenge-1");
    expect(posts(stepUpStartPath)[0]!.body).toMatchObject({ teamId, purpose: "review.approve" });
    expect(formError()).toBeNull();
  });

  it("a lost answer says to check before retrying (NETWORK_ERROR)", async () => {
    postResponses[decisionsPostPath] = () => Promise.reject(new TypeError("Failed to fetch"));
    await renderPage();
    await decide("REJECT");
    await waitFor(() => expect(formError()).toContain("connection dropped"));
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
    ["forbidden_wording", 403],
  ];

  it("every reason has its own message, and only review_already_resolved says 'already resolved'", () => {
    const messages = reasons.map(([reason, status]) => describeRefusal({ status, code: "REVIEW_DECISION_REFUSED", reason }, "fallback"));
    expect(new Set(messages).size).toBe(messages.length);
    messages.forEach((m, i) => {
      expect(m).not.toBe("fallback");
      if (reasons[i]![0] !== "review_already_resolved") expect(m).not.toMatch(/already resolved/i);
    });
  });

  it.each(reasons)("a decision refused with %s shows its message inside the panel", async (reason, status) => {
    postResponses[decisionsPostPath] = () =>
      json(status, { error: { code: "REVIEW_DECISION_REFUSED", message: "refused", details: { reason } } });
    await renderPage();
    const wsBefore = gets(wsPath);
    await decide("APPROVE");
    const expected = describeRefusal({ status, code: "REVIEW_DECISION_REFUSED", reason }, "x");
    await waitFor(() => expect(formError()).toBe(expected));
    expect(document.querySelector("[data-decision-form-error]")!.classList.contains("app-field-error")).toBe(true);
    // The typed rationale is kept for the retry, and the page rereads.
    expect((form()!.querySelector("[data-decision-form-rationale]") as HTMLTextAreaElement).value).toBe("Looks consistent.");
    await waitFor(() => expect(gets(wsPath)).toBeGreaterThan(wsBefore));
  });
});

describe("adjudication is the same panel", () => {
  it("in conflict the panel becomes the adjudication form and posts an adjudication kind", async () => {
    workspace = workspaceBody({ lifecycle: "ESCALATED", sla: "ESCALATED", viewer: viewerWith(["adjudicate"], { "*": "use_adjudication" }) });
    decisions = decisionsBody("conflict_detected", "submit_adjudication", [row("d1", "FIRST", "APPROVE", "a"), row("d2", "SECOND", "REJECT", "b")], true);
    postResponses[decisionsPostPath] = () =>
      json(200, { ok: true, outcome: outcome({ stageRecorded: "ADJUDICATION" }) });
    await renderPage();
    const panel = document.querySelector('[data-section="reviewer-decision-lineage"]') as HTMLElement;
    expect(panel.getAttribute("data-decision-panel-mode")).toBe("adjudication");
    expect(within(panel).getByRole("heading", { name: "Adjudication" })).toBeTruthy();
    // ONE form: no verdict radios, the adjudication kinds instead.
    expect(document.querySelectorAll("[data-decision-form]")).toHaveLength(1);
    expect(choice("APPROVE")).toBeNull();
    expect(form()!.getAttribute("data-decision-mode")).toBe("adjudication");
    expect(within(panel).getByText(/Approved \(internal\)/)).toBeTruthy();
    // Next step points at it.
    expect(action("go_to_decision")?.textContent).toBe("Go to adjudication");
    await decide("UPHOLD_FIRST", "First review is better supported.");
    await screen.findByText("Adjudication recorded. The review is resolved.");
    expect(posts(decisionsPostPath)[0]!.body).toMatchObject({
      teamId,
      decision: "UPHOLD_FIRST",
      reasonCode: "REVIEWER_DISAGREEMENT",
      rationale: "First review is better supported.",
    });
  });

  it("explains who can adjudicate when the viewer cannot, with no form", async () => {
    workspace = workspaceBody({ lifecycle: "ESCALATED", viewer: viewerWith([], { adjudicate: "adjudicator_not_independent", "*": "use_adjudication" }) });
    decisions = decisionsBody("conflict_detected", "blocked_not_adjudicator", [row("d1", "FIRST", "APPROVE", "a"), row("d2", "SECOND", "REJECT", "u-1")], true);
    await renderPage();
    const blocked = await waitFor(() => {
      const el = document.querySelector("[data-adjudication-blocked]");
      expect(el).toBeTruthy();
      return el!;
    });
    expect(blocked.textContent).toBe("Adjudication needs an owner or admin who made neither decision.");
    expect(form()).toBeNull();
  });
});

describe("Next step panel", () => {
  const primary = () => document.querySelector("[data-reviewer-next-step-primary] .app-primary-action") as HTMLElement | null;

  it("assigned, not started: Start review is the one primary and posts start", async () => {
    workspace = workspaceBody({ lifecycle: "ASSIGNED", viewer: viewerWith(["start", "pause"], { "*": "not_started" }) });
    await renderPage();
    expect(primary()?.textContent).toBe("Start review");
    expect(document.querySelectorAll("[data-reviewer-actions] .app-primary-action")).toHaveLength(1);
    fireEvent.click(primary()!);
    await waitFor(() => expect(posts(actionPath("start"))).toHaveLength(1));
  });

  it("in review and may decide: 'Go to decision' focuses the decision panel", async () => {
    await renderPage();
    const go = primary() as HTMLAnchorElement;
    expect(go.tagName).toBe("A");
    expect(go.textContent).toBe("Go to decision");
    expect(go.getAttribute("href")).toBe("#review-decision");
    fireEvent.click(go);
    await waitFor(() => expect(document.activeElement).toBe(choice("APPROVE")));
  });

  it("M focuses the decision panel with Request information preselected; C does nothing", async () => {
    await renderPage();
    fireEvent.keyDown(window, { key: "c" });
    expect(choice("APPROVE")!.getAttribute("aria-checked")).toBe("false");
    expect(posts(decisionsPostPath)).toHaveLength(0);
    fireEvent.keyDown(window, { key: "m" });
    await waitFor(() => expect(choice("REQUEST_INFO")!.getAttribute("aria-checked")).toBe("true"));
    expect(document.activeElement).toBe(choice("REQUEST_INFO"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("waiting for information: Record response is the primary and its dialog posts response-received", async () => {
    workspace = workspaceBody({
      lifecycle: "NEEDS_INFORMATION",
      viewer: viewerWith(["record_response", "pause"], { "*": "awaiting_response" }),
    });
    postResponses[actionPath("response-received")] = () => json(200, { ok: true, outcome: outcome({ reviewState: "first_required" }) });
    await renderPage();
    expect(primary()?.textContent).toBe("Record response");
    fireEvent.click(primary()!);
    const dialog = await screen.findByRole("dialog", { name: "Record the response" });
    const submit = within(dialog).getByRole("button", { name: "Record response" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    expect(submit.classList.contains("app-primary-action")).toBe(true);
    expect(within(dialog).getByRole("button", { name: "Cancel" }).classList.contains("app-secondary-action")).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Note (optional)"), { target: { value: "Custody log received." } });
    fireEvent.click(submit);
    await screen.findByText("Response recorded. The review can continue.");
    expect(posts(actionPath("response-received"))[0]!.body).toEqual({ teamId, note: "Custody log received." });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("a record-response refusal stays inside the dialog as a field error with the note kept", async () => {
    workspace = workspaceBody({ lifecycle: "NEEDS_INFORMATION", viewer: viewerWith(["record_response"]) });
    postResponses[actionPath("response-received")] = () =>
      json(403, { error: { code: "REVIEW_DECISION_REFUSED", message: "no", details: { reason: "not_assignee" } } });
    await renderPage();
    fireEvent.click(action("record_response")!);
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Note (optional)"), { target: { value: "kept" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Record response" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("Only the assigned reviewer");
    expect(alert.classList.contains("app-field-error")).toBe(true);
    expect((within(dialog).getByLabelText("Note (optional)") as HTMLTextAreaElement).value).toBe("kept");
    expect(document.querySelector("[data-reviewer-action-error]")).toBeNull();
  });

  it("handoff manager: 'Assign an independent second reviewer' opens the picker without the first reviewer", async () => {
    workspace = workspaceBody({
      viewer: viewerWith(["reassign"], { "*": "not_assignee" }, false),
      handoff: {
        requirement: "second_review",
        firstReviewerUserId: "u-1",
        firstReviewerDisplayName: "Current Reviewer",
        awaitingAssignment: true,
        eligibleReviewerCount: 1,
        staffing: "ok",
      },
    });
    await renderPage();
    expect(primary()?.textContent).toBe("Assign an independent second reviewer");
    // Not offered twice: no secondary Reassign beside it.
    expect(document.querySelectorAll('[data-reviewer-action="reassign"]')).toHaveLength(1);
    fireEvent.click(primary()!);
    const dialog = await screen.findByRole("dialog", { name: "Assign an independent second reviewer" });
    const picker = await waitFor(() => {
      const el = dialog.querySelector("[data-review-handoff-picker]");
      if (!el) throw new Error("picker not ready");
      return el;
    });
    chooseListbox(picker, PEER);
    fireEvent.click(within(dialog).getByRole("button", { name: "Assign second reviewer" }));
    await screen.findByText("Second reviewer assigned.");
    expect(posts(actionPath("reassign"))[0]!.body).toEqual({ teamId, newAssigneeUserId: PEER });
  });

  it("secondary actions appear only where allowed: Pause, Reassign, Escalate, Archive", async () => {
    workspace = workspaceBody({ viewer: viewerWith(["pause", "reassign", "archive", "escalate"], { "*": "not_assignee" }, false) });
    await renderPage();
    const secondary = document.querySelector("[data-reviewer-next-step-secondary]") as HTMLElement;
    const names = Array.from(secondary.querySelectorAll("[data-reviewer-action]")).map((b) => b.getAttribute("data-reviewer-action"));
    expect(names).toEqual(["pause", "reassign", "escalate", "archive"]);
    expect(action("archive")!.className).toBe("app-secondary-action app-secondary-action--danger");
    cleanup();
    mocks.canEscalate = false;
    workspace = workspaceBody({ viewer: viewerWith([], { "*": "not_assignee" }, false) });
    await renderPage();
    expect(document.querySelector("[data-reviewer-next-step-secondary]")).toBeNull();
    expect(action("escalate")).toBeNull();
    expect(action("archive")).toBeNull();
    // A Member allowed "archive" by the lifecycle but without bulk authority
    // (BULK_ACTIONS) is not offered a control the bulk CLOSE door refuses.
    cleanup();
    mocks.canBulk = false;
    workspace = workspaceBody({ viewer: viewerWith(["archive"], { "*": "not_assignee" }, false) });
    await renderPage();
    expect(action("archive")).toBeNull();
  });

  it("Escalate posts the escalations route with the console's body", async () => {
    await renderPage();
    fireEvent.click(action("escalate")!);
    const dialog = await screen.findByRole("dialog", { name: "Escalate this review" });
    const confirm = within(dialog).getByRole("button", { name: "Raise escalation" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    chooseListbox(dialog.querySelector("[data-reviewer-escalate-severity]"), "HIGH");
    fireEvent.change(within(dialog).getByLabelText("Summary"), { target: { value: "Custody gap needs a manager." } });
    fireEvent.click(confirm);
    await screen.findByText("Escalation raised.");
    expect(posts(escalationsPath)[0]!.body).toEqual({
      teamId,
      workflowId,
      reason: "REVIEWER_ESCALATED",
      severity: "HIGH",
      safeSummary: "Custody gap needs a manager.",
    });
  });

  it("Archive opens a confirm whose confirm button is app-danger-action", async () => {
    workspace = workspaceBody({ viewer: viewerWith(["archive"], { "*": "not_assignee" }, false) });
    postResponses[archivePath] = () => json(200, { projection: {} });
    await renderPage();
    fireEvent.click(action("archive")!);
    const dialog = await screen.findByRole("dialog", { name: "Archive this review?" });
    const confirm = within(dialog).getByRole("button", { name: "Archive review" });
    expect(confirm.className).toBe("app-danger-action");
    expect(within(dialog).queryAllByRole("button").filter((b) => b.classList.contains("app-primary-action"))).toHaveLength(0);
    fireEvent.click(confirm);
    await screen.findByText("Review archived.");
    expect(posts(archivePath)[0]!.body).toEqual({ teamId });
  });

  it("an archive refused row stays in the dialog", async () => {
    workspace = workspaceBody({ viewer: viewerWith(["archive"], { "*": "not_assignee" }, false) });
    postResponses[archivePath] = () =>
      json(409, { error: { code: "REVIEW_INVALID_TRANSITION", details: { reason: "second_review_pending" } } });
    await renderPage();
    fireEvent.click(action("archive")!);
    const dialog = await screen.findByRole("dialog", { name: "Archive this review?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Archive review" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "A second review or adjudication is still pending, so this review cannot be closed yet.",
    );
  });

  it("an older API without viewer falls back to the lifecycle rule", async () => {
    workspace = workspaceBody({ lifecycle: "NEEDS_INFORMATION" });
    await renderPage();
    expect(document.querySelector("[data-reviewer-actions-source]")?.getAttribute("data-reviewer-actions-source")).toBe("lifecycle");
    expect(action("record_response")?.disabled).toBe(false);
    expect(form()).toBeNull();
  });
});

describe("header, links and canonical controls", () => {
  it("shows one lifecycle badge and one SLA badge, the evidence ref as the title with a ghost Copy ID and a ghost back link to My reviews", async () => {
    workspace = workspaceBody({ lifecycle: "ESCALATED", sla: "ESCALATED", viewer: viewerWith([]) });
    await renderPage();
    const lifecycle = document.querySelectorAll("[data-reviewer-lifecycle-badge]");
    const sla = document.querySelectorAll("[data-reviewer-sla-badge]");
    expect(lifecycle).toHaveLength(1);
    expect(sla).toHaveLength(1);
    expect(lifecycle[0]!.textContent).toContain("Escalated");
    // Stage C (T-045): an open escalation never makes the deadline read
    // "SLA overdue"; the badge names the governing deadline (none here).
    expect(sla[0]!.textContent).not.toContain("overdue");
    expect(sla[0]!.textContent).toBe("No deadline");
    expect(sla[0]!.textContent).not.toMatch(/escalated/i);
    // TEAM-UI-SPEC (structure) — the evidence display reference IS the page
    // title; "Back to queue" became the "← My reviews" back link above it.
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Evidence ref 0000C1");
    expect(screen.getByRole("button", { name: "Copy full Evidence ID" }).classList.contains("app-ghost-action")).toBe(true);
    const back = screen.getByRole("link", { name: "My reviews" });
    expect(back.className).toBe("app-ghost-action");
    expect(back.getAttribute("href")).toBe("/review");
  });

  // TEAM-UI-SPEC (structure) — Evidence Detail's order: back link above the
  // title, the Next step strip FULL WIDTH (not a half-width card beside
  // Assignment), then decision (wider, left) | Assignment & SLA + Linked
  // evidence (right).
  it("renders ReviewPageHeader with a back link, the Next step strip full width, then decision | assignment + linked evidence", async () => {
    await renderPage();
    const header = document.querySelector("[data-review-page-header]") as HTMLElement;
    expect(header).not.toBeNull();
    const h1 = header.querySelector("h1") as HTMLElement;
    expect(h1.querySelector(":scope > .app-title-row")).not.toBeNull();
    expect(h1.previousElementSibling).toBeNull();
    const back = header.querySelector("[data-review-back-link]") as HTMLAnchorElement;
    expect(back.getAttribute("href")).toBe("/review");
    expect(back.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const strip = document.querySelector("[data-reviewer-actions]") as HTMLElement;
    expect(strip.getAttribute("data-reviewer-next-step-layout")).toBe("strip");
    const grid = document.querySelector("[data-reviewer-inspector-grid]") as HTMLElement;
    expect(grid.contains(strip)).toBe(false);
    expect(strip.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(header.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const main = grid.querySelector(".review-inspector-columns__main") as HTMLElement;
    const side = grid.querySelector(".review-inspector-columns__side") as HTMLElement;
    expect(main.querySelector('[data-section="reviewer-decision-lineage"]')).not.toBeNull();
    expect(within(side).getByRole("heading", { name: "Assignment & SLA" })).toBeTruthy();
    expect(within(side).getByRole("heading", { name: "Linked evidence" })).toBeTruthy();
    // The decision panel stays the single verdict entry.
    expect(document.querySelectorAll('[data-section="reviewer-decision-lineage"]')).toHaveLength(1);
  });

  it("linked artifacts: Open evidence detail and downloads secondary, Reports queue / Escalations ghost", async () => {
    await renderPage();
    const evidence = document.querySelector('[data-reviewer-links-group="evidence"]') as HTMLElement;
    const goto = document.querySelector('[data-reviewer-links-group="goto"]') as HTMLElement;
    expect(evidence.querySelectorAll(".app-primary-action")).toHaveLength(0);
    expect(within(evidence).getByText("Open evidence detail").className).toBe("app-secondary-action");
    expect(within(goto).getByText("Reports queue").className).toBe("app-ghost-action");
    expect(within(goto).getByText("Escalations").className).toBe("app-ghost-action");
    expect(screen.getByRole("button", { name: "Add note" }).className).toBe("app-secondary-action app-secondary-action--filled");
  });

  it("no ui-button inside the inspector, every button carries a canonical class, and no inline colour on a control", async () => {
    workspace = workspaceBody({ viewer: viewerWith(["approve", "reject", "request_info", "pause", "reassign", "archive"], { "*": "not_started" }) });
    await renderPage();
    expect(document.querySelectorAll(".ui-button, [data-ui-button]")).toHaveLength(0);
    const CANONICAL = /\b(app-primary-action|app-secondary-action|app-ghost-action|app-danger-action|app-tab|app-listbox__trigger)\b/;
    const buttons = Array.from(document.body.querySelectorAll("button"));
    expect(buttons.length).toBeGreaterThan(5);
    for (const b of buttons) {
      expect(b.className, `${b.outerHTML.slice(0, 120)}`).toMatch(CANONICAL);
      const style = b.getAttribute("style") ?? "";
      expect(style, b.outerHTML.slice(0, 120)).not.toMatch(/(^|;)\s*(background|color|border|box-shadow)\s*:/);
    }
    // At most one primary per panel.
    for (const panel of Array.from(document.querySelectorAll(".app-panel"))) {
      expect(panel.querySelectorAll(".app-primary-action").length).toBeLessThanOrEqual(1);
    }
  });
});
