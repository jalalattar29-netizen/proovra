/**
 * Phase IA-home-findings — NO duplicate sidebar CTAs on the self-serve Home.
 *
 * Audit finding #1: the Home had a card-header "→" CTA on almost every
 * card that merely re-navigated to the matching sidebar destination
 * (Recent Evidence "View all evidence" → /evidence, Case Health "All
 * cases" → /cases, Trust "View evidence", Reports "Open Reports",
 * Submissions "All submissions" → /inbox, Request&Collect "Manage intake
 * links", Storage "Manage in Billing", Team Work "Manage teams"). That
 * turned the Home into a link farm duplicating the left nav.
 *
 * This pins the corrected contract: a Home card MUST NOT carry a header
 * CTA whose only job is to navigate to a top-level sidebar route. The
 * remaining affordances are per-row deep links (e.g. /evidence/:id),
 * contextual empty-state actions, the inline failed-delivery retry, and
 * one contextual storage-upgrade link shown only at the limit — none of
 * which duplicate the sidebar.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readWeb(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
    "utf8",
  );
}

const SECTIONS = readWeb("components/home-experience/HomeSections.tsx");
const DASH = readWeb("components/home-experience/SelfServeHomeDashboard.tsx");

// Top-level destinations that already live in the left sidebar. A Home
// card header that simply links to one of these is a duplicate.
const SIDEBAR_ROUTES = [
  "/evidence",
  "/cases",
  "/reports",
  "/intake-links",
  "/teams",
  "/billing",
  "/inbox",
];

// ============================================================================
// 1. The removed labels are gone for good
// ============================================================================

describe("Phase IA-home-findings — removed nav-duplicate CTA labels", () => {
  const REMOVED_LABELS = [
    "View all evidence",
    "All cases",
    "View evidence",
    "Open Reports",
    "All submissions",
    "Manage intake links",
    "Manage in Billing",
    "Manage teams",
  ];
  for (const label of REMOVED_LABELS) {
    it(`"${label}" is no longer a Home CTA label`, () => {
      expect(SECTIONS).not.toContain(label);
    });
  }
});

// ============================================================================
// 2. No SectionCard header CTA targets a bare sidebar route
// ============================================================================

describe("Phase IA-home-findings — no card-header CTA duplicates the sidebar", () => {
  // Extract every href passed to a SectionCard `cta={{ ... href: "..." }}`.
  function ctaHrefs(src: string): string[] {
    const hrefs: string[] = [];
    const re = /cta=\{\{[^}]*href:\s*["'`]([^"'`]+)["'`]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) hrefs.push(m[1]);
    return hrefs;
  }

  it("HomeSections.tsx passes NO header cta to a bare sidebar route", () => {
    const offenders = ctaHrefs(SECTIONS).filter((h) =>
      SIDEBAR_ROUTES.includes(h.split("?")[0]),
    );
    expect(offenders, `nav-duplicate header CTAs: ${offenders.join(", ")}`).toEqual([]);
  });

  it("the self-serve dashboard header is still title + subtitle only (no button row)", () => {
    const header = DASH.match(/<header[\s\S]*?<\/header>/)?.[0] ?? "";
    expect(header).not.toMatch(/<Link/);
    expect(header).not.toMatch(/<button/);
  });
});

// ============================================================================
// 3. The legitimate, NON-duplicating affordances survive
// ============================================================================

describe("Phase IA-home-findings — contextual + per-row actions remain", () => {
  it("each list card still deep-links per row (not a bulk nav CTA)", () => {
    // Evidence/case/report rows link to the specific record, which is a
    // contextual deep link — the opposite of a duplicate sidebar CTA.
    expect(SECTIONS).toMatch(/href=\{r\.href\}/); // submissions / collection rows
    expect(SECTIONS).toMatch(/data-report-action="open-evidence"/);
  });

  it("empty-state creation CTAs (capture / create intake / create case) are kept", () => {
    expect(SECTIONS).toMatch(/data-trust-cta="capture-first"/);
    expect(SECTIONS).toMatch(/data-collection-cta="create-intake-link"/);
    expect(SECTIONS).toMatch(/data-case-cta="create-case"/);
  });

  it("the storage upgrade link is contextual (rendered only near/at the limit)", () => {
    // The upgrade Link sits inside the nearLimit/limitReached branch, not
    // in the card header.
    expect(SECTIONS).toMatch(/usage\.nearLimit \|\| usage\.limitReached \?[\s\S]*?data-storage-upgrade/);
    // And there is no permanent "Manage in Billing" header CTA.
    expect(SECTIONS).not.toContain("Manage in Billing");
  });

  it("the failed-delivery retry is an inline action, not a nav link", () => {
    expect(SECTIONS).toMatch(/data-delivery-retry/);
    expect(SECTIONS).toMatch(/\/v1\/communications\/messages\/\$\{encodeURIComponent\(messageId\)\}\/retry/);
  });
});
