/**
 * AUD-0015 — every public (marketing / legal) page has exactly one `<main>`.
 *
 * The audit measured `document.querySelectorAll("main,[role=main]").length`
 * as 0 on 21 public routes at 1440 and 375 px. Those pages compose their own
 * header, content and footer with no shared page shell, so the landmark is
 * given at the LAYOUT level: each segment's `layout.tsx` is
 * `PublicMainLayout`. This file proves:
 *
 *   1. the layout each audited route resolves to is wired, and renders one
 *      `<main>` around whatever the page renders;
 *   2. no page under those layouts renders a `<main>` of its own (which would
 *      make two), and no wired page also uses `MarketingPage` (which owns one);
 *   3. `MarketingPage` — the two pages that already had a main — still renders
 *      exactly one.
 */
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("../../components/marketing/MarketingHeader", () => ({
  MarketingHeader: () => <header>site header</header>,
}));
vi.mock("../../components/marketing/EnterpriseFooter", () => ({
  EnterpriseFooter: () => <footer>site footer</footer>,
}));

import {
  MarketingPage,
  PUBLIC_MAIN_ID,
  PublicMainLayout,
} from "../../components/marketing/page-shell/MarketingPage";
import AboutLayout from "../../app/about/layout";
import ContactSalesLayout from "../../app/contact-sales/layout";
import ForComplianceLayout from "../../app/for-compliance/layout";
import ForGovernmentLayout from "../../app/for-government/layout";
import ForInsuranceLayout from "../../app/for-insurance/layout";
import ForInvestigationsLayout from "../../app/for-investigations/layout";
import ForJournalismLayout from "../../app/for-journalism/layout";
import ForLawyersLayout from "../../app/for-lawyers/layout";
import PlatformLayout from "../../app/platform/layout";
import PricingLayout from "../../app/pricing/layout";
import RequestDemoLayout from "../../app/request-demo/layout";
import SupportLayout from "../../app/support/layout";
import TechnologyLayout from "../../app/technology/layout";
import TrustLayout from "../../app/trust/layout";
import LegalLayout from "../../app/legal/layout";
import VerifyDemoLayout from "../../app/verify/demo/layout";
import AuthCallbackUiLayout from "../../app/auth/callback/ui/layout";

const WEB = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(WEB, rel), "utf8");

/**
 * The 21 routes the audit found without a main, and the app directory each
 * one is SERVED from (the five legal short URLs redirect into /legal/[slug]).
 */
const AUDITED_ROUTES: ReadonlyArray<[route: string, servedFrom: string]> = [
  ["/about", "app/about"],
  ["/abuse-reporting", "app/legal/[slug]"],
  ["/auth/callback/ui", "app/auth/callback/ui"],
  ["/contact-sales", "app/contact-sales"],
  ["/data-retention", "app/legal/[slug]"],
  ["/for-compliance", "app/for-compliance"],
  ["/for-government", "app/for-government"],
  ["/for-insurance", "app/for-insurance"],
  ["/for-investigations", "app/for-investigations"],
  ["/for-journalism", "app/for-journalism"],
  ["/for-lawyers", "app/for-lawyers"],
  ["/platform", "app/platform"],
  ["/pricing", "app/pricing"],
  ["/privacy", "app/legal/[slug]"],
  ["/request-demo", "app/request-demo"],
  ["/subprocessors", "app/legal/[slug]"],
  ["/support", "app/support"],
  ["/technology", "app/technology"],
  ["/terms", "app/legal/[slug]"],
  ["/trust", "app/trust"],
  ["/verify/demo", "app/verify/demo"],
];

const LAYOUTS: ReadonlyArray<[segment: string, Layout: React.ComponentType<{ children: React.ReactNode }>]> = [
  ["app/about", AboutLayout],
  ["app/contact-sales", ContactSalesLayout],
  ["app/for-compliance", ForComplianceLayout],
  ["app/for-government", ForGovernmentLayout],
  ["app/for-insurance", ForInsuranceLayout],
  ["app/for-investigations", ForInvestigationsLayout],
  ["app/for-journalism", ForJournalismLayout],
  ["app/for-lawyers", ForLawyersLayout],
  ["app/platform", PlatformLayout],
  ["app/pricing", PricingLayout],
  ["app/request-demo", RequestDemoLayout],
  ["app/support", SupportLayout],
  ["app/technology", TechnologyLayout],
  ["app/trust", TrustLayout],
  ["app/legal", LegalLayout],
  ["app/verify/demo", VerifyDemoLayout],
  ["app/auth/callback/ui", AuthCallbackUiLayout],
];

/** The nearest ancestor segment of `dir` (inclusive) that has a layout.tsx. */
function owningLayout(dir: string): string | null {
  let d = dir;
  while (d !== "app" && d !== ".") {
    if (fs.existsSync(path.join(WEB, d, "layout.tsx"))) return d;
    d = path.posix.dirname(d);
  }
  return null;
}

function pagesUnder(dir: string): string[] {
  const abs = path.join(WEB, dir);
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) return pagesUnder(rel);
    return e.name === "page.tsx" ? [rel] : [];
  });
}

describe("AUD-0015 — one main landmark on every public page", () => {
  it.each(AUDITED_ROUTES)("%s is served under a PublicMainLayout segment", (_route, servedFrom) => {
    const segment = owningLayout(servedFrom);
    expect(segment, `${servedFrom} has no layout of its own`).not.toBeNull();
    expect(read(`${segment}/layout.tsx`)).toMatch(
      /export \{ PublicMainLayout as default \} from "[./]+components\/marketing\/page-shell\/MarketingPage";/,
    );
  });

  it.each(LAYOUTS)("%s/layout.tsx renders exactly one <main> around the page", (_segment, Layout) => {
    render(
      <Layout>
        <div className="page landing-page">
          <header>site header</header>
          <h1>Page title</h1>
          <footer>site footer</footer>
        </div>
      </Layout>,
    );
    const mains = screen.getAllByRole("main");
    expect(mains).toHaveLength(1);
    expect(mains[0].id).toBe(PUBLIC_MAIN_ID);
    expect(mains[0].getAttribute("tabindex")).toBe("-1");
    expect(mains[0].querySelector("h1")?.textContent).toBe("Page title");
    expect(document.querySelectorAll("main,[role=main]")).toHaveLength(1);
  });

  it.each(LAYOUTS)("no page under %s renders a second main", (segment) => {
    const pages = pagesUnder(segment);
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) {
      const src = read(page);
      expect(src, `${page} renders its own <main>`).not.toMatch(/<main\b|role=["']main["']/);
      expect(src, `${page} wraps itself in MarketingPage, which owns a <main>`).not.toMatch(
        /<MarketingPage\b/,
      );
    }
  });

  it("PublicMainLayout is the same landmark as the layouts use", () => {
    render(
      <PublicMainLayout>
        <p>content</p>
      </PublicMainLayout>,
    );
    expect(screen.getAllByRole("main")).toHaveLength(1);
  });

  it("MarketingPage (FAQ, Why PROOVRA) still renders exactly one main", () => {
    render(
      <MarketingPage>
        <h1>FAQ</h1>
      </MarketingPage>,
    );
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(document.querySelectorAll("main,[role=main]")).toHaveLength(1);
  });
});
