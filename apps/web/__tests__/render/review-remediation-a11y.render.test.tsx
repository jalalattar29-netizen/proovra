/**
 * Review remediation 2026-11-27 — keyboard and accessibility of the Review
 * surfaces, driven with KEYBOARD EVENTS ONLY (user-event `tab()` /
 * `keyboard()`; no clicks on the controls under test):
 *
 *   1. the decision form's radio group: Tab reaches it (checked radio, else
 *      the first ENABLED one), arrows move AND select among enabled choices
 *      (skip closed, wrap), Home/End, Space, then rationale and submit follow
 *      in tab order and Enter / Space on submit submits;
 *   2. the review page's dialogs (Escalate, Request independent review,
 *      Reassign / Assign second reviewer, Pause, Archive): initial focus on
 *      the first meaningful field, Tab / Shift+Tab stay inside, Escape closes
 *      when not busy and not while busy, focus returns to the opener;
 *   3. F-23 — the assistant's inline entry replaces the floating launcher on
 *      a page that renders it, opens the same panel, and returns focus.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { useState, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DecisionForm } from "../../app/(app)/reviewer-ops/[reviewId]/_components/DecisionPanel";
import {
  ArchiveDialog,
  EscalateDialog,
  ReassignDialog,
  RequestIndependentReviewDialog,
} from "../../app/(app)/reviewer-ops/[reviewId]/_components/InspectorDialogs";
import { deriveActions, type Viewer } from "../../app/(app)/reviewer-ops/[reviewId]/_components/inspector-model";
import { ReviewerReasonModal } from "../../app/(app)/reviewer-ops/components/ReviewerReasonModal";
import { ProovraChatWidget } from "../../components/ai/ProovraChatWidget";
import { AssistantInlineEntry } from "../../components/ai/AssistantInlineEntry";
import { ReviewPageHeader } from "../../components/reviewer-experience/ReviewPageHeader";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/reviewer-ops/r-1",
  useParams: () => ({}),
}));

const teamId = "44444444-4444-4444-8444-444444444444";
const workflowId = "22222222-2222-4222-8222-222222222222";

const ALL = ["start", "pause", "resume", "request_info", "record_response", "approve", "reject", "reassign", "adjudicate", "archive", "reopen", "escalate"];
function viewerWith(allowed: string[]): Viewer {
  return {
    userId: "u-1",
    isAssignee: true,
    actions: ALL.map((a) =>
      allowed.includes(a)
        ? { action: a as never, allowed: true }
        : { action: a as never, allowed: false, reason: "invalid_transition" },
    ),
  };
}
const actionsFor = (allowed: string[]) =>
  deriveActions({ viewer: viewerWith(allowed), lifecycleState: "IN_REVIEW", paused: false });

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: unknown) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (path.startsWith("/v1/reviewer-ops/assignable-reviewers")) {
      return json(200, {
        reviewers: [
          { userId: "u-2", displayName: "Second Reviewer With A Deliberately Long Display Name", placed: true },
          { userId: "u-3", displayName: "Third Reviewer", placed: true },
        ],
      });
    }
    if (path.includes("/decisions")) return json(200, { independentReviewerCount: 2 });
    if (path.startsWith("/v1/ai/availability")) {
      return json(200, { data: { available: true, decision: "ALLOWED", groundedAnswersAvailable: true } });
    }
    return json(200, {});
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const radio = (kind: string) => document.querySelector(`[data-decision-choice="${kind}"]`) as HTMLButtonElement;
const active = () => document.activeElement as HTMLElement | null;

// ---------------------------------------------------------------------------
// 1. Decision form
// ---------------------------------------------------------------------------

function DecisionHarness(props: { allowed: string[]; onSubmit: (b: unknown) => Promise<null> }) {
  return (
    <div>
      <button type="button" data-before>
        Before
      </button>
      <DecisionForm
        mode="decision"
        stage="FIRST"
        actions={actionsFor(props.allowed)}
        reviewState="first_required"
        secondRequired={false}
        onSubmit={props.onSubmit}
      />
    </div>
  );
}

describe("decision form — keyboard only", () => {
  it("Tab lands on the first ENABLED choice; arrows select among enabled choices, skip closed ones and wrap; Home/End", async () => {
    const user = userEvent.setup();
    // Approve is closed: the group's tab stop is Reject.
    render(<DecisionHarness allowed={["reject", "request_info"]} onSubmit={async () => null} />);
    (document.querySelector("[data-before]") as HTMLElement).focus();
    await user.tab();
    expect(active()).toBe(radio("REJECT"));
    expect(radio("APPROVE").disabled).toBe(true);
    expect(radio("REJECT").getAttribute("aria-checked")).toBe("false");

    await user.keyboard("{ArrowRight}");
    expect(active()).toBe(radio("REQUEST_INFO"));
    expect(radio("REQUEST_INFO").getAttribute("aria-checked")).toBe("true");

    // Wraps past the end and SKIPS the closed Approve.
    await user.keyboard("{ArrowDown}");
    expect(active()).toBe(radio("REJECT"));
    expect(radio("REJECT").getAttribute("aria-checked")).toBe("true");
    expect(radio("REQUEST_INFO").getAttribute("aria-checked")).toBe("false");

    await user.keyboard("{ArrowLeft}");
    expect(active()).toBe(radio("REQUEST_INFO"));
    await user.keyboard("{ArrowUp}");
    expect(active()).toBe(radio("REJECT"));

    await user.keyboard("{End}");
    expect(active()).toBe(radio("REQUEST_INFO"));
    expect(radio("REQUEST_INFO").getAttribute("aria-checked")).toBe("true");
    await user.keyboard("{Home}");
    expect(active()).toBe(radio("REJECT"));
    expect(radio("REJECT").getAttribute("aria-checked")).toBe("true");

    // Exactly one tab stop in the group: the checked radio.
    const stops = Array.from(document.querySelectorAll("[data-decision-choice]")).filter((el) => (el as HTMLElement).tabIndex === 0);
    expect(stops).toEqual([radio("REJECT")]);
  });

  it("Space selects; rationale and submit follow in tab order; Enter on submit records the decision", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => null);
    render(<DecisionHarness allowed={["approve", "reject", "request_info"]} onSubmit={onSubmit} />);
    (document.querySelector("[data-before]") as HTMLElement).focus();

    await user.tab();
    expect(active()).toBe(radio("APPROVE"));
    expect(radio("APPROVE").getAttribute("aria-checked")).toBe("false");
    await user.keyboard(" ");
    expect(radio("APPROVE").getAttribute("aria-checked")).toBe("true");

    await user.tab();
    expect(active()).toBe(document.querySelector("[data-decision-form-rationale]"));
    await user.keyboard("Custody log matches the capture record.");

    // The optional category, then the submit.
    await user.tab();
    expect(active()?.hasAttribute("data-decision-form-reason")).toBe(true);
    await user.tab();
    const submit = document.querySelector("[data-decision-form-submit]") as HTMLButtonElement;
    expect(active()).toBe(submit);
    expect(submit.disabled).toBe(false);

    await user.keyboard("{Enter}");
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      decision: "APPROVE",
      reasonCode: undefined,
      rationale: "Custody log matches the capture record.",
    });
  });

  it("Space on the submit button submits too", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => null);
    render(<DecisionHarness allowed={["approve", "reject", "request_info"]} onSubmit={onSubmit} />);
    (document.querySelector("[data-before]") as HTMLElement).focus();
    await user.tab();
    await user.keyboard("{ArrowRight}"); // Reject, selected by the arrow
    expect(radio("REJECT").getAttribute("aria-checked")).toBe("true");
    await user.tab();
    await user.keyboard("Capture hash does not match.");
    await user.tab();
    await user.tab();
    await user.keyboard(" ");
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ decision: "REJECT", rationale: "Capture hash does not match." }));
  });

  it("a checked choice that closes on reload never strands the tab stop", async () => {
    const user = userEvent.setup();
    const props = { mode: "decision" as const, stage: "FIRST" as const, reviewState: "first_required", secondRequired: false, onSubmit: async () => null };
    const { rerender } = render(
      <div>
        <button type="button" data-before>Before</button>
        <DecisionForm {...props} actions={actionsFor(["approve", "reject", "request_info"])} />
      </div>,
    );
    (document.querySelector("[data-before]") as HTMLElement).focus();
    await user.tab();
    await user.keyboard(" "); // Approve checked
    rerender(
      <div>
        <button type="button" data-before>Before</button>
        <DecisionForm {...props} actions={actionsFor(["reject", "request_info"])} />
      </div>,
    );
    (document.querySelector("[data-before]") as HTMLElement).focus();
    await user.tab();
    expect(active()).toBe(radio("REJECT"));
  });

  it("long choice labels and errors wrap instead of clipping", () => {
    render(<DecisionHarness allowed={["approve", "reject", "request_info"]} onSubmit={async () => null} />);
    const group = document.querySelector("[data-decision-form-decision]") as HTMLElement;
    expect(group.style.overflow).toBe("visible");
    expect(group.style.flexWrap).toBe("wrap");
    expect(radio("APPROVE").style.whiteSpace).toBe("normal");
    expect(radio("APPROVE").style.overflowWrap).toBe("anywhere");
    expect(radio("APPROVE").style.height).toBe("auto");
  });
});

// ---------------------------------------------------------------------------
// 2. Dialogs
// ---------------------------------------------------------------------------

type DialogCase = {
  name: string;
  opener: string;
  /** The dialog's root testid (Modal data-matter-modal). */
  testid: string;
  /** Selector of the expected initial focus. */
  initial: string;
  /** Renders the dialog for `open`; `onSubmit` may be held pending. */
  render: (p: { open: boolean; onCancel: () => void; onSubmit: (...a: unknown[]) => Promise<string | null> }) => ReactElement;
  /** Fills the required field (keyboard) so the confirm is enabled. */
  fill?: string;
};

