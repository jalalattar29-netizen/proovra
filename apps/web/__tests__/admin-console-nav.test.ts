/**
 * Admin control-plane navigation contract.
 *
 * ===========================================================================
 * WHAT THIS GUARDS, AND WHY THE SHAPE OF IT CHANGED
 * ===========================================================================
 * The list this replaces was FLAT — twenty pills in three groups, plus a "More
 * advanced (24)" disclosure — and it served two consumers. The breadcrumb, the
 * active-state resolver and the scope notice each derived their own answer from
 * their own copy of the paths, so a surface could be in the nav and absent from
 * the breadcrumb, or highlighted under the wrong parent, and nothing failed.
 *
 * `adminNavigation.ts` is now the single registry all five read. These
 * assertions are therefore about the REGISTRY, not about one renderer: what it
 * covers, what it cannot double-home, what it cannot leave dangling, and
 * whether its resolver returns the same answer the nav and the breadcrumb both
 * depend on.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ADMIN_CONTEXTUAL_ROUTES,
  ADMIN_NAV_SECTIONS,
  adminNavigationHrefs,
  isWorkspaceScopedAdminPath,
  resolveAdminLocation,
} from "../components/admin/adminNavigation";
import { ROUTE_REGISTRY } from "../lib/navigation/routeRegistry";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Map a concrete (non-dynamic) href to its (app) page file. */
function pageForHref(href: string): string {
  return resolve(APP_ROOT, `app/(app)${href}/page.tsx`);
}

const allChildren = ADMIN_NAV_SECTIONS.flatMap((s) =>
  s.children.map((c) => ({ section: s, child: c })),
);

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

test("primary navigation stays inside the 7–9 band", () => {
  // Nine is the ceiling for a reason: a primary navigation a reader has to
  // SCAN rather than recognise is the flat list again, one indirection later.
  assert.ok(
    ADMIN_NAV_SECTIONS.length >= 7 && ADMIN_NAV_SECTIONS.length <= 9,
    `expected 7–9 primary sections, found ${ADMIN_NAV_SECTIONS.length}`,
  );
});

test("every section lands on one of its OWN children", () => {
  // A section whose href is not one of its children lights up a section and
  // then highlights nothing beneath it — the state an operator reads as "the
  // click did not work".
  for (const section of ADMIN_NAV_SECTIONS) {
    assert.ok(
      section.children.some((c) => c.href === section.href),
      `section "${section.label}" lands on ${section.href}, which is not one of its children`,
    );
  }
});

test("no surface is homed under two sections", () => {
  const seen = new Map<string, string>();
  for (const { section, child } of allChildren) {
    const previous = seen.get(child.href);
    assert.equal(
      previous,
      undefined,
      `${child.href} is in both "${previous}" and "${section.label}" — a surface with two parents has no breadcrumb`,
    );
    seen.set(child.href, section.label);
  }
});

