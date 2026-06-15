/**
 * Phase IA-self-serve-completion — final source-contract pins for the
 * self-serve experience completion + cross-page surface cleanup brief.
 *
 * The prior phases pinned the static tier table (`phase-ia-surface-tier`),
 * the wiring of sidebar / All Tools / command palette / SurfaceGate
 * (`phase-ia-surface-tier-wiring`), and the simplified self-serve
 * components (`phase-ia-self-serve-simplification`). THIS file closes
 * the last three holes called out by the completion brief:
 *
 *   1. /home/page.tsx renders <SelfServeHomeDashboard /> for self-serve
 *      plans and keeps the legacy CommandCenter for enterprise. The
 *      discriminator MUST be the same (isPlatformAdmin OR
 *      isEnterpriseWorkspace OR plan === "ENTERPRISE") used elsewhere.
 *   2. Every ENTERPRISE redirect/notFound directory has a layout.tsx
 *      that re-exports `EnterpriseSurfaceLayout`. The completion brief
 *      explicitly called out that some surfaces had been re-tiered but
 *      had no SurfaceGate at the directory boundary — direct URLs leaked
 *      through. The 10 dirs covered here are the redirect/notFound
 *      surfaces whose layouts were added in this phase.
 *   3. Cross-page links to hidden enterprise surfaces are gated. The
 *      audit across apps/web found exactly 2 offenders, both pointing
 *      to /security-center from inside the Settings tree. Both are now
 *      wrapped with `canAccessSurface(surfaceUserCtx, "/security-center")`.
 *
 * Source-contract regex tests over the actual file text so a future
 * refactor that drops the wiring, deletes a layout.tsx, or re-opens a
 * cross-page link will trip the suite at the wiring layer (not the
 * Playwright layer, which the repo doesn't ship).
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readWeb(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
    "utf8",
  );
}

function webPath(rel: string): string {
  return fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url));
}

// ============================================================================
// 1. /home/page.tsx — wired to SelfServeHomeDashboard for self-serve plans
// ============================================================================

describe("Phase IA-self-serve-completion — /home wiring", () => {
  const HOME = readWeb("app/(app)/home/page.tsx");

  it("imports SelfServeHomeDashboard from the home-experience package", () => {
    expect(HOME).toMatch(
      /import\s*\{\s*SelfServeHomeDashboard\s*\}\s*from\s*["']\.\.\/\.\.\/\.\.\/components\/home-experience\/SelfServeHomeDashboard["']/,
    );
  });

  it("imports useSurfaceUserContext from the shared hook module", () => {
    expect(HOME).toMatch(
      /import\s*\{\s*useSurfaceUserContext\s*\}\s*from\s*["']\.\.\/\.\.\/\.\.\/lib\/surface\/useSurfaceUserContext["']/,
    );
  });

  it("delegates the surface decision to the canonical resolveHomeSurface helper", () => {
    // Phase IA-home-fork — the inline `isSelfServePlan`/`showSelfServe`
    // fork was replaced by a single unit-tested pure function. The page
    // imports + calls it. (See phase-ia-home-fork.test.ts for the
    // decision-level cases.)
    expect(HOME).toMatch(/import \{ resolveHomeSurface \}/);
    expect(HOME).toMatch(/const decision = resolveHomeSurface\(\{/);
  });

  it("resolveHomeSurface isolates CommandCenter behind an explicit enterprise condition", () => {
    const RESOLVER = readWeb("lib/surface/resolveHomeSurface.ts");
    expect(RESOLVER).toMatch(/isPlatformAdmin === true/);
    expect(RESOLVER).toMatch(/isEnterpriseWorkspace === true/);
    expect(RESOLVER).toMatch(/plan === "ENTERPRISE"/);
    expect(RESOLVER).toMatch(/if \(isEnterprise\) return "command-center"/);
    // Plan null → loading, NOT command-center (the fixed fallback).
    expect(RESOLVER).toMatch(/return "loading"/);
    // Default is self-serve.
    expect(RESOLVER).toMatch(/return "self-serve"/);
  });

  it("renders SelfServeHomeDashboard as the default (self-serve) decision branch", () => {
    // The self-serve render is the ELSE/default branch — every resolved
    // non-enterprise plan lands here; CommandCenter is the guarded
    // enterprise branch only.
    expect(HOME).toMatch(/<SelfServeHomeDashboard\s*\/>/);
    expect(HOME).toMatch(/decision === "command-center" \?[\s\S]{0,400}<CommandCenter\s*\/>/);
    // The replaced inline fork must be gone.
    expect(HOME).not.toMatch(/showSelfServe/);
    expect(HOME).not.toMatch(/isSelfServePlan/);
  });

  it("preserves the existing CommandCenter branch for enterprise users", () => {
    // Self-serve home MUST NOT delete the legacy dashboard — enterprise
    // users continue to see AccountPrioritiesBanner + CommandCenter.
    expect(HOME).toMatch(/<AccountPrioritiesBanner\s*\/>/);
    expect(HOME).toMatch(/<CommandCenter\s*\/>/);
  });

  it("keeps the canonical PageRouteGate at the outer boundary", () => {
    expect(HOME).toMatch(/<PageRouteGate routeId="workspace\.home">/);
  });

  it("tags the rendered tree so QA can disambiguate self-serve from enterprise", () => {
    expect(HOME).toMatch(/data-self-serve-home/);
    expect(HOME).toMatch(/data-phase-a-1c-home/);
  });
});

// ============================================================================
// 2. ENTERPRISE redirect/notFound dirs all have a SurfaceGate layout
// ============================================================================

describe("Phase IA-self-serve-completion — ENTERPRISE layout.tsx files added", () => {
  // The 10 directories added in this phase. Each one is an ENTERPRISE
  // surface with either a redirect or notFound directAccessPolicy that
  // previously had no layout.tsx — so a direct URL would have rendered
  // the page tree before the client-side SurfaceGate could decide.
  // The shared EnterpriseSurfaceLayout runs SurfaceGate at the directory
  // boundary, applying the tier rule before any page content mounts.
  const SELF_SERVE_COMPLETION_DIRS = [
    "app/(app)/workspaces",
    "app/(app)/notifications",
    "app/(app)/collaboration",
    "app/(app)/evidence-lifecycle",
    "app/(app)/exchange",
    "app/(app)/integrations",
    "app/(app)/workflows",
    "app/(app)/communications",
    "app/(app)/packaging",
    "app/(app)/organizations",
  ];

  for (const dir of SELF_SERVE_COMPLETION_DIRS) {
    it(`${dir}/layout.tsx exists and re-exports EnterpriseSurfaceLayout`, () => {
      const layoutPath = webPath(`${dir}/layout.tsx`);
      expect(existsSync(layoutPath)).toBe(true);
      const src = readFileSync(layoutPath, "utf8");
      expect(src).toMatch(
        /export\s*\{\s*default\s*\}\s*from\s*["']\.\.\/\.\.\/\.\.\/components\/surface\/EnterpriseSurfaceLayout["']/,
      );
    });
  }

  // Also pin that the shared layout itself still wraps children in
  // SurfaceGate — without this, every re-export is a no-op.
  it("EnterpriseSurfaceLayout wraps children in SurfaceGate", () => {
    const SHARED = readWeb("components/surface/EnterpriseSurfaceLayout.tsx");
    expect(SHARED).toMatch(/<SurfaceGate>\{children\}<\/SurfaceGate>/);
  });
});

// ============================================================================
// 3. Cross-page link cleanup — Settings tree gates /security-center deep links
// ============================================================================

describe("Phase IA-self-serve-completion — Settings tree gates /security-center", () => {
  const SETTINGS = readWeb("app/(app)/settings/page.tsx");

  it("imports canAccessSurface + useSurfaceUserContext", () => {
    expect(SETTINGS).toMatch(
      /import\s*\{\s*canAccessSurface\s*\}\s*from\s*["']\.\.\/\.\.\/\.\.\/lib\/surface\/access["']/,
    );
    expect(SETTINGS).toMatch(
      /import\s*\{\s*useSurfaceUserContext\s*\}\s*from\s*["']\.\.\/\.\.\/\.\.\/lib\/surface\/useSurfaceUserContext["']/,
    );
  });

  it("computes canSeeWorkspaceSecurity from canAccessSurface('/security-center')", () => {
    expect(SETTINGS).toMatch(
      /const canSeeWorkspaceSecurity\s*=\s*canAccessSurface\([\s\S]{0,200}surfaceUserCtx[\s\S]{0,200}"\/security-center"/,
    );
  });

  it("gates the Identity & Security card body on canSeeWorkspaceSecurity", () => {
    // The card MUST render the workspace deep link ONLY when the surface
    // is accessible. Self-serve users see an Account Security fallback
    // pointing at /settings/security.
    expect(SETTINGS).toMatch(
      /\{canSeeWorkspaceSecurity \?\s*\([\s\S]{0,2000}<Link href="\/security-center"/,
    );
    // The fallback branch links to the account-security page, which is
    // an ACCOUNT-tier surface available to every authenticated user.
    expect(SETTINGS).toMatch(
      /\) :\s*\([\s\S]{0,2000}<Link href="\/settings\/security">/,
    );
  });
});

describe("Phase IA-self-serve-completion — /settings/security gates inline link", () => {
  const SEC = readWeb("app/(app)/settings/security/page.tsx");

  it("imports canAccessSurface + useSurfaceUserContext", () => {
    expect(SEC).toMatch(
      /import\s*\{\s*canAccessSurface\s*\}\s*from\s*["']\.\.\/\.\.\/\.\.\/\.\.\/lib\/surface\/access["']/,
    );
    expect(SEC).toMatch(
      /import\s*\{\s*useSurfaceUserContext\s*\}\s*from\s*["']\.\.\/\.\.\/\.\.\/\.\.\/lib\/surface\/useSurfaceUserContext["']/,
    );
  });

  it("computes canSeeWorkspaceSecurity inside AccountSecurityPageInner", () => {
    // The compute MUST live INSIDE the inner component so the hook fires
    // under the PageRouteGate (not at module scope).
    const innerIdx = SEC.indexOf("function AccountSecurityPageInner");
    const computeIdx = SEC.indexOf("const canSeeWorkspaceSecurity");
    expect(innerIdx).toBeGreaterThan(-1);
    expect(computeIdx).toBeGreaterThan(innerIdx);
  });

  it("renders the /security-center deep-link sentence ONLY when canSeeWorkspaceSecurity", () => {
    // Pin the conditional. Self-serve users see the personal copy with
    // NO mention of the workspace surface.
    expect(SEC).toMatch(
      /\{canSeeWorkspaceSecurity \?\s*\([\s\S]{0,800}<Link href="\/security-center"[\s\S]{0,400}Identity &amp; Security/,
    );
    expect(SEC).toMatch(/\) : null\}/);
  });
});

// ============================================================================
// 4. Sanity sweep — no other core page links to a hidden ENTERPRISE surface
// ============================================================================

describe("Phase IA-self-serve-completion — core pages have no leaked enterprise hrefs", () => {
  // The completion brief mandated a sweep across the core self-serve
  // page tree. The grep across apps/web at the time found:
  //
  //   * Settings: 2 offenders pointing at /security-center — both
  //     wrapped in the canAccessSurface gate above.
  //   * Search: 1 offender pointing at /integrations from the
  //     no-results "Enable semantic search" CTA — wrapped in the
  //     canSeeIntegrations gate (see search-gate suite below).
  //
  // Pin that the OTHER core pages (evidence/cases/reports/billing) have
  // no Link/href to a hidden ENTERPRISE-only surface at all. /teams has
  // no top-level page.tsx (dynamic `[id]` only) so it's not in this list.
  const CLEAN_PAGES = [
    "app/(app)/evidence/page.tsx",
    "app/(app)/cases/page.tsx",
    "app/(app)/reports/page.tsx",
    "app/(app)/billing/page.tsx",
  ];

  // Hrefs that point straight at a hidden ENTERPRISE surface. We allow
  // /security-center (gated in settings) and /integrations (gated in
  // search) to be checked separately; the list below is the set of
  // surfaces that self-serve users must never see referenced from a
  // CORE page.
  const HIDDEN_HREFS = [
    "/governance",
    "/governance-platform",
    "/review",
    "/reviewer-ops",
    "/intelligence",
    "/intelligence-platform",
    "/intelligence-quality",
    "/investigation",
    "/executive",
    "/budget-center",
    "/redaction",
    "/audit-transparency",
    "/organizations",
    "/organization-admin",
    "/workflows",
    "/communications",
    "/packaging",
    "/exchange",
    "/evidence-lifecycle",
    "/collaboration",
    "/workspaces",
    "/notifications",
    "/persona",
  ];

  for (const page of CLEAN_PAGES) {
    it(`${page} contains no Link/href to a hidden ENTERPRISE surface`, () => {
      const src = readWeb(page);
      for (const href of HIDDEN_HREFS) {
        // Match `href="/foo"` exactly (or with a trailing slash / query).
        // Use word boundary on the right so /foo doesn't match /foobar.
        const safe = href.replace(/\//g, "\\/");
        const re = new RegExp(`href=\\\\?["']${safe}(?:[\\\\/"'?#]|$)`);
        expect(src, `${page} must not link to ${href}`).not.toMatch(re);
      }
    });
  }
});

// ============================================================================
// 5. Search page — /integrations deep link is gated on canSeeIntegrations
// ============================================================================

describe("Phase IA-self-serve-completion — Search page gates /integrations", () => {
  const SEARCH = readWeb("app/(app)/search/page.tsx");

  it("imports canAccessSurface + useSurfaceUserContext", () => {
    expect(SEARCH).toMatch(
      /import\s*\{\s*canAccessSurface\s*\}\s*from\s*["']\.\.\/\.\.\/\.\.\/lib\/surface\/access["']/,
    );
    expect(SEARCH).toMatch(
      /import\s*\{\s*useSurfaceUserContext\s*\}\s*from\s*["']\.\.\/\.\.\/\.\.\/lib\/surface\/useSurfaceUserContext["']/,
    );
  });

  it("computes canSeeIntegrations from canAccessSurface('/integrations')", () => {
    expect(SEARCH).toMatch(
      /const canSeeIntegrations\s*=\s*canAccessSurface\([\s\S]{0,200}surfaceUserCtx[\s\S]{0,200}"\/integrations"/,
    );
  });

  it("Phase SEARCH-REMEDIATION-3 — `NoResultsHelp` is gone (the truthful empty-state branches replaced it)", () => {
    // The legacy `<NoResultsHelp>` component carried persona +
    // canSeeIntegrations + mode signals into a single muddled
    // "try semantic search" footer. The center empty state now
    // distinguishes 4 honest modes (loading / error / idle /
    // no-match), each with bounded copy. The component name and
    // the canSeeIntegrations prop on it are both gone.
    expect(SEARCH).not.toMatch(/<NoResultsHelp\b/);
    expect(SEARCH).toMatch(/data-search-empty-state-kind="no-match"/);
    expect(SEARCH).toMatch(/data-search-empty-state-kind="idle"/);
  });
});