const DIALOGS: DialogCase[] = [
  {
    name: "Escalate",
    opener: "Escalate",
    testid: "reviewer-escalate",
    initial: "[data-reviewer-escalate-reason]",
    render: (p) => <EscalateDialog open={p.open} onCancel={p.onCancel} onSubmit={p.onSubmit as never} teamId={teamId} workflowId={workflowId} />,
    fill: "[data-reviewer-escalate-summary]",
  },
  {
    name: "Request independent review",
    opener: "Request independent review",
    testid: "reviewer-request-independent",
    initial: "[data-reviewer-request-independent-note]",
    render: (p) => (
      <RequestIndependentReviewDialog open={p.open} onCancel={p.onCancel} onSubmit={p.onSubmit as never} teamId={teamId} workflowId={workflowId} />
    ),
    fill: "[data-reviewer-request-independent-note]",
  },
  {
    name: "Reassign",
    opener: "Reassign",
    testid: "reviewer-reassign",
    initial: "[data-reviewer-reassign-picker]",
    render: (p) => (
      <ReassignDialog
        open={p.open}
        teamId={teamId}
        handoff={false}
        excludeUserId={null}
        currentAssigneeUserId="u-1"
        onCancel={p.onCancel}
        onSubmit={p.onSubmit as never}
        describeError={() => "Could not load."}
      />
    ),
  },
  {
    name: "Assign second reviewer",
    opener: "Assign second reviewer",
    testid: "reviewer-reassign",
    initial: "[data-reviewer-reassign-picker]",
    render: (p) => (
      <ReassignDialog
        open={p.open}
        teamId={teamId}
        handoff
        excludeUserId="u-1"
        currentAssigneeUserId="u-1"
        onCancel={p.onCancel}
        onSubmit={p.onSubmit as never}
        describeError={() => "Could not load."}
      />
    ),
  },
  {
    name: "Pause",
    opener: "Pause",
    testid: "reviewer-reason-pause",
    initial: "[data-reviewer-reason-modal] textarea",
    render: (p) => <ReviewerReasonModal kind="PAUSE" open={p.open} onCancel={p.onCancel} onSubmit={p.onSubmit as never} />,
    fill: "[data-reviewer-reason-modal] textarea",
  },
  {
    name: "Archive (confirm)",
    opener: "Archive review…",
    testid: "reviewer-archive",
    initial: "[data-reviewer-archive-note]",
    render: (p) => <ArchiveDialog open={p.open} onCancel={p.onCancel} onSubmit={p.onSubmit as never} />,
    fill: "[data-reviewer-archive-note]",
  },
];

