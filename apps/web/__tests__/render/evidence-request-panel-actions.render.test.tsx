/**
 * Record-detail "Linked requests" panel.
 *
 * R1-F-01  Card actions follow the shared request state machine; decided
 *          responses offer no decision; the create body never carries a hidden
 *          email; a blank deliverable is named before the server's 400; one
 *          Confirm sends one request; a send whose refresh failed is not
 *          reported as "Could not send".
 * R1-F-07  Only FEATURE_DISABLED hides the panel; an overload 503 is said.
 *
 * Driven with the REAL apiFetch over a stubbed fetch, so nested error codes
 * reach the panel exactly as in production.
 */
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("../../lib/platform-context", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  WorkspaceContextBanner: () => null,
  useWorkspaceContextSafety: () => ({
    runGuarded: async (fn: () => Promise<unknown>, after: () => unknown) => {
      await fn();
      await after();
    },
  }),
}));

import EvidenceRequestPanel from "../../app/(app)/evidence/[id]/components/EvidenceRequestPanel";

const TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EV = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

type Call = { method: string; path: string; body: unknown };
let calls: Call[] = [];
let list: () => { status: number; body: unknown };
let onPost: (path: string, body: unknown) => { status: number; body: unknown };

function req(over: Record<string, unknown> = {}) {
  return {
    id: "rq-1", status: "SENT", priority: "NORMAL", requestType: "ADDITIONAL_EVIDENCE", title: "Roof photos",
    instructions: "", dueAtUtc: null, recipientMode: "EXTERNAL_CONTRIBUTOR", recipientLabel: null, recipientEmail: null,
    intakeLinkId: null, reviewerNote: null, sentAtUtc: null, firstOpenedAtUtc: null, closedAtUtc: null, cancelledAtUtc: null,
    createdAt: "2026-09-01T00:00:00.000Z", deliverables: [], responses: [], ...over,
  };
}

