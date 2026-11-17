/**
 * B1-F-004 (free-audit 0ea0) — one person, one self-serve account per verified
 * address, in the web's words.
 *
 *   - A Google/Apple sign-in whose verified address an existing account holds is
 *     refused 409 EXISTING_ACCOUNT_SIGN_IN_REQUIRED. The OAuth callback shows the
 *     shared guidance (sign in to that account, connect the provider) under its
 *     own title — not "Sign-in failed" — and never a raw code. Other refusals keep
 *     "Sign-in failed".
 *   - "Forgot password" explains that an account opened with Google or Apple has
 *     no PROOVRA password, in both states, while the answer stays neutral and the
 *     only request is the ordinary reset request (no new email kind).
 *
 * The REAL callback page and modal run over a stubbed network.
 */
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { USER_FACING_ERRORS } from "@proovra/shared";

const setToken = vi.fn();
vi.mock("../../app/providers", () => ({ useAuth: () => ({ setToken }) }));
vi.mock("../../components/ui", () => ({ useToast: () => ({ addToast: vi.fn() }) }));

import CallbackPage from "../../app/auth/callback/ui/page";
import { ForgotPasswordModal, SOCIAL_SIGN_IN_RESET_HINT } from "../../components/marketing/ForgotPasswordModal";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const realLocation = window.location;
let answer: (path: string) => Response;
const posts: Array<{ path: string; body: unknown }> = [];

beforeEach(() => {
  setToken.mockReset();
  posts.length = 0;
  sessionStorage.clear();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      get href() {
        return realLocation.href;
      },
      get search() {
        return realLocation.search;
      },
      get hash() {
        return realLocation.hash;
      },
      get pathname() {
        return realLocation.pathname;
      },
      get hostname() {
        return realLocation.hostname;
      },
      get origin() {
        return realLocation.origin;
      },
      replace: vi.fn(),
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, "").split("?")[0] as string;
      if ((init?.method ?? "GET") === "POST") {
        posts.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
      }
      return answer(path);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Object.defineProperty(window, "location", { configurable: true, value: realLocation });
});

async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const GUIDANCE = USER_FACING_ERRORS.EXISTING_ACCOUNT_SIGN_IN_REQUIRED!;

describe("B1-F-004 — the shared guidance for an address an existing account holds", () => {
  it("names the way forward and no account detail", () => {
    expect(GUIDANCE.title).toBe("Sign in to your existing account");
    expect(GUIDANCE.message).toContain("no new account was created");
    expect(GUIDANCE.message).toContain("Security > Sign-in methods");
    const safe = toSafeUserError(Object.assign(new Error("x"), { code: "EXISTING_ACCOUNT_SIGN_IN_REQUIRED", statusCode: 409 }));
    expect(safe.title).toBe(GUIDANCE.title);
    expect(safe.message).toBe(GUIDANCE.message);
  });
});

describe("B1-F-004 — the OAuth callback answers a 409 guidance with guidance", () => {
  function openCallback(query: string) {
    window.history.replaceState(null, "", `/auth/callback/ui${query}`);
    return render(<CallbackPage />);
  }

  it("409 EXISTING_ACCOUNT_SIGN_IN_REQUIRED shows the guidance title and words, not 'Sign-in failed', and no session", async () => {
    answer = (path) =>
      path === "/v1/auth/google"
        ? json(409, { code: "EXISTING_ACCOUNT_SIGN_IN_REQUIRED", message: "server sentence" })
        : json(404, {});
    openCallback("?provider=google&id_token=tok-b1f004-1");
    await settle();
    expect(screen.getByText(GUIDANCE.title)).toBeTruthy();
    expect(screen.getByText(GUIDANCE.message)).toBeTruthy();
    expect(screen.queryByText("Sign-in failed")).toBeNull();
    expect(document.body.textContent).not.toContain("EXISTING_ACCOUNT_SIGN_IN_REQUIRED");
    expect(setToken).not.toHaveBeenCalled();
  });

  it("control: another refusal still reads 'Sign-in failed'", async () => {
    answer = () => json(401, { message: "invalid_id_token" });
    openCallback("?provider=google&id_token=tok-b1f004-2");
    await settle();
    expect(screen.getByRole("heading", { name: "Sign-in failed" })).toBeTruthy();
    expect(screen.queryByText(GUIDANCE.title)).toBeNull();
  });
});

describe("B1-F-004 — Forgot password explains social sign-in, and sends nothing new", () => {
  it("the hint shows before and after the request; the only call is the neutral reset request", async () => {
    answer = (path) => (path === "/v1/auth/password-reset/request" ? json(200, { ok: true }) : json(404, {}));
    render(<ForgotPasswordModal open onClose={() => undefined} />);
    expect(screen.getByTestId("forgot-password-social-hint").textContent).toBe(SOCIAL_SIGN_IN_RESET_HINT);
    expect(SOCIAL_SIGN_IN_RESET_HINT).toMatch(/Google or Apple/);

    fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: "someone@example.test" } });
    fireEvent.submit(screen.getByLabelText(/email address/i).closest("form")!);
    await settle();
    expect(screen.getByText(/If an account exists for this address/)).toBeTruthy();
    expect(screen.getByTestId("forgot-password-social-hint").textContent).toBe(SOCIAL_SIGN_IN_RESET_HINT);
    expect(posts).toEqual([{ path: "/v1/auth/password-reset/request", body: { email: "someone@example.test" } }]);
  });
});