function DialogHost({ c, onSubmit }: { c: DialogCase; onSubmit: (...a: unknown[]) => Promise<string | null> }) {
  const [open, setOpen] = useState(false);
  return (
    <main>
      <button type="button" data-page-before>
        Page control
      </button>
      <button type="button" data-opener onClick={() => setOpen(true)}>
        {c.opener}
      </button>
      <button type="button" data-page-after>
        Another page control
      </button>
      {c.render({ open, onCancel: () => setOpen(false), onSubmit })}
    </main>
  );
}

const dialogEl = (testid: string) => document.querySelector(`[data-matter-modal="${testid}"]`) as HTMLElement | null;

describe.each(DIALOGS)("review dialog — $name", (c) => {
  async function openByKeyboard(user: ReturnType<typeof userEvent.setup>) {
    const opener = document.querySelector("[data-opener]") as HTMLButtonElement;
    opener.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(dialogEl(c.testid)).not.toBeNull());
    return opener;
  }

  it("initial focus is the first meaningful field", async () => {
    const user = userEvent.setup();
    render(<DialogHost c={c} onSubmit={async () => null} />);
    await openByKeyboard(user);
    await waitFor(() => expect(active()?.matches(c.initial)).toBe(true));
    expect(dialogEl(c.testid)!.contains(active())).toBe(true);
  });

  it("Tab and Shift+Tab cycle inside the dialog", async () => {
    const user = userEvent.setup();
    render(<DialogHost c={c} onSubmit={async () => null} />);
    await openByKeyboard(user);
    await waitFor(() => expect(active()?.matches(c.initial)).toBe(true));
    const dialog = dialogEl(c.testid)!;
    const seen = new Set<Element>();
    for (let i = 0; i < 12; i++) {
      await user.tab();
      expect(dialog.contains(active())).toBe(true);
      seen.add(active()!);
    }
    // It really cycles (more than one stop), and comes back round.
    expect(seen.size).toBeGreaterThan(1);
    for (let i = 0; i < 12; i++) {
      await user.tab({ shift: true });
      expect(dialog.contains(active())).toBe(true);
    }
  });

  it("Escape closes it and focus returns to the control that opened it", async () => {
    const user = userEvent.setup();
    render(<DialogHost c={c} onSubmit={async () => null} />);
    const opener = await openByKeyboard(user);
    await waitFor(() => expect(active()?.matches(c.initial)).toBe(true));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(dialogEl(c.testid)).toBeNull());
    expect(active()).toBe(opener);
  });

  if (c.fill) {
    it("Escape does NOT close it while the request is in flight", async () => {
      const user = userEvent.setup();
      let release: (v: string | null) => void = () => {};
      const pending = () => new Promise<string | null>((r) => (release = r));
      render(<DialogHost c={c} onSubmit={pending} />);
      await openByKeyboard(user);
      await waitFor(() => expect(active()?.matches(c.initial)).toBe(true));
      (document.querySelector(c.fill!) as HTMLElement).focus();
      await user.keyboard("Operational note for the record.");
      const confirm = dialogEl(c.testid)!.querySelector("button[type=submit]") as HTMLButtonElement;
      confirm.focus();
      await user.keyboard("{Enter}");
      await waitFor(() => expect(confirm.getAttribute("aria-busy")).toBe("true"));
      await user.keyboard("{Escape}");
      expect(dialogEl(c.testid)).not.toBeNull();
      await act(async () => release("Not recorded: try again."));
    });
  }
});

