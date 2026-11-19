/**
 * PRO-W1C-05 (RG-18, DEC-25) — the Exchange create form offers the disclosure
 * profile the API accepts.
 *
 *   POST /v1/exchange/packages { kind, evidenceIds, disclosureProfile? }
 *     - an untouched form sends the request it always sent (no field: the
 *       API's default, FULL_FORENSIC);
 *     - choosing External disclosure sends the field;
 *     - a server that predates profiles ignores the field and does not echo
 *       it: the page then says a FULL package was made, never that an
 *       external one was.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), confirm: vi.fn() }));

vi.mock("../../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/api")>()),
  apiFetch: mocks.fetch,
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

const EVIDENCE = "55555555-5555-4555-8555-555555555555";
let createReply: (body: Record<string, unknown>) => unknown;

beforeEach(() => {
  // The current API echoes the profile the package was created under.
  createReply = (body) => ({ packageId: "pkg-1", disclosureProfile: body.disclosureProfile ?? "FULL_FORENSIC" });
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/v1/exchange/packages" && init?.method === "POST") {
      return createReply(JSON.parse(String(init.body)) as Record<string, unknown>);
    }
    if (path === "/v1/exchange/packages") return { packages: [] };
    throw new Error("unexpected " + path);
  });
});
afterEach(cleanup);

const createBodies = () =>
  mocks.fetch.mock.calls
    .filter(([p, init]) => p === "/v1/exchange/packages" && init?.method === "POST")
    .map(([, init]) => JSON.parse(String(init.body)) as Record<string, unknown>);

async function fillAndCreate(profileLabel?: string) {
  render(<ExchangePage />);
  const ids = await screen.findByPlaceholderText("Paste evidence IDs");
  if (profileLabel) {
    fireEvent.click(screen.getByRole("combobox", { name: "Disclosure profile" }));
    fireEvent.click(await screen.findByRole("option", { name: profileLabel }));
  }
  fireEvent.change(ids, { target: { value: EVIDENCE } });
  fireEvent.click(screen.getByRole("button", { name: "Create Package" }));
  await waitFor(() => expect(createBodies()).toHaveLength(1));
}

describe("PRO-O1Z-02 Exchange package-download policy refusal", () => {
  it("says the workspace policy refused the link, in words", async () => {
    const READY = "44444444-4444-4444-8444-444444444444";
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === `/v1/exchange/packages/${READY}/sign-url` && init?.method === "POST") {
        throw Object.assign(new Error("request failed"), {
          statusCode: 403,
          details: { denial: "POLICY_BLOCKED", code: "PACKAGE_BLOCKED_BY_POLICY" },
        });
      }
      if (path === "/v1/exchange/packages") {
        return {
          packages: [
            { id: READY, kind: "EVIDENCE", evidenceIds: ["e1"], state: "READY", createdAt: "2026-09-01T10:00:00.000Z", deliveryCount: 0, signedUrlExpiresAtUtc: null, lastBuild: null },
          ],
        };
      }
      if (path.includes("/deliveries")) return { deliveries: [], nextCursor: null };
      throw new Error("unexpected " + path);
    });
    render(<ExchangePage />);
    fireEvent.click(await screen.findByRole("button", { name: "Open package" }));
    const alert = await screen.findByText(/policy does not allow package downloads for your role/);
    expect(alert.closest("[role=alert]")).toBeTruthy();
    expect(document.body.textContent).not.toContain("POLICY_BLOCKED");
    expect(document.body.textContent).not.toContain("PACKAGE_BLOCKED_BY_POLICY");
  });
});

describe("PRO-W1C-05 Exchange disclosure profile selector", () => {
  it("defaults to the API's default and sends the request an older form sent", async () => {
    await fillAndCreate();
    expect(createBodies()[0]).toEqual({ kind: expect.any(String), evidenceIds: [EVIDENCE] });
    expect(screen.getByRole("combobox", { name: "Disclosure profile" }).textContent).toContain("Full forensic package");
    expect(document.querySelector("[data-exchange-disclosure-profile]")?.getAttribute("data-exchange-disclosure-profile")).toBe("FULL_FORENSIC");
    expect(document.querySelector("[data-exchange-create-notice]")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("sends the chosen profile and confirms it when the server echoes it", async () => {
    await fillAndCreate("External disclosure package");
    expect(createBodies()[0]).toMatchObject({ evidenceIds: [EVIDENCE], disclosureProfile: "EXTERNAL_DISCLOSURE" });
    const notice = await screen.findByText("External disclosure package requested.");
    expect(notice.getAttribute("role")).toBe("status");
    expect(screen.queryByText(/created as a full forensic package/)).toBeNull();
  });

  it("says a full package was made when an older server ignores the profile", async () => {
    createReply = () => ({ packageId: "pkg-1" });
    await fillAndCreate("External disclosure package");
    const warning = await screen.findByText(/created as a full forensic package/);
    expect(warning.closest("[role=alert]")).toBeTruthy();
    expect(document.querySelector("[data-exchange-create-notice]")).toBeNull();
  });
});