beforeEach(() => {
  calls = [];
  list = () => ({ status: 200, body: { requests: [req()] } });
  onPost = () => ({ status: 200, body: {} });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input).replace(/^https?:\/\/[^/]+/, "");
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method, path: url, body });
      const out = method === "GET" && url.startsWith("/v1/evidence-requests?") ? list() : onPost(url, body);
      return new Response(JSON.stringify(out.body), { status: out.status, headers: { "content-type": "application/json" } });
    }),
  );
  vi.stubGlobal("alert", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function mount() {
  const view = render(<EvidenceRequestPanel evidenceId={EV} teamId={TEAM} />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return view;
}
const card = () => document.querySelector(".evd-card") as HTMLElement;
const has = (name: RegExp) => within(card()).queryByRole("button", { name }) !== null;

describe("R1-F-07 — only FEATURE_DISABLED hides the panel", () => {
  it("an overload 503 SERVER_BUSY keeps the panel and says the load failed", async () => {
    list = () => ({ status: 503, body: { error: { code: "SERVER_BUSY", message: "busy" } } });
    const view = await mount();
    await waitFor(() => expect(view.container.querySelector(".evd-error")).not.toBeNull());
    expect(screen.getByText("Linked requests")).toBeTruthy();
  });

  it("FEATURE_DISABLED still hides it", async () => {
    list = () => ({ status: 503, body: { error: { code: "FEATURE_DISABLED", message: "off" } } });
    const view = await mount();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(view.container.textContent).toBe("");
  });
});

describe("R1-F-01 — card actions follow the shared state machine", () => {
  it("a DRAFT card offers Send and Cancel only", async () => {
    list = () => ({ status: 200, body: { requests: [req({ status: "DRAFT" })] } });
    await mount();
    await waitFor(() => expect(card()).toBeTruthy());
    expect(has(/^send$/i)).toBe(true);
    expect(has(/^cancel$/i)).toBe(true);
    expect(has(/^close$/i)).toBe(false);
    expect(has(/needs more info/i)).toBe(false);
  });

  it("a SENT card offers no Needs more info", async () => {
    await mount();
    await waitFor(() => expect(card()).toBeTruthy());
    expect(has(/needs more info/i)).toBe(false);
    expect(has(/^close$/i)).toBe(true);
  });

  it("a decided response offers no decision; an undecided one does", async () => {
    list = () => ({
      status: 200,
      body: {
        requests: [
          req({
            status: "UNDER_REVIEW",
            responses: [
              { id: "r-a", status: "ACCEPTED", responseEvidenceId: null, submittedAtUtc: "2026-09-02T00:00:00Z", submittedByExternalLabel: "Decided one", reviewerNote: null },
              { id: "r-b", status: "RECEIVED", responseEvidenceId: null, submittedAtUtc: "2026-09-02T00:00:00Z", submittedByExternalLabel: "Open one", reviewerNote: null },
            ],
          }),
        ],
      },
    });
    await mount();
    await waitFor(() => expect(screen.getByText("Decided one")).toBeTruthy());
    const decided = screen.getByText("Decided one").closest(".evd-card") as HTMLElement;
    const open = screen.getByText("Open one").closest(".evd-card") as HTMLElement;
    expect(within(decided).queryByRole("button", { name: /rejected as insufficient/i })).toBeNull();
    expect(within(open).queryByRole("button", { name: /rejected as insufficient/i })).not.toBeNull();
  });

  it("one Confirm sends one request", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    onPost = (path) => (path.endsWith("/close") ? { status: 200, body: {} } : { status: 200, body: {} });
    const origFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if ((init?.method ?? "GET") === "POST") await gate;
        return (origFetch as typeof fetch)(input, init);
      }),
    );
    await mount();
    await waitFor(() => expect(card()).toBeTruthy());
    await act(async () => {
      within(card()).getByRole("button", { name: /^close$/i }).click();
    });
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Resolved by phone" } });
    const confirm = within(dialog).getByRole("button", { name: /confirm/i });
    await act(async () => {
      confirm.click();
      confirm.click();
    });
    release();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(calls.filter((c) => c.method === "POST" && c.path.endsWith("/close"))).toHaveLength(1);
  });

  it("a send whose list refresh fails is not reported as 'Could not send'", async () => {
    list = () => ({ status: 200, body: { requests: [req({ status: "DRAFT" })] } });
    onPost = () => ({ status: 200, body: { rawToken: null, intakeUrl: null } });
    const view = await mount();
    await waitFor(() => expect(card()).toBeTruthy());
    list = () => ({ status: 500, body: { error: { code: "INTERNAL", message: "boom" } } });
    await act(async () => {
      within(card()).getByRole("button", { name: /^send$/i }).click();
    });
    await waitFor(() => expect(view.container.querySelector(".evd-error")?.textContent ?? "").toMatch(/sent/i));
    expect(globalThis.alert).not.toHaveBeenCalled();
  });
});

describe("R1-F-01 — the create form never posts what it hides, and names a blank deliverable", () => {
  it("does not offer Internal team member (no assignee control) and blocks a blank deliverable", async () => {
    list = () => ({ status: 200, body: { requests: [] } });
    await mount();
    await act(async () => {
      screen.getByRole("button", { name: /new request/i }).click();
    });
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).not.toContain("Internal team member");
    fireEvent.change(dialog.querySelector("input.evd-input") as HTMLInputElement, { target: { value: "Need more" } });
    await act(async () => {
      within(dialog).getByRole("button", { name: /add deliverable/i }).click();
    });
    await act(async () => {
      within(dialog).getByRole("button", { name: /create request/i }).click();
    });
    expect(dialog.textContent).toContain("Deliverable 2 needs a title.");
    expect(calls.some((c) => c.method === "POST" && c.path === "/v1/evidence-requests")).toBe(false);
  });
});