describe("review dialogs — a popup inside the dialog owns Escape", () => {
  it("Escape on an open listbox closes the list, not the Escalate dialog", async () => {
    const user = userEvent.setup();
    render(<DialogHost c={DIALOGS[0]!} onSubmit={async () => null} />);
    (document.querySelector("[data-opener]") as HTMLElement).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(active()?.matches("[data-reviewer-escalate-reason]")).toBe(true));
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(document.querySelector('[role="listbox"]')).not.toBeNull());
    await waitFor(() => expect(active()?.getAttribute("role")).toBe("listbox"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.querySelector('[role="listbox"]')).toBeNull());
    expect(dialogEl("reviewer-escalate")).not.toBeNull();
    // A second Escape (focus back on the trigger, inside the dialog) closes it.
    await user.keyboard("{Escape}");
    await waitFor(() => expect(dialogEl("reviewer-escalate")).toBeNull());
  });
});

// ---------------------------------------------------------------------------
// 3. F-23 — the assistant's inline entry
// ---------------------------------------------------------------------------

describe("F-23 — assistant inline entry on Review pages", () => {
  afterEach(() => {
    delete document.documentElement.dataset.assistantInline;
    delete document.documentElement.dataset.assistantInlineCount;
  });

  it("pages without an inline entry keep today's floating launcher", async () => {
    render(<ProovraChatWidget />);
    await waitFor(() => expect(document.querySelector(".assistant-launcher")).not.toBeNull());
    expect(document.documentElement.dataset.assistantInline).toBeUndefined();
  });

  it("a Review page header carries the entry; the floating launcher is gone while it is mounted", async () => {
    const { rerender } = render(
      <>
        <ReviewPageHeader title="Inbox" />
        <ProovraChatWidget />
      </>,
    );
    await waitFor(() => expect(document.querySelector("[data-review-page-header] [data-assistant-inline-entry]")).not.toBeNull());
    expect(document.documentElement.dataset.assistantInline).toBe("true");
    expect(document.querySelector(".assistant-launcher")).toBeNull();
    expect(document.querySelector(".assistant-launcher-slot")).toBeNull();

    // Leaving the Review page (no header) brings the launcher back.
    rerender(
      <>
        <div>Another page</div>
        <ProovraChatWidget />
      </>,
    );
    await waitFor(() => expect(document.querySelector(".assistant-launcher")).not.toBeNull());
    expect(document.documentElement.dataset.assistantInline).toBeUndefined();
  });

  it("the entry opens the same panel by keyboard; Escape closes it and focus returns to the entry", async () => {
    const user = userEvent.setup();
    render(
      <>
        <AssistantInlineEntry />
        <ProovraChatWidget />
      </>,
    );
    const entry = await waitFor(() => {
      const el = document.querySelector("[data-assistant-inline-entry]") as HTMLButtonElement | null;
      expect(el).not.toBeNull();
      return el!;
    });
    expect(entry.getAttribute("aria-expanded")).toBe("false");
    entry.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(document.querySelector("[data-assistant-panel]")).not.toBeNull());
    expect(entry.getAttribute("aria-expanded")).toBe("true");
    await waitFor(() => expect(active()?.getAttribute("aria-label")).toBe("Ask the assistant"));

    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.querySelector("[data-assistant-panel]")).toBeNull());
    expect(entry.getAttribute("aria-expanded")).toBe("false");
    expect(active()).toBe(entry);
  });

  it("without the assistant mounted the entry renders nothing (never a dead button)", () => {
    render(<AssistantInlineEntry />);
    expect(document.querySelector("[data-assistant-inline-entry]")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. CSS contracts (vitest runs with css: false, so the rules are read)
// ---------------------------------------------------------------------------

describe("Review surfaces CSS — tabs, tool cards, dialogs", () => {
  const CSS = readFileSync(resolve(__dirname, "../../components/reviewer-experience/review-surfaces.css"), "utf8");
  const ASSISTANT = readFileSync(resolve(__dirname, "../../components/ai/assistant.css"), "utf8");
  const body = (css: string, head: string) => {
    const i = css.indexOf(head);
    expect(i).toBeGreaterThanOrEqual(0);
    return css.slice(i, css.indexOf("}", i));
  };

  it("the Inbox view row and hub row wrap whatever order the stylesheets load in", () => {
    const rule = body(CSS, ".app-tabs.review-hub-tabs,\n.app-tabs.review-view-tabs,");
    expect(rule).toMatch(/flex-wrap:\s*wrap/);
    expect(rule).toMatch(/overflow:\s*visible/);
    const tab = body(CSS, ".review-view-tabs > .app-tab {");
    expect(tab).toMatch(/height:\s*auto/);
    expect(tab).toMatch(/white-space:\s*normal/);
  });

  it("a Review tool card is a clickable destination: pointer, border, hover and focus-visible states", () => {
    const card = body(CSS, ".review-tool-card {");
    expect(card).toMatch(/cursor:\s*pointer/);
    expect(card).toMatch(/border:\s*1px solid/);
    expect(CSS).toMatch(/\.review-tool-card:hover,\s*\.review-tool-card:focus-visible \{/);
    expect(CSS).toMatch(/\n\.review-tool-card:focus-visible \{\s*outline:\s*2px solid/);
  });

  it("Review dialogs wrap long titles, errors and confirm labels", () => {
    expect(CSS).toMatch(/\[data-matter-modal\^="reviewer-"\] \.app-dialog__footer \{ flex-wrap: wrap; \}/);
    expect(body(CSS, '[data-matter-modal^="reviewer-"] .app-dialog__footer > button {')).toMatch(/white-space:\s*normal/);
  });

  it("inline mode hides the launcher slot only under the opt-in flag", () => {
    expect(body(ASSISTANT, ':root[data-assistant-inline="true"] .assistant-launcher-slot {')).toMatch(/display:\s*none/);
  });
});
