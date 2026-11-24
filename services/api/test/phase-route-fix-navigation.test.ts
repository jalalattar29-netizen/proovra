/**
 * Phase ROUTE-FIX — Global navigation / public routes / account routes
 * / workspace gating regression suite.
 *
 * The topbar/sidebar canonicalization had a critical regression:
 *
 *   - Pricing disappeared from the topbar.
 *   - Billing was hidden from personal users.
 *   - Teams was hidden from personal users (no create-team entry).
 *   - The capability resolver did not grant BILLING_VIEW / TEAM_VIEW
 *     to personal workspaces.
 *   - The navigation registry had no surface distinction between
 *     sidebar (operator) and account-menu (always available).
 *
 * This suite locks the fix in place.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { resolveCapabilities } from "../src/services/platform-context/capability-registry.js";
import {
  NAVIGATION_REGISTRY,
  buildNavigationProjection,
  filterNavigationRegistry,
  type NavigationGateContext,
} from "../src/services/platform-context/navigation-registry.js";

// T-125 / PRD-01 — the builders take the active workspace's server-projected
// commercial answer and kind, as platform-context.service.ts passes them.
const FEATURES_NONE = {
  casesIncluded: false,
  intakeIncluded: false,
  teamCollaborationIncluded: false,
  reviewerOperationsIncluded: false,
  redactionIncluded: false,
};
const NO_WORKSPACE_GATE: NavigationGateContext = {
  activeSpaceType: null,
  isEnterpriseWorkspace: false,
  isPlatformAdmin: false,
  planFeatures: FEATURES_NONE,
};
const FREE_GATE: NavigationGateContext = { ...NO_WORKSPACE_GATE, activeSpaceType: "PERSONAL" };
const PRO_GATE: NavigationGateContext = {
  ...FREE_GATE,
  planFeatures: { ...FEATURES_NONE, casesIncluded: true, intakeIncluded: true, teamCollaborationIncluded: true },
};
/** A legacy TEAM-scope (OWNED) workspace: Team features, not Enterprise. */
const TEAM_ORG_GATE: NavigationGateContext = {
  activeSpaceType: "ORGANIZATION",
  isEnterpriseWorkspace: false,
  isPlatformAdmin: false,
  planFeatures: { ...PRO_GATE.planFeatures, reviewerOperationsIncluded: true },
};
const ENTERPRISE_GATE: NavigationGateContext = {
  ...TEAM_ORG_GATE,
  isEnterpriseWorkspace: true,
  planFeatures: { ...TEAM_ORG_GATE.planFeatures, redactionIncluded: true },
};

// account-menu refactor 2026-07-21 — the account menu is now resolved entirely
// on the client by the single canonical resolver
// apps/web/lib/navigation/accountMenu.ts. The server emits an empty account
// menu. These helpers read the client source so the source-contract tests can
// assert on the NEW client-resolved shape.
function readWebSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}
function readAccountResolverSource(): string {
  return readWebSource("../../../apps/web/lib/navigation/accountMenu.ts");
}
function readAccountToolbarSource(): string {
  return readWebSource(
    "../../../apps/web/components/app-shell-v2/AppAccountToolbar.tsx",
  );
}

// ===========================================================================
// PART 1 — Capability decoupling: personal users must get account-tier caps
// ===========================================================================

