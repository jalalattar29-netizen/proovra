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
    // Phase 12 Point 4 (Pass E) — `contextOptions` is the canonical,
    // server-authorized switcher source and is now REQUIRED (the API
    // projects it unconditionally). `null` models "envelope not loaded
    // yet", not "older API"; tests that need workspaces override it.
    contextOptions: null,
    ...overrides,
  };
}

/** Canonical `contextOptions` carrying Personal + the given organizations. */
const ctxWithOrgs = (
  orgs: ReadonlyArray<{ id: string; name: string }>,
): NonNullable<AccountMenuInput["contextOptions"]> => ({
  personalSpace: {
    workspaceId: "personal-1",
    name: "Personal Space",
    role: "OWNER",
  },
  ownedWorkspaces: [],
  organizations: orgs.map((o) => ({
    organizationId: `parent-${o.id}`,
    organizationName: o.name,
    workspaces: [
      { workspaceId: o.id, workspaceName: o.name, workspaceRole: "MEMBER" },
    ],
  })),
});

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

test("Section 1 is Settings · Billing — one door into Settings, not three", () => {
  /*
   * This asserted four entries: Account settings, Security, Notification
   * preferences, Billing. The middle two were `/settings#security` and
   * `/settings#notifications` — the same page as the first, reached by anchor.
   *
   * One destination behind three rows made the account menu a second Settings
   * rail, and it grew with Settings: every new section was a candidate to
   * promote here. Settings already lists its own sections, and the command
   * palette already finds them directly ("Settings · Security").
   *
   * Billing stays: `/billing` is a different route, not a tab.
   */
  const m = resolveAccountMenu(input());
  assert.deepEqual(
    m.account.map((i) => i.id),
    ["account.settings", "account.billing"],
  );
  assert.equal(m.account[0].label, "Settings");
  assert.equal(m.account[0].href, "/settings");
  // Billing navigates INTERNALLY to the canonical /billing route — never the
  // public marketing pages.
  assert.equal(m.account[1].href, "/billing");
});

