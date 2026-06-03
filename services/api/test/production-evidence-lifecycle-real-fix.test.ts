/**
 * Production regression test — Evidence Lifecycle REAL FIX
 * (post-deploy follow-up; previous final-fix was a band-aid).
 *
 * The previous deploy still showed:
 *   - "/evidence-lifecycle" → "Unable to load lifecycle dashboard."
 *     red error (the dashboard 403 entitlement gate fired, apiFetch
 *     couldn't parse the non-standard denial body, mapErrorToState
 *     fell to the catch-all "error" phase).
 *   - "/evidence-lifecycle/archive" → "Archive Tiers could not render."
 *     (the LifecycleSectionBoundary fallback — masking a real type
 *     mismatch between backend `Record<tier, bucket>` and frontend
 *     `Array<{tier, storageGbMonthUsd, retrievalGbUsd}>` which threw
 *     `costs.find is not a function` at render time.)
 *
 * REAL FIXES PINNED HERE — these tests INTENTIONALLY fail if the
 * previous band-aid behaviour ever returns.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../../..");

function readFile(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), "utf8");
}

// ── Fix 1: apiFetch propagates top-level denial bodies as `details` ───

describe("REAL FIX 1 — apiFetch promotes top-level denial bodies", () => {
  const API = readFile("apps/web/lib/api.ts");

  it("(1) detects top-level denial fields and promotes them into details", () => {
    expect(API).toMatch(/topLevelDenialFields/);
    expect(API).toMatch(/promotedDetails/);
    expect(API).toMatch(/bodyHasTopLevelDenial/);
  });

  it("(2) error.details falls back through detailsFromBody → promotedDetails → billingWall", () => {
    expect(API).toMatch(
      /error\.details\s*=\s*detailsFromBody\s*\?\?\s*promotedDetails\s*\?\?\s*billingWall/,
    );
  });

  it("(3) error.code falls back through codeFromBody → top-level denial → status default", () => {
    expect(API).toMatch(/typeof\s+obj\?\.\["denial"\]\s*===\s*["']string["']/);
  });

  it("(4) the topLevelDenialFields list covers all the known denial keys", () => {
    // These are the keys used by the legacy denial routes
    // (e.g. POST /v1/lifecycle/dashboard ENTITLEMENT_REQUIRED body).
    expect(API).toMatch(/"denial"/);
    expect(API).toMatch(/"entitlement"/);
    expect(API).toMatch(/"requiredTier"/);
  });
});

// ── Fix 2: dashboard route no longer wholesale-403s ──────────────────

describe("REAL FIX 2 — dashboard route never returns wholesale 403", () => {
  const ROUTES = readFile("services/api/src/routes/product-and-lifecycle.routes.ts");

  it("(5) the dashboard handler does NOT reply with 403 ENTITLEMENT_REQUIRED on the dashboard", () => {
    const startIdx = ROUTES.indexOf('"/v1/lifecycle/dashboard"');
    expect(startIdx).toBeGreaterThan(0);
    const slice = ROUTES.slice(startIdx, startIdx + 5000);
    // The old "return reply.code(403).send({denial: ENTITLEMENT_REQUIRED, entitlement: FEATURE_LIFECYCLE_DASHBOARD})"
    // is gone. The entitlement state is now surfaced as a flag inside
    // the dashboard envelope so the page renders either way.
    expect(slice).not.toMatch(
      /return\s+reply\.code\(403\)\.send\(\{\s*denial:\s*["']ENTITLEMENT_REQUIRED["']\s*,\s*entitlement:\s*["']FEATURE_LIFECYCLE_DASHBOARD["']/,
    );
  });

  it("(6) the dashboard handler still inspects the entitlement and SETS entitlementMissing on the envelope", () => {
    const startIdx = ROUTES.indexOf('"/v1/lifecycle/dashboard"');
    const slice = ROUTES.slice(startIdx, startIdx + 5000);
    expect(slice).toMatch(/let\s+entitlementMissing\s*=\s*false/);
    expect(slice).toMatch(/entitlementMissing\s*=\s*!feOk\.ok/);
    expect(slice).toMatch(/entitlementMissing\?\:\s*boolean/);
    // The flag is sent inside the dashboard envelope.
    expect(slice).toMatch(/entitlementMissing\s*=\s*entitlementMissing/);
  });

  it("(7) the dashboard handler still returns 200 with `{dashboard}` on all data paths", () => {
    const startIdx = ROUTES.indexOf('"/v1/lifecycle/dashboard"');
    const slice = ROUTES.slice(startIdx, startIdx + 5000);
    expect(slice).toMatch(/return\s+reply\.code\(200\)\.send\(\{\s*dashboard\s*\}\)/);
  });
});

// ── Fix 3: dashboard frontend NEVER shows "Unable to load" red error ─

describe("REAL FIX 3 — dashboard frontend never shows the bad red error", () => {
  const DASHBOARD = readFile("apps/web/app/(app)/evidence-lifecycle/page.tsx");

  it("(8) the source NO LONGER contains the rejected red-error string", () => {
    // The bad string was: "Unable to load lifecycle dashboard."
    // It is now replaced with a soft "activity counts unavailable"
    // notice that doesn't blank the rest of the page.
    expect(DASHBOARD).not.toMatch(/Unable to load lifecycle dashboard\./);
  });

  it("(9) refresh() converts generic errors into a degraded LoadedDashboard (not error phase)", () => {
    // The handler MUST keep auth/entitlement panels but convert "error"
    // phase into a degraded loaded state so chrome always renders.
    expect(DASHBOARD).toMatch(/mapped\.phase\s*===\s*["']error["']/);
    expect(DASHBOARD).toMatch(/setState\(\s*\{\s*phase:\s*["']loaded["']\s*,\s*dashboard:\s*empty\s*\}\s*\)/);
    expect(DASHBOARD).toMatch(/empty\.degraded\s*=\s*true/);
  });

  it("(10) the entitlement-missing banner is rendered inside LoadedDashboard", () => {
    expect(DASHBOARD).toMatch(/data-evidence-lifecycle-entitlement-banner/);
    expect(DASHBOARD).toMatch(/dashboard\.entitlementMissing/);
  });

  it("(11) the LifecycleDashboard type includes entitlementMissing", () => {
    expect(DASHBOARD).toMatch(/entitlementMissing\?\:\s*boolean/);
  });
});

// ── Fix 4: archive page no longer throws "costs.find is not a function" ─

describe("REAL FIX 4 — archive page reads the correct backend shape", () => {
  const ARCHIVE = readFile("apps/web/app/(app)/evidence-lifecycle/archive/page.tsx");

  it("(12) ArchiveTierCostBucket interface matches the real backend shape", () => {
    expect(ARCHIVE).toMatch(/interface\s+ArchiveTierCostBucket\s*\{/);
    expect(ARCHIVE).toMatch(/evidenceCount\s*:\s*number/);
    expect(ARCHIVE).toMatch(/totalCostUsdMicrosPerMonth\s*:\s*number/);
  });

  it("(13) costs state is typed as a Record<tier, bucket> object, NOT an array", () => {
    // The previous interface (Array<{tier, storageGbMonthUsd, retrievalGbUsd}>)
    // was a TypeScript lie — backend never returned that shape.
    expect(ARCHIVE).toMatch(/useState<ArchiveCostBuckets>/);
    expect(ARCHIVE).toMatch(/type\s+ArchiveCostBuckets\s*=/);
    expect(ARCHIVE).toMatch(/Partial<\s*Record<\s*string\s*,/);
    expect(ARCHIVE).toMatch(/ArchiveTierCostBucket/);
    // No `.find(` on costs anywhere — that was the throw site.
    expect(ARCHIVE).not.toMatch(/costs\.find\s*\(/);
  });

  it("(14) tier rendering uses costs[tier] (object access), NOT costs.find(...)", () => {
    expect(ARCHIVE).toMatch(/const\s+bucket\s*=\s*costs\[tier\]/);
  });

  it("(15) page renders DEEP_ARCHIVE (real backend enum), not the made-up FROZEN", () => {
    expect(ARCHIVE).toMatch(/"DEEP_ARCHIVE"/);
    // FROZEN was a UI invention that never existed in the backend.
    expect(ARCHIVE).not.toMatch(/"FROZEN"/);
  });

  it("(16) page has NO LifecycleSectionBoundary wrap — the real fix is upstream", () => {
    // The boundary was hiding the real bug. After fixing the type
    // mismatch, the boundary should not be needed. Re-introducing it
    // here would only re-mask future shape regressions.
    expect(ARCHIVE).not.toMatch(/<LifecycleSectionBoundary/);
    expect(ARCHIVE).not.toMatch(/import[^;]*LifecycleSectionBoundary/);
  });

  it("(17) cost endpoint failure surfaces a banner but does NOT blank tier cards", () => {
    // The cost endpoint and transitions endpoint have INDEPENDENT
    // error states. A 4xx/5xx on /costs renders "No cost data
    // configured" inside each tier card; tier cards always render.
    expect(ARCHIVE).toMatch(/costsError/);
    expect(ARCHIVE).toMatch(/transitionsError/);
    expect(ARCHIVE).toMatch(/data-archive-tier-cards/);
    // Tier cards section is OUTSIDE any conditional that depends on
    // costsError — render unconditionally.
    const cardsIdx = ARCHIVE.indexOf("data-archive-tier-cards");
    const beforeCards = ARCHIVE.slice(0, cardsIdx);
    // Last opening tag before cards must NOT be a conditional like
    // `{costsError ? null : (`.
    expect(beforeCards).not.toMatch(/\{\s*costsError\s*\?\s*null\s*:\s*\(\s*$/m);
  });

  it("(18) cost / count formatters defend against undefined / non-finite numbers", () => {
    expect(ARCHIVE).toMatch(/function\s+formatMicrosUsd/);
    expect(ARCHIVE).toMatch(/Number\.isFinite\(micros\)/);
    expect(ARCHIVE).toMatch(/function\s+formatCount/);
  });

  it("(19) source does NOT contain the rejected red-mask string", () => {
    expect(ARCHIVE).not.toMatch(/Archive Tiers could not render/);
  });
});

// ── Fix 5: Governance Lifecycle / Governance Posture NOT removed ─────

describe("REAL FIX 5 — Governance Posture route is preserved", () => {
  const ROUTE_REGISTRY = readFile("apps/web/lib/navigation/routeRegistry.ts");

  it("(20) governance.lifecycle route entry exists with the correct href + label", () => {
    expect(ROUTE_REGISTRY).toMatch(/id:\s*["']governance\.lifecycle["']/);
    expect(ROUTE_REGISTRY).toMatch(/href:\s*["']\/governance\/lifecycle["']/);
    expect(ROUTE_REGISTRY).toMatch(/label:\s*["']Governance Posture["']/);
  });

  it("(21) governance.lifecycle is visible in sidebar AND command palette AND all tools", () => {
    const idx = ROUTE_REGISTRY.indexOf('id: "governance.lifecycle"');
    expect(idx).toBeGreaterThan(0);
    // The entry runs from this id line down to the next `},`.
    const entrySlice = ROUTE_REGISTRY.slice(idx, idx + 800);
    expect(entrySlice).toMatch(/sidebarEligible:\s*true/);
    expect(entrySlice).toMatch(/commandPaletteVisible:\s*true/);
    expect(entrySlice).toMatch(/allToolsVisible:\s*true/);
  });

  it("(22) the underlying page file still exists", () => {
    const pagePath = resolve(
      REPO_ROOT,
      "apps/web/app/(app)/governance/lifecycle/page.tsx",
    );
    expect(existsSync(pagePath)).toBe(true);
  });
});

// ── Fix 6: empty-data dashboard renders summary cards (not error) ────

describe("REAL FIX 6 — dashboard renders summary cards with zero data", () => {
  const DASHBOARD = readFile("apps/web/app/(app)/evidence-lifecycle/page.tsx");

  it("(23) emptyDashboard helper exists and produces a fully-typed empty projection", () => {
    expect(DASHBOARD).toMatch(/function\s+emptyDashboard\(\)\s*:\s*LifecycleDashboard\s*\{/);
    expect(DASHBOARD).toMatch(/retention:\s*\{\}/);
    expect(DASHBOARD).toMatch(/legalHolds:\s*\{\}/);
    expect(DASHBOARD).toMatch(/archive:\s*\{\}/);
    expect(DASHBOARD).toMatch(/destruction:\s*\{\}/);
  });

  it("(24) all 6 sub-page tiles + capability launcher render even when data is empty", () => {
    // The SUB_PAGES array is the source of truth for which sub-pages
    // appear as launcher tiles. Confirm all 6 are present.
    expect(DASHBOARD).toMatch(/href:\s*["']\/evidence-lifecycle\/retention["']/);
    expect(DASHBOARD).toMatch(/href:\s*["']\/evidence-lifecycle\/legal-holds["']/);
    expect(DASHBOARD).toMatch(/href:\s*["']\/evidence-lifecycle\/archive["']/);
    expect(DASHBOARD).toMatch(/href:\s*["']\/evidence-lifecycle\/destruction["']/);
    expect(DASHBOARD).toMatch(/href:\s*["']\/evidence-lifecycle\/webhooks["']/);
    expect(DASHBOARD).toMatch(/href:\s*["']\/evidence-lifecycle\/chain-transfers["']/);
  });

  it("(25) LoadedDashboard is invoked even when the projection is empty (degraded or otherwise)", () => {
    // phase === "loaded" always feeds LoadedDashboard; nothing checks
    // whether the projection has data first.
    expect(DASHBOARD).toMatch(
      /state\.phase\s*===\s*["']loaded["'][\s\S]*?LoadedDashboard/,
    );
  });
});