test("every entry declares a purpose and a scope", () => {
  for (const section of ADMIN_NAV_SECTIONS) {
    assert.ok(section.purpose.length > 0, `${section.id} must state its question`);
    for (const child of section.children) {
      assert.ok(child.purpose.length > 0, `${child.href} must state its purpose`);
      assert.ok(
        child.scope === "PLATFORM" || child.scope === "WORKSPACE",
        `${child.href} must declare what it administers`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// No dead ends
// ---------------------------------------------------------------------------

test("every navigation href resolves to a real page on disk", () => {
  for (const { child } of allChildren) {
    assert.ok(
      existsSync(pageForHref(child.href)),
      `"${child.label}" (${child.href}) must resolve to a page.tsx`,
    );
  }
});

test("every contextual detail names a parent that IS in the navigation", () => {
  const hrefs = new Set(adminNavigationHrefs());
  for (const ctx of ADMIN_CONTEXTUAL_ROUTES) {
    assert.ok(
      hrefs.has(ctx.parentHref),
      `${ctx.prefix} claims parent ${ctx.parentHref}, which is not in the navigation — its breadcrumb would lead nowhere`,
    );
    assert.ok(
      ADMIN_NAV_SECTIONS.some((s) => s.id === ctx.sectionId),
      `${ctx.prefix} claims section "${ctx.sectionId}", which does not exist`,
    );
  }
});

/**
 * THE COVERAGE GATE.
 *
 * Every `/admin/*` page on disk is either in the navigation or is a contextual
 * detail of something that is. A page that is neither is reachable by URL, by
 * the command palette, and by nothing else — and it renders with no active
 * section and no breadcrumb, which is the dead end this phase removes.
 */
test("every /admin page on disk is navigable or contextual", () => {
  const adminRoot = resolve(APP_ROOT, "app/(app)/admin");
  const pages: string[] = [];
  (function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry === "page.tsx") {
        pages.push(
          full
            .slice(resolve(APP_ROOT, "app/(app)").length)
            .replace(/\\/g, "/")
            .replace(/\/page\.tsx$/, ""),
        );
      }
    }
  })(adminRoot);

  const orphans = pages.filter((href) => {
    // A dynamic segment is matched by its contextual prefix.
    const concrete = href.replace(/\/\[[^\]]+\]/g, "/__id__");
    return resolveAdminLocation(concrete) === null;
  });

  assert.deepEqual(
    orphans,
    [],
    "these /admin pages belong to no section and are not a contextual detail of one — they render with no active navigation and no breadcrumb",
  );
});

// ---------------------------------------------------------------------------
// Active-state resolution — the same answer for nav and breadcrumb
// ---------------------------------------------------------------------------

test("longest href wins, so a child never lights up its parent instead", () => {
  // `/admin/evidence-ops/records` and `/admin/evidence-ops` are both prefixes
  // of the first. A shortest-first match highlighted the parent while the child
  // was open, which reads as "I did not go anywhere".
  const child = resolveAdminLocation("/admin/evidence-ops/records");
  assert.equal(child?.child?.href, "/admin/evidence-ops/records");
  const parent = resolveAdminLocation("/admin/evidence-ops");
  assert.equal(parent?.child?.href, "/admin/evidence-ops");
});

test("/admin matches exactly and never as a prefix", () => {
  assert.equal(resolveAdminLocation("/admin")?.section.id, "overview");
  // As a prefix it would light up Overview on every page in the console.
  assert.notEqual(resolveAdminLocation("/admin/customers")?.section.id, "overview");
});

test("a contextual detail resolves to its section and its parent list", () => {
  const loc = resolveAdminLocation("/admin/customers/9f3c1b22-0000-0000-0000-000000000000");
  assert.equal(loc?.section.id, "customers");
  assert.equal(loc?.contextual?.parentHref, "/admin/customers");
  // Without this an operator who reached a customer from search saw no active
  // section and had the browser Back button as their only route out.
  assert.ok(loc?.contextual, "a detail page must resolve to a parent list");
});

test("a path outside /admin resolves to nothing", () => {
  assert.equal(resolveAdminLocation("/operations"), null);
  assert.equal(resolveAdminLocation("/"), null);
  assert.equal(resolveAdminLocation(null), null);
});

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

test("scope comes from the registry, not from a second list of paths", () => {
  // Two lists of paths drift: a page could be promoted in the nav and left in
  // the tenant-scope list, or the reverse, and nothing would notice.
  assert.equal(isWorkspaceScopedAdminPath("/admin/identity"), true);
  assert.equal(isWorkspaceScopedAdminPath("/admin/platform/signers"), true);
  // Promoted in ADM-013 Phase 1: it no longer resolves a workspace at all.
  assert.equal(isWorkspaceScopedAdminPath("/admin/platform/observability"), false);
  assert.equal(isWorkspaceScopedAdminPath("/admin/customers"), false);
});

test("a contextual detail inherits the scope of the list it came from", () => {
  // A workspace-scoped list cannot produce a platform-scoped detail.
  assert.equal(isWorkspaceScopedAdminPath("/admin/identity/sessions"), true);
  assert.equal(isWorkspaceScopedAdminPath("/admin/users/__id__"), false);
});

test("the old two-list arrangement is gone", () => {
  const configPath = resolve(APP_ROOT, "components/admin/admin-nav-config.ts");
  assert.equal(
    existsSync(configPath),
    false,
    "admin-nav-config.ts still exists — its ADMIN_NAV_ITEMS and TENANT_SCOPED_ADMIN_PATHS are the two lists that could disagree",
  );
});

// ---------------------------------------------------------------------------
// Boundaries
// ---------------------------------------------------------------------------

test("navigation does not leak into tenant surfaces", () => {
  for (const href of adminNavigationHrefs()) {
    assert.ok(
      href.startsWith("/admin"),
      `${href} is outside the admin console and must not be in its navigation`,
    );
  }
  // `/tools` is the TENANT All-Tools index. It used to sit in this nav and led
  // the operator straight out of the platform console into the product.
  assert.ok(!adminNavigationHrefs().includes("/tools"));
});

test("the layout renders the navigation, the breadcrumb and the scope notice", () => {
  // Rendered ONCE, above the page boundary. Nineteen of the thirty-nine admin
  // pages rendered no console nav for exactly as long as rendering it was each
  // page's own job.
  const layout = readFileSync(
    resolve(APP_ROOT, "app/(app)/admin/layout.tsx"),
    "utf8",
  );
  assert.match(layout, /<AdminConsoleNav \/>/);
  assert.match(layout, /<AdminBreadcrumb \/>/);
  assert.match(layout, /AdminTenantScopeNotice/);
  assert.match(layout, /isWorkspaceScopedAdminPath/);
});

test("platform.provisioning is surfaced in the command palette + All Tools", () => {
  const route = (ROUTE_REGISTRY as ReadonlyArray<Record<string, unknown>>).find(
    (r) => r.id === "platform.provisioning",
  );
  assert.ok(route, "platform.provisioning must be registered");
  assert.equal(route!.href, "/admin/provisioning");
  assert.equal(route!.commandPaletteVisible, true, "must be command-palette visible");
  assert.equal(route!.allToolsVisible, true, "must be All Tools visible");
});

test("every navigation entry that names a routeId names a real one", () => {
  const ids = new Set(
    (ROUTE_REGISTRY as ReadonlyArray<{ id: string }>).map((r) => r.id),
  );
  for (const { child } of allChildren) {
    if (!child.routeId) continue;
    assert.ok(
      ids.has(child.routeId),
      `${child.href} names routeId "${child.routeId}", which is not in the canonical route registry`,
    );
  }
});
