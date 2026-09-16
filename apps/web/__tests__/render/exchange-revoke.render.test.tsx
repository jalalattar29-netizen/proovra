/**
 * BATCH J — Evidence Exchange: revoke a shared package.
 *
 *   POST /v1/exchange/packages/:id/revoke
 *     app/(app)/exchange/page.tsx — per-row "Revoke" behind a danger
 *     confirmation; announced only after the package list reread shows the
 *     package REVOKED; a revoked row offers no link/delivery/download action;
 *     a refused or failed list read is never rendered as "No packages".
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
  return { usePlatformContext: () => ctx };
});
vi.mock("../../components/identity-security/StepUpModal", () => {
  const control = {
    state: { kind: "idle" },
    runStepUpAction: async (fn: (headers?: Record<string, string>) => Promise<unknown>) => fn({}),
  };
  return { useStepUpAction: () => control, StepUpModal: () => null };
});

import ExchangePage from "../../app/(app)/exchange/page";

const PKG = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ISO = "2026-09-01T10:00:00.000Z";

function pkg(id: string, state: string) {
  return { id, kind: "SHARE", evidenceIds: ["e1"], state, createdAt: ISO, deliveryCount: 0, signedUrlExpiresAtUtc: null };
}

function failure(statusCode: number): Error {
  return Object.assign(new Error("request failed"), { statusCode });
}

let revoked = false;
function defaultReply(path: string, init?: RequestInit): unknown {
  if (init?.method === "POST" && path.endsWith("/revoke")) {
    revoked = true;
    return { ok: true };
  }
  if (path === "/v1/exchange/packages") {
    return { packages: [pkg(PKG, revoked ? "REVOKED" : "READY"), pkg(OTHER, "REVOKED")] };
  }
  if (path.includes("/deliveries")) return { deliveries: [], nextCursor: null };
  throw new Error("unexpected " + path);
}

beforeEach(() => {
  revoked = false;
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => defaultReply(path, init));
  mocks.confirm.mockReset();
  mocks.confirm.mockResolvedValue(true);
});
afterEach(cleanup);

function row(id: string): HTMLElement {
  return document.querySelector(`[data-exchange-package-row="${id}"]`) as HTMLElement;
}
async function ready() {
  await waitFor(() => expect(row(PKG)).toBeTruthy());
}
const writes = () => mocks.fetch.mock.calls.filter(([, init]) => init?.method === "POST");

describe("exchange package revoke workflow", () => {
  it("revokes after a danger confirmation and announces only after the reread shows REVOKED", async () => {
    render(<ExchangePage />);
    await ready();
    fireEvent.click(within(row(PKG)).getByRole("button", { name: /^Revoke Share package/ }));
    await screen.findByText(/package revoked and confirmed from the saved record/);
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Revoke this package?", tone: "danger" }));
    expect(String(mocks.confirm.mock.calls[0][0].description)).toMatch(/stops working immediately/);
    const calls = mocks.fetch.mock.calls;
    const write = calls.findIndex(([, init]) => init?.method === "POST");
    expect(calls[write][0]).toBe(`/v1/exchange/packages/${PKG}/revoke`);
    expect(JSON.parse(calls[write][1].body)).toEqual({});
    expect(calls.slice(write + 1).some(([path, init]) => path === "/v1/exchange/packages" && (!init?.method || init.method === "GET"))).toBe(true);
    // The row now shows the reread state and offers no revoke, link or delivery.
    await waitFor(() => expect(row(PKG).getAttribute("data-exchange-package-state")).toBe("REVOKED"));
    expect(within(row(PKG)).queryByRole("button", { name: /^Revoke/ })).toBeNull();
  });

  it("cancellation makes no write", async () => {
    mocks.confirm.mockResolvedValue(false);
    render(<ExchangePage />);
    await ready();
    fireEvent.click(within(row(PKG)).getByRole("button", { name: /^Revoke Share package/ }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    expect(writes()).toHaveLength(0);
    expect(screen.queryByText(/package revoked/)).toBeNull();
  });

  it("a revoked package explains why its actions are unavailable", async () => {
    render(<ExchangePage />);
    await ready();
    const revokedRow = row(OTHER);
    expect(within(revokedRow).queryByRole("button", { name: /^Revoke/ })).toBeNull();
    for (const name of ["Open package", "Record delivery"]) {
      const button = within(revokedRow).getByRole("button", { name });
      expect(button.hasAttribute("disabled")).toBe(true);
      expect(document.getElementById(button.getAttribute("aria-describedby")!)?.textContent).toBe(
        "This package was revoked. Its links no longer work.",
      );
    }
  });

  it.each([403, 500])("a %s list read is not rendered as an empty list", async (status) => {
    mocks.fetch.mockImplementation(async (path: string) => {
      if (path === "/v1/exchange/packages") throw failure(status);
      return defaultReply(path);
    });
    render(<ExchangePage />);
    const alert = await waitFor(() => {
      const el = document.querySelector("[data-exchange-list-error]");
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    expect(alert.textContent).toMatch(/not an empty list/);
    expect(screen.queryByText("No packages.")).toBeNull();
  });

  it("an empty list that did load says so truthfully", async () => {
    mocks.fetch.mockResolvedValue({ packages: [] });
    render(<ExchangePage />);
    await screen.findByText("No packages.");
    expect(document.querySelector("[data-exchange-list-error]")).toBeNull();
  });

  it.each([
    [403, "Only an organization administrator can revoke a package."],
    [404, "This package no longer exists in this workspace. Refresh the list."],
  ])("a %s refusal is reported without claiming success", async (status, message) => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") throw failure(status);
      return defaultReply(path, init);
    });
    render(<ExchangePage />);
    await ready();
    fireEvent.click(within(row(PKG)).getByRole("button", { name: /^Revoke Share package/ }));
    await screen.findByText(message);
    expect(screen.queryByText(/package revoked/)).toBeNull();
    expect(row(PKG).getAttribute("data-exchange-package-state")).toBe("READY");
  });

  it("does not claim success when the reread still shows the package live", async () => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") return { ok: true };
      return defaultReply(path, init);
    });
    render(<ExchangePage />);
    await ready();
    fireEvent.click(within(row(PKG)).getByRole("button", { name: /^Revoke Share package/ }));
    await screen.findByText(/still shows as Ready/);
    expect(screen.queryByText(/package revoked/)).toBeNull();
  });

  it("does not claim success when the reread fails", async () => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        revoked = true;
        return { ok: true };
      }
      if (revoked && path === "/v1/exchange/packages") throw failure(503);
      return defaultReply(path, init);
    });
    render(<ExchangePage />);
    await ready();
    fireEvent.click(within(row(PKG)).getByRole("button", { name: /^Revoke Share package/ }));
    await screen.findByText(/could not be reloaded to confirm it/);
    expect(screen.queryByText(/package revoked/)).toBeNull();
  });
});
