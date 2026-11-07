/**
 * AUTH-LOCKOUT-NONTOTP — sign-in asks for the second factor the person
 * enrolled, through the rendered pages.
 *
 *   /auth/mfa-challenge  reads POST /v1/auth/mfa/methods on arrival (never the
 *                        verify route) and offers that person's factors: a
 *                        code sent to their phone, their passkey, or the
 *                        authenticator / recovery-code forms as before.
 *   /auth/mfa-passkey    the mobile app's system-browser half: the token comes
 *                        from the fragment, the sign-in endpoints are called,
 *                        and the outcome returns to the app's sign-in URL.
 *
 * The real `apiFetch` runs against a stubbed network (see
 * mfa-challenge-sign-in.render.test.tsx for why).
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  startAuthentication: vi.fn(),
  supports: vi.fn(() => true),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
  useSearchParams: () => new URLSearchParams("next=/cases"),
}));
vi.mock("../../components/mfa-recovery/MfaRecoveryRequestPanel", () => ({ MfaRecoveryRequestPanel: () => null }));
vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: mocks.supports,
  startAuthentication: mocks.startAuthentication,
  startRegistration: vi.fn(),
}));

import MfaChallengePage from "../../app/auth/mfa-challenge/page";
import { PasskeyHandoff, navigation } from "../../app/step-up/passkey/PasskeyHandoff";

type Reply = { status: number; body: unknown };
let routes: Record<string, Reply>;
const fetchMock = vi.fn();
const bodiesTo = (suffix: string) =>
  fetchMock.mock.calls
    .filter(([url]) => String(url).endsWith(suffix))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body ?? "{}")) as Record<string, unknown>);

beforeEach(() => {
  mocks.replace.mockReset();
  mocks.startAuthentication.mockReset();
  mocks.supports.mockReturnValue(true);
  routes = {
    "/v1/auth/mfa/verify": { status: 200, body: { token: "session" } },
    "/v1/auth/me": { status: 200, body: { user: { id: "u" } } },
  };
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    const key = Object.keys(routes).find((k) => String(url).endsWith(k));
    const reply = key ? routes[key]! : { status: 404, body: {} };
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("sign-in second factor: the one the person enrolled", () => {
  it("a phone-only account is offered a code to its phone, and the code completes the sign-in", async () => {
    routes["/v1/auth/mfa/methods"] = { status: 200, body: { methods: ["SMS"], destinationMask: "+1 •••• 1234", passkeyOptions: null } };
    routes["/v1/auth/mfa/send-code"] = { status: 200, body: { sent: true, channel: "SMS", destinationMask: "+1 •••• 1234" } };
    render(<MfaChallengePage />);
    fireEvent.click(await screen.findByRole("button", { name: "Send code" }));
    expect((await screen.findByText(/We sent a code to \+1 •••• 1234/)).textContent).toBeTruthy();
    expect(bodiesTo("/v1/auth/mfa/verify")).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("Code sent to your phone"), { target: { value: "482 913" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify and continue" }));
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/cases"));
    expect(bodiesTo("/v1/auth/mfa/verify")).toEqual([{ contactCode: "482913" }]);
  });

  it("a passkey-only account signs in with its passkey; a dismissed sheet sends nothing", async () => {
    const options = { challenge: "c".repeat(43), allowCredentials: [{ id: "cred-1" }] };
    const assertion = { id: "cred-1", type: "public-key", response: { signature: "s" } };
    routes["/v1/auth/mfa/methods"] = { status: 200, body: { methods: ["PASSKEY"], destinationMask: null, passkeyOptions: options } };
    render(<MfaChallengePage />);
    const go = await screen.findByRole("button", { name: "Continue with passkey" });

    mocks.startAuthentication.mockRejectedValueOnce(Object.assign(new Error("dismissed"), { name: "NotAllowedError" }));
    fireEvent.click(go);
    await screen.findByText(/nothing was sent/);
    expect(bodiesTo("/v1/auth/mfa/verify")).toHaveLength(0);

    mocks.startAuthentication.mockResolvedValueOnce(assertion);
    fireEvent.click(screen.getByRole("button", { name: "Continue with passkey" }));
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/cases"));
    expect(bodiesTo("/v1/auth/mfa/verify")).toEqual([{ passkeyAssertion: assertion }]);
  });

  it("lists the person's other enrolled factors to switch to", async () => {
    routes["/v1/auth/mfa/methods"] = {
      status: 200,
      body: { methods: ["PASSKEY", "TOTP", "SMS", "RECOVERY_CODE"], destinationMask: "+1 •••• 1234", passkeyOptions: { challenge: "x".repeat(43) } },
    };
    render(<MfaChallengePage />);
    await screen.findByRole("button", { name: "Continue with passkey" });
    expect(screen.getByRole("button", { name: "Use the authenticator code instead" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send a code to your phone instead" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use a recovery code instead" }));
    expect(await screen.findByLabelText("Single-use recovery code")).toBeTruthy();
  });

  it("an authenticator-only account keeps the same recovery toggle before and after the methods answer", async () => {
    routes["/v1/auth/mfa/methods"] = { status: 200, body: { methods: ["TOTP", "RECOVERY_CODE"], destinationMask: null, passkeyOptions: null } };
    render(<MfaChallengePage />);
    const before = document.querySelector('[data-cc-mfa-toggle="use-recovery"]');
    expect(before).toBeTruthy();
    await waitFor(() => expect(bodiesTo("/v1/auth/mfa/methods")).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelector("[data-cc-mfa-methods]")).toBeNull();
    expect(document.querySelector('[data-cc-mfa-toggle="use-recovery"]')).toBe(before);
    fireEvent.click(before as Element);
    expect(await screen.findByLabelText("Single-use recovery code")).toBeTruthy();
  });
});

describe("/auth/mfa-passkey — the app's system-browser passkey for a sign-in", () => {
  it("uses the sign-in endpoints with the fragment token and returns to the app's sign-in URL", async () => {
    const options = { challenge: "c".repeat(43), allowCredentials: [{ id: "cred-1" }] };
    const assertion = { id: "cred-1", type: "public-key", response: { signature: "s" } };
    routes["/v1/auth/mfa/passkey-handoff/options"] = { status: 200, body: { passkeyOptions: options } };
    routes["/v1/auth/mfa/passkey-handoff/answer"] = { status: 200, body: { verified: true } };
    const assign = vi.fn();
    vi.spyOn(navigation, "assign").mockImplementation(assign);
    mocks.startAuthentication.mockResolvedValue(assertion);
    const token = "t".repeat(43);
    window.history.replaceState(null, "", `/auth/mfa-passkey#token=${token}&return=app`);
    render(<PasskeyHandoff flow="sign-in" />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue with passkey" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("proovra://sign-in/passkey-complete?result=approved"));
    expect(window.location.hash).toBe("");
    expect(bodiesTo("/v1/auth/mfa/passkey-handoff/options")).toEqual([{ token }]);
    expect(bodiesTo("/v1/auth/mfa/passkey-handoff/answer")).toEqual([{ token, assertion }]);
    expect(screen.getByRole("heading").textContent).toMatch(/confirmed/);
  });
});
