/**
 * Settings → Security: "Passkeys and security keys" (2026-10-28).
 *
 * Behaviour, through the rendered card: it lists the account's passkeys with
 * empty / loading / error states. Binding or removing a passkey is answered by
 * the STRONGEST authenticator the person already holds (closure audit N-2):
 * the card names the workspace the person is in, the server answers 401
 * STEP_UP_REQUIRED for PASSKEY_REGISTER / PASSKEY_REMOVE, the one step-up
 * dialog verifies, and the SAME request is retried with the challenge header.
 * A dismissed passkey sheet is calm and posts nothing.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const WS = "22222222-2222-4222-8222-222222222222";
const CHALLENGE = "33333333-3333-4333-8333-333333333333";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  startRegistration: vi.fn(),
  startAuthentication: vi.fn(),
  supports: vi.fn(() => true),
  confirm: vi.fn(async () => true),
}));

vi.mock("../../lib/api", () => ({ apiFetch: mocks.fetch, ApiError: class ApiError extends Error {} }));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: mocks.supports,
  startRegistration: mocks.startRegistration,
  startAuthentication: mocks.startAuthentication,
}));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: mocks.confirm }) }));
vi.mock("../../lib/platform-context", () => ({
  usePlatformContext: () => ({ activeWorkspaceId: WS }),
}));

import { PasskeysCard } from "../../components/identity-security/PasskeysCard";

const KEY = {
  id: "11111111-1111-4111-8111-111111111111",
  label: "Work laptop",
  createdAt: "2026-10-01T10:00:00.000Z",
  lastUsedAt: null,
  backedUp: true,
  transports: ["internal", "hybrid"],
};

function stepUpRequired(purpose: string, resourceKind: string, resourceId: string) {
  return Object.assign(new Error("Step-up required"), {
    code: "STEP_UP_REQUIRED",
    statusCode: 401,
    details: { purpose, resourceKind, resourceId },
  });
}

type Call = { path: string; init?: RequestInit };
const calls: Call[] = [];
const bodyOf = (c: Call) => JSON.parse(String(c.init?.body ?? "{}"));
const headerOf = (c: Call) => (c.init?.headers as Record<string, string> | undefined)?.["x-proovra-step-up-challenge-id"];

/** The one step-up dialog: started, verified with an authenticator code. */
function stepUpRoutes(path: string, init?: RequestInit) {
  if (path === "/v1/identity-security/step-up/start") {
    return { challenge: { id: CHALLENGE }, method: "TOTP", availableMethods: ["TOTP"], destinationMask: null };
  }
  if (path === "/v1/identity-security/step-up/check") {
    expect(JSON.parse(String(init?.body))).toMatchObject({ teamId: WS, challengeId: CHALLENGE, code: "123456" });
    return { status: "approved" };
  }
  return undefined;
}

async function verifyStepUp() {
  const input = await screen.findByLabelText("Code from your authenticator app");
  fireEvent.change(input, { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: "Confirm + retry" }));
}

