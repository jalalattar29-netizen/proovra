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

const NAV_CONFIG = readWeb("lib/navigation-config.ts");
const SIDEBAR = readWeb("components/app-shell-v2/AppSidebarV2.tsx");
const TOPBAR = readWeb("components/app-shell-v2/AppTopbarV2.tsx");

// =============================================================================
// PART 1 — navigation-config is the data-driven source of truth
// =============================================================================

describe("Phase 32.8B — navigation-config is the data-driven source of truth", () => {
  it("exports a canonical NAV_DOMAINS catalog covering all 5 domains", () => {
    expect(NAV_CONFIG).toMatch(
      /export const NAV_DOMAINS\s*=\s*\[\s*"WORKSPACE",\s*"REVIEW_GOVERNANCE",\s*"PLATFORM_HEALTH",\s*"ADMINISTRATION",\s*"ACCOUNT",\s*\]\s*as const/,
    );
  });

  it("exports a bounded NavWorkspaceScope (PERSONAL / TEAM / BOTH)", () => {
    expect(NAV_CONFIG).toMatch(
      /export const NAV_WORKSPACE_SCOPES\s*=\s*\[\s*"PERSONAL"\s*,\s*"TEAM"\s*,\s*"BOTH"\s*,?\s*\]\s*as const/,
    );
  });

  it("exports a structured NavItem type with all required metadata fields", () => {
    // Every metadata field required for Phase 37 persona filtering
    // must be in the NavItem type definition.
    for (const field of [
      "id",
      "label",
      "href",
      "iconKey",
      "domain",
      "workspaceScope",
      "visibility",
      "futurePersonaTags",
      "badgeKey",
      "deprecated",
    ]) {
      expect(NAV_CONFIG, `NavItem missing required metadata field ${field}`)
        .toMatch(new RegExp(`${field}[\\?]?:`));
    }
  });

  it("exports a NavGroup type with id, title, domain, order, items", () => {
    expect(NAV_CONFIG).toMatch(/export type NavGroup\s*=\s*\{/);
    for (const field of ["id", "title", "domain", "order", "items"]) {
      expect(NAV_CONFIG).toMatch(new RegExp(`${field}[\\?]?:`));
    }
  });

  it("exports NAVIGATION_GROUPS as the single source of truth array", () => {
    expect(NAV_CONFIG).toMatch(
      /export const NAVIGATION_GROUPS\s*:\s*ReadonlyArray<NavGroup>\s*=/,
    );
  });

  it("exports selectNavigationGroups for role-aware filtering", () => {
    expect(NAV_CONFIG).toMatch(
      /export function selectNavigationGroups\(context:\s*\{/,
    );
  });

  it("exports an ACCOUNT_MENU_ITEMS catalog (topbar dropdown only)", () => {
    expect(NAV_CONFIG).toMatch(
      /export const ACCOUNT_MENU_ITEMS\s*:\s*ReadonlyArray<AccountMenuItem>\s*=/,
    );
  });
});

// =============================================================================
// PART 2 — Canonical 5-group hierarchy
// =============================================================================

describe("Phase 32.8B — canonical sidebar hierarchy (5 groups, Account in topbar)", () => {
  it("declares the four sidebar groups in canonical order: Workspace → Review & Governance → Platform Health → Administration", () => {
    const idxWorkspace = NAV_CONFIG.indexOf('title: "Workspace"');
    const idxReview = NAV_CONFIG.indexOf('title: "Review & Governance"');
    const idxPlatform = NAV_CONFIG.indexOf('title: "Platform Health"');
    const idxAdmin = NAV_CONFIG.indexOf('title: "Administration"');
    expect(idxWorkspace).toBeGreaterThan(-1);
    expect(idxReview).toBeGreaterThan(idxWorkspace);
    expect(idxPlatform).toBeGreaterThan(idxReview);
    expect(idxAdmin).toBeGreaterThan(idxPlatform);
  });

  it("Workspace group items: Home, Capture, Evidence, Cases, Reports, Search (Phase 32.8A canonical surfaces)", () => {
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

  it("Review & Governance group merges reviewer-ops + governance (Phase 32.8A)", () => {
    // Both reviewer-ops queue items AND governance preservation
    // items live under the unified Review & Governance group.
    //
    // NOTE: the governance.lifecycle label was rebaselined from
    // "Lifecycle" to "Governance Posture" to disambiguate it from
    // the workspace.evidence_lifecycle surface ("Lifecycle Operations").
    // See docs/architecture/workspace-surface-audit.md.
    for (const label of [
      "Reviewer Ops",
      "SLA",
      "Escalations",
      "Governance",
      "Governance Posture",
      "Policy",
      "Retention",
      "Destruction",
    ]) {
      expect(NAV_CONFIG).toMatch(new RegExp(`label:\\s*"${label}"`));
    }
  });

  it("Platform Health group is visually separated from Governance (Phase 32.8A boundary)", () => {
    for (const label of [
      "Operations Center",
      "Observability",
      "Runbooks",
      "Security Center",
    ]) {
      expect(NAV_CONFIG).toMatch(new RegExp(`label:\\s*"${label}"`));
    }
  });

  it("Administration group covers Workspaces, Billing, Integrations, Intake Links, Settings, Platform Admin", () => {
    // Phase B0.5 renamed the nav label from "Teams" to "Workspaces"
    // (workspace-operating-model-runbook.md). Phase 3 then canonicalised
    // the workspace-admin URL to `/workspaces`; the DB model name (`Team`)
    // is unchanged. This test asserts labels only.
    for (const label of [
      "Workspaces",
      "Billing",
      "Integrations",
      "Intake Links",
      "Settings",
      "Platform Admin",
    ]) {
      expect(NAV_CONFIG).toMatch(new RegExp(`label:\\s*"${label}"`));
    }
  });

  it("Account is in the topbar dropdown, NOT the sidebar (Phase 32.8A workspace/account separation)", () => {
    // No NAV_GROUP whose domain is ACCOUNT — Account lives in
    // ACCOUNT_MENU_ITEMS (topbar) only.
    const navigationGroupsBlock = NAV_CONFIG.match(
      /export const NAVIGATION_GROUPS[\s\S]*?\]\s*;/,
    );
    expect(navigationGroupsBlock).toBeTruthy();
    expect(navigationGroupsBlock![0]).not.toMatch(/ACCOUNT_GROUP/);
    // The ACCOUNT_MENU_ITEMS catalog DOES exist (separately, for the topbar).
    expect(NAV_CONFIG).toMatch(/export const ACCOUNT_MENU_ITEMS/);
  });

  it("no duplicate href between Workspace and Review & Governance (no Dashboard alongside Home)", () => {
    // Specifically guard the Phase 32.8A finding that /dashboard
    // and /home both existed. /dashboard now redirects; only
    // /home appears in the nav config.
    expect(NAV_CONFIG).not.toMatch(/href:\s*"\/dashboard"/);
    // /home appears exactly once as a nav item.
    const homeMatches = NAV_CONFIG.match(/href:\s*"\/home"/g) ?? [];
    expect(homeMatches.length).toBe(1);
  });

  it("sidebar group titles are unique (no duplicate Operations vs Operations Center as a group)", () => {
    const titleMatches =
      NAV_CONFIG.match(/title:\s*"([^"]+)"/g)?.map((m) =>
        m.replace(/title:\s*"/, "").replace(/"$/, ""),
      ) ?? [];
    // Filter to the canonical 4 group titles; should appear once each.
    const groupTitles = titleMatches.filter((t) =>
      [
        "Workspace",
        "Review & Governance",
        "Platform Health",
        "Administration",
      ].includes(t),
    );
    expect(groupTitles.sort()).toEqual([
      "Administration",
      "Platform Health",
      "Review & Governance",
      "Workspace",
    ]);
  });
});

// =============================================================================
// PART 3 — Phase 37 persona future-proofing
// =============================================================================

describe("Phase 32.8B — Phase 37 persona future-proofing", () => {
  it("declares the bounded FUTURE_PERSONA_TAGS catalog (RESERVED for Phase 37)", () => {
    expect(NAV_CONFIG).toMatch(/export const FUTURE_PERSONA_TAGS/);
    // The list MUST include the personas Phase 37 plans to support.
    for (const persona of [
      "INDIVIDUAL_USER",
      "LAWYER",
      "INVESTIGATOR",
      "INSURANCE_REVIEWER",
      "JOURNALIST",
      "ENTERPRISE_ADMIN",
      "REVIEWER",
      "AUDITOR",
      "WORKSPACE_OWNER",
    ]) {
      expect(
        NAV_CONFIG,
        `FUTURE_PERSONA_TAGS missing ${persona}`,
      ).toMatch(new RegExp(`"${persona}"`));
    }
  });

  it("every NavItem declares a non-empty futurePersonaTags array", () => {
    // Find every futurePersonaTags occurrence and verify NONE
    // of them are an empty array (`[]`).
    const empty = NAV_CONFIG.match(/futurePersonaTags:\s*\[\s*\]/g) ?? [];
    expect(empty.length).toBe(0);
    // And at least 20 items declare the field (lower-bound sanity).
    const declared = NAV_CONFIG.match(/futurePersonaTags:\s*\[/g) ?? [];
    expect(declared.length).toBeGreaterThanOrEqual(20);
  });

  it("persona tags do NOT drive filtering today — only role/profile/platform-admin do", () => {
    // The selectNavigationGroups body must NOT reference
    // futurePersonaTags. Persona-aware filtering is Phase 37.
    const selectFnIdx = NAV_CONFIG.indexOf(
      "export function selectNavigationGroups",
    );
    expect(selectFnIdx).toBeGreaterThan(-1);
    const selectFnEnd = NAV_CONFIG.indexOf("\n}\n", selectFnIdx);
    const fn = NAV_CONFIG.slice(selectFnIdx, selectFnEnd);
    expect(fn).not.toMatch(/futurePersonaTags/);
  });

  it("workspaceScope is declared on every NavItem (Phase 32.8C ready)", () => {
    // The renderer doesn't filter by workspaceScope today, but
    // every item must declare it so the future filter has data.
    // Lower-bound sanity: at least 20 declarations.
    const declared = NAV_CONFIG.match(/workspaceScope:\s*"(PERSONAL|TEAM|BOTH)"/g) ?? [];
    expect(declared.length).toBeGreaterThanOrEqual(20);
  });
});

// =============================================================================
// PART 4 — Backward-compat redirects
// =============================================================================

describe("Phase 32.8B — backward-compat redirects for consolidated routes", () => {
  it("exports a canonical DEPRECATED_ROUTE_REDIRECTS map", () => {
    expect(NAV_CONFIG).toMatch(
      /export const DEPRECATED_ROUTE_REDIRECTS\s*=\s*\{/,
    );
  });

  const expectedRedirects: Record<string, string> = {
    "/dashboard": "/home",
    // Phase 3 canonicalised the platform-ops surface to `/operations`
    // (was `/operations → /ops`; now `/ops → /operations`) and removed
    // the `/review → /reviewer-ops` entry (`/review` is now canonical;
    // `/reviewer-ops → /review` lives in next.config.js).
    "/ops": "/operations",
    "/security": "/security-center",
    "/locked": "/evidence?filter=locked",
    "/deleted": "/evidence?filter=deleted",
    "/archive": "/evidence?filter=archived",
    "/reviewer-ops/policy": "/governance/policy",
  };

  it("includes every Phase 32.8A consolidated route", () => {
    for (const [from, to] of Object.entries(expectedRedirects)) {
      const escapedFrom = from.replace(/\//g, "\\/").replace(/\?/g, "\\?");
      const escapedTo = to.replace(/\//g, "\\/").replace(/\?/g, "\\?");
      expect(
        NAV_CONFIG,
        `DEPRECATED_ROUTE_REDIRECTS missing "${from}" → "${to}"`,
      ).toMatch(new RegExp(`"${escapedFrom}":\\s*"${escapedTo}"`));
    }
  });

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

describe("Phase 32.8B — topbar separates workspace context from account context", () => {
  it("renders a distinct workspace chip (data-app-topbar-workspace)", () => {
    expect(TOPBAR).toMatch(/data-app-topbar-workspace/);
    expect(TOPBAR).toMatch(/data-app-topbar-workspace-menu/);
  });

  it("renders a distinct account chip (data-app-topbar-account)", () => {
    expect(TOPBAR).toMatch(/data-app-topbar-account/);
    expect(TOPBAR).toMatch(/data-app-topbar-account-menu/);
  });

  it("workspace chip surfaces the canonical workspace metadata (name + scope + role)", () => {
    expect(TOPBAR).toMatch(/data-workspace-name/);
    expect(TOPBAR).toMatch(/data-workspace-scope-line/);
    // Scope chip on each workspace option ("Personal" or "Team").
    expect(TOPBAR).toMatch(/data-workspace-scope-chip/);
  });

  // Phase 32.8 Foundation — switcher now consumes
  // `envelope.availableWorkspaces` (server-resolved). The local
  // workspaceList state was removed.
  it("workspace switcher lists workspaces from the canonical envelope", () => {
    expect(TOPBAR).toMatch(/availableWorkspaces/);
    expect(TOPBAR).toMatch(/data-workspace-option/);
  });

  it("account dropdown consumes the canonical envelope account-menu items (Profile, Notifications, Pricing, Billing, Teams, Help, Settings) + Sign out", () => {
    // Phase ROUTE-FIX — the account menu is now sourced from the
    // canonical envelope's `navigation.accountMenu.items` rather
    // than being hardcoded in the topbar. The static `data-` keys
    // are emitted dynamically with the registry item id.
    expect(TOPBAR).toMatch(/navigation\.accountMenu\.items/);
    expect(TOPBAR).toMatch(/data-account-menu-item=\{item\.id\}/);
    expect(TOPBAR).toMatch(/data-account-menu-item="signout"/);
  });

  it("account dropdown does NOT include workspace switching (clean separation)", () => {
    // Locate the account menu JSX block specifically and verify
    // it does not include the workspace switcher hooks.
    const acctIdx = TOPBAR.indexOf('data-app-topbar-account-menu');
    expect(acctIdx).toBeGreaterThan(-1);
    // The account menu body ends at the next </div> or </button>
    // closing the menu container. Take a generous slice.
    const acctSlice = TOPBAR.slice(acctIdx, acctIdx + 2400);
    expect(acctSlice).not.toMatch(/data-workspace-option/);
    expect(acctSlice).not.toMatch(/Switch workspace/);
  });

  it("workspace chip does NOT include account actions (clean separation)", () => {
    const wsIdx = TOPBAR.indexOf('data-app-topbar-workspace-menu');
    expect(wsIdx).toBeGreaterThan(-1);
    const wsSlice = TOPBAR.slice(wsIdx, wsIdx + 2400);
    expect(wsSlice).not.toMatch(/data-account-menu-item/);
    expect(wsSlice).not.toMatch(/Sign out/);
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
  // OBSOLETE — Phase 32.8 Foundation: sidebar no longer imports
  // navigation-config or calls selectNavigationGroups. It renders
  // the server-resolved navigation tree from
  // `envelope.navigation.groups`. See
  // phase-32-8-foundation-platform-context.test.ts.
  it.skip("imports from lib/navigation-config (not inline nav arrays)", () => {});

  it("does NOT define its own PRIMARY_NAV / OPERATIONS_NAV_BASE / GOVERNANCE_NAV_BASE / ADMIN_NAV arrays", () => {
    expect(SIDEBAR).not.toMatch(/const PRIMARY_NAV/);
    expect(SIDEBAR).not.toMatch(/const OPERATIONS_NAV_BASE/);
    expect(SIDEBAR).not.toMatch(/const GOVERNANCE_NAV_BASE/);
    expect(SIDEBAR).not.toMatch(/const ADMIN_NAV/);
  });

  it.skip("calls selectNavigationGroups exactly once with the visibility context", () => {});

  it("renders groups via a single map over the canonical group tree", () => {
    expect(SIDEBAR).toMatch(/groups\.map\(\(group\)\s*=>/);
  });

  it("hydrates runtime badges from real runtime state — never fabricates a badge", () => {
    expect(SIDEBAR).toMatch(/runtime\.counts\.escalations > 0/);
    expect(SIDEBAR).toMatch(/governanceIncidents > 0/);
    expect(SIDEBAR).toMatch(/ariaLabel:\s*`Runtime \$\{runtime\.severity\.toLowerCase\(\)\}`/);
  });

  it.skip("still resolves role from useActiveWorkspaceId fallback (Phase 32.6.4 preserved)", () => {});
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

  it("preserves backend-canonical role enum surface (Phase 32.6.4)", () => {
    // The visibility predicate still accepts the bounded role enum.
    // The shape lives in workspace-profile.ts (SidebarVisibility);
    // the nav config imports + uses it.
    const PROFILE_SRC = readWeb("lib/workspace-profile.ts");
    expect(PROFILE_SRC).toMatch(/roles\?:\s*ReadonlyArray<WorkspaceRole>/);
    // And the nav config consumes the imported SidebarVisibility type.
    expect(NAV_CONFIG).toMatch(/SidebarVisibility/);
  });

  it("never weakens governance role gating (OWNER/ADMIN remains required on policy/retention/destruction)", () => {
    // Each of these items declares the OWNER/ADMIN role gate.
    // We assert the literal tuple appears at LEAST three times
    // (once per gated item).
    const tuples = NAV_CONFIG.match(/roles:\s*\["OWNER",\s*"ADMIN"\]/g) ?? [];
    expect(tuples.length).toBeGreaterThanOrEqual(3);
  });

  it("Platform Admin entry requires platform admin (does NOT widen to MEMBER)", () => {
    // The Platform Admin nav item carries requiresPlatformAdmin: true.
    expect(NAV_CONFIG).toMatch(
      /label: "Platform Admin"[\s\S]{0,600}requiresPlatformAdmin:\s*true/,
    );
  });

  it("no #anchor href on any nav item (Phase 32.5 anchor-link cleanup preserved)", () => {
    const anchors = NAV_CONFIG.match(/href:\s*"[^"]*#[^"]*"/g) ?? [];
    expect(anchors.length).toBe(0);
  });

  it("/governance/policy is the canonical Policy href (Phase 32.8A consolidation)", () => {
    // The Policy nav item points at /governance/policy, NOT the
    // legacy /reviewer-ops/policy.
    expect(NAV_CONFIG).toMatch(
      /label: "Policy"[\s\S]{0,400}href: "\/governance\/policy"/,
    );
    // And the legacy path is NOT referenced as a sidebar href.
    expect(NAV_CONFIG).not.toMatch(/href:\s*"\/reviewer-ops\/policy"/);
  });
});
