import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * PROV-001 — a first verification needs the account's password beside the link.
 *
 * The real `apiFetch` runs against a stubbed network: the refusal is the route's
 * own nested `error.code`, so a mock could not prove the page reads it.
 */

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("token=link-token"),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/auth/verify-email",
}));
vi.mock("../../app/providers", () => ({ useAuth: () => ({ setToken: vi.fn() }) }));
vi.mock("../../components/marketing/MarketingHeader", () => ({ MarketingHeader: () => null }));

import VerifyEmailPage from "../../app/auth/verify-email/page";

const bodies: Array<Record<string, unknown>> = [];
let answer: (body: Record<string, unknown>) => { status: number; body: unknown };

beforeEach(() => {
  bodies.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (!String(url).includes("/v1/auth/email/verify")) {
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      bodies.push(body);
      const a = answer(body);
      return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const refuse = (code: string) => ({ status: 403, body: { error: { code, message: code } } });

describe("verify-email — the password proof", () => {
  it("asks for the password instead of calling the link dead, and offers the way out", async () => {
    answer = () => refuse("EMAIL_VERIFICATION_PASSWORD_REQUIRED");
    render(<VerifyEmailPage />);
    await screen.findByRole("heading", { name: "Confirm your password" });
    expect(screen.getByTestId("verify-forgot-password").getAttribute("href")).toBe("/forgot-password");
    expect(screen.queryByText("Verification link invalid or expired")).toBeNull();
    expect(bodies).toEqual([{ token: "link-token" }]);
  });

  it("sends the password with the token, and says so when it is wrong", async () => {
    answer = (b) =>
      b.password ? refuse("EMAIL_VERIFICATION_PASSWORD_INCORRECT") : refuse("EMAIL_VERIFICATION_PASSWORD_REQUIRED");
    render(<VerifyEmailPage />);
    const input = await screen.findByTestId("verify-password-input");
    fireEvent.change(input, { target: { value: "Wrong-Password-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify my email" }));
    await screen.findByTestId("verify-password-error");
    expect(bodies[1]).toEqual({ token: "link-token", password: "Wrong-Password-1" });
    // Still the password step: the link is alive.
    expect(screen.getByRole("heading", { name: "Confirm your password" })).toBeTruthy();
  });

  it("an account with no password verifies at once, as before", async () => {
    answer = () => ({ status: 200, body: { token: "jwt", user: { id: "u" } } });
    render(<VerifyEmailPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Email verified" })).toBeTruthy());
  });

  it("a dead link is still the invalid card", async () => {
    answer = () => ({ status: 400, body: { error: { code: "INVALID_OR_EXPIRED", message: "x" } } });
    render(<VerifyEmailPage />);
    await screen.findByRole("heading", { name: "Verification link invalid or expired" });
  });
});
