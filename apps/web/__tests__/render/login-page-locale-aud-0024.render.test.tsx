/**
 * AUD-0024 — /login speaks the language it declares.
 *
 * With Arabic or German selected the document said `lang="ar" dir="rtl"` (or
 * `lang="de"`) while the sign-in page kept its heading, lead, placeholders,
 * links, consent sentence and submit button in English; in Arabic those
 * English sentences were then laid out right-to-left with their punctuation
 * on the wrong end. Only "Continue with Apple", the "Or" divider and the
 * register prompt were translated — and the prompt said "Register? Register".
 *
 * The REAL page is mounted with the REAL shared dictionary behind `t()`; only
 * the providers, the network and the identity SDK loaders are stubbed.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { dict } from "@proovra/shared/i18n";

import LoginPage from "../../app/login/page";

type Locale = keyof typeof dict;
type Key = keyof (typeof dict)["en"];

let locale: Locale = "en";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/login",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("../../app/providers", () => ({
  useAuth: () => ({ setToken: () => undefined }),
  useLocale: () => ({
    locale,
    t: (key: Key) => (dict[locale] as Record<Key, string>)[key] ?? dict.en[key],
  }),
}));
vi.mock("../../components/ui", () => ({ useToast: () => ({ addToast: vi.fn() }) }));
vi.mock("../../lib/api", () => ({
  apiBaseUrl: () => "http://api.test",
  apiFetch: vi.fn(async () => ({})),
  isApiResponseError: () => false,
  readApiToken: () => null,
}));
vi.mock("../../lib/oauth", () => ({
  // The SDKs never arrive in jsdom; the page must render without them.
  loadGoogleIdentity: () => new Promise(() => undefined),
  loadAppleIdentity: () => new Promise(() => undefined),
  fetchSocialSignInNonce: async () => "nonce",
}));
vi.mock("../../components/marketing/MarketingHeader", () => ({ MarketingHeader: () => null }));
vi.mock("../../components/marketing/ForgotPasswordModal", () => ({ ForgotPasswordModal: () => null }));

/** The English the audit saw on the translated page, plus the rest of the page's own copy. */
const ENGLISH = [
  "Return to your",
  "workspace.",
  "Sign in to continue reviewing evidence records",
  "Welcome Back",
  "Evidence Operations Workspace",
  "Secure Review Access",
  "Reports, Cases & Verification Materials",
  "Account access",
  "Continue with your preferred sign-in method",
  "Forgot password",
  "Use single sign-on",
  "If our",
  "need your acceptance, we will ask right after you sign in.",
  "Terms of Service",
  "Privacy Policy",
  "Cookie Policy",
  "Sign in with Email",
  "Continue with Google",
  "Continue with Apple",
];

function mount(next: Locale) {
  locale = next;
  return render(<LoginPage />);
}

const heading = (l: Locale) => dict[l].loginHeroTitle.replace("{brand}", "PROOVRA");

describe("AUD-0024 — the sign-in page in the selected language", () => {
  it("every locale carries exactly the English key set", () => {
    const en = Object.keys(dict.en).sort();
    for (const l of Object.keys(dict) as Locale[]) {
      expect(Object.keys(dict[l]).sort(), l).toEqual(en);
    }
  });

  it("every translated sentence keeps the English placeholders", () => {
    const names = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const l of Object.keys(dict) as Locale[]) {
      for (const k of Object.keys(dict.en) as Key[]) {
        expect(names(dict[l][k]), `${l}.${k}`).toEqual(names(dict.en[k]));
      }
    }
  });

  for (const l of ["de", "ar"] as const) {
    it(`${l}: no English page copy is rendered, in text or in attributes`, () => {
      const { container } = mount(l);
      const text = container.textContent ?? "";
      const attrs = [...container.querySelectorAll("[placeholder],[aria-label],[title]")]
        .flatMap((el) => ["placeholder", "aria-label", "title"].map((a) => el.getAttribute(a) ?? ""))
        .join(" | ");
      for (const english of ENGLISH) {
        expect(text, `text contains "${english}"`).not.toContain(english);
        expect(attrs, `attribute contains "${english}"`).not.toContain(english);
      }
      expect((screen.getByLabelText(dict[l].loginEmailLabel) as HTMLInputElement).placeholder).toBe(
        dict[l].loginEmailLabel,
      );
      expect(container.querySelector("#login-password")?.getAttribute("placeholder")).toBe(
        dict[l].loginPasswordLabel,
      );
      expect(container.querySelector("#login-password")?.getAttribute("placeholder")).not.toBe("Password");
    });

    it(`${l}: the heading is the translated sentence, brand untranslated`, () => {
      mount(l);
      const h1 = screen.getByRole("heading", { level: 1 });
      expect(h1.textContent).toBe(heading(l));
      expect(h1.textContent).toContain("PROOVRA");
      expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(dict[l].signInTitle);
    });

    it(`${l}: the consent sentence is one translated sentence that keeps its three links`, () => {
      const { container } = mount(l);
      const notice = container.querySelector("[data-auth-legal-notice]")!;
      const expected = dict[l].loginLegalNotice
        .replace("{terms}", dict[l].loginLegalTerms)
        .replace("{privacy}", dict[l].loginLegalPrivacy)
        .replace("{cookies}", dict[l].loginLegalCookies);
      expect(notice.textContent).toBe(expected);
      const links = [...notice.querySelectorAll("a")].map((a) => [a.getAttribute("href"), a.textContent]);
      expect(links).toEqual(
        expect.arrayContaining([
          ["/legal/terms", dict[l].loginLegalTerms],
          ["/legal/privacy", dict[l].loginLegalPrivacy],
          ["/legal/cookies", dict[l].loginLegalCookies],
        ]),
      );
      expect(links).toHaveLength(3);
    });

    it(`${l}: the register prompt is a question and one link, not the link twice`, () => {
      const { container } = mount(l);
      const prompt = container.querySelector(".auth-switch")!;
      expect(prompt.textContent).toBe(`${dict[l].loginNoAccount} ${dict[l].register}`);
      expect(prompt.querySelector("a")?.textContent).toBe(dict[l].register);
    });

    it(`${l}: the page's own validation messages are translated`, () => {
      const { container } = mount(l);
      fireEvent.submit(container.querySelector("form")!);
      expect(container.querySelector("#login-email-error")?.textContent).toBe(dict[l].loginErrorEmailRequired);
      expect(container.querySelector("#login-password-error")?.textContent).toBe(
        dict[l].loginErrorPasswordRequired,
      );
    });
  }

  it("en: the English page reads as it did, with the prompt fixed", () => {
    const { container } = mount("en");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Return to your PROOVRA workspace.");
    expect(container.querySelector("[data-auth-legal-notice]")?.textContent).toBe(
      "If our Terms of Service, Privacy Policy or Cookie Policy need your acceptance, we will ask right after you sign in.",
    );
    expect(screen.getByRole("button", { name: "Sign in with Email" })).toBeTruthy();
    expect(container.querySelector(".auth-switch")?.textContent).toBe("No account yet? Register");
  });
});
