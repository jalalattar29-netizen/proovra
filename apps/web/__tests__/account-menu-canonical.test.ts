/**
 * CANONICAL ACCOUNT-MENU CONTRACTS (2026-07-21 refactor).
 *
 * ONE client resolver (`lib/navigation/accountMenu.ts`) decides EVERY item in
 * the top-bar account menu. These source-contract + pure-function assertions
 * pin the enterprise-canonical structure and the Phase 11 validation matrix:
 * no dead links, org visibility by membership (never plan), no public
 * /pricing entry, Help & Support external, exactly one switcher, one Billing
 * route shared by the menu and the sidebar.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveAccountMenu,
  type AccountMenuInput,
} from "../lib/navigation/accountMenu";
import type { CapabilityKey } from "../lib/platform-context/types";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(resolve(APP_ROOT, rel), "utf8");

// A fully-capable authenticated user; individual tests narrow from here.
const ALL_CAPS: Partial<Record<CapabilityKey, boolean>> = {
  ACCOUNT_SETTINGS_VIEW: true,
  ACCOUNT_BILLING_VIEW: true,
};

function input(overrides: Partial<AccountMenuInput> = {}): AccountMenuInput {
  return {
    capabilities: ALL_CAPS,
    isPlatformAdmin: false,
    activeSpace: { type: "PERSONAL", id: "personal-1" },
    personalSpace: { id: "personal-1", status: "active" },
    organizations: [],
    accountPlan: "FREE",
    ...overrides,
  };
}

const activeOrg = (id: string, name = id) =>
  ({
    id,
    name,
    displayName: name,
    role: "MEMBER" as const,
    membershipStatus: "ACTIVE" as const,
  });

function allHrefs(model: ReturnType<typeof resolveAccountMenu>): string[] {
  return [...model.account, ...model.organization, ...model.support].map(
    (i) => i.href,
  );
}

// ---------------------------------------------------------------------------
// 1. Section 1 — canonical order + destinations.
// ---------------------------------------------------------------------------

test("Section 1 is Account Settings · Security · Notification Preferences · Billing", () => {
  const m = resolveAccountMenu(input());
  assert.deepEqual(
    m.account.map((i) => i.id),
    [
      "account.settings",
      "account.security",
      "account.notifications",
      "account.billing",
    ],
  );
  assert.equal(m.account[0].href, "/settings");
  assert.equal(m.account[1].href, "/settings#security");
  assert.equal(m.account[2].href, "/settings#notifications");
  // Billing navigates INTERNALLY to the canonical /billing route — never the
  // public marketing pages.
  assert.equal(m.account[3].href, "/billing");
});

// ---------------------------------------------------------------------------
// 2. No Pricing & Plans — in ANY plan/role/org combination.
// ---------------------------------------------------------------------------

test("no Pricing & Plans entry, and no /pricing href, for any scope", () => {
  const scopes: AccountMenuInput[] = [
    input({ accountPlan: "FREE" }),
    input({ accountPlan: "PAYG" }),
    input({ accountPlan: "PRO" }),
    input({ accountPlan: "TEAM" }),
    input({
      accountPlan: "ENTERPRISE",
      activeSpace: { type: "ORGANIZATION", id: "org-1" },
      organizations: [activeOrg("org-1")],
    }),
    input({ isPlatformAdmin: true }),
  ];
  for (const s of scopes) {
    const m = resolveAccountMenu(s);
    const hrefs = allHrefs(m);
    assert.ok(!hrefs.includes("/pricing"), `no /pricing for ${s.accountPlan}`);
    assert.ok(
      !hrefs.some((h) => h.startsWith("/pricing")),
      `no /pricing* for ${s.accountPlan}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3. No application navigation duplicated into the menu (account-only).
// ---------------------------------------------------------------------------

test("menu never duplicates sidebar/application navigation", () => {
  const m = resolveAccountMenu(
    input({
      activeSpace: { type: "ORGANIZATION", id: "org-1" },
      organizations: [activeOrg("org-1")],
    }),
  );
  const banned = ["/workspaces", "/teams", "/cases", "/evidence", "/home", "/capture", "/operations"];
  const hrefs = allHrefs(m);
  for (const b of banned) {
    assert.ok(!hrefs.includes(b), `account menu must not link ${b}`);
  }
});

// ---------------------------------------------------------------------------
// 4. Help & Support — public, external (new tab).
// ---------------------------------------------------------------------------

test("Help & Support is /support and opens in a new tab (external)", () => {
  const m = resolveAccountMenu(input());
  assert.equal(m.support.length, 1);
  assert.equal(m.support[0].href, "/support");
  assert.equal(m.support[0].external, true);
});

// ---------------------------------------------------------------------------
// 5. Organization visibility — membership ONLY, never plan (Phase 4).
// ---------------------------------------------------------------------------

test("Organization Settings is HIDDEN for a personal-only user (0 orgs)", () => {
  const m = resolveAccountMenu(input({ organizations: [] }));
  assert.equal(m.organization.length, 0);
});

test("Organization Settings appears with ≥1 ACTIVE membership — on ANY plan", () => {
  for (const plan of ["FREE", "PAYG", "PRO", "TEAM"]) {
    const m = resolveAccountMenu(
      input({ accountPlan: plan, organizations: [activeOrg("org-1")] }),
    );
    assert.equal(
      m.organization.length,
      1,
      `org settings must show on ${plan} when a member`,
    );
    assert.equal(m.organization[0].href, "/organizations");
  }
});

test("a PRO personal user with NO org membership never sees org settings (plan does not grant it)", () => {
  const m = resolveAccountMenu(input({ accountPlan: "PRO", organizations: [] }));
  assert.equal(m.organization.length, 0);
});

test("a PENDING-only invitation does NOT surface org settings or a switchable org", () => {
  const m = resolveAccountMenu(
    input({
      organizations: [
        {
          id: "org-pending",
          name: "Pending Org",
          displayName: "Pending Org",
          role: null,
          membershipStatus: "PENDING",
        },
      ],
    }),
  );
  assert.equal(m.organization.length, 0);
  assert.equal(m.workspaces.organizations.length, 0);
});

// ---------------------------------------------------------------------------
// 6. Workspace switcher — Personal always leads; orgs are ACTIVE memberships.
// ---------------------------------------------------------------------------

test("switcher: Personal Space always present; ACTIVE orgs listed; active flag correct", () => {
  const m = resolveAccountMenu(
    input({
      activeSpace: { type: "ORGANIZATION", id: "org-2" },
      organizations: [activeOrg("org-1", "Acme"), activeOrg("org-2", "Globex")],
    }),
  );
  assert.ok(m.workspaces.personal, "personal space present");
  assert.equal(m.workspaces.personal!.kind, "PERSONAL");
  assert.equal(m.workspaces.personal!.active, false);
  assert.equal(m.workspaces.organizations.length, 2);
  assert.equal(m.workspaces.total, 3);
  const globex = m.workspaces.organizations.find((o) => o.id === "org-2");
  assert.equal(globex!.active, true, "active org is flagged");
});

test("invited-then-accepted user keeps Personal Space AND gains the org (never merged)", () => {
  // Before acceptance: personal only.
  const before = resolveAccountMenu(input({ organizations: [] }));
  assert.equal(before.workspaces.total, 1);
  assert.ok(before.workspaces.personal);
  // After acceptance (envelope now carries the ACTIVE org): both present.
  const after = resolveAccountMenu(input({ organizations: [activeOrg("org-1")] }));
  assert.ok(after.workspaces.personal, "Personal Space still present");
  assert.equal(after.workspaces.organizations.length, 1);
  assert.equal(after.workspaces.total, 2);
});

// ---------------------------------------------------------------------------
// 7. No dead links — every rendered link's destination actually loads.
// ---------------------------------------------------------------------------

test("Billing is gated on ACCOUNT_BILLING_VIEW — no dead link when the capability is absent", () => {
  const withCap = resolveAccountMenu(input());
  assert.ok(withCap.account.some((i) => i.id === "account.billing"));

  const withoutCap = resolveAccountMenu(
    input({ capabilities: { ACCOUNT_SETTINGS_VIEW: true } }),
  );
  assert.ok(
    !withoutCap.account.some((i) => i.id === "account.billing"),
    "billing hidden when the destination would not load",
  );
});

test("settings section hidden entirely when ACCOUNT_SETTINGS_VIEW is absent", () => {
  const m = resolveAccountMenu(
    input({ capabilities: { ACCOUNT_BILLING_VIEW: true } }),
  );
  assert.ok(!m.account.some((i) => i.href.startsWith("/settings")));
});

// ---------------------------------------------------------------------------
// 8. Toolbar renders PURELY from the resolver — one menu, one switcher.
// ---------------------------------------------------------------------------

test("AppAccountToolbar uses the canonical resolver, not the server account-menu projection", () => {
  const src = read("components/app-shell-v2/AppAccountToolbar.tsx");
  assert.match(src, /resolveAccountMenu/, "renders from the single resolver");
  assert.ok(
    !/navigation\.accountMenu\.items/.test(src),
    "no longer consumes the retired server account-menu projection",
  );
  assert.ok(!/CROSS_SURFACE_SIDEBAR_HREFS/.test(src), "no client-side strip hack");
});

test("there is exactly ONE workspace switcher — folded into the account menu", () => {
  const src = read("components/app-shell-v2/AppAccountToolbar.tsx");
  // The in-menu switcher exists…
  assert.match(src, /data-account-menu-switcher/, "switcher lives in the account menu");
  // …and the old standalone top-bar switcher dropdown is gone.
  assert.ok(
    !/data-app-topbar-workspace-menu/.test(src),
    "no separate standalone workspace-switcher dropdown",
  );
});

test("Help & Support renders as a real new-tab external anchor in the toolbar", () => {
  const src = read("components/app-shell-v2/AppAccountToolbar.tsx");
  assert.match(src, /target=\{item\.external \? "_blank" : undefined\}/);
  assert.match(src, /rel=\{item\.external \? "noopener noreferrer" : undefined\}/);
});

// ---------------------------------------------------------------------------
// 9. Billing — one canonical route, shared by menu + sidebar.
// ---------------------------------------------------------------------------

test("Billing is sidebar-eligible on the SAME /billing route (no duplicate route)", () => {
  const registry = read("lib/navigation/routeRegistry.ts");
  const billingStart = registry.indexOf('id: "account.billing"');
  const billingBlock = registry.slice(billingStart, billingStart + 900);
  assert.match(billingBlock, /href:\s*"\/billing"/, "canonical /billing route");
  assert.match(billingBlock, /sidebarEligible:\s*true/, "billing now sidebar-eligible");
});

// ---------------------------------------------------------------------------
// 10. Server projection retired — no duplicated account-menu logic.
// ---------------------------------------------------------------------------

test("server navigation registry no longer projects account-menu items or /pricing", () => {
  const registry = read(
    "../../services/api/src/services/platform-context/navigation-registry.ts",
  );
  assert.ok(!/account\.pricing/.test(registry), "account.pricing deleted (Phase 7)");
  assert.ok(!/ACCOUNT_GROUP,/.test(registry), "ACCOUNT_GROUP removed from the registry");
  assert.match(
    registry,
    /accountMenuItems:\s*PlatformContextNavItem\[\]\s*=\s*\[\]/,
    "account-menu projection emits an empty list",
  );
});
