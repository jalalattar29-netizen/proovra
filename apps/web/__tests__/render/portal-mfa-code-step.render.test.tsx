import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * D27 — the external reviewer's emailed-code step.
 *
 * The API emails a six-digit code to the invited address and refuses the
 * portal until the code is verified. These tests drive the real pages against
 * a mocked API origin and prove: the masked destination is shown only when the
 * server says a code was sent, "Send a new code" is disabled with a reason
 * during the cooldown, each refusal is explained in product language, and
 * nothing navigates to the portal before the server answers 200.
 */

// React 18 in the harness has no `use`; the accept page reads a settled promise.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, default: actual, use: (p: { value: unknown }) => p.value };
});
vi.mock("../../lib/api", () => ({ apiBaseUrl: () => "https://api.example.test" }));

const push = vi.fn();
let search = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => search,
  usePathname: () => "/portal",
}));

import PortalTokenEntryPage from "../../app/portal/page";
import PortalAcceptPage from "../../app/portal/accept/[grantId]/page";

const AUTH = "https://api.example.test/v1/portal/auth";
const TOKEN = "tok-abcdefghijkl";

type Reply = { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;
let replies: Reply[];
const fetchMock = vi.fn();

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const sent = (seconds = 60) => ({
  status: 401,
  body: { denial: "MFA_REQUIRED", codeSent: true, destination: "r***@x.test", resendAvailableInSeconds: seconds, attemptsRemaining: null },
});
const ok = { status: 200, body: { sessionId: "a".repeat(32), newLogin: true, reviewerEmail: "r@x.test", role: "EXTERNAL_REVIEWER", expiresAtUtc: "2027-01-01T00:00:00.000Z" } };

function authBodies(): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter(([url]) => url === AUTH)
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

beforeEach(() => {
  push.mockReset();
  search = new URLSearchParams();
  replies = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    if (url !== AUTH) return json(404, {});
    const next = replies.shift();
    if (!next) throw new Error("unexpected auth call");
    const r = await next;
    return json(r.status, r.body);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function reachCodeStep(first: Reply = sent()) {
  replies.push(first);
  render(<PortalTokenEntryPage />);
  fireEvent.change(screen.getByLabelText("Invitation token"), { target: { value: TOKEN } });
  fireEvent.click(screen.getByRole("button", { name: "Open portal" }));
  await screen.findByRole("heading", { name: "Enter your sign-in code" });
}
const codeInput = () => screen.getByLabelText("Six-digit code") as HTMLInputElement;
const verifyButton = () => screen.getByRole("button", { name: /Verify code|Checking code/ });
const resendButton = () => screen.getByRole("button", { name: /Send a (new )?code|Sending/ });

describe("portal sign-in — emailed code step", () => {
  it("says where the code went, focuses the code field and does not open the portal", async () => {
    await reachCodeStep();
    expect(screen.getByText(/We emailed a six-digit code to r\*\*\*@x\.test\./)).toBeTruthy();
    expect(document.activeElement).toBe(codeInput());
    expect(push).not.toHaveBeenCalled();
    expect(authBodies()).toEqual([{ token: TOKEN }]);
    // The token cannot be edited under a code that belongs to it.
    expect((screen.getByLabelText("Invitation token") as HTMLInputElement).readOnly).toBe(true);
  });

  it("verify is disabled with a reason until six digits are entered, and non-digits are dropped", async () => {
    await reachCodeStep();
    expect(verifyButton().hasAttribute("disabled")).toBe(true);
    expect(verifyButton().getAttribute("data-disabled-reason")).toBe("Enter the six-digit code from the email.");
    fireEvent.change(codeInput(), { target: { value: "12a3" } });
    expect(codeInput().value).toBe("123");
    fireEvent.change(codeInput(), { target: { value: "123456" } });
    expect(verifyButton().hasAttribute("disabled")).toBe(false);
  });

  it("opens the portal only after the server accepts the code, sending the code it was given", async () => {
    await reachCodeStep();
    let release!: (r: { status: number; body: unknown }) => void;
    replies.push(new Promise((r) => (release = r)));
    fireEvent.change(codeInput(), { target: { value: "482913" } });
    fireEvent.click(verifyButton());
    await screen.findByRole("button", { name: /Checking code/ });
    expect(push).not.toHaveBeenCalled();
    expect(authBodies()[1]).toEqual({ token: TOKEN, mfaToken: "482913" });

    await act(async () => release(ok));
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/portal/${encodeURIComponent(TOKEN)}`));
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("a wrong code is explained with the tries left, clears the field and does not navigate", async () => {
    await reachCodeStep();
    replies.push({ status: 401, body: { denial: "MFA_INVALID", codeSent: false, destination: null, resendAvailableInSeconds: null, attemptsRemaining: 4 } });
    fireEvent.change(codeInput(), { target: { value: "111111" } });
    fireEvent.click(verifyButton());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("That code is not correct. You have 4 tries left.");
    expect(alert.getAttribute("data-portal-mfa-problem")).toBe("MFA_INVALID");
    expect(codeInput().value).toBe("");
    expect(push).not.toHaveBeenCalled();
  });

  it("an exhausted code says a new one is needed and releases the resend cooldown", async () => {
    await reachCodeStep();
    expect(resendButton().hasAttribute("disabled")).toBe(true);
    replies.push({ status: 401, body: { denial: "MFA_CODE_EXHAUSTED", codeSent: false, destination: null, resendAvailableInSeconds: null, attemptsRemaining: 0 } });
    fireEvent.change(codeInput(), { target: { value: "222222" } });
    fireEvent.click(verifyButton());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Too many incorrect codes\. That code no longer works\./);
    expect(screen.queryByText(/We emailed a six-digit code/)).toBeNull();
    expect(resendButton().hasAttribute("disabled")).toBe(false);
    expect(resendButton().textContent).toBe("Send a code");
    expect(push).not.toHaveBeenCalled();
  });

  it("an unavailable code service is refused in plain language, never as a sent code", async () => {
    await reachCodeStep({ status: 503, body: { denial: "MFA_UNAVAILABLE" } });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe(
      "We can't send or check sign-in codes right now, so the portal stays closed. Try again in a few minutes.",
    );
    expect(screen.queryByText(/We emailed/)).toBeNull();
    expect(screen.getByText("This invitation needs a six-digit code sent to the invited email address.")).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });

  it("a rate-limited request says how long to wait", async () => {
    await reachCodeStep({ status: 429, body: { denial: "RATE_LIMITED" } });
    expect(screen.getByRole("alert").textContent).toBe(
      "Too many codes were requested for this invitation. Wait 15 minutes, then send a new code.",
    );
  });

  it("'Send a new code' is disabled with a counting reason for the cooldown, then requests a new code", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], shouldAdvanceTime: false });
    await reachCodeStep();
    expect(resendButton().hasAttribute("disabled")).toBe(true);
    expect(resendButton().getAttribute("data-disabled-reason")).toBe("You can ask for a new code in 60 seconds.");

    act(() => vi.advanceTimersByTime(20_000));
    expect(resendButton().getAttribute("data-disabled-reason")).toBe("You can ask for a new code in 40 seconds.");

    act(() => vi.advanceTimersByTime(40_000));
    expect(resendButton().hasAttribute("disabled")).toBe(false);
    expect(resendButton().getAttribute("data-disabled-reason")).toBeNull();

    replies.push(sent(60));
    fireEvent.click(resendButton());
    await waitFor(() => expect(authBodies()).toHaveLength(2));
    expect(authBodies()[1]).toEqual({ token: TOKEN });
    await waitFor(() => expect(resendButton().hasAttribute("disabled")).toBe(true));
    expect(resendButton().getAttribute("data-disabled-reason")).toBe("You can ask for a new code in 60 seconds.");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(push).not.toHaveBeenCalled();
  });

  it("a refused token is explained without showing the code step", async () => {
    replies.push({ status: 401, body: { denial: "TOKEN_REVOKED" } });
    render(<PortalTokenEntryPage />);
    fireEvent.change(screen.getByLabelText("Invitation token"), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole("button", { name: "Open portal" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/This invitation was withdrawn/);
    expect(screen.queryByLabelText("Six-digit code")).toBeNull();
  });
});

describe("invitation landing — emailed code step in place", () => {
  function resolved<T>(value: T) {
    const p = Promise.resolve(value) as Promise<T> & { status?: string; value?: T };
    p.status = "fulfilled";
    p.value = value;
    return p;
  }

  it("asks for the code on the landing page instead of sending the reviewer to paste the token again", async () => {
    search = new URLSearchParams({ token: TOKEN });
    replies.push(sent());
    render(<PortalAcceptPage params={resolved({ grantId: "11111111-1111-4111-8111-111111111111" })} />);
    fireEvent.click(screen.getByRole("button", { name: "Open with invitation link" }));
    await screen.findByText(/We emailed a six-digit code to r\*\*\*@x\.test\./);
    expect(push).not.toHaveBeenCalled();

    replies.push(ok);
    fireEvent.change(codeInput(), { target: { value: "654321" } });
    fireEvent.click(verifyButton());
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/portal/${encodeURIComponent(TOKEN)}`));
    expect(push).not.toHaveBeenCalledWith("/portal");
    expect(authBodies()[1]).toEqual({ token: TOKEN, mfaToken: "654321" });
  });
});

describe("signed-in portal pages — lapsed MFA", () => {
  it("the dashboard asks for the code before loading anything, and loads only after the server accepts it", async () => {
    const { default: PortalDashboardPage } = await import("../../app/portal/[token]/page");
    const p = Promise.resolve({ token: TOKEN }) as Promise<{ token: string }> & { status?: string; value?: unknown };
    p.status = "fulfilled";
    p.value = { token: TOKEN };
    const dashboardCalls = () =>
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/v1/portal/dashboard")).length;

    replies.push(sent());
    render(<PortalDashboardPage params={p} />);
    await screen.findByRole("heading", { name: "Confirm it is you" });
    expect(screen.getByText(/We emailed a six-digit code to r\*\*\*@x\.test\./)).toBeTruthy();
    expect(screen.queryByText(/Portal access denied/)).toBeNull();
    expect(dashboardCalls()).toBe(0);

    replies.push(ok, ok);
    fireEvent.change(codeInput(), { target: { value: "135790" } });
    fireEvent.click(verifyButton());
    await waitFor(() => expect(dashboardCalls()).toBe(1));
    expect(authBodies()[1]).toMatchObject({ token: TOKEN, mfaToken: "135790" });
    // The reload re-authenticates without a code: the server now reports MFA satisfied.
    expect(authBodies()[2]).not.toHaveProperty("mfaToken");
  });
});
