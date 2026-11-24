/**
 * Stage D (T-077) — `/review/workspace` is retired: it opens the Review page's
 * FOCUS MODE on the next review assigned to the viewer.
 *
 *   - an assigned review → `/reviewer-ops/<id>?from=inbox&view=MY_REVIEWS&mode=focus`;
 *   - nothing assigned   → it says so and links to the Inbox (never a spinner);
 *   - a refusal or failure (PRO-077) → an alert with Retry, never "Loading…"
 *     forever, and Retry reads again.
 *
 * Mounted with the REAL apiFetch over a stubbed fetch.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const nav = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: nav.replace, back: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/review/workspace",
  useParams: () => ({}),
}));
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../components/reviewer-experience/ReviewPageHeader", () => ({
  ReviewPageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
vi.mock("../../lib/platform-context", () => ({
  useActiveSpaceId: () => "11111111-1111-4111-8111-111111111111",
}));

import ReviewerWorkspacePage from "../../app/(app)/review/workspace/page";

type Reply = { status: number; body: unknown };
const WF = "22222222-2222-4222-8222-222222222222";
let reply: () => Reply = () => ({ status: 200, body: { rows: [], nextCursor: null } });
const calls: string[] = [];

beforeEach(() => {
  calls.length = 0;
  nav.replace.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/v1/reviewer-ops/queue?")) {
        const r = reply();
        return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({}), { status: 404, headers: { "content-type": "application/json" } });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function mount() {
  await act(async () => {
    render(<ReviewerWorkspacePage />);
  });
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe("T-077 — /review/workspace opens focus mode on the next assigned review", () => {
  it("an assigned review: replaces the URL with the Review page in focus mode, carrying the Assigned to me view", async () => {
    reply = () => ({
      status: 200,
      body: { rows: [{ workflowId: WF, evidenceId: "e", lifecycleState: "ASSIGNED", priority: "NORMAL", assignedToUserId: "u" }], nextCursor: null },
    });
    await mount();
    expect(calls[0]).toContain("queue=MY_REVIEWS");
    expect(nav.replace).toHaveBeenCalledWith(`/reviewer-ops/${WF}?from=inbox&view=MY_REVIEWS&mode=focus`);
  });

  it("nothing assigned: says so and links to the Inbox — not a spinner", async () => {
    reply = () => ({ status: 200, body: { rows: [], nextCursor: null } });
    await mount();
    expect(nav.replace).not.toHaveBeenCalled();
    expect(screen.getByText("No reviews are assigned to you.")).toBeTruthy();
    expect(document.querySelector("[data-focus-redirect-inbox]")!.getAttribute("href")).toBe("/review?view=UNASSIGNED");
    expect(document.body.textContent).not.toMatch(/Opening your next review/);
  });

  it("PRO-077: a VIEWER's 403 is a stated refusal with Retry, never 'Loading…' forever; Retry reads again", async () => {
    reply = () => ({ status: 403, body: { denial: "NOT_PERMITTED" } });
    await mount();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Opening your next review/);
    const before = calls.length;
    reply = () => ({ status: 200, body: { rows: [], nextCursor: null } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
    expect(calls.length).toBeGreaterThan(before);
    expect(screen.getByText("No reviews are assigned to you.")).toBeTruthy();
  });
});
