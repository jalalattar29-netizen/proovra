/**
 * Phase G0 — Operational Convergence Wave 1 (source-contract suite).
 *
 * Asserts the closure of six deferred items from Phase B / B0:
 *
 *   B.1  — sidebar rewrite uses Phase B canonical hierarchy
 *   B.2  — OperationalBreadcrumb mounted on nested operational pages
 *   B.3  — terminology normalized in user-facing nav
 *   B.4  — operations path normalization preserved
 *   B0.3 — workspace switcher explains workspace vs organization
 *   B0.5 — /workspaces is the canonical frontend route; /teams works
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  const url = new URL(rel, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\n/)
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

const CANONICAL_GROUPS = readSource(
  "../../../apps/web/lib/navigation/canonicalNavigationGroups.ts",
);
const GROUPING_RESOLVER = readSource(
  "../../../apps/web/lib/navigation/navigationGroupingResolver.ts",
);
const ROUTE_REGISTRY = readSource(
  "../../../apps/web/lib/navigation/routeRegistry.ts",
);
// Product-reset: AppTopbarV2 (dead duplicate topbar) deleted; contract
// retargeted to the live AppAccountToolbar.
const TOPBAR = readSource(
  "../../../apps/web/components/app-shell-v2/AppAccountToolbar.tsx",
);
const WORKSPACES_PAGE = readSource(
  "../../../apps/web/app/(app)/workspaces/page.tsx",
);
// Phase Final-Closure-Remediation — the legacy /teams page (a
// duplicate of /workspaces) was deleted; the URL now redirects via
// `next.config.js`. We assert the canonical surface + the redirect
// declaration instead of the legacy file body.
const NEXT_CONFIG = readSource("../../../apps/web/next.config.js");
const CR0_TEST = readSource("./phase-cr0-system-freeze-baseline.test.ts");

// ===========================================================================
// B.1 — Sidebar rewrite
// ===========================================================================

describe("Phase G0 (B.1) — sidebar uses Phase B canonical hierarchy", () => {
  it("ALLOWED_ROOT_GROUP_TITLES drops R2 titles and emits Phase B titles", () => {
    expect(CANONICAL_GROUPS).toContain('"Workspace"');
    expect(CANONICAL_GROUPS).toContain('"Governance"');
    expect(CANONICAL_GROUPS).toContain('"Outputs"');
    expect(CANONICAL_GROUPS).toContain('"System"');
    // The legacy R2 titles must NOT appear in the bounded title list.
    const allowed = CANONICAL_GROUPS.match(
      /ALLOWED_ROOT_GROUP_TITLES[\s\S]*?\];/,
    );
    expect(allowed).toBeTruthy();
    expect(allowed![0]).not.toMatch(/"Primary workflows"/);
    expect(allowed![0]).not.toMatch(/"Governance & Compliance"/);
    // The legacy "Operations" group title is also retired from the
    // bounded list (review work folds into Workspace; platform-health
    // folds into System).
    expect(allowed![0]).not.toMatch(/"Operations"/);
  });

  it("canonical group definitions expose the four Phase B groups", () => {
    expect(CANONICAL_GROUPS).toMatch(
      /SIDEBAR_GROUP_WORKSPACE\s*=\s*\{[\s\S]*?title:\s*"Workspace"/,
    );
    expect(CANONICAL_GROUPS).toMatch(
      /SIDEBAR_GROUP_GOVERNANCE\s*=\s*\{[\s\S]*?title:\s*"Governance"/,
    );
    expect(CANONICAL_GROUPS).toMatch(
      /SIDEBAR_GROUP_OUTPUTS\s*=\s*\{[\s\S]*?title:\s*"Outputs"/,
    );
    expect(CANONICAL_GROUPS).toMatch(
      /SIDEBAR_GROUP_SYSTEM\s*=\s*\{[\s\S]*?title:\s*"System"/,
    );
  });

  it("CR0 baseline test pin updated to the Phase B titles", () => {
    expect(CR0_TEST).toContain('"Workspace"');
    expect(CR0_TEST).toContain('"Governance"');
    expect(CR0_TEST).toContain('"Outputs"');
    expect(CR0_TEST).toContain('"System"');
    // Phase G0 update: ALLOWED_ROOT_GROUP_TITLES must no longer include
    // the legacy R2 titles.
    const allowedTitlesBlock = CR0_TEST.match(
      /Phase G0[\s\S]*?ALLOWED_ROOT_GROUP_TITLES\s*=\s*\[[\s\S]*?\];/,
    );
    expect(allowedTitlesBlock).toBeTruthy();
    expect(allowedTitlesBlock![0]).not.toMatch(/"Primary workflows"/);
    expect(allowedTitlesBlock![0]).not.toMatch(/"Governance & Compliance"/);
  });

  it("grouping resolver consumes phaseBOperationalGroups.ts for group membership", () => {
    // Product-decision 2026-07-14: the resolver also imports the
    // declarative group arrays (PHASE_B_OPERATIONAL_GROUPS) to enforce
    // the item-order contract, so the import is multi-name now.
    expect(GROUPING_RESOLVER).toMatch(
      /import\s*\{[\s\S]*?operationalGroupForRoute[\s\S]*?\}\s*from\s+"\.\/phaseBOperationalGroups"/,
    );
    expect(GROUPING_RESOLVER).toMatch(/PHASE_B_OPERATIONAL_GROUPS/);
    expect(GROUPING_RESOLVER).toMatch(
      /operationalGroupForRoute\(item\.route\.id\)/,
    );
  });

  it("grouping resolver emits the four Phase B groups in canonical order", () => {
    const code = GROUPING_RESOLVER;
    const wsPos = code.indexOf("SIDEBAR_GROUP_WORKSPACE.id");
    const govPos = code.indexOf("SIDEBAR_GROUP_GOVERNANCE.id");
    const outPos = code.indexOf("SIDEBAR_GROUP_OUTPUTS.id");
    const sysPos = code.indexOf("SIDEBAR_GROUP_SYSTEM.id");
    expect(wsPos).toBeGreaterThan(0);
    expect(govPos).toBeGreaterThan(wsPos);
    expect(outPos).toBeGreaterThan(govPos);
    expect(sysPos).toBeGreaterThan(outPos);
  });
});

// ===========================================================================
// B.2 — Breadcrumb expansion
// ===========================================================================

describe("Phase G0 (B.2) — OperationalBreadcrumb mounted on nested pages", () => {
  // Intake Links was intentionally removed from this list during the
  // strict-UX modal-copy cleanup — the breadcrumb row ("Workspace ›
  // Intake links") above the H1 was visual clutter that duplicated
  // the page title and pushed the primary CTA below the fold on
  // narrow viewports. The breadcrumb component itself is still in
  // use on every other nested page; this is a page-specific opt-out,
  // not a global removal.
  const PAGES: Array<{ name: string; rel: string }> = [
    {
      name: "Matter Workspace",
      rel: "../../../apps/web/app/(app)/cases/[id]/page.tsx",
    },
    {
      name: "Evidence Request inspector",
      rel: "../../../apps/web/app/(app)/evidence-requests/[id]/page.tsx",
    },
    {
      name: "Governance destruction",
      rel: "../../../apps/web/app/(app)/governance/destruction/page.tsx",
    },
    {
      name: "Governance retention",
      rel: "../../../apps/web/app/(app)/governance/retention/page.tsx",
    },
    {
      name: "Canonical /workspaces",
      rel: "../../../apps/web/app/(app)/workspaces/page.tsx",
    },
  ];
  for (const { name, rel } of PAGES) {
    it(`${name} mounts OperationalBreadcrumb`, () => {
      const src = readSource(rel);
      expect(src).toMatch(/import\s*\{\s*OperationalBreadcrumb\s*\}/);
      expect(src).toMatch(/<OperationalBreadcrumb/);
    });
  }

  it("Intake links page does NOT mount OperationalBreadcrumb (intentional opt-out for UX cleanup)", () => {
    // Inverse regression pin — a future refactor that "puts the
    // breadcrumb back to match every other page" would re-introduce
    // the visual clutter the strict-UX brief removed. Lock the
    // exception in place. The companion pin in
    // apps/web/__tests__/intake-links-modal-strict-ux.test.ts (Pin
    // 1) covers the same invariant from the web side.
    const src = readSource(
      "../../../apps/web/app/(app)/intake-links/page.tsx",
    );
    expect(src).not.toMatch(/<OperationalBreadcrumb/);
    expect(src).not.toMatch(/import\s*\{\s*OperationalBreadcrumb\s*\}/);
  });
});

// ===========================================================================
// B.3 — Terminology normalization
// ===========================================================================

describe("Phase G0 (B.3) — terminology normalized in primary navigation", () => {
  it("route registry uses 'Workspaces' for the admin.teams entry label", () => {
    expect(ROUTE_REGISTRY).toMatch(
      /id:\s*"admin\.teams"[\s\S]*?label:\s*"Workspaces"/,
    );
  });

  it("primary nav never surfaces forbidden SaaS drift terminology", () => {
    const code = stripComments(CANONICAL_GROUPS);
    expect(code).not.toMatch(/\bkanban\b/i);
    expect(code).not.toMatch(/\bCRM\b/);
    expect(code).not.toMatch(/\bproject\s+board\b/i);
    expect(code).not.toMatch(/\bticket\b/i);
    expect(code).not.toMatch(/\btenant\b/i);
  });

  it("topbar workspace switcher uses 'Workspace' and 'Organization' terminology", () => {
    expect(TOPBAR).toContain("Personal Space");
    expect(TOPBAR).toContain("Organization workspace");
  });
});

// ===========================================================================
// B.4 — Operations path normalization (still in place from Phase B)
// ===========================================================================

describe("Phase G0 (B.4) — operations path alias preserved", () => {
  it("next.config.js still aliases /ops/reliability → /operations/reliability", () => {
    const cfg = readSource("../../../apps/web/next.config.js");
    expect(cfg).toMatch(
      /source:\s*"\/ops\/reliability",\s*destination:\s*"\/operations\/reliability"/,
    );
  });
});

// ===========================================================================
// B0.3 — Workspace switcher UX
// ===========================================================================

describe("Phase G0 (B0.3) — workspace switcher UX", () => {
  it("renders an explicit failure label when platform context is FAILED", () => {
    // The live toolbar surfaces the FAILED platform-context state as a
    // "Workspace unavailable / Tap to retry" label in the switcher chip.
    expect(TOPBAR).toContain('state.name === "FAILED"');
    expect(TOPBAR).toMatch(/Workspace unavailable/);
  });
});

// ===========================================================================
// B0.5 — /workspaces canonical
// ===========================================================================

describe("Phase G0 (B0.5) — /workspaces canonical frontend route", () => {
  it("/workspaces page exists and mounts WorkspaceAdministrationHome", () => {
    expect(WORKSPACES_PAGE).toContain("WorkspaceAdministrationHome");
    expect(WORKSPACES_PAGE).toMatch(/<WorkspaceAdministrationHome\s*\/>/);
  });

  it("/workspaces page is wrapped in PageRouteGate with the admin.teams route id", () => {
    expect(WORKSPACES_PAGE).toContain("PageRouteGate");
    expect(WORKSPACES_PAGE).toContain('routeId="admin.teams"');
  });

  it("/workspaces page mounts the operational breadcrumb", () => {
    expect(WORKSPACES_PAGE).toContain("OperationalBreadcrumb");
  });

  it("the workspace administration view stays at /workspaces; /teams is NOT redirected away", () => {
    // Phase HOME-DATA-OWNERSHIP — the /teams → /workspaces redirect was
    // REMOVED (it shadowed the self-serve /teams landing and blanked
    // Home's "Invite a teammate" for personal-space users). The admin
    // view remains at /workspaces, gate intact.
    expect(NEXT_CONFIG).not.toMatch(
      /source:\s*["']\/teams["'][\s\S]{0,200}destination:\s*["']\/workspaces["']/,
    );
    expect(WORKSPACES_PAGE).toContain("WorkspaceAdministrationHome");
    expect(WORKSPACES_PAGE).toContain("PageRouteGate");
  });

  it("route registry's admin.teams entry now points at /workspaces", () => {
    expect(ROUTE_REGISTRY).toMatch(
      /id:\s*"admin\.teams"[\s\S]*?href:\s*"\/workspaces"/,
    );
  });

  it("topbar workspace switcher actions point at /workspaces", () => {
    expect(TOPBAR).toContain('href="/workspaces?action=create"');
    expect(TOPBAR).toContain('href="/workspaces?action=join"');
    expect(TOPBAR).toContain('href="/workspaces"');
    // Legacy /teams hrefs must not appear in the topbar surface.
    expect(stripComments(TOPBAR)).not.toMatch(/href="\/teams"/);
  });
});
