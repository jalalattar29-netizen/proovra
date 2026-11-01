import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

/**
 * The password reset form's failure states.
 *
 * The confirm route answers a flat `{ message: "<reason>" }`, which `apiFetch`
 * raises as a plain Error, not ApiError. The page also compared the reason to
 * `toSafeUserError`'s sentence, which never carries it, so a dead link read as
 * a generic failure and the user was never offered a new one.
 *
 * The real `apiFetch` runs against a stubbed network, because a mocked
 * `apiFetch` would prove a branch the page never reaches.
 */

const mocks = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () => new URLSearchParams("token=reset-token-from-the-email"),
}));
vi.mock("../../components/marketing/MarketingHeader", () => ({ MarketingHeader: () => null }));

import ResetPasswordPage from "../../app/reset-password/page";

const PASSWORD = "Str0ng-Reset-Passw0rd";

let confirmReply: () => Promise<Response>;
const fetchMock = vi.fn();

function json(status: number, body: unknown) {
  return async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function submitNewPassword() {
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: PASSWORD } });
  fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: PASSWORD } });
  fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
}

beforeEach(() => {
  confirmReply = json(200, { ok: true });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => confirmReply());
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("password reset failure states", () => {
  it.each(["invalid_or_expired", "invalid_token"])("offers a new link when the route answers %s", async (message) => {
    confirmReply = json(400, { message });
    render(<ResetPasswordPage />);
    submitNewPassword();
    await screen.findByRole("heading", { name: "Reset link expired" });
    expect(screen.queryByRole("heading", { name: "Create a new password" })).toBeNull();
  });

  it("asks the user to wait when rate limited", async () => {
    confirmReply = json(429, { message: "too_many_requests" });
    render(<ResetPasswordPage />);
    submitNewPassword();
    expect((await screen.findByRole("alert")).textContent).toMatch(/Too many requests/);
  });

  it.each([
    ["a 500 envelope", json(500, { error: { code: "INTERNAL_SERVER_ERROR", message: "invalid_token" } })],
    ["a lost connection", async () => Promise.reject(new TypeError("Failed to fetch"))],
  ])("keeps the form and a retry for %s", async (_name, reply) => {
    confirmReply = reply;
    render(<ResetPasswordPage />);
    submitNewPassword();
    expect((await screen.findByRole("alert")).textContent).toMatch(/Please try again/);
    expect(screen.getByRole("heading", { name: "Create a new password" })).toBeTruthy();
  });
});
