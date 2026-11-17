/**
 * B2A-F-12 — the header offers seven languages (Arabic right-to-left), but the
 * app shell, Home, Search, the command palette, Support and the lead forms
 * were hard-coded English, with physical-direction styles that did not mirror.
 *
 * Their copy now lives in the ONE web dictionary (`@proovra/shared/i18n`
 * `dict`, spread from i18n-app-shell / i18n-home / i18n-search /
 * i18n-support-leads) and is read through `useT()` (app/providers.tsx).
 *
 *  1. Key parity: every locale carries every key, none empty.
 *  2. Escaped literals: no `\uXXXX` / `\n` escape text, no control characters,
 *     no stray braces; every `{placeholder}` of English appears in each
 *     translation, and `fillCopy` fills them.
 *  3. Real translations: the new surfaces' strings are not English copies
 *     (a few words are the same in that language — capped, not allowed wholesale),
 *     and Arabic is Arabic script.
 *  4. Render: the REAL lead form and command palette render translated copy
 *     (labels, validation messages) under Arabic and German; English when no
 *     provider is mounted.
 *  5. Logical direction: the audited sources carry no physical-direction
 *     inline styles (marginLeft/Right, paddingLeft/Right, borderLeft/Right,
 *     textAlign left/right, left:/right:).
 *
 * RED on the unfixed tree: none of these keys existed, and the components
 * rendered English under every locale.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APP_SHELL_COPY,
  HOME_COPY,
  SEARCH_COPY,
  SUPPORT_LEADS_COPY,
  dict,
  fillCopy,
  supportedLocales,
  type Locale,
} from "@proovra/shared/i18n";

type Key = keyof (typeof dict)["en"];
let locale: Locale | null = null;

vi.mock("../../app/providers", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // The provider's own lookup rule: the active locale, English for a gap.
  useT: () => (key: Key) =>
    locale ? ((dict[locale] as Record<Key, string>)[key] || dict.en[key]) : dict.en[key],
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/home",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
const WS = "11111111-1111-4111-8111-111111111111";
const PLATFORM = {
  envelope: {
    activeSpace: { type: "PERSONAL", id: WS },
    platform: { isPlatformAdmin: false },
    capabilities: { DASHBOARD_VIEW: true, EVIDENCE_VIEW: true, EVIDENCE_CAPTURE: true, SEARCH_VIEW: true, SETTINGS_VIEW: true },
    account: { accountPlan: "FREE" },
    flags: { isEnterpriseWorkspace: false },
    planFeatures: { intakeIncluded: false, reportsIncluded: true, professionalSurfacesIncluded: false },
  },
};
vi.mock("../../lib/platform-context", async (original) => ({
  ...(await original<typeof import("../../lib/platform-context")>()),
  usePlatformContext: () => PLATFORM,
  useWorkspaceFragment: () => ({ id: WS, status: "active" }),
  usePersonalSpaceFragment: () => ({ id: WS, status: "active" }),
}));

import { CommandPalette } from "../../components/navigation/CommandPalette";
import { ContactSalesForm } from "../../components/contact-sales-form";
import { ToastProvider } from "../../components/ui";

afterEach(() => {
  cleanup();
  locale = null;
});

const SURFACES = { APP_SHELL_COPY, HOME_COPY, SEARCH_COPY, SUPPORT_LEADS_COPY } as const;
const NON_EN = supportedLocales.filter((l) => l !== "en");
const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).slice().sort();

describe("B2A-F-12 — dictionary key parity across all seven locales", () => {
  it("the header's seven languages are the dictionary's locales", () => {
    expect([...supportedLocales].sort()).toEqual(["ar", "de", "en", "es", "fr", "ru", "tr"]);
    expect(Object.keys(dict).sort()).toEqual([...supportedLocales].sort());
  });

  it("every locale carries exactly the English keys, none empty", () => {
    const en = Object.keys(dict.en).sort();
    for (const l of supportedLocales) {
      const keys = Object.keys(dict[l]).sort();
      expect({ locale: l, missing: en.filter((k) => !keys.includes(k)), extra: keys.filter((k) => !en.includes(k)) }).toEqual({
        locale: l,
        missing: [],
        extra: [],
      });
      for (const k of keys) {
        const v = (dict[l] as Record<string, unknown>)[k];
        expect(typeof v === "string" && v.trim().length > 0, `${l}.${k} is empty`).toBe(true);
      }
    }
  });

  it("each surface module covers every locale with the same keys", () => {
    for (const [name, copy] of Object.entries(SURFACES)) {
      const en = Object.keys(copy.en).sort();
      expect(en.length, `${name} is empty`).toBeGreaterThan(50);
      for (const l of NON_EN) expect(Object.keys(copy[l]).sort(), `${name}.${l}`).toEqual(en);
    }
  });
});

describe("B2A-F-12 — no escaped literals, placeholders preserved", () => {
  it("no value carries escape text, control characters or stray braces", () => {
    for (const l of supportedLocales) {
      for (const [k, v] of Object.entries(dict[l]) as Array<[string, string]>) {
        expect(/\\u[0-9a-fA-F]{4}|\\n|\\t|�|\bundefined\b|\[object /.test(v), `${l}.${k}: ${v}`).toBe(false);
        expect([...v].some((ch) => ch.charCodeAt(0) < 0x20), `${l}.${k} has a control character`).toBe(false);
        expect(/[{}]/.test(v.replace(/\{\w+\}/g, "")), `${l}.${k} has a stray brace: ${v}`).toBe(false);
      }
    }
  });

  it("every translation keeps exactly the English placeholders", () => {
    for (const l of NON_EN) {
      for (const k of Object.keys(dict.en) as Key[]) {
        expect(placeholders((dict[l] as Record<Key, string>)[k]), `${l}.${k}`).toEqual(placeholders(dict.en[k]));
      }
    }
  });

  it("fillCopy fills every placeholder and leaves an unknown one visible", () => {
    expect(fillCopy(SUPPORT_LEADS_COPY.ar.leadSalesSubmitFailed, { email: "sales@proovra.com" })).toContain("sales@proovra.com");
    expect(fillCopy(SUPPORT_LEADS_COPY.ar.leadSalesSubmitFailed, { email: "x" })).not.toMatch(/\{\w+\}/);
    expect(fillCopy("{a} and {b}", { a: 1 })).toBe("1 and {b}");
  });

  it("the copy modules' source holds real characters, not \\u escapes", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const f of ["i18n-app-shell.ts", "i18n-home.ts", "i18n-search.ts", "i18n-support-leads.ts"]) {
      const src = readFileSync(join(here, "../../../../packages/shared/src", f), "utf8");
      expect(/\\u[0-9a-fA-F]{4}/.test(src), f).toBe(false);
    }
  });
});

describe("B2A-F-12 — real translations, not English copies", () => {
  it("each locale translates the new surfaces (words identical to English — Photo, Audio, Document in French — capped at 8%)", () => {
    for (const [name, copy] of Object.entries(SURFACES)) {
      // Separators and arrows (no letters) are the same in every language.
      const keys = (Object.keys(copy.en) as Array<keyof typeof copy.en>).filter((k) => /\p{L}/u.test(copy.en[k]));
      for (const l of NON_EN) {
        const same = keys.filter((k) => copy[l][k] === copy.en[k]);
        expect(same.length / keys.length, `${name}.${l} copies English: ${same.join(", ")}`).toBeLessThanOrEqual(0.08);
      }
    }
  });

  it("Arabic is written in Arabic script", () => {
    for (const [name, copy] of Object.entries(SURFACES)) {
      const values = Object.values(copy.ar) as string[];
      const arabic = values.filter((v) => /[؀-ۿ]/.test(v));
      expect(arabic.length / values.length, name).toBeGreaterThanOrEqual(0.97);
    }
  });
});

function renderSales() {
  return render(
    <ToastProvider>
      <ContactSalesForm />
    </ToastProvider>,
  );
}

describe("B2A-F-12 — the lead form renders its locale (labels, submit, validation)", () => {
  it("English with no provider (the default), unchanged", () => {
    renderSales();
    expect(screen.getByRole("button", { name: "Contact sales" })).toBeTruthy();
    expect(screen.getAllByText("Full name").length).toBeGreaterThan(0);
  });

  for (const l of ["ar", "de"] as const) {
    it(`${l}: labels, submit and client-side validation messages are translated`, () => {
      locale = l;
      renderSales();
      const copy = SUPPORT_LEADS_COPY[l];
      expect(screen.getAllByText(copy.leadFullName).length).toBeGreaterThan(0);
      const submit = screen.getByRole("button", { name: copy.leadSalesSubmit });
      act(() => {
        fireEvent.click(submit);
      });
      expect(screen.getAllByText(copy.leadErrorFullNameRequired).length).toBeGreaterThan(0);
      expect(screen.getAllByText(copy.leadErrorOrganizationRequired).length).toBeGreaterThan(0);
      expect(document.body.textContent).not.toContain("Full name is required.");
      expect(document.body.textContent).not.toContain("Contact sales");
    });
  }
});

describe("B2A-F-12 — the command palette renders its locale", () => {
  async function openPalette() {
    const view = render(<CommandPalette />);
    await act(async () => {
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    });
    return view;
  }

  it("Arabic: the dialog, its search field and a route label are Arabic", async () => {
    locale = "ar";
    const { container } = await openPalette();
    const input = container.querySelector("[data-command-palette-input]") as HTMLInputElement;
    expect(input.getAttribute("placeholder")).toBe(APP_SHELL_COPY.ar.shellPalettePlaceholder);
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe(APP_SHELL_COPY.ar.shellPaletteDialog);
    const capture = container.querySelector('[data-command-palette-result-id="workspace.capture"]');
    expect(capture?.textContent ?? "").toContain(APP_SHELL_COPY.ar["shellRoute.workspace.capture"]);
  });

  it("English without a provider (unchanged default)", async () => {
    const { container } = await openPalette();
    const input = container.querySelector("[data-command-palette-input]") as HTMLInputElement;
    expect(input.getAttribute("placeholder")).toBe("Search tools, routes, settings…");
  });
});

describe("B2A-F-12 — logical direction in the audited sources", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const FILES = [
    "components/app-shell-v2/AppSidebarV2.tsx",
    "components/app-shell-v2/AppAccountToolbar.tsx",
    "components/navigation/CommandPalette.tsx",
    "components/home-experience/HomeSections.tsx",
    "components/home-experience/HomeDashboardSections.tsx",
    "components/home-experience/SelfServeHomeDashboard.tsx",
    "app/(app)/search/page.tsx",
    "app/support/page.tsx",
    "components/contact-sales-form.tsx",
    "components/request-demo-form.tsx",
  ];
  const PHYSICAL =
    /\b(marginLeft|marginRight|paddingLeft|paddingRight|borderLeft|borderRight)\b|textAlign:\s*["'](left|right)["']|[{,]\s*(left|right):\s|\b(ml|mr|pl|pr)-\d|\btext-(left|right)\b|\b(left|right)-\d/;
  for (const f of FILES) {
    it(`${f} has no physical-direction style`, () => {
      const src = readFileSync(join(here, "../..", f), "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      expect(src.match(PHYSICAL)?.[0] ?? null).toBeNull();
    });
  }
});
