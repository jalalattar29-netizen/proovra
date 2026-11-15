/**
 * F-P1-05 — Apple's sign-in window opens within the click.
 *
 * `AppleID.auth.signIn()` with `usePopup: true` opens a window. Browsers that
 * block windows not opened directly by a click (Safari on macOS / iOS, strict
 * blockers) refuse one opened after the handler awaited a network round trip —
 * and the Apple buttons awaited the API nonce first. The nonce is now fetched
 * before the click (lib/useSocialNoncePrefetch.ts) and the click calls
 * `signIn()` with no await in between.
 *
 * What this proves is the code fact: `signIn()` has been called by the time the
 * click handler returns, with an API-issued nonce that is used once. Whether a
 * particular browser then shows Apple's window is browser behaviour
 * (EXTERNALLY-UNVERIFIED).
 *
 * The REAL login and register pages run; the Apple SDK, the nonce fetch and
 * the auth exchange are doubles.
 */
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let n = 0;
  return {
    nonce: vi.fn(async () => `nonce-${++n}`),
    reset() {
      n = 0;
    },
  };
});

const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("../../app/providers", () => ({
  useAuth: () => ({ setToken: () => undefined }),
  useLocale: () => ({ locale: "en", t: (key: string) => key }),
}));
vi.mock("../../components/ui", () => ({ useToast: () => ({ addToast: vi.fn() }) }));
vi.mock("../../lib/oauth", () => ({
  loadGoogleIdentity: () => new Promise(() => undefined),
  loadAppleIdentity: async () => undefined,
  fetchSocialSignInNonce: mocks.nonce,
}));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("../../components/marketing/MarketingHeader", () => ({ MarketingHeader: () => null }));
vi.mock("../../components/marketing/ForgotPasswordModal", () => ({ ForgotPasswordModal: () => null }));

import LoginPage from "../../app/login/page";
import RegisterPage from "../../app/register/page";

type InitOptions = { nonce?: string };
const inits: InitOptions[] = [];
const signIn = vi.fn(() => new Promise<never>(() => undefined));

beforeEach(() => {
  mocks.reset();
  mocks.nonce.mockClear();
  inits.length = 0;
  signIn.mockClear();
  process.env.NEXT_PUBLIC_APPLE_CLIENT_ID = "com.proovra.web.test";
  (window as unknown as { AppleID: unknown }).AppleID = {
    auth: {
      init: (o: InitOptions) => inits.push(o),
      signIn,
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 404, headers: { "content-type": "application/json" } })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete process.env.NEXT_PUBLIC_APPLE_CLIENT_ID;
  delete (window as unknown as { AppleID?: unknown }).AppleID;
});

async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/** Clicks and reports whether signIn() ran before the handler yielded. */
function clickAndCheckSynchronous(button: HTMLElement): boolean {
  const before = signIn.mock.calls.length;
  fireEvent.click(button);
  return signIn.mock.calls.length === before + 1;
}

describe("F-P1-05 — Apple sign-in opens its window inside the click", () => {
  it("login: signIn() is called synchronously with the prefetched nonce, and each attempt gets a fresh one", async () => {
    render(<LoginPage />);
    await settle();
    // Prefetched on mount once Apple is ready.
    expect(mocks.nonce).toHaveBeenCalledWith("apple");
    const button = screen.getByRole("button", { name: "signInApple" });

    expect(clickAndCheckSynchronous(button)).toBe(true);
    const firstNonce = inits.at(-1)?.nonce;
    expect(firstNonce).toMatch(/^nonce-\d+$/);
    await settle();

    // The used nonce is replaced; the next attempt never reuses it.
    expect(clickAndCheckSynchronous(button)).toBe(true);
    const secondNonce = inits.at(-1)?.nonce;
    expect(secondNonce).toMatch(/^nonce-\d+$/);
    expect(secondNonce).not.toBe(firstNonce);
  });

  it("register: the same, once the terms are accepted", async () => {
    render(<RegisterPage />);
    await settle();
    fireEvent.click(document.querySelector("input.auth-legal-checkbox") as HTMLInputElement);
    const button = screen.getByRole("button", { name: "Continue with Apple" });
    expect(clickAndCheckSynchronous(button)).toBe(true);
    expect(inits.at(-1)?.nonce).toMatch(/^nonce-\d+$/);
  });

  it("with no nonce in hand (the prefetch failed), the click still works by fetching in place", async () => {
    mocks.nonce.mockRejectedValueOnce(new Error("offline"));
    render(<LoginPage />);
    await settle();
    const button = screen.getByRole("button", { name: "signInApple" });
    fireEvent.click(button);
    await settle();
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(inits.at(-1)?.nonce).toMatch(/^nonce-\d+$/);
  });
});
