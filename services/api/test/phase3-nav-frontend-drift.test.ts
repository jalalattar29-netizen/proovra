/**
 * Phase 3 — backend navigation-registry ↔ frontend routeRegistry drift guard.
 *
 * The backend navigation-registry (services/api/src/services/platform-context)
 * feeds the platform-context envelope's account-menu (rendered live by
 * AppAccountToolbar) and the legacy navigation.groups. Every
 * backend nav href MUST resolve to a canonical route in the frontend
 * routeRegistry (the single source of truth for the product's routes), OR be
 * on a small, documented compatibility allowlist (public marketing/help pages
 * that intentionally live outside the product registry).
 *
 * This test prevents backend/frontend nav drift — e.g. a backend entry
 * pointing at a route that was moved or deleted on the frontend (the exact
 * class of bug Phase 3 fixed: stale `/teams`, `/reviewer-ops`,
 * `workspace.intelligence_platform`, and the `/ops`→`/operations`
 * canonicalization).
 */

import { describe, expect, it } from "vitest";

import { NAVIGATION_REGISTRY } from "../src/services/platform-context/navigation-registry.js";
// The frontend routeRegistry .js is a self-contained compiled copy that is
// safe to import from the api test context (same pattern as phase-r10).
import { ROUTE_REGISTRY } from "../../../apps/web/lib/navigation/routeRegistry.js";

// Public / support / marketing routes that legitimately exist as pages but
// are intentionally NOT part of the product routeRegistry. Additions here
// must come with a reason.
const COMPAT_HREFS: ReadonlySet<string> = new Set<string>([
  "/pricing", // public marketing page (account.pricing)
  "/support", // help center page (account.help)
]);

const frontendHrefs = new Set<string>(
  (ROUTE_REGISTRY as ReadonlyArray<{ href: string }>).map((r) => r.href),
);

const backendItems = (
  NAVIGATION_REGISTRY as ReadonlyArray<{
    items: ReadonlyArray<{ id: string; href: string }>;
  }>
).flatMap((g) => g.items.map((i) => ({ id: i.id, href: i.href })));

describe("Phase 3 — backend nav ↔ frontend routeRegistry drift", () => {
  it.each(backendItems)(
    "backend nav '$id' → $href resolves in the frontend routeRegistry",
    ({ href }) => {
      expect(
        frontendHrefs.has(href) || COMPAT_HREFS.has(href),
        `backend nav href ${href} is not in the frontend ROUTE_REGISTRY and ` +
          `not allowlisted. Either the frontend route moved/was deleted (fix ` +
          `navigation-registry.ts to the canonical href), or add it to ` +
          `COMPAT_HREFS with a reason.`,
      ).toBe(true);
    },
  );

  it("no backend nav href points at a bare route deleted/renamed in Phases 2-3", () => {
    // Exact-match: only the BARE routes below were removed. Valid child
    // routes remain canonical (e.g. /reviewer-ops was removed but
    // /reviewer-ops/sla, /reviewer-ops/escalations, /reviewer-ops/[reviewId]
    // are live; /teams landing was removed but /teams/[id] is retained).
    const forbiddenExact = new Set<string>([
      "/teams", // deleted landing → /collaboration-teams (product) or /workspaces (admin)
      "/intelligence-platform", // merged into /intelligence
      "/inspect",
      "/verify-references",
      "/security/trust-center",
      "/reviewer-ops", // bare index removed → /review
    ]);
    const offenders = backendItems.filter((i) => forbiddenExact.has(i.href));
    expect(
      offenders,
      `backend nav still points at deleted/renamed routes: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });
});
