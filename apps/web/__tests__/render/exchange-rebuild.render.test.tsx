/**
 * D59 — Evidence Exchange: "Build again" for a package whose build failed.
 *
 *   POST /v1/exchange/packages/:id/build
 *     app/(app)/exchange/page.tsx — offered only on a DRAFT package whose
 *     projected `lastBuild` failed; no confirmation; announced only after the
 *     package list reread shows the package has left DRAFT; refusals in words.
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

const FAILED = "11111111-1111-4111-8111-111111111111";
const FAILED2 = "33333333-3333-4333-8333-333333333333";
const PLAIN_DRAFT = "22222222-2222-4222-8222-222222222222";
const READY = "44444444-4444-4444-8444-444444444444";
const ISO = "2026-09-01T10:00:00.000Z";

type Pkg = Record<string, unknown>;
function pkg(id: string, state: string, lastBuild: Pkg | null): Pkg {
  return { id, kind: "SHARE", evidenceIds: ["e1"], state, createdAt: ISO, deliveryCount: 0, signedUrlExpiresAtUtc: null, lastBuild };
}
const failedBuild = { state: "FAILED", failedAtUtc: ISO };

let states: Record<string, string>;
let buildReply: (id: string) => Promise<unknown>;

beforeEach(() => {
  states = { [FAILED]: "DRAFT", [FAILED2]: "DRAFT" };
  buildReply = async (id) => {
    states[id] = "BUILDING";
    return { packageId: id, state: "BUILDING" };
  };
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
    const m = /^\/v1\/exchange\/packages\/([^/]+)\/build$/.exec(path);
    if (init?.method === "POST" && m) return buildReply(decodeURIComponent(m[1]));
    if (path === "/v1/exchange/packages") {
      return {
        packages: [
          pkg(FAILED, states[FAILED], states[FAILED] === "DRAFT" ? failedBuild : null),
          pkg(FAILED2, states[FAILED2], states[FAILED2] === "DRAFT" ? failedBuild : null),
          pkg(PLAIN_DRAFT, "DRAFT", null),
          pkg(READY, "READY", failedBuild),
        ],
      };
    }
    if (path.includes("/deliveries")) return { deliveries: [], nextCursor: null };
    throw new Error("unexpected " + path);
  });
  mocks.confirm.mockReset();
  mocks.confirm.mockResolvedValue(true);
});
afterEach(cleanup);

const row = (id: string) => document.querySelector(`[data-exchange-package-row="${id}"]`) as HTMLElement;
const buildWrites = () => mocks.fetch.mock.calls.filter(([p, init]) => init?.method === "POST" && String(p).endsWith("/build"));
async function ready() {
  await waitFor(() => expect(row(FAILED)).toBeTruthy());
}

describe("D59 Exchange Build again", () => {
  it("D59 offers Build again only on a DRAFT package whose last build failed", async () => {
    render(<ExchangePage />);
    await ready();
    expect(within(row(FAILED)).getByText(/^Last build failed/)).toBeTruthy();
    expect(within(row(FAILED)).getByRole("button", { name: /^Build again/ })).toBeTruthy();
    expect(within(row(PLAIN_DRAFT)).queryByRole("button", { name: /^Build again/ })).toBeNull();
    expect(within(row(READY)).queryByRole("button", { name: /^Build again/ })).toBeNull();
    expect(within(row(READY)).queryByText(/Last build failed/)).toBeNull();
  });

  it("D59 requests the build without a confirmation and announces it only after the reread", async () => {
    render(<ExchangePage />);
    await ready();
    fireEvent.click(within(row(FAILED)).getByRole("button", { name: /^Build again/ }));
    const notice = await screen.findByText(/Build requested for the .* package and confirmed from the saved record/);
    expect(notice.textContent).toContain("Building");
    expect(buildWrites()).toHaveLength(1);
    expect(buildWrites()[0][0]).toBe(`/v1/exchange/packages/${FAILED}/build`);
    expect(mocks.confirm).not.toHaveBeenCalled();
    const calls = mocks.fetch.mock.calls.map((c) => c[0] as string);
    expect(calls.lastIndexOf("/v1/exchange/packages")).toBeGreaterThan(calls.indexOf(`/v1/exchange/packages/${FAILED}/build`));
    await waitFor(() => expect(row(FAILED).getAttribute("data-exchange-package-state")).toBe("BUILDING"));
    expect(within(row(FAILED)).queryByRole("button", { name: /^Build again/ })).toBeNull();
  });

  it("D59 a package that is no longer DRAFT is refused in words", async () => {
    buildReply = async () => {
      throw Object.assign(new Error("request failed"), { statusCode: 409, code: "EXCHANGE_PACKAGE_NOT_DRAFT" });
    };
    render(<ExchangePage />);
    await ready();
    fireEvent.click(within(row(FAILED)).getByRole("button", { name: /^Build again/ }));
    const alert = await screen.findByText(/no longer waiting for a build, so nothing was changed/);
    expect(alert.closest("[role=alert]")).toBeTruthy();
    expect(document.body.textContent).not.toContain("EXCHANGE_PACKAGE_NOT_DRAFT");
    expect(document.querySelector("[data-exchange-rebuild-notice]")).toBeNull();
  });

  it("D59 does not claim success when the reread still shows DRAFT", async () => {
    buildReply = async (id) => ({ packageId: id, state: "BUILDING" });
    render(<ExchangePage />);
    await ready();
    fireEvent.click(within(row(FAILED)).getByRole("button", { name: /^Build again/ }));
    await screen.findByText(/still shows as waiting for a build/);
    expect(document.querySelector("[data-exchange-rebuild-notice]")).toBeNull();
  });

  it("D59 other Build again controls say why they are disabled while one is in flight", async () => {
    let release: () => void = () => {};
    buildReply = (id) =>
      new Promise((resolve) => {
        release = () => {
          states[id] = "BUILDING";
          resolve({ packageId: id, state: "BUILDING" });
        };
      });
    render(<ExchangePage />);
    await ready();
    fireEvent.click(within(row(FAILED)).getByRole("button", { name: /^Build again/ }));
    const other = within(row(FAILED2)).getByRole("button", { name: /^Build again/ }) as HTMLButtonElement;
    await waitFor(() => expect(other.disabled).toBe(true));
    expect(other.getAttribute("data-disabled-reason")).toBe(
      "Another package build is being requested. Wait for it to finish.",
    );
    fireEvent.click(other);
    expect(buildWrites()).toHaveLength(1);
    release();
    await screen.findByText(/Build requested for the .* package and confirmed/);
  });
});
