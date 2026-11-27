/**
 * Stage D — the Review page and its FOCUS MODE (`/reviewer-ops/[id]?mode=focus`).
 *
 *   T-077  focus mode is a layout of the Review page: the same decision panel
 *          (the ONE `[data-decision-form]`, posting the canonical door), the
 *          same Next step strip and Escalate dialog; J/K move within the Inbox
 *          view; A/R/I only preselect a verdict; E opens Escalate; the stage A
 *          guarantees (T-001…T-006) hold on it.
 *   T-076  the inline preview reads the `/parts` preview contract and renders
 *          an <img> / <iframe>; a non-previewable file says so.
 *   T-074  Back returns to the Inbox view the review came from.
 *   T-090  card titles are h2 (no skipped level); every disabled decision
 *          submit says why; the choice is a radio group.
 *   T-093  one integrity-limits sentence in the library's words.
 *
 * Real page, real apiFetch over a stubbed fetch, RTL cleanup().
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const nav = vi.hoisted(() => ({ search: "mode=focus&from=inbox&view=OVERDUE", push: vi.fn(), replace: vi.fn() }));
vi.mock("../../lib/platform-context", async (orig) => ({
  ...(await orig<typeof import("../../lib/platform-context")>()),
  useActiveSpaceId: () => "44444444-4444-4444-8444-444444444444",
  useOptionalPlatformContext: () => ({
    envelope: { user: { id: "u-1" }, capabilities: { REVIEW_ESCALATE: true, BULK_ACTIONS: true } },
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
  useRouter: () => ({ push: nav.push, replace: nav.replace, back: () => {} }),
  useSearchParams: () => new URLSearchParams(nav.search),
  usePathname: () => "/reviewer-ops/22222222-2222-4222-8222-222222222222",
  useParams: () => ({ reviewId: "22222222-2222-4222-8222-222222222222" }),
}));

import ReviewWorkspacePage from "../../app/(app)/reviewer-ops/[reviewId]/page";
import { FIRST_ONLY_MESSAGE } from "../../app/(app)/reviewer-ops/[reviewId]/_components/inspector-model";
import { reviewStringScanViolations } from "./_review-string-scan";
import { EVIDENCE_LIBRARY_LEGAL_BOUNDARY } from "../../app/(app)/evidence/lib/evidence-library-formatters";

const teamId = "44444444-4444-4444-8444-444444444444";
const workflowId = "22222222-2222-4222-8222-222222222222";
const NEXT = "33333333-3333-4333-8333-333333333333";
const evidenceId = "e1000000-0000-4000-8000-0000000000c1";
const ALL = ["start", "pause", "resume", "request_info", "record_response", "approve", "reject", "reassign", "adjudicate", "archive", "reopen", "escalate"];

function viewerWith(allowed: string[], reasons: Record<string, string> = {}, isAssignee = true) {
  return {
    userId: "u-1",
    isAssignee,
    actions: ALL.map((a) => (allowed.includes(a) ? { action: a, allowed: true } : { action: a, allowed: false, reason: reasons[a] ?? reasons["*"] ?? "invalid_transition" })),
  };
}

function workspaceBody(lifecycle: string, viewer: unknown) {
  return {
    projection: {
      workflowId,
      evidenceId,
      lifecycleState: lifecycle,
      assignedToUserId: "u-1",
      assignedAtUtc: "2026-11-20T10:00:00.000Z",
      priority: "NORMAL",
      slaPausedAtUtc: null,
      pausedReason: null,
      slaRollupState: "HEALTHY",
      slaDimensions: [],
    },
    openEscalation: null,
    allowedLifecycleTransitions: [],
    viewer,
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let workspace: Record<string, unknown>;
let parts: unknown;
let coding: unknown = {};
let postResponses: Record<string, () => Response>;
const calls: Array<{ method: string; path: string; body: unknown }> = [];
const decisionsPostPath = `/v1/reviewer-ops/workspace/${workflowId}/decisions`;

beforeEach(() => {
  nav.search = "mode=focus&from=inbox&view=OVERDUE";
  nav.push.mockReset();
  nav.replace.mockReset();
  workspace = workspaceBody("IN_REVIEW", viewerWith(["approve", "reject", "request_info", "escalate", "pause"]));
  parts = { parts: [{ partIndex: 0, isPrimary: true, previewable: true, mimeType: "image/png", previewUrl: "https://s3.example/presigned.png", displayName: "photo.png" }] };
  coding = {};
  postResponses = {};
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, "");
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method === "GET" && path === `/v1/reviewer-ops/workspace/${workflowId}?teamId=${teamId}`) return json(200, workspace);
      if (method === "GET" && path === `/v1/reviewer-ops/workspace/${workflowId}/decisions?teamId=${teamId}`) {
        return json(200, {
          workflowId,
          evidenceId,
          state: "first_required",
          secondReviewRequirement: { required: false, reason: null },
          callerContext: { userId: "u-1", teamRole: "MEMBER", isAdjudicator: false, callerIsFirstReviewer: false, nextAction: "submit_first" },
          decisions: [],
        });
      }
      if (method === "GET" && path === `/v1/evidence/${evidenceId}/parts`) return json(200, parts);
      if (method === "GET" && path.startsWith(`/v1/reviewer/work/${workflowId}/coding`)) return json(200, coding);
      if (method === "GET" && path.startsWith("/v1/coding/schemas/schema-1")) return json(200, { schema: { id: "schema-1", fields: [{ id: "f1", key: "relevance", label: "Relevance", fieldType: "TEXT", required: true, options: null, order: 1 }] } });
      if (method === "GET" && path.startsWith(`/v1/reviewer-ops/workspace/${workflowId}/notes`)) return json(200, { workflowId, evidenceId, summary: { total: 0 }, items: [] });
      if (method === "GET" && path.startsWith("/v1/reviewer-ops/queue?")) {
        return json(200, { rows: [{ workflowId, evidenceId }, { workflowId: NEXT, evidenceId: "e2" }].map((r) => ({ ...r, lifecycleState: "IN_REVIEW", priority: "NORMAL", assignedToUserId: null })), nextCursor: null });
      }
      if (method === "POST" && postResponses[path]) return postResponses[path]!();
      if (method === "POST") return json(200, { ok: true });
      return json(200, {});
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderPage() {
  render(<ReviewWorkspacePage />);
  await screen.findByRole("heading", { name: "Next step" });
  await waitFor(() => expect(document.querySelector('[data-section="reviewer-decision-lineage"]')?.getAttribute("data-decision-state")).toBe("first_required"));
}
const choice = (kind: string) => document.querySelector(`[data-decision-choice="${kind}"]`) as HTMLButtonElement | null;

describe("T-077 — focus mode is the Review page's layout", () => {
  it("mounts the one decision form, the evidence and the work side by side; no separate workspace rail", async () => {
    await renderPage();
    expect(document.querySelector('[data-review-page][data-review-mode="focus"]')).not.toBeNull();
    expect(document.querySelector("[data-review-focus]")).not.toBeNull();
    expect(document.querySelectorAll("[data-decision-form]")).toHaveLength(1);
    const focus = document.querySelector("[data-review-focus]") as HTMLElement;
    expect(focus.querySelector("[data-review-evidence-preview]")).not.toBeNull();
    expect(focus.querySelector("[data-decision-form]")).not.toBeNull();
    // The workspace's rail, ribbon and duplicated role chip are gone.
    expect(document.body.textContent).not.toMatch(/Role: |Workspace ribbon|Open my queue/);
    expect(document.querySelector("[data-reviewer-workspace]")).toBeNull();
    // The layout toggle says what it does.
    const toggle = document.querySelector("[data-review-focus-toggle]") as HTMLButtonElement;
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.textContent).toBe("Leave focus mode");
  });

  it("records through the canonical door and reports a first-of-two decision as such (T-001, T-003)", async () => {
    postResponses[decisionsPostPath] = () =>
      json(201, { outcome: { stageRecorded: "FIRST", statusChanged: false, reviewState: "second_required", nextRequirement: "second_review", idempotent: false } });
    await renderPage();
    fireEvent.click(choice("REJECT")!);
    fireEvent.change(document.querySelector("[data-decision-form-rationale]")!, { target: { value: "Custody gap at upload" } });
    fireEvent.click(document.querySelector("[data-decision-form-submit]")!);
    await screen.findByText(FIRST_ONLY_MESSAGE);
    const sent = calls.filter((c) => c.method === "POST");
    expect(sent.map((c) => c.path)).toEqual([decisionsPostPath]);
    expect(sent[0]!.body).toMatchObject({ teamId, decision: "REJECT", rationale: "Custody gap at upload" });
  });

  it("a refusal keeps the choice, the typed text and an inline alert (T-002)", async () => {
    postResponses[decisionsPostPath] = () => json(409, { error: { code: "decision_not_allowed", details: { reason: "stale_decision" } } });
    await renderPage();
    fireEvent.click(choice("APPROVE")!);
    fireEvent.change(document.querySelector("[data-decision-form-rationale]")!, { target: { value: "Everything reconciles" } });
    fireEvent.click(document.querySelector("[data-decision-form-submit]")!);
    const alert = await waitFor(() => {
      const el = document.querySelector("[data-decision-form] [role=alert]");
      expect(el).toBeTruthy();
      return el!;
    });
    expect(alert.textContent).toMatch(/changed while you were working/);
    expect((document.querySelector("[data-decision-form-rationale]") as HTMLTextAreaElement).value).toBe("Everything reconciles");
  });

  it("an assigned review offers Start (S) as the primary (T-004)", async () => {
    workspace = workspaceBody("ASSIGNED", viewerWith(["start", "escalate"], { approve: "not_started", reject: "not_started", request_info: "not_started" }));
    render(<ReviewWorkspacePage />);
    await screen.findByRole("heading", { name: "Next step" });
    const start = document.querySelector('[data-reviewer-next-step-primary] [data-reviewer-action="start"]') as HTMLButtonElement;
    expect(start.textContent).toBe("Start review");
    fireEvent.keyDown(window, { key: "s" });
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === `/v1/reviewer-ops/reviews/${workflowId}/start`)).toBe(true));
  });

  it("A / R / I only preselect a verdict (nothing is submitted); E opens the shared Escalate dialog (T-005, T-006)", async () => {
    await renderPage();
    fireEvent.keyDown(window, { key: "a" });
    await waitFor(() => expect(choice("APPROVE")!.getAttribute("aria-checked")).toBe("true"));
    fireEvent.keyDown(window, { key: "r" });
    await waitFor(() => expect(choice("REJECT")!.getAttribute("aria-checked")).toBe("true"));
    fireEvent.keyDown(window, { key: "i" });
    await waitFor(() => expect(choice("REQUEST_INFO")!.getAttribute("aria-checked")).toBe("true"));
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    fireEvent.keyDown(window, { key: "e" });
    const dialog = await screen.findByRole("dialog", { name: "Escalate this review" });
    expect(dialog.querySelector("[data-reviewer-escalate-independence]")?.textContent).toMatch(/does not change who can decide the review/);
  });

  it("J moves to the next review of the Inbox view, staying in focus mode; K at the start says so", async () => {
    await renderPage();
    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith(`/reviewer-ops/${NEXT}?from=inbox&view=OVERDUE&mode=focus`));
    expect(calls.find((c) => c.path.startsWith("/v1/reviewer-ops/queue?"))!.path).toContain("queue=OVERDUE");
    fireEvent.keyDown(window, { key: "k" });
    await screen.findByText("No more reviews in this view.");
  });

  it("the help lists the keys the page registered, generated from the keymap (T-094)", async () => {
    await renderPage();
    fireEvent.keyDown(window, { key: "?" });
    const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    const keys = Array.from(dialog.querySelectorAll("[data-reviewer-shortcut-key]")).map((k) => k.getAttribute("data-reviewer-shortcut-key"));
    // Start is not open on an in-review review, so S is not listed.
    expect(keys).toEqual(["J", "K", "A", "R", "I", "E", "F", "?", "Esc"]);
  });
});

describe("T-076 — the inline preview reads the /parts contract", () => {
  it("an image part renders an <img> from its previewUrl", async () => {
    await renderPage();
    const preview = await waitFor(() => {
      const img = document.querySelector("[data-review-evidence-preview] img") as HTMLImageElement | null;
      expect(img).toBeTruthy();
      return img!;
    });
    expect(preview.getAttribute("src")).toBe("https://s3.example/presigned.png");
    expect(calls.some((c) => c.path === `/v1/evidence/${evidenceId}/parts`)).toBe(true);
    expect(document.body.textContent).not.toContain("Evidence bytes are not yet available");
  });

  it("a PDF renders an <iframe>", async () => {
    parts = { parts: [{ partIndex: 0, isPrimary: true, previewable: true, mimeType: "application/pdf", previewUrl: "https://s3.example/doc.pdf" }] };
    await renderPage();
    await waitFor(() => expect(document.querySelector("[data-review-evidence-preview] iframe")).toBeTruthy());
  });

  it("a non-previewable file says it is not previewable; a policy refusal says so", async () => {
    parts = { parts: [{ partIndex: 0, isPrimary: true, previewable: false, mimeType: "application/zip", previewUrl: null }] };
    await renderPage();
    await waitFor(() =>
      expect(document.querySelector("[data-media-viewer-unavailable]")?.getAttribute("data-media-viewer-unavailable")).toBe("not_previewable"),
    );
    expect(document.querySelector("[data-review-evidence-preview]")!.textContent).toMatch(/not previewable/);
    cleanup();
    parts = { parts: [{ partIndex: 0, isPrimary: true, previewable: true, mimeType: "image/png", previewUrl: null }] };
    await renderPage();
    await waitFor(() =>
      expect(document.querySelector("[data-media-viewer-unavailable]")?.getAttribute("data-media-viewer-unavailable")).toBe("policy"),
    );
  });
});

describe("standard layout — T-074 / T-090 / T-093", () => {
  it("Back returns to the Inbox view the review was opened from", async () => {
    nav.search = "from=inbox&view=OVERDUE";
    await renderPage();
    const back = document.querySelector("[data-review-back-link]") as HTMLAnchorElement;
    expect(back.getAttribute("href")).toBe("/review?view=OVERDUE");
    expect(back.textContent).toContain("Overdue");
  });

  it("no skipped heading level; the decision is a radio group; a disabled submit says why", async () => {
    nav.search = "";
    await renderPage();
    const levels = Array.from(document.querySelectorAll("h1, h2, h3, h4")).map((h) => Number(h.tagName.slice(1)));
    expect(levels[0]).toBe(1);
    for (let i = 1; i < levels.length; i += 1) {
      expect(levels[i]! - levels[i - 1]!, `heading ${i}`).toBeLessThanOrEqual(1);
    }
    expect(screen.getByRole("heading", { level: 2, name: "Next step" })).toBeTruthy();
    expect(screen.getByRole("radiogroup")).toBeTruthy();
    const submit = document.querySelector("[data-decision-form-submit]") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    const reasonId = submit.getAttribute("aria-describedby")!;
    expect(document.getElementById(reasonId)!.textContent).toBe("Choose a decision first.");
    const addNote = screen.getByRole("button", { name: "Add note" }) as HTMLButtonElement;
    expect(addNote.disabled).toBe(true);
    expect(document.getElementById(addNote.getAttribute("aria-describedby")!)!.textContent).toMatch(/Write the note first/);
  });

  it("one integrity-limits sentence in the Evidence Library's words", async () => {
    nav.search = "";
    await renderPage();
    const limits = document.querySelectorAll("[data-review-integrity-limits]");
    expect(limits).toHaveLength(1);
    expect(limits[0]!.textContent).toBe(EVIDENCE_LIBRARY_LEGAL_BOUNDARY);
    expect(within(document.querySelector("[data-review-header]") as HTMLElement).getByText("Open evidence")).toBeTruthy();
  });
});

// Keep act imported for helpers that may need it later.
void act;

describe("T-084 — the Review page string scan (both layouts)", () => {
  for (const search of ["", "mode=focus&from=inbox&view=ESCALATED"]) {
    it(`no raw enum, code, engine wording or id fragment (${search || "standard"})`, async () => {
      nav.search = search;
      workspace = {
        ...workspaceBody("ESCALATED", viewerWith(["approve", "reject", "request_info", "pause"])),
        openEscalation: {
          id: "esc-1",
          reason: "REVIEW_OVERDUE",
          severity: "WARNING",
          status: "OPEN",
          safeSummary: "Review past due — automatic escalation by reviewer ops reconcile.",
          createdAt: "2026-11-20T10:00:00.000Z",
          assignedToUserId: null,
        },
        activeEscalationCount: 1,
      };
      await renderPage();
      const text = document.body.textContent ?? "";
      expect(reviewStringScanViolations(text)).toEqual([]);
      // The escalation line is the catalog summary of the governing escalation.
      expect(document.querySelector("[data-review-header-escalation]")!.textContent).toBe("Escalation: Warning (1 active)");
    });
  }
});

describe("T-082 — coding on the shared Review page", () => {
  for (const search of ["", "mode=focus&from=inbox&view=MY_REVIEWS"]) {
    it(`a review with a bound schema shows the coding fields (${search || "standard"})`, async () => {
      nav.search = search;
      coding = { schemaBinding: { id: "schema-1", label: "Privilege review", version: 1, status: "PUBLISHED" }, values: [], coverage: { unfulfilledFieldIds: ["f1"] } };
      await renderPage();
      const panel = await waitFor(() => {
        const el = document.querySelector("[data-review-coding-panel]");
        expect(el).toBeTruthy();
        return el as HTMLElement;
      });
      expect(panel.querySelector("[data-coding-panel]")).not.toBeNull();
      expect(panel.textContent).toContain("Relevance");
      expect(panel.textContent).toMatch(/do not decide it/);
    });
  }
});
