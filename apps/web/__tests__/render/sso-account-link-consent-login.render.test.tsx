/**
 * B5B-F-302 — an enterprise sign-in that matched a pre-existing self-serve
 * account is refused. The API links nothing, mints no session, leaves a
 * 15-minute pending-link ticket and bounces to
 * `/login?sso_error=sso_account_link_requires_consent` (OIDC) or
 * `/login?saml_error=saml_account_link_requires_consent` (SAML).
 *
 * The page must say what happened and what the owner can do — not the generic
 * "could not be completed" it showed for every unknown reason.
 *
 * The REAL page and the REAL `apiFetch` are mounted; only the network, the
 * providers and the identity SDK loaders are stubbed.
 */
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dict } from "@proovra/shared/i18n";

type Key = keyof (typeof dict)["en"];

const nav = vi.hoisted(() => ({ query: "" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/login",
  useSearchParams: () => new URLSearchParams(nav.query),
}));
vi.mock("../../app/providers", () => ({
  useAuth: () => ({ setToken: () => undefined }),
  useLocale: () => ({ locale: "en", t: (key: Key) => dict.en[key] }),
}));
vi.mock("../../components/ui", () => ({ useToast: () => ({ addToast: vi.fn() }) }));
vi.mock("../../lib/oauth", () => ({
  loadGoogleIdentity: () => new Promise(() => undefined),
  loadAppleIdentity: () => new Promise(() => undefined),
  fetchSocialSignInNonce: async () => "nonce",
}));
vi.mock("../../components/marketing/MarketingHeader", () => ({ MarketingHeader: () => null }));
vi.mock("../../components/marketing/ForgotPasswordModal", () => ({ ForgotPasswordModal: () => null }));

import LoginPage from "../../app/login/page";

const fetchMock = vi.fn(
  async (_input: unknown, _init?: RequestInit) =>
    new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
);

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function alertFor(query: string): Promise<string> {
  nav.query = query;
  render(<LoginPage />);
  return (await screen.findByRole("alert")).textContent ?? "";
}

describe("B5B-F-302 — /login after a refused organization sign-in", () => {
  for (const query of [
    "sso_error=sso_account_link_requires_consent",
    "saml_error=saml_account_link_requires_consent",
  ]) {
    it(`${query.split("=")[0]}: says an account exists, nothing happened, and how to approve`, async () => {
      const text = await alertFor(query);
      expect(text).toMatch(/already exists/);
      expect(text).toMatch(/Nothing was linked and no one was signed in/);
      expect(text).toMatch(/sign in to your existing account the usual way/);
      expect(text).toMatch(/Settings → Security within 15 minutes/);
      expect(text).not.toMatch(/could not be completed/);
    });
  }

  it("no automatic jump into an approval: the page only states the refusal", async () => {
    await alertFor("sso_error=sso_account_link_requires_consent");
    expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toEqual(
      expect.arrayContaining([expect.stringContaining("/v1/identity/links/organization")]),
    );
  });

  it("an explicit administrator refusal keeps its own message", async () => {
    const text = await alertFor("sso_error=sso_account_link_denied");
    expect(text).toMatch(/cannot be linked/);
    expect(text).not.toMatch(/15 minutes/);
  });
});
