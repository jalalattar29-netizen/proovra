import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * RT-006 — the sign-in MFA challenge page.
 *
 * The pending token lives only in an HTTP-only cookie, so nothing but the
 * user's own submission may reach the verify route: the page used to post an
 * empty body on load, and that request cost the user the challenge.
 *
 * The real `apiFetch` runs against a stubbed network. The route answers a flat
 * `{ message }`, which `apiFetch` raises as a plain Error rather than ApiError,
 * so a mocked `apiFetch` would prove a branch the page never reaches.
 */

const mocks = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
  useSearchParams: () => new URLSearchParams("next=/cases"),
}));
vi.mock("../../components/mfa-recovery/MfaRecoveryRequestPanel", () => ({ MfaRecoveryRequestPanel: () => null }));

import MfaChallengePage from "../../app/auth/mfa-challenge/page";

const VERIFY = "/v1/auth/mfa/verify";

let verifyReply: { status: number; body: unknown };
const fetchMock = vi.fn();

function verifyCalls() {
  return fetchMock.mock.calls.filter(([url]) => String(url).endsWith(VERIFY));
}

async function submitCode(code: string) {
  fireEvent.change(await screen.findByLabelText("Six-digit authenticator code"), { target: { value: code } });
  fireEvent.click(screen.getByRole("button", { name: "Verify and continue" }));
}

beforeEach(() => {
  mocks.replace.mockReset();
  verifyReply = { status: 200, body: { token: "session" } };
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    const reply = String(url).endsWith(VERIFY) ? verifyReply : { status: 200, body: { user: { id: "u" } } };
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("sign-in MFA challenge", () => {
  it("sends nothing to the verify route until the user submits, and shows no error on arrival", async () => {
    render(<MfaChallengePage />);
    await screen.findByRole("heading", { name: "Two-factor verification" });
    await new Promise((r) => setTimeout(r, 0));
    expect(verifyCalls()).toHaveLength(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("submits the code once and continues to the requested page", async () => {
    render(<MfaChallengePage />);
    await submitCode("123 456");
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/cases"));
    expect(verifyCalls()).toHaveLength(1);
    expect(JSON.parse(String(verifyCalls()[0]![1].body))).toEqual({ code: "123456" });
  });

  it("keeps the form up for a wrong code", async () => {
    verifyReply = { status: 401, body: { message: "mfa_invalid" } };
    render(<MfaChallengePage />);
    await submitCode("123456");
    expect((await screen.findByRole("alert")).textContent).toMatch(/did not match/);
    expect(screen.getByLabelText("Six-digit authenticator code")).toBeTruthy();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("states the wait when attempts are rate limited", async () => {
    verifyReply = { status: 429, body: { message: "rate_limited" } };
    render(<MfaChallengePage />);
    await submitCode("123456");
    expect((await screen.findByRole("alert")).textContent).toMatch(/Wait a minute/);
  });

  it.each(["mfa_pending_invalid", "mfa_challenge_expired", "mfa_challenge_already_used"])(
    "offers a fresh sign-in when the route answers %s",
    async (message) => {
      verifyReply = { status: 401, body: { message } };
      render(<MfaChallengePage />);
      await submitCode("123456");
      await screen.findByRole("heading", { name: "Sign-in session expired" });
      expect(screen.getByRole("link", { name: "Return to sign in" }).getAttribute("href")).toBe("/login");
    },
  );
});
