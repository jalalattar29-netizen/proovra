/**
 * Settings → Security: "Passkeys and security keys" (2026-10-28).
 *
 * Behaviour, through the rendered card: it lists the account's passkeys with
 * empty / loading / error states; adding one re-drives the server's account
 * step-up (401 STEP_UP_REQUIRED -> "Verify it's you" -> retry WITH the proof),
 * runs the browser ceremony and posts the ticket + label + response; a
 * dismissed passkey sheet is calm and posts nothing; removing one confirms,
 * re-drives the step-up the same way and reloads.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  startRegistration: vi.fn(),
  startAuthentication: vi.fn(),
  supports: vi.fn(() => true),
  confirm: vi.fn(async () => true),
}));

vi.mock("../../lib/api", () => ({ apiFetch: mocks.fetch, ApiError: class ApiError extends Error {} }));
vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: mocks.supports,
  startRegistration: mocks.startRegistration,
  startAuthentication: mocks.startAuthentication,
}));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: mocks.confirm }) }));
vi.mock("../../app/(app)/security-center/components/PersonalSecuritySections", () => ({
  extractStepUp: (err: { body?: { error?: { code?: string; methods?: string[] } } }) => {
    const code = err?.body?.error?.code;
    return code === "STEP_UP_REQUIRED" || code === "STEP_UP_INVALID"
      ? { methods: err.body?.error?.methods ?? ["reauth"], message: "" }
      : null;
  },
  StepUpVerify: ({ title, onSubmit }: { title: string; onSubmit: (p: unknown) => void }) => (
    <div role="group" aria-label="Verify it's you">
      <p>{title}</p>
      <button type="button" onClick={() => onSubmit({ method: "password", currentPassword: "pw" })}>
        Verify &amp; continue
      </button>
    </div>
  ),
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
const stepUpRequired = () =>
  Object.assign(new Error("step up"), { body: { error: { code: "STEP_UP_REQUIRED", methods: ["password"] } } });

type Call = { path: string; init?: RequestInit };
const calls: Call[] = [];
const bodyOf = (c: Call) => JSON.parse(String(c.init?.body ?? "{}"));

beforeEach(() => {
  calls.length = 0;
  mocks.fetch.mockReset();
  mocks.startRegistration.mockReset();
  mocks.confirm.mockClear();
  mocks.supports.mockReturnValue(true);
});
afterEach(() => vi.clearAllMocks());

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

  it("adds a passkey: step-up re-driven with the proof, ceremony run, ticket + label + response posted", async () => {
    const listed: unknown[][] = [[], [KEY]];
    let optionsAttempts = 0;
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      if (path === "/v1/identity-security/passkeys") return { passkeys: listed.shift() ?? [KEY] };
      if (path.endsWith("/registration/options")) {
        optionsAttempts += 1;
        if (optionsAttempts === 1) throw stepUpRequired();
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

    const prompt = await screen.findByRole("group", { name: "Verify it's you" });
    expect(mocks.startRegistration).not.toHaveBeenCalled();
    fireEvent.click(within(prompt).getByRole("button", { name: /Verify/ }));

    expect(await screen.findByText("Passkey “Work laptop” added.")).toBeTruthy();
    const optionCalls = calls.filter((c) => c.path.endsWith("/registration/options"));
    expect(bodyOf(optionCalls[0]!)).toEqual({});
    expect(bodyOf(optionCalls[1]!)).toEqual({ stepUp: { method: "password", currentPassword: "pw" } });
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

  it("removes a passkey after confirming and passing the step-up", async () => {
    const listed: unknown[][] = [[KEY], []];
    let deletes = 0;
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      if (path === "/v1/identity-security/passkeys") return { passkeys: listed.shift() ?? [] };
      if (path === `/v1/identity-security/passkeys/${KEY.id}` && init?.method === "DELETE") {
        deletes += 1;
        if (deletes === 1) throw stepUpRequired();
        return { ok: true };
      }
      throw new Error(`unexpected ${path}`);
    });
    render(<PasskeysCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove passkey Work laptop" }));
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    const prompt = await screen.findByRole("group", { name: "Verify it's you" });
    fireEvent.click(within(prompt).getByRole("button", { name: /Verify/ }));
    expect(await screen.findByText("Passkey “Work laptop” removed.")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("You have no passkeys yet.")).toBeTruthy());
    const del = calls.filter((c) => c.init?.method === "DELETE");
    expect(bodyOf(del[0]!)).toEqual({});
    expect(bodyOf(del[1]!)).toEqual({ stepUp: { method: "password", currentPassword: "pw" } });
    // The confirmation is asked once, not again on the proof retry.
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
  });
});