test("no account row is an anchor into a page another row already opens", () => {
  // The rule the collapse enforces: two rows must not resolve to one page.
  const m = resolveAccountMenu(input());
  const pages = m.account.map((i) => i.href.split("#")[0]);
  assert.equal(
    new Set(pages).size,
    pages.length,
    `two entries share a destination: ${pages.join(", ")}`,
  );
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

// (P3 domain remediation 2026-07-21) — the switcher is grouped Personal /
// Your workspaces (OWNED) / Organizations (grouped by parent org), built
// EXCLUSIVELY from the server-authorized `contextOptions`. Phase 12 Point 4
// (Pass E) deleted the legacy flat-`organizations` rollout fallback, so this
// invariant is now expressed through the canonical input.
const flatWorkspaces = (m: ReturnType<typeof resolveAccountMenu>) =>
  m.workspaces.organizations.flatMap((g) => g.workspaces);

test("switcher: Personal Space always present; ACTIVE orgs listed; active flag correct", () => {
  const m = resolveAccountMenu(
    input({
      activeSpace: { type: "ORGANIZATION", id: "org-2" },
      organizations: [activeOrg("org-1", "Acme"), activeOrg("org-2", "Globex")],
      contextOptions: ctxWithOrgs([
        { id: "org-1", name: "Acme" },
        { id: "org-2", name: "Globex" },
      ]),
    }),
  );
  assert.ok(m.workspaces.personal, "personal space present");
  assert.equal(m.workspaces.personal!.kind, "PERSONAL");
  assert.equal(m.workspaces.personal!.active, false);
  assert.equal(flatWorkspaces(m).length, 2);
  assert.equal(m.workspaces.total, 3);
  const globex = flatWorkspaces(m).find((o) => o.id === "org-2");
  assert.equal(globex!.active, true, "active org is flagged");
});

test("PHASE 10 §13.2 STEP 6: personalSpaceAllowed=false hides the Personal Space switcher entry", () => {
  const m = resolveAccountMenu(
    input({
      personalSpaceAllowed: false,
      organizations: [activeOrg("org-1", "Acme")],
      contextOptions: ctxWithOrgs([{ id: "org-1", name: "Acme" }]),
    }),
  );
  assert.equal(m.workspaces.personal, null, "personal space suppressed for a managed identity");
  assert.equal(flatWorkspaces(m).length, 1, "the org entry is unaffected");
  assert.equal(m.workspaces.total, 1);
});

test("PHASE 10 §13.2 STEP 6: personalSpaceAllowed absent/true is unaffected (STANDARD identity default)", () => {
  const absent = resolveAccountMenu(input({}));
  assert.ok(absent.workspaces.personal, "personal space present when the flag is absent");
  const explicitTrue = resolveAccountMenu(input({ personalSpaceAllowed: true }));
  assert.ok(explicitTrue.workspaces.personal, "personal space present when explicitly allowed");
});

test("invited-then-accepted user keeps Personal Space AND gains the org (never merged)", () => {
  // Before acceptance: personal only.
  const before = resolveAccountMenu(input({ organizations: [] }));
  assert.equal(before.workspaces.total, 1);
  assert.ok(before.workspaces.personal);
  // After acceptance (envelope now carries the ACTIVE org): both present.
  const after = resolveAccountMenu(
    input({
      organizations: [activeOrg("org-1")],
      contextOptions: ctxWithOrgs([{ id: "org-1", name: "org-1" }]),
    }),
  );
  assert.ok(after.workspaces.personal, "Personal Space still present");
  assert.equal(flatWorkspaces(after).length, 1);
  assert.equal(after.workspaces.total, 2);
});

test("P3: server contextOptions groups OWNED under 'Your workspaces' — never as Organizations", () => {
  const m = resolveAccountMenu(
    input({
      contextOptions: {
        personalSpace: {
          workspaceId: "personal-1",
          name: "Personal Space",
          role: "OWNER",
        },
        ownedWorkspaces: [
          { workspaceId: "owned-1", name: "My PRO workspace", role: "OWNER" },
        ],
        organizations: [
          {
            organizationId: "org-A",
            organizationName: "Acme Corp",
            workspaces: [
              {
                workspaceId: "ws-A1",
                workspaceName: "Acme Investigations",
                workspaceRole: "MEMBER",
              },
            ],
          },
        ],
      },
    }),
  );
  // Self-service owned workspace: kind OWNED, in the owned group.
  assert.equal(m.workspaces.owned.length, 1);
  assert.equal(m.workspaces.owned[0].kind, "OWNED");
  assert.equal(m.workspaces.owned[0].label, "My PRO workspace");
  // Enterprise workspace: grouped under its named organization.
  assert.equal(m.workspaces.organizations.length, 1);
  assert.equal(m.workspaces.organizations[0].organizationName, "Acme Corp");
  assert.equal(m.workspaces.organizations[0].workspaces[0].kind, "ORGANIZATION");
  // The owned workspace never leaks into the Organizations group.
  assert.ok(
    !flatWorkspaces(m).some((w) => w.id === "owned-1"),
    "OWNED workspace must not appear under Organizations",
  );
  assert.equal(m.workspaces.total, 3);
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

// (P3/P4 domain remediation 2026-07-21) — ARCHITECTURE DECISION REVERSED
// with cause: for an evidence-custody platform the active context must be
// unmistakable BEFORE custody-sensitive actions, so the switcher is now a
// PERSISTENT visible context chip owning ONE canonical panel. The account
// menu keeps a "Switch workspace" ACTION that opens that same panel — one
// resolver, one panel, two triggers, never a second implementation.
test("there is exactly ONE workspace switcher — a persistent chip + one canonical panel", () => {
  const src = read("components/app-shell-v2/AppAccountToolbar.tsx");
  // The persistent context chip is always visible…
  assert.match(src, /data-app-context-chip/, "persistent context chip present");
  // …owning the single canonical switcher panel…
  const panels = src.match(/data-app-context-switcher/g) ?? [];
  assert.equal(panels.length, 1, "exactly one switcher panel");
  // …grouped Personal / Your workspaces / Organizations…
  assert.match(src, /data-context-group="PERSONAL"/);
  assert.match(src, /data-context-group="OWNED"/);
  assert.match(src, /data-context-group="ORGANIZATION"/);
  assert.match(src, /Your workspaces/);
  // …and the account menu triggers the SAME panel (no inline second
  // switcher implementation).
  assert.match(src, /data-account-menu-item="switch-workspace"/);
  assert.ok(
    !/data-account-menu-switcher/.test(src),
    "no inline in-menu switcher implementation remains",
  );
});

test("switching guards dirty work and lands record-scoped routes safely", () => {
  const src = read("components/app-shell-v2/AppAccountToolbar.tsx");
  assert.match(src, /getDirtyWorkLabels\(\)/, "dirty-work registry consulted");
  // In-panel accessible confirmation (repo bans raw window.confirm).
  assert.match(src, /data-context-switch-confirm/, "in-panel confirmation");
  assert.match(src, /Switch anyway/, "explicit proceed action");
  assert.match(src, /Stay here/, "explicit cancel action");
  assert.ok(!/window\.confirm/.test(src), "no raw window.confirm");
  assert.match(src, /RECORD_SCOPED_ROUTE/, "record-scoped routes redirected");
  assert.match(src, /router\.push\("\/home"\)/, "safe landing route");
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