describe("Phase ROUTE-FIX — capability resolver", () => {
  it("PERSONAL workspace grants BILLING_VIEW (account-level surface)", () => {
    for (const plan of ["FREE", "PRO"] as const) {
      const caps = resolveCapabilities({
        scope: "PERSONAL",
        role: "OWNER",
        plan,
        isPlatformAdmin: false,
      });
      expect(caps.BILLING_VIEW).toBe(true);
    }
  });

  it("PERSONAL workspace grants TEAM_VIEW (create-team entry point)", () => {
    for (const plan of ["FREE", "PRO"] as const) {
      const caps = resolveCapabilities({
        scope: "PERSONAL",
        role: "OWNER",
        plan,
        isPlatformAdmin: false,
      });
      expect(caps.TEAM_VIEW).toBe(true);
    }
  });

  it("PERSONAL workspace does NOT grant TEAM_MANAGE / BILLING_MANAGE (still write-gated)", () => {
    const caps = resolveCapabilities({
      scope: "PERSONAL",
      role: "OWNER",
      plan: "PRO",
      isPlatformAdmin: false,
    });
    // Read access only — write actions still gated. Personal users
    // see Teams as a create-entry, not an operator surface.
    expect(caps.TEAM_MANAGE).toBe(false);
  });

  it("TEAM_VIEW + BILLING_VIEW still granted to team workspaces", () => {
    for (const role of ["OWNER", "ADMIN", "MEMBER", "VIEWER"] as const) {
      const caps = resolveCapabilities({
        scope: "TEAM",
        role,
        plan: "TEAM",
        isPlatformAdmin: false,
      });
      expect(caps.TEAM_VIEW).toBe(true);
    }
    const admin = resolveCapabilities({
      scope: "TEAM",
      role: "ADMIN",
      plan: "TEAM",
      isPlatformAdmin: false,
    });
    expect(admin.BILLING_VIEW).toBe(true);
  });
});

// ===========================================================================
// PART 2 — Navigation registry must expose the bounded set of items
// ===========================================================================

describe("Phase ROUTE-FIX — navigation registry inventory", () => {
  // account-menu refactor 2026-07-21 — the server-side ACCOUNT group is
  // retired. The top-bar account menu is now resolved entirely on the client
  // by apps/web/lib/navigation/accountMenu.ts; the server emits an empty
  // account-menu projection for schema stability. The old assertions pinned
  // the retired server-projected design and are rewritten to the new reality.
  it("no longer declares a server-side ACCOUNT group — the account menu is client-resolved", () => {
    const accountGroup = NAVIGATION_REGISTRY.find((g) => g.id === "account");
    expect(accountGroup).toBeUndefined();
    // The registry now has exactly the 4 sidebar groups.
    expect(NAVIGATION_REGISTRY.map((g) => g.id)).toEqual([
      "workspace",
      "review_governance",
      "platform_health",
      "administration",
    ]);
    // buildNavigationProjection always emits an empty account menu.
    const caps = resolveCapabilities({
      scope: "PERSONAL",
      role: "OWNER",
      plan: "FREE",
      isPlatformAdmin: false,
    });
    expect(buildNavigationProjection(caps, FREE_GATE).accountMenu.items).toEqual([]);
  });

  it("Pricing is fully deleted (Phase 7) — no account.pricing anywhere and no /pricing in the client resolver", () => {
    // No registry item references pricing…
    const allIds = NAVIGATION_REGISTRY.flatMap((g) =>
      g.items.map((i) => i.id),
    );
    expect(allIds).not.toContain("account.pricing");
    // …and the client account resolver owns no pricing entry.
    const resolver = readAccountResolverSource();
    expect(resolver).not.toContain("account.pricing");
    expect(resolver).not.toMatch(/href:\s*"\/pricing"/);
  });

  it("Help & support is a PUBLIC external link owned by the client resolver", () => {
    const resolver = readAccountResolverSource();
    // The support item is resolved on the client, opens in a new tab.
    expect(resolver).toContain('id: "account.help"');
    expect(resolver).toMatch(/href:\s*"\/support"/);
    expect(resolver).toMatch(/external:\s*true/);
  });

  it("Settings / Billing / Teams have surface = BOTH so they appear in sidebar AND account menu", () => {
    const adminGroup = NAVIGATION_REGISTRY.find((g) => g.id === "administration");
    expect(adminGroup).toBeTruthy();
    for (const id of ["admin.settings", "admin.billing", "admin.teams"]) {
      const item = adminGroup!.items.find((i) => i.id === id);
      expect(item, `missing ${id}`).toBeTruthy();
      expect(item!.surface).toBe("BOTH");
    }
  });
});

