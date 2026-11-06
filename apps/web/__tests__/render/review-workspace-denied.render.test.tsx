/**
 * PRO-077 (UI-06) — a VIEWER on /review/workspace.
 *
 * GET /v1/reviewer/workspace answers a VIEWER 403 { denial: "NOT_PERMITTED" }.
 * The page's load effect awaited it without a catch, so the rejection escaped,
 * `loadingWorkspace` never went false, and the page read "Loading reviewer
 * workspace…" forever with an unhandled "HTTP 403: API error".
 *
 * Mounted with the REAL apiFetch over a stubbed fetch, so the error is the
 * shape production raises for this flat body (not an ApiError).
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/review/workspace",
  useParams: () => ({}),
}));
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../lib/platform-context", () => ({
  useActiveSpaceId: () => "11111111-1111-4111-8111-111111111111",
  useActiveSpace: () => ({ id: "11111111-1111-4111-8111-111111111111", roleLabel: "VIEWER" }),
}));

import { ToastProvider } from "../../components/ui";
import ReviewerWorkspacePage from "../../app/(app)/review/workspace/page";

type Reply = { status: number; body: unknown };
let reply: () => Reply = () => ({ status: 403, body: { denial: "NOT_PERMITTED" } });
const calls: string[] = [];

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/v1/reviewer/workspace")) {
        const r = reply();
        return new Response(JSON.stringify(r.body), {
          status: r.status,
          headers: { "content-type": "application/json" },
        });
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
    render(
      <ToastProvider>
        <ReviewerWorkspacePage />
      </ToastProvider>,
    );
  });
  // let the load effect settle
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("PRO-077: the reviewer workspace never spins on a refusal", () => {
  it("a VIEWER's 403 shows the no-reviewer-role state, not a loader", async () => {
    reply = () => ({ status: 403, body: { denial: "NOT_PERMITTED" } });
    await mount();
    expect(calls.some((u) => u.includes("/v1/reviewer/workspace"))).toBe(true);
    expect(screen.queryByText("Loading reviewer workspace…")).toBeNull();
    expect(screen.getByText("You do not have a reviewer role in this workspace.")).toBeTruthy();
  });

  it("a server failure offers a retry, and the retry loads the workspace", async () => {
    reply = () => ({ status: 500, body: { message: "boom" } });
    await mount();
    expect(screen.queryByText("Loading reviewer workspace…")).toBeNull();
    expect(screen.getByText("The reviewer workspace could not be loaded.")).toBeTruthy();
    // a failure is not presented as a missing role
    expect(screen.queryByText("You do not have a reviewer role in this workspace.")).toBeNull();

    reply = () => ({ status: 200, body: { workspace: null } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(calls.filter((u) => u.includes("/v1/reviewer/workspace")).length).toBe(2);
    expect(screen.queryByText("The reviewer workspace could not be loaded.")).toBeNull();
  });
});
