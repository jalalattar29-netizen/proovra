/**
 * AUD-0024 — the shared marketing header on a page in another language.
 *
 * The sign-in page in Arabic declares `lang="ar" dir="rtl"`, and its own copy
 * now comes from the dictionary. The header above it (navigation, Sign in /
 * Create account, the language menu) is the English chrome every public page
 * shares, so it states its own language and direction: assistive technology
 * reads it as English and the Arabic layout does not reverse its punctuation.
 * Each language's own name in the menu is marked in that language.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/login",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("../../app/providers", () => ({
  useAuth: () => ({ hasSession: false }),
  useLocale: () => ({ locale: "ar", setLocale: vi.fn(), setLocaleMode: vi.fn(), t: (k: string) => k, isRTL: true }),
}));
vi.mock("../../components/analytics/PublicPageView", () => ({ default: () => null }));

import { MarketingHeader } from "../../components/marketing/MarketingHeader";

describe("AUD-0024 — the marketing header states its own language", () => {
  it("is English, left-to-right, inside an Arabic document", () => {
    document.documentElement.lang = "ar";
    document.documentElement.dir = "rtl";
    const { container } = render(<MarketingHeader />);
    const header = container.querySelector("header[data-marketing-header]");
    expect(header).not.toBeNull();
    expect(header!.getAttribute("lang")).toBe("en");
    expect(header!.getAttribute("dir")).toBe("ltr");
    // The English navigation and the auth action live inside it.
    expect(header!.textContent).toContain("Platform");
    expect(header!.textContent).toContain("Create account");
  });

  it("marks each language's own name in that language", () => {
    render(<MarketingHeader />);
    const triggers = screen.getAllByRole("button", { name: /^Language — / });
    fireEvent.click(triggers[0]!);
    const menu = screen.getByRole("menu", { name: "Select language" });
    const arabic = Array.from(menu.querySelectorAll("span")).find((s) => s.textContent === "العربية");
    expect(arabic?.getAttribute("lang")).toBe("ar");
    const german = Array.from(menu.querySelectorAll("span")).find((s) => s.textContent === "Deutsch");
    expect(german?.getAttribute("lang")).toBe("de");
  });
});
