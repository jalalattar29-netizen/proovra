/**
 * IDENT-007 — the guided setup on /auth/mfa-challenge?enroll=1, driven through
 * the REAL apiFetch over a stubbed fetch, so the flat refusal bodies the
 * enrolment routes really send reach the component as they do in production.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const nav = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace, push: () => {} }),
  useSearchParams: () => new URLSearchParams("enroll=1&next=/cases"),
}));
vi.mock("../../components/mfa-recovery/MfaRecoveryRequestPanel", () => ({
  MfaRecoveryRequestPanel: () => null,
}));

import MfaChallengePage from "../../app/auth/mfa-challenge/page";

type Reply = { status: number; body: unknown };
let replies: Record<string, Reply[]>;
let calls: string[];

function json({ status, body }: Reply): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  calls = [];
  nav.replace.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const path = new URL(String(input), "http://api.test").pathname;
      calls.push(path);
      const next = replies[path]?.shift();
      if (!next) throw new Error(`unexpected call ${path}`);
      return json(next);
    }),
  );
  replies = {
    "/v1/identity/mfa/enroll/start": [
      { status: 200, body: { factorId: "f1", otpauthUri: "otpauth://totp/x?secret=ABC", secretBase32: "ABC" } },
    ],
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const enter = (code: string) => {
  fireEvent.change(screen.getByLabelText("Six-digit authenticator code"), { target: { value: code } });
  fireEvent.click(screen.getByRole("button", { name: "Verify and continue" }));
};

describe("MFA setup during sign-in", () => {
  it("starts setup instead of sending the person back to sign in", async () => {
    render(<MfaChallengePage />);
    expect((await screen.findByText("ABC")).tagName).toBe("CODE");
    expect(screen.queryByText("Sign in to start enrollment")).toBeNull();
  });

  it("a wrong code keeps the form and says so", async () => {
    replies["/v1/identity/mfa/enroll/verify"] = [{ status: 400, body: { error: "code_invalid" } }];
    render(<MfaChallengePage />);
    await screen.findByText("ABC");
    enter("000000");
    expect((await screen.findByRole("alert")).textContent).toMatch(/did not match/);
    expect(screen.getByLabelText("Six-digit authenticator code")).toBeTruthy();
  });

  it("shows the recovery codes, and only then finishes and goes on", async () => {
    replies["/v1/identity/mfa/enroll/verify"] = [
      { status: 200, body: { factorId: "f1", recoveryCodes: ["AAAAA-BBBBB", "CCCCC-DDDDD"] } },
    ];
    replies["/v1/auth/mfa/enrollment/complete"] = [{ status: 200, body: { token: "t", user: { id: "u" } } }];
    render(<MfaChallengePage />);
    await screen.findByText("ABC");
    enter("123456");
    await screen.findByText("AAAAA-BBBBB");
    expect(nav.replace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "I saved them, continue" }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/cases"));
  });

  it("an expired enrolment token leads back to sign-in", async () => {
    // apiFetch replays a bare 401 once.
    const ended = { status: 401, body: { message: "unauthorized" } };
    replies["/v1/identity/mfa/enroll/start"] = [ended, ended];
    render(<MfaChallengePage />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/session ended/);
    expect(screen.getByRole("link", { name: "Return to sign in" })).toBeTruthy();
  });
});
