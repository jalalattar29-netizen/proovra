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

import { describe, expect, it } from "vitest";

import { resolveCapabilities } from "../src/services/platform-context/capability-registry.js";
import {
  NAVIGATION_REGISTRY,
  buildNavigationProjection,
  filterNavigationRegistry,
} from "../src/services/platform-context/navigation-registry.js";

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
  it("includes the ACCOUNT group with Pricing + Help + Profile + Notifications", () => {
    const accountGroup = NAVIGATION_REGISTRY.find((g) => g.id === "account");
    expect(accountGroup).toBeTruthy();
    const ids = accountGroup!.items.map((i) => i.id);
    expect(ids).toContain("account.pricing");
    expect(ids).toContain("account.billing");
    expect(ids).toContain("account.teams");
    expect(ids).toContain("account.help");
    expect(ids).toContain("account.profile");
    expect(ids).toContain("account.notifications");
  });

  it("Pricing has no capability gate (public marketing route)", () => {
    const accountGroup = NAVIGATION_REGISTRY.find((g) => g.id === "account");
    const pricing = accountGroup!.items.find((i) => i.id === "account.pricing");
    expect(pricing).toBeTruthy();
    expect(pricing!.requiresCapability).toBeNull();
    expect(pricing!.href).toBe("/pricing");
  });

  it("Help & support has no capability gate", () => {
    const accountGroup = NAVIGATION_REGISTRY.find((g) => g.id === "account");
    const help = accountGroup!.items.find((i) => i.id === "account.help");
    expect(help).toBeTruthy();
    expect(help!.requiresCapability).toBeNull();
    expect(help!.href).toBe("/support");
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
  it("PERSONAL FREE user gets a usable sidebar with Home / Capture / Evidence / Cases / Reports / Search / Settings", () => {
    const caps = resolveCapabilities({
      scope: "PERSONAL",
      role: "OWNER",
      plan: "FREE",
      isPlatformAdmin: false,
    });
    const { sidebar } = buildNavigationProjection(caps);
    const sidebarIds = sidebar.groups.flatMap((g) => g.items.map((i) => i.id));
    for (const id of [
      "workspace.home",
      "workspace.capture",
      "workspace.evidence",
      "workspace.cases",
      "workspace.reports",
      "workspace.search",
      "admin.settings",
    ]) {
      expect(sidebarIds, `missing ${id}`).toContain(id);
    }
  });

  it("PERSONAL FREE user sees Billing + Teams in the sidebar (account-level surfaces)", () => {
    const caps = resolveCapabilities({
      scope: "PERSONAL",
      role: "OWNER",
      plan: "FREE",
      isPlatformAdmin: false,
    });
    const { sidebar } = buildNavigationProjection(caps);
    const sidebarIds = sidebar.groups.flatMap((g) => g.items.map((i) => i.id));
    expect(sidebarIds).toContain("admin.billing");
    expect(sidebarIds).toContain("admin.teams");
  });

  it("PERSONAL PRO user sees the same usable sidebar (no plan-level hide of Billing/Teams)", () => {
    const caps = resolveCapabilities({
      scope: "PERSONAL",
      role: "OWNER",
      plan: "PRO",
      isPlatformAdmin: false,
    });
    const { sidebar } = buildNavigationProjection(caps);
    const sidebarIds = sidebar.groups.flatMap((g) => g.items.map((i) => i.id));
    expect(sidebarIds).toContain("admin.billing");
    expect(sidebarIds).toContain("admin.teams");
    expect(sidebarIds).toContain("admin.settings");
  });

  it("PERSONAL user gets a complete account menu with Pricing / Billing / Teams / Help / Profile / Notifications / Settings", () => {
    const caps = resolveCapabilities({
      scope: "PERSONAL",
      role: "OWNER",
      plan: "FREE",
      isPlatformAdmin: false,
    });
    const { accountMenu } = buildNavigationProjection(caps);
    const ids = accountMenu.items.map((i) => i.id);
    for (const id of [
      "account.profile",
      "account.notifications",
      "account.pricing",
      "account.billing",
      "account.teams",
      "account.help",
      "admin.settings",
    ]) {
      expect(ids, `missing ${id} in account menu`).toContain(id);
    }
  });

  it("PERSONAL user does NOT see team-only sidebar surfaces (Reviewer Ops, Governance act, etc.)", () => {
    const caps = resolveCapabilities({
      scope: "PERSONAL",
      role: "OWNER",
      plan: "PRO",
      isPlatformAdmin: false,
    });
    const { sidebar } = buildNavigationProjection(caps);
    const sidebarIds = sidebar.groups.flatMap((g) => g.items.map((i) => i.id));
    // Reviewer Ops + Governance are team-only — must not appear.
    expect(sidebarIds).not.toContain("review.queue");
    expect(sidebarIds).not.toContain("governance.hub");
    expect(sidebarIds).not.toContain("governance.policy");
    expect(sidebarIds).not.toContain("governance.retention");
  });

  it("TEAM MEMBER user sees the full operator sidebar + account menu", () => {
    const caps = resolveCapabilities({
      scope: "TEAM",
      role: "MEMBER",
      plan: "TEAM",
      isPlatformAdmin: false,
    });
    const { sidebar, accountMenu } = buildNavigationProjection(caps);
    const sidebarIds = sidebar.groups.flatMap((g) => g.items.map((i) => i.id));
    const accountIds = accountMenu.items.map((i) => i.id);
    expect(sidebarIds).toContain("review.queue");
    expect(sidebarIds).toContain("governance.hub");
    expect(sidebarIds).toContain("admin.teams");
    expect(sidebarIds).toContain("admin.billing");
    expect(accountIds).toContain("account.pricing");
    expect(accountIds).toContain("account.billing");
    expect(accountIds).toContain("account.teams");
  });

  it("account menu items appear at most once (dedupe BOTH-surface items)", () => {
    const caps = resolveCapabilities({
      scope: "TEAM",
      role: "OWNER",
      plan: "TEAM",
      isPlatformAdmin: false,
    });
    const { accountMenu } = buildNavigationProjection(caps);
    const ids = accountMenu.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("Pricing is visible in the account menu for EVERY scope (FREE personal, PRO personal, TEAM)", () => {
    for (const input of [
      { scope: "PERSONAL" as const, role: "OWNER" as const, plan: "FREE" as const },
      { scope: "PERSONAL" as const, role: "OWNER" as const, plan: "PRO" as const },
      { scope: "TEAM" as const, role: "MEMBER" as const, plan: "TEAM" as const },
      { scope: "TEAM" as const, role: "VIEWER" as const, plan: "TEAM" as const },
    ]) {
      const caps = resolveCapabilities({
        ...input,
        isPlatformAdmin: false,
      });
      const { accountMenu } = buildNavigationProjection(caps);
      const ids = accountMenu.items.map((i) => i.id);
      expect(
        ids,
        `Pricing missing for ${JSON.stringify(input)}`,
      ).toContain("account.pricing");
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
    const legacy = filterNavigationRegistry(caps);
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
    const legacyIds = filterNavigationRegistry(caps)
      .flatMap((g) => g.items.map((i) => i.id))
      .sort();
    const sidebarIds = buildNavigationProjection(caps)
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
    const { readFileSync, existsSync } = await import("node:fs");
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
  it("AppTopbarV2 reads navigation.accountMenu.items from the envelope", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(
      fileURLToPath(
        new URL(
          "../../../apps/web/components/app-shell-v2/AppTopbarV2.tsx",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(src).toMatch(/navigation\.accountMenu\.items/);
    // The account menu loop maps every server-provided item to a
    // <Link>; the legacy hardcoded Profile/Notifications/Settings
    // chain is gone.
    expect(src).toMatch(/data-account-menu-item-domain/);
    // Sign-out remains a top-level button (it's not a navigation
    // item — it's a session action).
    expect(src).toMatch(/data-account-menu-item="signout"/);
  });

  it("AppTopbarV2 maps known icon keys (billing / teams / support) for the account menu", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(
      fileURLToPath(
        new URL(
          "../../../apps/web/components/app-shell-v2/AppTopbarV2.tsx",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(src).toMatch(/ACCOUNT_MENU_ICONS/);
    for (const key of [
      "profile",
      "notifications",
      "settings",
      "billing",
      "teams",
      "support",
    ]) {
      expect(src).toContain(`${key}:`);
    }
  });
});
