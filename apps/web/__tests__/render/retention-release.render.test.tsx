/**
 * BATCH J — Evidence Lifecycle retention: release a policy.
 *
 *   POST /v1/lifecycle/retention/policies/:id/release
 *     app/(app)/evidence-lifecycle/retention/page.tsx — per-row "Release
 *     policy" behind a danger confirmation. The list is ACTIVE-only, so the
 *     success notice waits for a reread in which the policy is gone. Failed
 *     reads of either half are never rendered as empty.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), confirm: vi.fn() }));

vi.mock("../../lib/api", () => ({
  apiFetch: mocks.fetch,
  ApiError: class ApiError extends Error {},
}));
vi.mock("../../components/ui/ConfirmActionModal", () => ({
  useConfirmAction: () => ({ confirm: mocks.confirm }),
}));
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../lib/platform-context", () => {
  const ctx = { activeWorkspaceId: "ws-1" };
  const safety = { runGuarded: async (fn: () => Promise<unknown>, done: () => void) => { await fn(); done(); } };
  return {
    usePlatformContext: () => ctx,
    useWorkspaceContextSafety: () => safety,
    WorkspaceContextBanner: () => null,
  };
});

import RetentionPage from "../../app/(app)/evidence-lifecycle/retention/page";

const POLICY = "11111111-1111-4111-8111-111111111111";
const policy = { id: POLICY, name: "Claims seven year", template: "INSURANCE_7Y", years: 7, appliesTo: "workspace", inheritsFrom: null, isOverride: false, exceptions: [] };
const EVIDENCE = "33333333-3333-4333-8333-333333333333";

function failure(statusCode: number): Error {
  return Object.assign(new Error("request failed"), { statusCode });
}

let released = false;
function defaultReply(path: string, init?: RequestInit): unknown {
  if (init?.method === "POST" && path.endsWith("/release")) {
    released = true;
    return { ok: true };
  }
  if (path === "/v1/lifecycle/retention/policies") return { policies: released ? [] : [policy] };
  if (path === "/v1/lifecycle/retention/upcoming-expirations") return { expirations: { count: 1, sampleEvidenceIds: [EVIDENCE] } };
  throw new Error("unexpected " + path);
}

beforeEach(() => {
  released = false;
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => defaultReply(path, init));
  mocks.confirm.mockReset();
  mocks.confirm.mockResolvedValue(true);
});
afterEach(cleanup);

const writes = () => mocks.fetch.mock.calls.filter(([, init]) => init?.method === "POST");
const releaseButton = () => screen.findByRole("button", { name: "Release retention policy Claims seven year" });

describe("lifecycle retention policy release", () => {
  it("renders the real projection: template and period as words, expirations as a count", async () => {
    render(<RetentionPage />);
    await releaseButton();
    const table = screen.getByRole("table", { name: "Retention policies" });
    expect(within(table).getByText("Insurance — 7 years")).toBeTruthy();
    expect(within(table).getByText("7 years")).toBeTruthy();
    expect(screen.getByText("Whole workspace")).toBeTruthy();
    expect(screen.getByText(EVIDENCE).hasAttribute("data-identifier")).toBe(true);
  });

  it("releases after a danger confirmation and announces only after the reread drops the policy", async () => {
    render(<RetentionPage />);
    fireEvent.click(await releaseButton());
    await screen.findByText(/was released and no longer appears among active policies/);
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ tone: "danger" }));
    expect(String(mocks.confirm.mock.calls[0][0].description)).toMatch(/inherited or default retention/);
    const calls = mocks.fetch.mock.calls;
    const write = calls.findIndex(([, init]) => init?.method === "POST");
    expect(calls[write][0]).toBe(`/v1/lifecycle/retention/policies/${POLICY}/release`);
    expect(JSON.parse(calls[write][1].body)).toEqual({});
    expect(calls.slice(write + 1).some(([path]) => path === "/v1/lifecycle/retention/policies")).toBe(true);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Release retention policy Claims seven year" })).toBeNull());
  });

  it("cancellation makes no write", async () => {
    mocks.confirm.mockResolvedValue(false);
    render(<RetentionPage />);
    fireEvent.click(await releaseButton());
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    expect(writes()).toHaveLength(0);
    expect(screen.queryByText(/was released/)).toBeNull();
  });

  it.each([
    [403, "Only an organization administrator or compliance officer can release a retention policy."],
    [404, "This policy no longer exists in this workspace. Refresh the list."],
  ])("a %s refusal is reported without claiming success", async (status, message) => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") throw failure(status);
      return defaultReply(path, init);
    });
    render(<RetentionPage />);
    fireEvent.click(await releaseButton());
    expect((await screen.findByText(message)).getAttribute("role")).toBe("alert");
    expect(screen.queryByText(/was released/)).toBeNull();
  });

  it("does not claim success when the reread still lists the policy", async () => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") return { ok: true };
      return defaultReply(path, init);
    });
    render(<RetentionPage />);
    fireEvent.click(await releaseButton());
    await screen.findByText(/still appears among active policies/);
    expect(screen.queryByText(/was released and no longer appears/)).toBeNull();
  });

  it("does not claim success when the reread fails", async () => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") { released = true; return { ok: true }; }
      if (released && path === "/v1/lifecycle/retention/policies") throw failure(503);
      return defaultReply(path, init);
    });
    render(<RetentionPage />);
    fireEvent.click(await releaseButton());
    await screen.findByText(/could not be reloaded to confirm it/);
    expect(screen.queryByText(/was released and no longer appears/)).toBeNull();
  });

  it.each([403, 500])("a %s policy read is not rendered as an empty list", async (status) => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/v1/lifecycle/retention/policies") throw failure(status);
      return defaultReply(path, init);
    });
    render(<RetentionPage />);
    await waitFor(() => expect(document.querySelector("[data-retention-policies-unreadable]")?.textContent).toMatch(/not an empty list/));
    expect(screen.queryByText("No retention policy configured")).toBeNull();
  });

  it("a failed expiration read is not rendered as nothing expiring", async () => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/v1/lifecycle/retention/upcoming-expirations") throw failure(500);
      return defaultReply(path, init);
    });
    render(<RetentionPage />);
    await waitFor(() => expect(document.querySelector("[data-retention-expirations-unreadable]")).toBeTruthy());
    expect(screen.queryByText("No evidence expiring in the next 30 days")).toBeNull();
  });

  it("a loaded empty list says so truthfully", async () => {
    mocks.fetch.mockImplementation(async (path: string) =>
      path === "/v1/lifecycle/retention/policies" ? { policies: [] } : { expirations: { count: 0, sampleEvidenceIds: [] } },
    );
    render(<RetentionPage />);
    await screen.findByText("No retention policy configured");
    await screen.findByText("No evidence expiring in the next 30 days");
    expect(document.querySelector("[data-retention-policies-unreadable]")).toBeNull();
  });

  it("the create form omits a blank scope target instead of sending null", async () => {
    render(<RetentionPage />);
    await releaseButton();
    fireEvent.change(screen.getByPlaceholderText("e.g. Default 3-year retention"), { target: { value: "New" } });
    fireEvent.click(screen.getByRole("button", { name: "Create policy" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    const body = JSON.parse(writes()[0][1].body);
    expect(body).toEqual({ name: "New", template: "INSURANCE_7Y", scopeKind: "WORKSPACE" });
  });
});
