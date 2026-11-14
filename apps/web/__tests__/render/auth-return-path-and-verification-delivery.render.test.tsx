/**
 * F-26g / F-26f / F-06 — where sign-in, sign-up and verification send people,
 * and what the sign-up page says about the verification email.
 *
 * The REAL pages run the REAL apiFetch over a stubbed network; only routing,
 * providers, toasts and the identity SDK loaders are stubbed.
 *
 *   - safeReturnPath keeps in-app paths (with query) and refuses
 *     protocol-relative, backslash, control-character and absolute URLs
 *   - /login with `next=//evil.example` lands on /home; a valid next is kept
 *   - /register sends its validated `next` with the registration and resend;
 *     it says "couldn't send" when the provider refused, "sent" only when it
 *     was accepted, and holds Resend for the server's real cooldown
 *   - /auth/verify-email lands on the link's validated `next`, never off-site;
 *     a throttle or an outage is not "link expired" and offers Try again
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

let params = new URLSearchParams();
const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() };

vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/",
  useSearchParams: () => params,
}));
vi.mock("../../app/providers", () => ({
  useAuth: () => ({ setToken: () => undefined }),
  useLocale: () => ({ locale: "en", t: (key: string) => key }),
}));
vi.mock("../../components/ui", () => ({ useToast: () => ({ addToast: vi.fn() }) }));
vi.mock("../../lib/oauth", () => ({
  loadGoogleIdentity: () => new Promise(() => undefined),
  loadAppleIdentity: () => new Promise(() => undefined),
  fetchSocialSignInNonce: async () => "nonce",
}));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("../../components/marketing/MarketingHeader", () => ({ MarketingHeader: () => null }));
vi.mock("../../components/marketing/ForgotPasswordModal", () => ({ ForgotPasswordModal: () => null }));

import { safeReturnPath } from "../../lib/navigation/safe-return-path";
import LoginPage from "../../app/login/page";
import RegisterPage from "../../app/register/page";
import VerifyEmailPage from "../../app/auth/verify-email/page";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Answer = (path: string, body: Record<string, unknown> | null) => Response | Promise<Response>;
let answer: Answer;
const posts: Array<{ path: string; body: Record<string, unknown> | null }> = [];

beforeEach(() => {
  posts.length = 0;
  router.push.mockReset();
  router.replace.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, "").split("?")[0] as string;
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      if ((init?.method ?? "GET") === "POST") posts.push({ path, body });
      return answer(path, body);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

describe("F-26g — the one return-path rule", () => {
  it.each(["/home", "/invite/tok_123", "/billing?plan=pro&interval=month", "/evidence/abc#items", "/%2F%2Fevil.example"])(
    "keeps the in-app path %s",
    (p) => {
      expect(safeReturnPath(p)).toBe(p);
    },
  );
  it.each([
    "//evil.example",
    "/\\evil.example",
    "/\\/evil.example",
    "/\tevil",
    "https://evil.example/x",
    "javascript:alert(1)",
    "evil.example",
    "",
    null,
    undefined,
  ])("refuses %s", (p) => {
    expect(safeReturnPath(p as string | null | undefined)).toBe("/home");
  });
});

describe("F-26g — /login never navigates off-site", () => {
  async function signIn(next: string) {
    params = new URLSearchParams({ next });
    answer = (p) =>
      p === "/v1/auth/email/login"
        ? json(200, { token: "jwt", user: { id: "u1" } })
        : p === "/v1/auth/me"
          ? json(200, { user: { id: "u1" } })
          : json(200, {});
    render(<LoginPage />);
    fireEvent.change(document.getElementById("login-email") as HTMLInputElement, { target: { value: "me@example.com" } });
    fireEvent.change(document.getElementById("login-password") as HTMLInputElement, { target: { value: "Secret-Pass-1234" } });
    fireEvent.submit(document.querySelector("form") as HTMLFormElement);
    await settle();
  }

  it("a protocol-relative next lands on /home", async () => {
    await signIn("//evil.example");
    expect(router.replace).toHaveBeenCalledWith("/home");
    expect(router.replace.mock.calls.flat().join(" ")).not.toContain("evil");
  });

  it("a backslash next lands on /home", async () => {
    await signIn("/\\evil.example");
    expect(router.replace).toHaveBeenCalledWith("/home");
  });

  it("an in-app next with a query is kept", async () => {
    await signIn("/billing?plan=pro");
    expect(router.replace).toHaveBeenCalledWith("/billing?plan=pro");
  });
});

describe("F-06 / F-26f — /register says what happened to the email", () => {
  async function register(delivery: Record<string, unknown>, next?: string) {
    params = new URLSearchParams(next === undefined ? {} : { next });
    answer = (p) => {
      if (p === "/v1/auth/email/availability") return json(200, { available: true });
      if (p === "/v1/auth/email/register") return json(201, { email: "me@example.com", ...delivery });
      if (p === "/v1/auth/email/resend-verification") return json(200, { ok: true, retryAfterSec: 60 });
      return json(200, {});
    };
    render(<RegisterPage />);
    fireEvent.change(document.getElementById("register-email") as HTMLInputElement, { target: { value: "me@example.com" } });
    fireEvent.change(document.getElementById("register-password") as HTMLInputElement, { target: { value: "Register-Pass-1234" } });
    fireEvent.change(document.getElementById("register-password-confirm") as HTMLInputElement, {
      target: { value: "Register-Pass-1234" },
    });
    fireEvent.click(document.querySelector('input[type="checkbox"]') as HTMLInputElement);
    fireEvent.submit(document.querySelector("form") as HTMLFormElement);
    await settle();
  }
  const registerBody = () => posts.find((p) => p.path === "/v1/auth/email/register")?.body;

  it("a refused send is reported as not sent, and Resend is available at once and carries the return path", async () => {
    await register({ verificationSent: false, verificationDelivery: "failed", resendAfterSec: 0 }, "/invite/tok_1");
    expect(registerBody()).toMatchObject({ email: "me@example.com", next: "/invite/tok_1" });
    expect(screen.getByTestId("register-verification-failed")).toBeTruthy();
    expect(screen.queryByTestId("register-verification-sent")).toBeNull();
    const resend = screen.getByTestId("register-resend") as HTMLButtonElement;
    expect(resend.disabled).toBe(false);
    expect(resend.textContent).toBe("Resend email");

    fireEvent.click(resend);
    await settle();
    expect(posts.find((p) => p.path === "/v1/auth/email/resend-verification")?.body).toEqual({
      email: "me@example.com",
      next: "/invite/tok_1",
    });
    // Honest about what was asked, and held for the server's real cooldown.
    expect(document.body.textContent).toContain("We’ve asked for a new verification link");
    expect(document.body.textContent).not.toContain("Verification email sent.");
    expect((screen.getByTestId("register-resend") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("register-resend").textContent).toMatch(/Resend available in \d+s/);
  });

  it("an accepted send says sent, and Resend waits out the cooldown first", async () => {
    await register({ verificationSent: true, verificationDelivery: "sent", resendAfterSec: 60 });
    expect(screen.getByTestId("register-verification-sent")).toBeTruthy();
    const resend = screen.getByTestId("register-resend") as HTMLButtonElement;
    expect(resend.disabled).toBe(true);
    expect(resend.textContent).toMatch(/Resend available in (59|60)s/);
  });

  it("an unconfirmed send says so instead of claiming it was sent", async () => {
    await register({ verificationSent: false, verificationDelivery: "unconfirmed", resendAfterSec: 60 });
    expect(screen.getByTestId("register-verification-unconfirmed")).toBeTruthy();
    expect(screen.queryByTestId("register-verification-sent")).toBeNull();
  });

  it("an off-site next is never sent to the API", async () => {
    await register({ verificationSent: true, verificationDelivery: "sent", resendAfterSec: 60 }, "//evil.example");
    expect(registerBody()?.next).toBe("/home");
  });
});

describe("F-26f / F-06 — /auth/verify-email", () => {
  const verified = () => json(200, { token: "jwt", user: { id: "u1" } });

  it("lands on the link's in-app next (invite, plan) after verifying", async () => {
    params = new URLSearchParams({ token: "tok", next: "/invite/tok_9" });
    answer = (p) => (p === "/v1/auth/email/verify" ? verified() : json(200, {}));
    render(<VerifyEmailPage />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Continue to PROOVRA" }));
    expect(router.push).toHaveBeenCalledWith("/invite/tok_9");
  });

  it("an off-site next lands on /home", async () => {
    params = new URLSearchParams({ token: "tok", next: "//evil.example" });
    answer = (p) => (p === "/v1/auth/email/verify" ? verified() : json(200, {}));
    render(<VerifyEmailPage />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Continue to PROOVRA" }));
    expect(router.push).toHaveBeenCalledWith("/home");
  });

  it("a throttle is not an expired link", async () => {
    params = new URLSearchParams({ token: "tok" });
    answer = (p) => (p === "/v1/auth/email/verify" ? json(429, { message: "rate_limited" }) : json(200, {}));
    render(<VerifyEmailPage />);
    await settle();
    expect(screen.getByTestId("verify-retry-rate-limited")).toBeTruthy();
    expect(screen.queryByText("Verification link invalid or expired")).toBeNull();
  });

  it("an outage is not an expired link, and Try again uses the same link", async () => {
    params = new URLSearchParams({ token: "tok" });
    let n = 0;
    answer = (p) => {
      if (p !== "/v1/auth/email/verify") return json(200, {});
      n += 1;
      if (n === 1) throw new TypeError("Failed to fetch");
      return verified();
    };
    render(<VerifyEmailPage />);
    await settle();
    expect(screen.getByTestId("verify-retry-unreachable")).toBeTruthy();
    expect(screen.queryByText("Verification link invalid or expired")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle();
    expect(screen.getByRole("heading", { name: "Email verified" })).toBeTruthy();
    expect(posts.filter((p) => p.path === "/v1/auth/email/verify").map((p) => p.body)).toEqual([
      { token: "tok" },
      { token: "tok" },
    ]);
  });
});