beforeEach(() => {
  calls.length = 0;
  mocks.fetch.mockReset();
  mocks.startRegistration.mockReset();
  mocks.confirm.mockClear();
  mocks.supports.mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PasskeysCard", () => {
  it("shows loading, then the empty state", async () => {
    let resolve: (v: unknown) => void = () => {};
    mocks.fetch.mockImplementation(() => new Promise((r) => (resolve = r)));
    render(<PasskeysCard />);
    expect(screen.getByRole("heading", { name: "Passkeys and security keys" })).toBeTruthy();
    expect(screen.getByText("Loading passkeys…")).toBeTruthy();
    resolve({ passkeys: [] });
    expect(await screen.findByText("You have no passkeys yet.")).toBeTruthy();
  });

  it("shows a load failure as an alert", async () => {
    mocks.fetch.mockRejectedValue(new Error("boom"));
    render(<PasskeysCard />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not be loaded/);
  });

  it("adds a passkey: the ladder step-up is answered, the SAME request retried with the challenge, then the ceremony", async () => {
    const listed: unknown[][] = [[], [KEY]];
    let optionsAttempts = 0;
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      const su = stepUpRoutes(path, init);
      if (su) return su;
      if (path === "/v1/identity-security/passkeys") return { passkeys: listed.shift() ?? [KEY] };
      if (path.endsWith("/registration/options")) {
        optionsAttempts += 1;
        if (optionsAttempts === 1) throw stepUpRequired("PASSKEY_REGISTER", "user", "me");
        return { options: { challenge: "c".repeat(43) }, ticket: "ticket-abc" };
      }
      if (path.endsWith("/registration/verify")) return { passkey: KEY };
      throw new Error(`unexpected ${path}`);
    });
    mocks.startRegistration.mockResolvedValue({ id: "cred-1", type: "public-key", response: {} });

    render(<PasskeysCard />);
    await screen.findByText("You have no passkeys yet.");
    fireEvent.change(screen.getByLabelText("Name for the new passkey"), { target: { value: "Work laptop" } });
    fireEvent.click(screen.getByRole("button", { name: "Add passkey" }));

    await screen.findByRole("dialog", { name: "Step-up confirmation" });
    expect(mocks.startRegistration).not.toHaveBeenCalled();
    await verifyStepUp();

    expect(await screen.findByText("Passkey “Work laptop” added.")).toBeTruthy();
    const optionCalls = calls.filter((c) => c.path.endsWith("/registration/options"));
    expect(bodyOf(optionCalls[0]!)).toEqual({ workspaceId: WS });
    expect(headerOf(optionCalls[0]!)).toBeUndefined();
    expect(bodyOf(optionCalls[1]!)).toEqual({ workspaceId: WS });
    expect(headerOf(optionCalls[1]!)).toBe(CHALLENGE);
    const start = calls.find((c) => c.path === "/v1/identity-security/step-up/start")!;
    expect(bodyOf(start)).toMatchObject({ teamId: WS, purpose: "PASSKEY_REGISTER" });
    expect(mocks.startRegistration).toHaveBeenCalledWith({ optionsJSON: { challenge: "c".repeat(43) } });
    const verify = calls.find((c) => c.path.endsWith("/registration/verify"))!;
    expect(bodyOf(verify)).toEqual({
      ticket: "ticket-abc",
      label: "Work laptop",
      response: { id: "cred-1", type: "public-key", response: {} },
    });
    expect(await screen.findByText("Work laptop")).toBeTruthy();
  });

  it("a dismissed passkey sheet is calm and posts nothing", async () => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      if (path === "/v1/identity-security/passkeys") return { passkeys: [] };
      if (path.endsWith("/registration/options")) return { options: { challenge: "x" }, ticket: "t" };
      throw new Error(`unexpected ${path}`);
    });
    mocks.startRegistration.mockRejectedValue(Object.assign(new Error("dismissed"), { name: "NotAllowedError" }));
    render(<PasskeysCard />);
    await screen.findByText("You have no passkeys yet.");
    fireEvent.change(screen.getByLabelText("Name for the new passkey"), { target: { value: "Key" } });
    fireEvent.click(screen.getByRole("button", { name: "Add passkey" }));
    expect(await screen.findByText("Passkey setup was cancelled. Nothing was changed.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(calls.some((c) => c.path.endsWith("/registration/verify"))).toBe(false);
  });

  it("removes a passkey after confirming and answering the ladder step-up", async () => {
    const listed: unknown[][] = [[KEY], []];
    let deletes = 0;
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      const su = stepUpRoutes(path, init);
      if (su) return su;
      if (path === "/v1/identity-security/passkeys") return { passkeys: listed.shift() ?? [] };
      if (path === `/v1/identity-security/passkeys/${KEY.id}` && init?.method === "DELETE") {
        deletes += 1;
        if (deletes === 1) throw stepUpRequired("PASSKEY_REMOVE", "mfa_factor", KEY.id);
        return { ok: true };
      }
      throw new Error(`unexpected ${path}`);
    });
    render(<PasskeysCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove passkey Work laptop" }));
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    await verifyStepUp();
    expect(await screen.findByText("Passkey “Work laptop” removed.")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("You have no passkeys yet.")).toBeTruthy());
    const del = calls.filter((c) => c.init?.method === "DELETE");
    expect(bodyOf(del[0]!)).toEqual({ workspaceId: WS });
    expect(headerOf(del[1]!)).toBe(CHALLENGE);
    // The confirmation is asked once, not again on the retry.
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
  });

  it("cancelling the step-up changes nothing and says so", async () => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      const su = stepUpRoutes(path, init);
      if (su) return su;
      if (path === "/v1/identity-security/passkeys") return { passkeys: [] };
      if (path.endsWith("/registration/options")) throw stepUpRequired("PASSKEY_REGISTER", "user", "me");
      throw new Error(`unexpected ${path}`);
    });
    render(<PasskeysCard />);
    await screen.findByText("You have no passkeys yet.");
    fireEvent.change(screen.getByLabelText("Name for the new passkey"), { target: { value: "Key" } });
    fireEvent.click(screen.getByRole("button", { name: "Add passkey" }));
    // Wait for the verifying stage, not just the dialog: the "Preparing…"
    // stage has its own Cancel, which React replaces when /step-up/start
    // answers. Clicking the first Cancel found could hit that detached button
    // and do nothing — this case failed on ci for a12372913 that way.
    await screen.findByLabelText("Code from your authenticator app");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Nothing was changed.")).toBeTruthy();
    expect(mocks.startRegistration).not.toHaveBeenCalled();
  });

  for (const approved of [false, true]) {
    it(`cancelling while the step-up is still starting stays cancelled when the start answers late (${approved ? "pre-approved" : "challenge"})`, async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => (release = r));
      let optionsCalls = 0;
      mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
        calls.push({ path, init });
        if (path === "/v1/identity-security/step-up/start") {
          await gate;
          return approved
            ? { challenge: { id: CHALLENGE, status: "APPROVED" } }
            : { challenge: { id: CHALLENGE }, method: "TOTP", availableMethods: ["TOTP"], destinationMask: null };
        }
        if (path === "/v1/identity-security/passkeys") return { passkeys: [] };
        if (path.endsWith("/registration/options")) {
          optionsCalls += 1;
          if (optionsCalls === 1) throw stepUpRequired("PASSKEY_REGISTER", "user", "me");
          return { challenge: "x" };
        }
        throw new Error(`unexpected ${path}`);
      });
      render(<PasskeysCard />);
      await screen.findByText("You have no passkeys yet.");
      fireEvent.change(screen.getByLabelText("Name for the new passkey"), { target: { value: "Key" } });
      fireEvent.click(screen.getByRole("button", { name: "Add passkey" }));
      await screen.findByText("Preparing your verification…");
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(await screen.findByText("Nothing was changed.")).toBeTruthy();
      release();
      // The late answer belongs to a cancelled flow: no dialog comes back,
      // and nothing is retried.
      await waitFor(() => expect(calls.some((c) => c.path === "/v1/identity-security/step-up/start")).toBe(true));
      await new Promise((r) => setTimeout(r, 50));
      expect(screen.queryByRole("dialog", { name: "Step-up confirmation" })).toBeNull();
      expect(optionsCalls).toBe(1);
      expect(mocks.startRegistration).not.toHaveBeenCalled();
    });
  }
});
