/**
 * Phase 32.8B — Enterprise navigation rebuild + app shell cleanup.
 *
 * Source-contract regression suite. The frontend has no JS test
 * runner; every invariant below is encoded as a structural property
 * of the source text. The intent is to lock in the architecture
 * Phase 32.8A specified:
 *
 *  PART 1 — navigation-config is the data-driven source of truth
 *           (groups + items + metadata, NOT scattered JSX).
 *  PART 2 — canonical 5-group hierarchy (Account in topbar, not
 *           sidebar).
 *  PART 3 — Phase 37 persona future-proofing.
 *  PART 4 — Backward-compat redirects exist for every consolidated
 *           legacy route.
 *  PART 5 — Topbar workspace/account separation.
 *  PART 6 — Sidebar renderer consumes the canonical filter pipeline.
 *  PART 7 — No-regression invariants (no duplicates, no fake widgets,
 *           verification-first card preserved).
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

// Phase 38.6 — the canonical navigation source of truth is the route
// registry (`lib/navigation/routeRegistry.ts`). The legacy
// `lib/navigation-config.ts` (NavGroup/domain/persona shape) was
// deleted. Route/label/href invariants that routeRegistry still
// expresses are re-pointed here; assertions that were inherently about
// navigation-config's internal shape (NAV_DOMAINS, NavItem/NavGroup
// types, NAVIGATION_GROUPS, selectNavigationGroups, FUTURE_PERSONA_TAGS,
// futurePersonaTags/workspaceScope per-item metadata, DEPRECATED_ROUTE_
// REDIRECTS, sidebar-group role tuples) were removed with the file.
const NAV_CONFIG = readWeb("lib/navigation/routeRegistry.ts");
const SIDEBAR = readWeb("components/app-shell-v2/AppSidebarV2.tsx");
// Product-reset: AppTopbarV2 (dead duplicate topbar) deleted; contract
// retargeted to the live AppAccountToolbar.
const TOPBAR = readWeb("components/app-shell-v2/AppAccountToolbar.tsx");

// =============================================================================
// PART 2 — Canonical route labels + href invariants (routeRegistry)
// =============================================================================

describe("Phase 38.6 — canonical route registry labels + href invariants", () => {
  it("Workspace surfaces: Home, Capture, Evidence, Cases, Reports, Search (canonical labels)", () => {
    for (const label of [
      "Home",
      "Capture",
      "Evidence",
      "Cases",
      "Reports",
      "Search",
    ]) {
      expect(NAV_CONFIG).toMatch(new RegExp(`label:\\s*"${label}"`));
    }
  });

  it("no duplicate href between Home and Dashboard (no /dashboard alongside /home)", () => {
    // Guard the Phase 32.8A finding that /dashboard and /home both
    // existed. /dashboard now redirects; only /home is a canonical route.
    expect(NAV_CONFIG).not.toMatch(/href:\s*"\/dashboard"/);
    // /home appears exactly once in the registry.
    const homeMatches = NAV_CONFIG.match(/href:\s*"\/home"/g) ?? [];
    expect(homeMatches.length).toBe(1);
  });
});

// =============================================================================
// PART 4 — Backward-compat redirects (next.config.js)
// =============================================================================

describe("Phase 32.8B — backward-compat redirects for consolidated routes", () => {
  it("every consolidated legacy route has a backward-compat redirect (CR1 Part 2 folded into next.config.js)", () => {
    // Phase B SUPERSEDES the `/review → /reviewer-ops` redirect.
    // Phase C0 made `/review` the canonical Reviewer Console; the
    // CR1 redirect was bouncing operators away from it. Phase B's
    // contract test (`phase-b-ia-reset`) asserts the redirect is
    // gone. The rest of the CR1 redirect table is preserved.
    const cases: Array<{ source: string; target: string }> = [
      { source: "/dashboard", target: "/home" },
      // Phase 3 flipped the canonical platform-ops route: `/ops` now
      // redirects to `/operations` (previously the reverse).
      { source: "/ops", target: "/operations" },
      { source: "/security", target: "/security-center" },
      { source: "/locked", target: "/evidence?filter=locked" },
      { source: "/deleted", target: "/evidence?filter=deleted" },
      { source: "/archive", target: "/evidence?filter=archived" },
      { source: "/reviewer-ops/policy", target: "/governance/policy" },
    ];
    const cfg = readWeb("next.config.js");
    expect(cfg, "next.config.js must declare an async redirects() block").toMatch(
      /async\s+redirects\s*\(/,
    );
    for (const { source, target } of cases) {
      const escSource = source.replace(/\//g, "\\/");
      const escTarget = target.replace(/[/?=]/g, (m) => `\\${m}`);
      expect(
        cfg,
        `next.config.js must redirect ${source} → ${target}`,
      ).toMatch(
        new RegExp(
          `source:\\s*["']${escSource}["'][\\s\\S]{0,200}destination:\\s*["']${escTarget}["']`,
        ),
      );
    }
  });

  it("/governance/policy is the canonical policy surface (Phase 32.8A consolidation)", () => {
    const policy = readWeb("app/(app)/governance/policy/page.tsx");
    // Real page with the policy controls — NOT a redirect file.
    expect(policy).not.toMatch(/import\s+\{\s*redirect\s*\}\s+from\s+"next\/navigation"/);
    // Real controls visible:
    expect(policy).toMatch(/Step-up enforcement/);
    expect(policy).toMatch(/SLA overrides/);
    expect(policy).toMatch(/Reviewer inactivity/);
  });
});

// =============================================================================
// PART 5 — Topbar workspace/account separation
// =============================================================================

describe("Phase 32.8B — topbar persistent context chip + account menu separation", () => {
  // (P3/P4 domain remediation 2026-07-21) — the folded design is REVERSED
  // WITH CAUSE: an evidence-custody platform must keep the active operating
  // context unmistakable BEFORE custody-sensitive actions, so a PERSISTENT
  // context chip lives in the header and owns the ONE canonical switcher
  // panel. The account menu returns to account management plus a
  // "Switch workspace" ACTION that opens that same panel.
  it("renders the persistent context chip; the folded in-menu switcher is retired (P3/P4 domain remediation 2026-07-21)", () => {
    // The persistent chip exists with its bounded label slots.
    expect(TOPBAR).toMatch(/data-app-context-chip/); // (P3/P4 domain remediation 2026-07-21)
    expect(TOPBAR).toMatch(/data-context-chip-name/); // (P3/P4 domain remediation 2026-07-21)
    expect(TOPBAR).toMatch(/data-context-chip-scope-line/); // (P3/P4 domain remediation 2026-07-21)
    // The retired OLD standalone-menu attr stays gone (the chip wrapper is
    // data-app-context-chip, not the legacy data-app-topbar-workspace-menu)…
    expect(TOPBAR).not.toMatch(/data-app-topbar-workspace-menu/);
    // …and the retired FOLDED in-menu switcher attrs are gone too.
    expect(TOPBAR).not.toMatch(/data-account-menu-switcher/); // (P3/P4 domain remediation 2026-07-21)
    expect(TOPBAR).not.toMatch(/data-account-menu-workspace=/); // (P3/P4 domain remediation 2026-07-21)
    // The account menu keeps a workspaces SECTION — now carrying the
    // switch-workspace action, not an inline switcher.
    expect(TOPBAR).toMatch(/data-account-menu-section="workspaces"/);
  });

  it("renders a single account control (data-app-topbar-account)", () => {
    expect(TOPBAR).toMatch(/data-app-topbar-account/);
    expect(TOPBAR).toMatch(/data-app-topbar-account-menu/);
  });

  it("account menu surfaces the active workspace + per-option scope chips", () => {
    // Active-workspace badge in the menu header.
    expect(TOPBAR).toMatch(/data-account-menu-header-workspace/);
    // Scope chip on each workspace option ("Personal" or "Organization").
    expect(TOPBAR).toMatch(/data-workspace-scope-chip/);
  });

  // ENTERPRISE TENANT MODEL — the live toolbar consumes the canonical
  // envelope sections (personalSpace + organizations), not the legacy
  // `availableWorkspaces` list.
  it("workspace switcher lists workspaces from the canonical envelope", () => {
    expect(TOPBAR).toMatch(/envelope\?\.personalSpace/);
    expect(TOPBAR).toMatch(/envelope\?\.organizations/);
  });

  it("account menu is resolved on the client via resolveAccountMenu (settings/security/notifications/billing + org + help + signout, no Pricing)", () => {
    // account-menu refactor 2026-07-21 — the menu is now resolved by the
    // single canonical client resolver, not sourced from the server envelope's
    // navigation.accountMenu.items. Item data-keys are emitted with the
    // resolver item id.
    expect(TOPBAR).toMatch(/resolveAccountMenu/);
    expect(TOPBAR).not.toMatch(/navigation\.accountMenu\.items/);
    expect(TOPBAR).toMatch(/data-account-menu-item=\{item\.id\}/);
    expect(TOPBAR).toMatch(/data-account-menu-item="signout"/);
    // No Pricing entry anywhere in the toolbar.
    expect(TOPBAR).not.toMatch(/\/pricing/);
  });

  it("context chip owns the ONE canonical switcher panel; account menu links to it (P3/P4 domain remediation 2026-07-21)", () => {
    // Exactly ONE canonical panel — one resolver, one panel, two triggers,
    // never a second switcher implementation.
    const panels = TOPBAR.match(/data-app-context-switcher/g) ?? []; // (P3/P4 domain remediation 2026-07-21)
    expect(panels.length).toBe(1); // (P3/P4 domain remediation 2026-07-21)
    // Switching calls the platform-context switchWorkspace flow, never
    // navigating to a /workspaces admin page.
    expect(TOPBAR).toMatch(/handleSwitchWorkspace/);
    expect(TOPBAR).toMatch(/switchWorkspace\(workspaceId\)/); // (P3/P4 domain remediation 2026-07-21)
    // Groups: Personal / Your workspaces / per-organization (no Actions).
    expect(TOPBAR).toMatch(/data-context-group="PERSONAL"/); // (P3/P4 domain remediation 2026-07-21)
    expect(TOPBAR).toMatch(/data-context-group="OWNED"/); // (P3/P4 domain remediation 2026-07-21)
    expect(TOPBAR).toMatch(/data-context-group="ORGANIZATION"/); // (P3/P4 domain remediation 2026-07-21)
    expect(TOPBAR).not.toMatch(/data-context-group="ACTIONS"/); // (P3/P4 domain remediation 2026-07-21)
    // The account menu carries a switch-workspace ACTION that opens the
    // SAME panel (openSwitcher) — not an inline switcher.
    const acctIdx = TOPBAR.indexOf("data-app-topbar-account-menu");
    expect(acctIdx).toBeGreaterThan(-1);
    const acctSlice = TOPBAR.slice(acctIdx);
    expect(acctSlice).toMatch(/data-account-menu-item="switch-workspace"/); // (P3/P4 domain remediation 2026-07-21)
    expect(acctSlice).toMatch(/onClick=\{openSwitcher\}/); // (P3/P4 domain remediation 2026-07-21)
  });

  it("the switcher has no create/join/manage organization actions", () => {
    // The retired standalone chip carried an "Actions" group linking to
    // /workspaces?action=create|join and /workspaces. Those are gone from the
    // switcher (the /workspaces admin surface is reachable from the sidebar).
    expect(TOPBAR).not.toMatch(/\/workspaces\?action=/);
    expect(TOPBAR).not.toMatch(/Create organization/);
    expect(TOPBAR).not.toMatch(/Join organization/);
  });

  it("topbar no longer renders the deprecated horizontal duplicate-nav (Phase 32.8A finding)", () => {
    // The legacy TOP_NAV array (Workspace/Capture/Evidence/Cases/
    // Teams/Reports/Billing/Settings) duplicated the sidebar; the
    // refactor removed it.
    expect(TOPBAR).not.toMatch(/const TOP_NAV\s*=/);
  });
});

// =============================================================================
// PART 6 — Sidebar renderer consumes the canonical filter pipeline
// =============================================================================

describe("Phase 32.8B — sidebar renderer consumes the canonical filter pipeline", () => {
  // OBSOLETE — Phase 32.8 Foundation removed the sidebar's dependency
  // on a nav-config module + selectNavigationGroups; Phase 38.6 deleted
  // the legacy navigation-config file outright. The sidebar now renders
  // from the canonical ROUTE_REGISTRY. See
  // phase-32-8-foundation-platform-context.test.ts.
  it("does NOT define its own PRIMARY_NAV / OPERATIONS_NAV_BASE / GOVERNANCE_NAV_BASE / ADMIN_NAV arrays", () => {
    expect(SIDEBAR).not.toMatch(/const PRIMARY_NAV/);
    expect(SIDEBAR).not.toMatch(/const OPERATIONS_NAV_BASE/);
    expect(SIDEBAR).not.toMatch(/const GOVERNANCE_NAV_BASE/);
    expect(SIDEBAR).not.toMatch(/const ADMIN_NAV/);
  });

  it("renders groups via a single map over the canonical group tree", () => {
    expect(SIDEBAR).toMatch(/groups\.map\(\(group\)\s*=>/);
  });

  it("hydrates runtime badges from real runtime state — never fabricates a badge", () => {
    expect(SIDEBAR).toMatch(/runtime\.counts\.escalations > 0/);
    expect(SIDEBAR).toMatch(/governanceIncidents > 0/);
    expect(SIDEBAR).toMatch(/ariaLabel:\s*`Runtime \$\{runtime\.severity\.toLowerCase\(\)\}`/);
  });

});

// =============================================================================
// PART 7 — No-regression invariants
// =============================================================================

describe("Phase 32.8B — no-regression invariants", () => {
  it("renders the enterprise sidebar from ROUTE_REGISTRY with a support affordance", () => {
    // The legacy Verification-first trust card was intentionally removed
    // from the internal sidebar during the enterprise navigation
    // redesign; trust messaging now belongs in report/verify/package
    // surfaces, not persistent app navigation. This test pins the
    // CURRENT intended sidebar behaviour instead of the retired card.
    //
    // Sidebar still renders the Need help? / Contact support affordance.
    expect(SIDEBAR).toMatch(/Need help\?/);
    expect(SIDEBAR).toMatch(/Contact support/);
    // Sidebar nav is driven by the canonical ROUTE_REGISTRY (not the
    // legacy server-provided navigation envelope).
    expect(SIDEBAR).toMatch(/ROUTE_REGISTRY/);
    // And the sidebar never performs its own data fetching — there is no
    // apiFetch(...) call site in the component (comments referencing the
    // invariant are fine; an actual call would have a paren).
    expect(SIDEBAR).not.toMatch(/apiFetch\(/);
  });

  it("preserves the support link in the sidebar", () => {
    expect(SIDEBAR).toMatch(/href="\/support"/);
  });

  it("preserves backend-canonical capability gating (Phase 32.6.4 → 38.6)", () => {
    // PHASE 12 POINT 4 PASS D/G — repointed to the LIVE authority.
    //
    // This asserted a `roles?: ReadonlyArray<WorkspaceRole>` field inside
    // `lib/workspace-profile.ts` — a module with zero importers, deleted in
    // this pass. Phase 38.6 had already moved the real gate to the route
    // registry's `requiredCapabilities`, so the surviving pin described a
    // shape nothing consumed. The registry is asserted instead.
    const REGISTRY_SRC = readWeb("lib/navigation/routeRegistry.ts");
    expect(REGISTRY_SRC).toMatch(/requiredCapabilities/);
  });

  // OBSOLETE — Phase 38.6 removed navigation-config. Governance role
  // gating is no longer expressed as `roles: ["OWNER", "ADMIN"]`
  // sidebar-item tuples; the routeRegistry gates via
  // `requiredCapabilities` (e.g. GOVERNANCE_ACT / RETENTION_MANAGE) and
  // server-side enforcement. Covered by the route-authz tests.
  // OBSOLETE — Phase 38.6 removed navigation-config. Platform-admin
  // gating is no longer a `requiresPlatformAdmin: true` nav-item flag;
  // the routeRegistry entry `platform.admin` requires the
  // PLATFORM_ADMIN capability + PLATFORM_ADMIN active space.
  it("no #anchor href on any nav item (Phase 32.5 anchor-link cleanup preserved)", () => {
    // Settings IA refactor (2026-07-17): the unified /settings workspace
    // deliberately uses SECTION anchors for its merged child routes —
    // those are real in-page destinations with scrollspy navigation, not
    // the Phase 32.5 dead-anchor problem. Everything else stays banned.
    const anchors = (NAV_CONFIG.match(/href:\s*"[^"]*#[^"]*"/g) ?? []).filter(
      (a) => !a.includes('"/settings#'),
    );
    expect(anchors.length).toBe(0);
  });

  it("/governance/policy is the canonical Policy href (Phase 32.8A consolidation)", () => {
    // The canonical policy route points at /governance/policy, NOT the
    // legacy /reviewer-ops/policy.
    expect(NAV_CONFIG).toMatch(/href: "\/governance\/policy"/);
    // And the legacy path is NOT referenced as a route href.
    expect(NAV_CONFIG).not.toMatch(/href:\s*"\/reviewer-ops\/policy"/);
  });
});
