/**
 * BATCH J — Evidence Lifecycle webhooks: deactivate an endpoint.
 *
 *   POST /v1/integrations/webhooks/endpoints/:id/deactivate
 *     app/(app)/evidence-lifecycle/webhooks/page.tsx — per-row "Deactivate"
 *     on ACTIVE endpoints behind a danger confirmation; announced only after
 *     the endpoint list reread shows the endpoint is no longer active.
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

import WebhooksPage from "../../app/(app)/evidence-lifecycle/webhooks/page";

const EP = "11111111-1111-4111-8111-111111111111";
const OLD = "22222222-2222-4222-8222-222222222222";
const ISO = "2026-09-01T10:00:00.000Z";
const URL_A = "https://receiver.example/hook";

function endpoint(id: string, state: string, url = URL_A) {
  return { id, url, subscribedEvents: ["evidence.created"], state, createdAtUtc: ISO };
}
function failure(statusCode: number): Error {
  return Object.assign(new Error("request failed"), { statusCode });
}

let deactivated = false;
function defaultReply(path: string, init?: RequestInit): unknown {
  if (init?.method === "POST" && path.endsWith("/deactivate")) {
    deactivated = true;
    return { ok: true };
  }
  if (path === "/v1/integrations/webhooks/endpoints") {
    return { endpoints: [endpoint(EP, deactivated ? "DEACTIVATED" : "ACTIVE"), endpoint(OLD, "DEACTIVATED", "https://old.example/hook")] };
  }
  if (path === "/v1/integrations/webhooks/lifecycle-deliveries") return { deliveries: [] };
  throw new Error("unexpected " + path);
}

beforeEach(() => {
  deactivated = false;
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => defaultReply(path, init));
  mocks.confirm.mockReset();
  mocks.confirm.mockResolvedValue(true);
});
afterEach(cleanup);

const writes = () => mocks.fetch.mock.calls.filter(([, init]) => init?.method === "POST");
async function deactivateButton() {
  return screen.findByRole("button", { name: `Deactivate endpoint ${URL_A}` });
}

describe("lifecycle webhook endpoint deactivation", () => {
  it("deactivates after a danger confirmation and announces only after the reread", async () => {
    render(<WebhooksPage />);
    fireEvent.click(await deactivateButton());
    await screen.findByText(/Endpoint deactivated and confirmed from the saved record/);
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ tone: "danger", title: "Deactivate this webhook endpoint?" }));
    expect(String(mocks.confirm.mock.calls[0][0].description)).toContain(URL_A);
    const calls = mocks.fetch.mock.calls;
    const write = calls.findIndex(([, init]) => init?.method === "POST");
    expect(calls[write][0]).toBe(`/v1/integrations/webhooks/endpoints/${EP}/deactivate`);
    expect(JSON.parse(calls[write][1].body)).toEqual({});
    expect(calls.slice(write + 1).some(([path]) => path === "/v1/integrations/webhooks/endpoints")).toBe(true);
    await waitFor(() => expect(screen.queryByRole("button", { name: `Deactivate endpoint ${URL_A}` })).toBeNull());
  });

  it("cancellation makes no write", async () => {
    mocks.confirm.mockResolvedValue(false);
    render(<WebhooksPage />);
    fireEvent.click(await deactivateButton());
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    expect(writes()).toHaveLength(0);
    expect(screen.queryByText(/Endpoint deactivated/)).toBeNull();
  });

  it("offers no deactivate control on an endpoint that is already inactive", async () => {
    render(<WebhooksPage />);
    await deactivateButton();
    expect(screen.queryByRole("button", { name: "Deactivate endpoint https://old.example/hook" })).toBeNull();
    expect(screen.getAllByText("No longer receives events").length).toBe(1);
  });

  it.each([
    [403, "Only an organization administrator can deactivate a webhook endpoint."],
    [404, "This endpoint no longer exists in this workspace. Refresh the list."],
  ])("a %s refusal is reported without claiming success", async (status, message) => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") throw failure(status);
      return defaultReply(path, init);
    });
    render(<WebhooksPage />);
    fireEvent.click(await deactivateButton());
    const alert = await screen.findByText(message);
    expect(alert.getAttribute("role")).toBe("alert");
    expect(screen.queryByText(/Endpoint deactivated/)).toBeNull();
  });

  it("does not claim success when the reread still shows the endpoint active", async () => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") return { ok: true };
      return defaultReply(path, init);
    });
    render(<WebhooksPage />);
    fireEvent.click(await deactivateButton());
    await screen.findByText(/still shows as active/);
    expect(screen.queryByText(/Endpoint deactivated/)).toBeNull();
  });

  it("does not claim success when the reread fails", async () => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        deactivated = true;
        return { ok: true };
      }
      if (deactivated && path === "/v1/integrations/webhooks/endpoints") throw failure(503);
      return defaultReply(path, init);
    });
    render(<WebhooksPage />);
    fireEvent.click(await deactivateButton());
    await screen.findByText(/could not be reloaded to confirm it/);
    expect(screen.queryByText(/Endpoint deactivated and confirmed/)).toBeNull();
  });

  it("a failed endpoint read is not rendered as an empty list", async () => {
    mocks.fetch.mockImplementation(async (path: string) => {
      if (path === "/v1/integrations/webhooks/endpoints") throw failure(403);
      return defaultReply(path);
    });
    render(<WebhooksPage />);
    await waitFor(() => expect(document.querySelector("[data-webhook-endpoints-unreadable]")).toBeTruthy());
    expect(screen.queryByText("No webhook endpoints configured")).toBeNull();
  });

  it("does not show the empty state while the first read is still loading", async () => {
    mocks.fetch.mockImplementation(() => new Promise(() => {}));
    render(<WebhooksPage />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("No webhook endpoints configured")).toBeNull();
    const section = screen.getByRole("table", { name: "Webhook endpoints" });
    expect(within(section).queryByText("No webhook endpoints configured")).toBeNull();
  });
});