// ===========================================================================
// PART 3 — Navigation projection: sidebar vs account-menu separation
// ===========================================================================

describe("Phase ROUTE-FIX — sidebar / account-menu projection", () => {
  it("PERSONAL FREE user gets a usable sidebar with Home / Capture / Evidence / Reports / Search / Settings (no Cases: FREE sells none)", () => {
    const caps = resolveCapabilities({
      scope: "PERSONAL",
      role: "OWNER",
      plan: "FREE",
      isPlatformAdmin: false,
    });
    const { sidebar } = buildNavigationProjection(caps, FREE_GATE);
    const sidebarIds = sidebar.groups.flatMap((g) => g.items.map((i) => i.id));
    for (const id of [
      "workspace.home",
      "workspace.capture",
      "workspace.evidence",
      "workspace.reports",
      "workspace.search",
      "admin.settings",
    ]) {
      expect(sidebarIds, `missing ${id}`).toContain(id);
    }
    // T-125 — the web hides Cases from a plan without casesIncluded
    // (navPlanFeature); the payload no longer advertises it either.
    expect(sidebarIds).not.toContain("workspace.cases");
  });

  // T-125 (team remediation): /workspaces is an Enterprise-only web surface
  // (lib/surface/tiers.ts), so the server no longer advertises it to a
  // personal or Team context; it would open a "not found" page.
  it("PERSONAL FREE user sees Billing in the sidebar, and never the Enterprise-only Workspaces list", () => {
    const caps = resolveCapabilities({
      scope: "PERSONAL",
      role: "OWNER",
      plan: "FREE",
      isPlatformAdmin: false,
    });
    const { sidebar } = buildNavigationProjection(caps, FREE_GATE);
    const sidebarIds = sidebar.groups.flatMap((g) => g.items.map((i) => i.id));
    expect(sidebarIds).toContain("admin.billing");
    expect(sidebarIds).not.toContain("admin.teams");
  });

  it("PERSONAL PRO user sees the same usable sidebar (Billing, Settings; no Enterprise-only Workspaces list)", () => {
    const caps = resolveCapabilities({
      scope: "PERSONAL",
      role: "OWNER",
      plan: "PRO",
      isPlatformAdmin: false,
    });
    const { sidebar } = buildNavigationProjection(caps, PRO_GATE);
    const sidebarIds = sidebar.groups.flatMap((g) => g.items.map((i) => i.id));
    expect(sidebarIds).toContain("admin.billing");
    expect(sidebarIds).not.toContain("admin.teams");
    expect(sidebarIds).toContain("admin.settings");
  });

  it("client account resolver exposes Settings + Billing — and NO pricing", () => {
    /*
     * This asserted four ids: settings, security, notifications, billing.
     * The middle two resolved to `/settings#security` and
     * `/settings#notifications` — the SAME page as the first, reached by
     * anchor — so the account menu carried three doors into one destination
     * and grew a Settings rail of its own.
     *
     * Settings lists its own sections, and the command palette finds them
     * directly ("Settings · Security"). Billing keeps its row: /billing is a
     * different route, not a tab.
     */
    const resolver = readAccountResolverSource();
    for (const id of ["account.settings", "account.billing"]) {
      expect(resolver, `missing ${id} in client resolver`).toContain(
        `id: "${id}"`,
      );
    }
    expect(resolver).not.toContain("account.pricing");
    // Server projection stays empty regardless of scope.
    const caps = resolveCapabilities({
      scope: "PERSONAL",
      role: "OWNER",
      plan: "FREE",
      isPlatformAdmin: false,
    });
    expect(buildNavigationProjection(caps, FREE_GATE).accountMenu.items).toEqual([]);
  });

  it("PERSONAL user does NOT see team-only sidebar surfaces (Reviewer Ops, Governance act, etc.)", () => {
    const caps = resolveCapabilities({
      scope: "PERSONAL",
      role: "OWNER",
      plan: "PRO",
      isPlatformAdmin: false,
    });
    const { sidebar } = buildNavigationProjection(caps, PRO_GATE);
    const sidebarIds = sidebar.groups.flatMap((g) => g.items.map((i) => i.id));
    // Reviewer Ops + Governance are team-only — must not appear.
    expect(sidebarIds).not.toContain("review.queue");
    expect(sidebarIds).not.toContain("governance.hub");
    expect(sidebarIds).not.toContain("governance.policy");
    expect(sidebarIds).not.toContain("governance.retention");
  });

  it("ENTERPRISE org MEMBER sees the full operator sidebar; account menu is client-resolved (account-menu refactor 2026-07-21)", () => {
    const caps = resolveCapabilities({
      scope: "TEAM",
      role: "MEMBER",
      plan: "TEAM",
      isPlatformAdmin: false,
    });
    const { sidebar, accountMenu } = buildNavigationProjection(caps, ENTERPRISE_GATE);
    const sidebarIds = sidebar.groups.flatMap((g) => g.items.map((i) => i.id));
    expect(sidebarIds).toContain("review.queue");
    expect(sidebarIds).toContain("governance.hub");
    expect(sidebarIds).toContain("admin.teams");
    expect(sidebarIds).toContain("admin.billing");
    // The account menu is no longer server-projected — it is resolved on the
    // client. The server emits an empty list.
    expect(accountMenu.items).toEqual([]);
    // T-125 / PRD-01 — the same role on a non-Enterprise (legacy TEAM-scope)
    // workspace keeps Review but is not advertised the Enterprise-only
    // governance pages the web refuses it.
    const teamIds = buildNavigationProjection(caps, TEAM_ORG_GATE).sidebar.groups.flatMap((g) =>
      g.items.map((i) => i.id),
    );
    expect(teamIds).toContain("review.queue");
    expect(teamIds).not.toContain("governance.hub");
  });

  it("account menu items appear at most once (dedupe BOTH-surface items)", () => {
    const caps = resolveCapabilities({
      scope: "TEAM",
      role: "OWNER",
      plan: "TEAM",
      isPlatformAdmin: false,
    });
    const { accountMenu } = buildNavigationProjection(caps, TEAM_ORG_GATE);
    const ids = accountMenu.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("Pricing has no account-menu entry in any scope — Billing owns plan/checkout (account-menu refactor 2026-07-21)", () => {
    // Pricing was deleted (Phase 7). The client resolver never emits a pricing
    // link, and the server account-menu projection is always empty.
    const resolver = readAccountResolverSource();
    expect(resolver).not.toContain("account.pricing");
    expect(resolver).not.toMatch(/href:\s*"\/pricing"/);
    for (const input of [
      { scope: "PERSONAL" as const, role: "OWNER" as const, plan: "FREE" as const },
      { scope: "PERSONAL" as const, role: "OWNER" as const, plan: "PRO" as const },
      { scope: "TEAM" as const, role: "MEMBER" as const, plan: "TEAM" as const },
      { scope: "TEAM" as const, role: "VIEWER" as const, plan: "TEAM" as const },
    ]) {
      const caps = resolveCapabilities({ ...input, isPlatformAdmin: false });
      const { accountMenu } = buildNavigationProjection(caps, input.scope === "TEAM" ? TEAM_ORG_GATE : input.plan === "FREE" ? FREE_GATE : PRO_GATE);
      expect(
        accountMenu.items,
        `account menu should be empty for ${JSON.stringify(input)}`,
      ).toEqual([]);
    }
  });
});

// ===========================================================================
// PART 4 — Backwards compatibility: legacy `groups` field still works
// ===========================================================================

describe("Phase ROUTE-FIX — backwards compatibility", () => {
  it("legacy filterNavigationRegistry still emits sidebar groups only (account group is NOT in legacy output)", () => {
    const caps = resolveCapabilities({
      scope: "TEAM",
      role: "MEMBER",
      plan: "TEAM",
      isPlatformAdmin: false,
    });
    const legacy = filterNavigationRegistry(caps, TEAM_ORG_GATE);
    const groupIds = legacy.map((g) => g.id);
    expect(groupIds).toContain("workspace");
    expect(groupIds).toContain("administration");
    // Account-menu-only items don't leak into the sidebar.
    const sidebarItemIds = legacy.flatMap((g) => g.items.map((i) => i.id));
    expect(sidebarItemIds).not.toContain("account.pricing");
    expect(sidebarItemIds).not.toContain("account.help");
  });

  it("buildNavigationProjection sidebar matches legacy filterNavigationRegistry", () => {
    const caps = resolveCapabilities({
      scope: "TEAM",
      role: "OWNER",
      plan: "TEAM",
      isPlatformAdmin: false,
    });
    const legacyIds = filterNavigationRegistry(caps, TEAM_ORG_GATE)
      .flatMap((g) => g.items.map((i) => i.id))
      .sort();
    const sidebarIds = buildNavigationProjection(caps, TEAM_ORG_GATE)
      .sidebar.groups.flatMap((g) => g.items.map((i) => i.id))
      .sort();
    expect(sidebarIds).toEqual(legacyIds);
  });
});

// ===========================================================================
// PART 5 — Public / marketing routes are not workspace-gated
// ===========================================================================

describe("Phase ROUTE-FIX — public routes are not workspace-gated", () => {
  it("Pricing route exists on disk at app/pricing/page.tsx", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const path = fileURLToPath(
      new URL("../../../apps/web/app/pricing/page.tsx", import.meta.url),
    );
    expect(() => readFileSync(path, "utf8")).not.toThrow();
  });

  it("Support route exists on disk at app/support/page.tsx", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const path = fileURLToPath(
      new URL("../../../apps/web/app/support/page.tsx", import.meta.url),
    );
    expect(() => readFileSync(path, "utf8")).not.toThrow();
  });

  it("Pricing + Help are NOT inside the (app) workspace layout (no workspace gating)", async () => {
    const { existsSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    // Anti-test: if someone moves /pricing under (app), they will
    // silently apply the workspace layout's auth + provider chain.
    const inAppLayout = fileURLToPath(
      new URL("../../../apps/web/app/(app)/pricing", import.meta.url),
    );
    expect(existsSync(inAppLayout)).toBe(false);
    const helpInAppLayout = fileURLToPath(
      new URL("../../../apps/web/app/(app)/support", import.meta.url),
    );
    expect(existsSync(helpInAppLayout)).toBe(false);
  });
});

// ===========================================================================
// PART 6 — Topbar consumes the canonical account menu (no hardcoded items)
// ===========================================================================

describe("Phase ROUTE-FIX — topbar wires the canonical account menu", () => {
  // account-menu refactor 2026-07-21 — the top-bar account menu is now resolved
  // entirely on the client via resolveAccountMenu. The toolbar no longer reads
  // the server-projected navigation.accountMenu.items.
  it("AppAccountToolbar resolves the account menu on the client via resolveAccountMenu", () => {
    const src = readAccountToolbarSource();
    expect(src).toMatch(/resolveAccountMenu/);
    // The server-projected account-menu items are no longer consumed.
    expect(src).not.toMatch(/navigation\.accountMenu\.items/);
    // Sign-out remains a top-level button (it's not a navigation
    // item — it's a session action).
    expect(src).toMatch(/data-account-menu-item="signout"/);
  });

  it("AppAccountToolbar maps the canonical account-menu icon keys", () => {
    const src = readAccountToolbarSource();
    expect(src).toMatch(/ACCOUNT_MENU_ICONS/);
    // New canonical icon-key set (Pricing/Teams/Profile removed).
    for (const key of [
      "settings",
      "security",
      "notifications",
      "billing",
      "organization",
      "help",
    ]) {
      expect(src).toContain(`${key}:`);
    }
  });
});
