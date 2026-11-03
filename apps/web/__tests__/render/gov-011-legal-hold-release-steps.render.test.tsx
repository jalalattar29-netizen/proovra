/**
 * GOV-011 and RT-012 — the legal-holds page shows the release step the API will
 * accept, never sends the acknowledgement that used to satisfy the gate, and picks
 * the held record by name. Real `apiFetch` over a stubbed network.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../lib/platform-context/PlatformContextProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/platform-context/PlatformContextProvider")>()),
  usePlatformContext: () => ({ activeWorkspaceId: "11111111-1111-4111-8111-111111111111", envelope: null }),
}));
vi.mock("../../lib/platform-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/platform-context")>()),
  useTeamId: () => "11111111-1111-4111-8111-111111111111",
  useWorkspaceContextSafety: () => ({ runGuarded: (fn: () => unknown) => fn() }),
  usePlatformContext: () => ({ activeWorkspaceId: "11111111-1111-4111-8111-111111111111", envelope: null }),
}));

import { ToastProvider } from "../../components/ui-legacy";
import { ConfirmActionProvider } from "../../components/ui/ConfirmActionModal";
import LegalHoldsPage from "../../app/(app)/evidence-lifecycle/legal-holds/page";

const HOLD = "22222222-2222-4222-8222-222222222222";

function hold(over: Record<string, unknown>) {
  return {
    id: HOLD,
    teamId: "t",
    kind: "EVIDENCE",
    scopeTargetId: "e",
    name: "Litigation",
    reason: "x",
    state: "ACTIVE",
    createdAtUtc: "2026-10-01T10:00:00.000Z",
    scope: "EVIDENCE",
    version: 1,
    releaseApprovalRequired: true,
    releaseApprovalState: "PENDING",
    releaseRequestedByUserId: null,
    ...over,
  };
}

let row = hold({});
const fetchMock = vi.fn();
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const posted = () =>
  fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")
    .map(([url, init]) => ({ url: String(url), body: String((init as RequestInit).body ?? "") }));

const page = () =>
  render(
    <ToastProvider>
      <ConfirmActionProvider>
        <LegalHoldsPage />
      </ConfirmActionProvider>
    </ToastProvider>,
  );

beforeEach(() => {
  row = hold({});
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (init?.method === "POST") return json({ ok: true, hold: row });
    if (path.endsWith("/v1/lifecycle/legal-holds")) return json({ holds: [row] });
    if (path.includes("/v1/evidence?")) return json({ items: [{ id: "e1", title: "Accident photo" }] });
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  // The note comes from the product's dialog: a browser prompt must not be used.
  vi.stubGlobal("prompt", () => {
    throw new Error("window.prompt was called");
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Type the note in the dialog and confirm it, as a person does. */
async function giveReason(note = "matter closed") {
  const input = await waitFor(() => {
    const el = document.querySelector("[data-confirm-action-reason-input]");
    expect(el).not.toBeNull();
    return el as HTMLTextAreaElement;
  });
  fireEvent.change(input, { target: { value: note } });
  fireEvent.click(document.querySelector("[data-confirm-action-submit]") as HTMLButtonElement);
}

describe("legal hold release under approval", () => {
  it("offers Request release first, and posts only the request", async () => {
    page();
    fireEvent.click(await screen.findByRole("button", { name: "Request release" }));
    await giveReason();
    await waitFor(() => expect(posted()).toHaveLength(1));
    expect(posted()[0]?.url).toContain(`/v1/lifecycle/legal-holds/${HOLD}/release-request`);
    expect(posted()[0]?.body).toContain("matter closed");
    expect(screen.queryByRole("button", { name: "Release" })).toBeNull();
  });

  it("offers Approve release once someone has asked", async () => {
    row = hold({ releaseRequestedByUserId: "someone" });
    page();
    expect(await screen.findByRole("button", { name: "Approve release" })).toBeTruthy();
  });

  it("offers Release once approved, and sends no acknowledgement", async () => {
    row = hold({ releaseApprovalState: "APPROVED", releaseRequestedByUserId: "a", releaseApprovedByUserId: "b" });
    page();
    fireEvent.click(await screen.findByRole("button", { name: "Release" }));
    await giveReason();
    await waitFor(() => expect(posted()).toHaveLength(1));
    expect(posted()[0]?.body).not.toContain("approvalAcknowledged");
    expect(posted()[0]?.body).toContain("matter closed");
  });

  it("cancelling the dialog sends nothing", async () => {
    page();
    fireEvent.click(await screen.findByRole("button", { name: "Request release" }));
    await waitFor(() => expect(document.querySelector("[data-confirm-action-cancel]")).not.toBeNull());
    fireEvent.click(document.querySelector("[data-confirm-action-cancel]") as HTMLButtonElement);
    await waitFor(() => expect(document.querySelector("[data-confirm-action-cancel]")).toBeNull());
    expect(posted()).toHaveLength(0);
  });

  it("the placement form picks the record by name", async () => {
    page();
    expect(await screen.findByRole("button", { name: "Accident photo" })).toBeTruthy();
    expect(screen.queryByLabelText("Scope Target ID")).toBeNull();
  });
});
