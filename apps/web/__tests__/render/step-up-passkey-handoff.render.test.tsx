/**
 * /step-up/passkey — the mobile app's system-browser passkey handoff
 * (2026-10-28).
 *
 * Behaviour, through the rendered page: the challenge and token are read from
 * the URL FRAGMENT (never the query) and the fragment is cleared from history;
 * the options call and the answer call carry them in the body; a passkey
 * approves and the way back to the app is offered; a dismissed sheet is calm
 * and can be retried; a refused link is calm; with `return=app` the page
 * navigates to the app's return URL with the server's outcome.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  startAuthentication: vi.fn(),
  supports: vi.fn(() => true),
}));
vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: mocks.supports,
  startAuthentication: mocks.startAuthentication,
  startRegistration: vi.fn(),
}));
vi.mock("../../lib/api", () => ({ apiBaseUrl: () => "https://api.test" }));

import { PasskeyHandoff, navigation } from "../../app/step-up/passkey/PasskeyHandoff";

const CHALLENGE = "22222222-2222-4222-8222-222222222222";
const TOKEN = "t".repeat(43);
const OPTIONS = { challenge: "c".repeat(43), allowCredentials: [{ id: "cred-1" }] };
const ASSERTION = { id: "cred-1", type: "public-key", response: { signature: "s" } };

type Call = { url: string; body: Record<string, unknown> };
let calls: Call[] = [];
let answerStatus = 200;
let optionsStatus = 200;
const assign = vi.fn();

function respond(status: number, body: unknown) {
  return { status, ok: status < 300, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  calls = [];
  answerStatus = 200;
  optionsStatus = 200;
  assign.mockReset();
  vi.spyOn(navigation, "assign").mockImplementation(assign);
  mocks.supports.mockReturnValue(true);
  mocks.startAuthentication.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      if (url.endsWith("/handoff/passkey/options")) {
        return optionsStatus === 200 ? respond(200, { passkeyOptions: OPTIONS }) : respond(optionsStatus, { status: "denied" });
      }
      if (url.endsWith("/handoff/passkey")) {
        return answerStatus === 200 ? respond(200, { status: "approved" }) : respond(answerStatus, { status: "denied" });
      }
      return respond(404, {});
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function openAt(hash: string) {
  window.history.replaceState(null, "", `/step-up/passkey${hash}`);
  return render(<PasskeyHandoff />);
}

describe("passkey handoff page", () => {
  it("reads the fragment, clears it from history, and approves with the passkey", async () => {
    mocks.startAuthentication.mockResolvedValue(ASSERTION);
    openAt(`#challenge=${CHALLENGE}&token=${TOKEN}`);
    const go = await screen.findByRole("button", { name: "Continue with passkey" });
    expect(window.location.hash).toBe("");
    expect(window.location.search).toBe("");
    expect(calls[0]).toEqual({
      url: "https://api.test/v1/identity-security/step-up/handoff/passkey/options",
      body: { challengeId: CHALLENGE, token: TOKEN },
    });

    fireEvent.click(go);
    expect(await screen.findByRole("heading", { name: "You're confirmed" })).toBeTruthy();
    expect(mocks.startAuthentication).toHaveBeenCalledWith({ optionsJSON: OPTIONS });
    expect(calls[1]).toEqual({
      url: "https://api.test/v1/identity-security/step-up/handoff/passkey",
      body: { challengeId: CHALLENGE, token: TOKEN, assertion: ASSERTION },
    });
    const back = screen.getByRole("link", { name: "Return to the PROOVRA app" });
    expect(back.getAttribute("href")).toBe("proovra://step-up/complete");
    expect(assign).not.toHaveBeenCalled();
  });

  it("a dismissed passkey sheet is calm and can be retried", async () => {
    mocks.startAuthentication.mockRejectedValueOnce(Object.assign(new Error("no"), { name: "NotAllowedError" }));
    mocks.startAuthentication.mockResolvedValueOnce(ASSERTION);
    openAt(`#challenge=${CHALLENGE}&token=${TOKEN}`);
    fireEvent.click(await screen.findByRole("button", { name: "Continue with passkey" }));
    expect(await screen.findByText(/nothing was confirmed/)).toBeTruthy();
    expect(calls.filter((c) => c.url.endsWith("/handoff/passkey"))).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "You're confirmed" })).toBeTruthy();
  });

  it("a link without a usable fragment never calls the API and says so calmly", async () => {
    openAt("");
    expect(await screen.findByText(/expired or was already used/)).toBeTruthy();
    expect(calls).toHaveLength(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("an expired or used link (uniform 400) is reported calmly", async () => {
    optionsStatus = 400;
    openAt(`#challenge=${CHALLENGE}&token=${TOKEN}`);
    expect(await screen.findByText(/expired or was already used/)).toBeTruthy();
    expect(mocks.startAuthentication).not.toHaveBeenCalled();
  });

  it("return=app: an approval navigates to the app with result=approved", async () => {
    mocks.startAuthentication.mockResolvedValue(ASSERTION);
    openAt(`#challenge=${CHALLENGE}&token=${TOKEN}&return=app`);
    fireEvent.click(await screen.findByRole("button", { name: "Continue with passkey" }));
    await screen.findByRole("heading", { name: "You're confirmed" });
    expect(assign).toHaveBeenCalledWith("proovra://step-up/complete?result=approved");
  });

  it("return=app: a refusal navigates to the app with result=denied", async () => {
    answerStatus = 400;
    mocks.startAuthentication.mockResolvedValue(ASSERTION);
    openAt(`#challenge=${CHALLENGE}&token=${TOKEN}&return=app`);
    fireEvent.click(await screen.findByRole("button", { name: "Continue with passkey" }));
    expect(await screen.findByText(/couldn't confirm with that passkey/)).toBeTruthy();
    expect(assign).toHaveBeenCalledWith("proovra://step-up/complete?result=denied");
  });

  it("return=app: a dismissed sheet does NOT navigate (it is not the server's answer)", async () => {
    mocks.startAuthentication.mockRejectedValue(Object.assign(new Error("no"), { name: "AbortError" }));
    openAt(`#challenge=${CHALLENGE}&token=${TOKEN}&return=app`);
    fireEvent.click(await screen.findByRole("button", { name: "Continue with passkey" }));
    expect(await screen.findByText(/nothing was confirmed/)).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
  });
});
