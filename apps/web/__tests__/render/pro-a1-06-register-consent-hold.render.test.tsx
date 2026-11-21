import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

/**
 * PRO-A1-06 — the verification link records Terms/Privacy/Cookies acceptance
 * ONLY for the consent the person gave on /register in this browser.
 *
 * The real verify-email page and the real `apiFetch` run against a stubbed
 * network; the hold is written by the same helper /register uses.
 *   - allowed: a hold for the verified address made on this browser today ->
 *     exactly one POST /v1/users/legal-acceptance, and the hold is spent;
 *   - refused: no hold (a link opened on another device), a hold for another
 *     address, or a hold older than a day -> no acceptance is recorded.
 */

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("token=link-token"),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/auth/verify-email",
}));
vi.mock("../../app/providers", () => ({ useAuth: () => ({ setToken: vi.fn() }) }));
vi.mock("../../components/marketing/MarketingHeader", () => ({ MarketingHeader: () => null }));

import VerifyEmailPage from "../../app/auth/verify-email/page";
import { savePendingRegisterLegalAcceptance } from "../../lib/legalAcceptance";

const ACCEPTANCES: Array<{ policyKey: "privacy" | "terms" | "cookies"; policyVersion: string }> = [
  { policyKey: "terms", policyVersion: "v1" },
  { policyKey: "privacy", policyVersion: "v1" },
];

let calls: Array<{ url: string; method: string; body: unknown }> = [];

beforeEach(() => {
  calls = [];
  window.localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, method: (init?.method ?? "GET").toUpperCase(), body: init?.body ? JSON.parse(String(init.body)) : null });
      if (u.includes("/v1/auth/email/verify")) {
        return new Response(JSON.stringify({ token: "jwt", user: { id: "u-1", email: "Person@Example.com" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

const acceptancePosts = () => calls.filter((c) => c.method === "POST" && c.url.includes("/v1/users/legal-acceptance"));

async function verify() {
  render(<VerifyEmailPage />);
  await waitFor(() => expect(screen.getByRole("heading", { name: "Email verified" })).toBeTruthy());
}

describe("PRO-A1-06 — verify-email records consent only from this browser's register hold", () => {
  it("allowed: the person who ticked the box on /register here, verifying the same address, has the acceptance recorded once", async () => {
    savePendingRegisterLegalAcceptance({ email: "person@example.com", acceptances: ACCEPTANCES, createdAt: new Date().toISOString() });
    await verify();
    await waitFor(() => expect(acceptancePosts()).toHaveLength(1));
    expect((acceptancePosts()[0].body as { source: string }).source).toBe("register");
    // The hold is spent: it can never be replayed.
    expect(window.localStorage.getItem("proovra_pending_register_legal_acceptance")).toBeNull();
  });

  it("refused: a link opened in a browser with no register hold records no acceptance", async () => {
    await verify();
    await new Promise((r) => setTimeout(r, 50));
    expect(acceptancePosts()).toHaveLength(0);
  });

  it("refused: a hold for a different address records no acceptance for the verified account", async () => {
    savePendingRegisterLegalAcceptance({ email: "someone-else@example.com", acceptances: ACCEPTANCES, createdAt: new Date().toISOString() });
    await verify();
    await new Promise((r) => setTimeout(r, 50));
    expect(acceptancePosts()).toHaveLength(0);
  });

  it("refused: a hold older than a day records no acceptance", async () => {
    savePendingRegisterLegalAcceptance({
      email: "person@example.com",
      acceptances: ACCEPTANCES,
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    });
    await verify();
    await new Promise((r) => setTimeout(r, 50));
    expect(acceptancePosts()).toHaveLength(0);
  });
});
