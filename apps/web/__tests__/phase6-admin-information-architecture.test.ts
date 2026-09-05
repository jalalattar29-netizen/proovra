/**
 * PHASE 6 — THE ADMIN INFORMATION ARCHITECTURE, HELD TO ITS OWN CLAIMS.
 *
 * Four properties, each of which was false at some point in this console's
 * history and each of which is cheap to break again:
 *
 *   1. every Admin page is reachable — through global navigation, or from a
 *      collection it is a detail of;
 *   2. every navigation destination is a real page;
 *   3. the Sidebar and the Command Palette agree about what exists and who
 *      may see it, because they read two different sources;
 *   4. every contextual detail has a breadcrumb parent, which is what makes a
 *      deep link a starting point rather than a dead end.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ADMIN_CONTEXTUAL_ROUTES,
  ADMIN_NAV_SECTIONS,
  resolveAdminLocation,
} from "../components/admin/adminNavigation";
import { ROUTE_REGISTRY } from "../lib/navigation/routeRegistry";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ADMIN_DIR = resolve(APP_ROOT, "app", "(app)", "admin");

/** Every Admin page that exists on disk, as a route path. */
function adminPagesOnDisk(dir = ADMIN_DIR, prefix = "/admin"): string[] {
  const out: string[] = [];
  if (existsSync(resolve(dir, "page.tsx"))) out.push(prefix);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("_")) continue; // colocated sections, not routes
    const segment = entry.name.startsWith("[") ? ":param" : entry.name;
    out.push(...adminPagesOnDisk(resolve(dir, entry.name), `${prefix}/${segment}`));
  }
  return out;
}

const navHrefs = new Set<string>();
for (const s of ADMIN_NAV_SECTIONS) for (const c of s.children) navHrefs.add(c.href);

test("the section hierarchy stays compact and every page is placed once", () => {
  const seen = new Map<string, string>();
  for (const s of ADMIN_NAV_SECTIONS) {
    assert.ok(s.children.length > 0, `${s.id}: a section with no pages is a label`);
    /*
     * Ten, not twelve. "Operations" reached thirteen entries — queue depth
     * beside signing keys beside cost reporting — which is a list to read
     * rather than a structure to navigate.
     */
    assert.ok(
      s.children.length <= 10,
      `${s.id} has ${s.children.length} entries; a section past ten is a list again`,
    );
    for (const c of s.children) {
      const prior = seen.get(c.href);
      assert.equal(prior, undefined, `${c.href} appears in both ${prior} and ${s.id}`);
      seen.set(c.href, s.id);
    }
  }
});

test("every navigation destination is a real page on disk", () => {
  const disk = new Set(adminPagesOnDisk());
  const missing = [...navHrefs].filter((h) => !disk.has(h));
  assert.deepEqual(missing, [], `navigation offers routes with no page:\n${missing.join("\n")}`);
});

test("every Admin page on disk is reachable — no orphans", () => {
  const unreachable: string[] = [];
  for (const page of adminPagesOnDisk()) {
    if (navHrefs.has(page)) continue;
    // A detail page is reachable from the collection it belongs to.
    const asPath = page.replace(/:param/g, "example");
    const location = resolveAdminLocation(asPath);
    if (location?.contextual) continue;
    unreachable.push(page);
  }
  assert.deepEqual(
    unreachable,
    [],
    `these Admin pages are in neither navigation nor a contextual collection:\n${unreachable.join("\n")}`,
  );
});

test("every contextual detail has a breadcrumb parent that is itself a real destination", () => {
  const broken: string[] = [];
  for (const c of ADMIN_CONTEXTUAL_ROUTES) {
    if (!navHrefs.has(c.parentHref)) broken.push(`${c.prefix} -> ${c.parentHref} (not in navigation)`);
    const section = ADMIN_NAV_SECTIONS.find((s) => s.id === c.sectionId);
    if (!section) broken.push(`${c.prefix} -> section "${c.sectionId}" does not exist`);
  }
  assert.deepEqual(broken, [], `contextual routes with a broken parent:\n${broken.join("\n")}`);
});

test("a detail path resolves as a DETAIL, so the breadcrumb names the record", () => {
  /*
   * `isDetail` is what makes the breadcrumb render the record crumb and the
   * return crumb. It was false for the runbook reader — the path matched the
   * catalog by prefix and no contextual rule claimed it — so the reader showed
   * the catalog's breadcrumb: no runbook named, and no way back.
   */
  const cases = [
    "/admin/customers/00000000-0000-4000-8000-000000000001",
    "/admin/users/00000000-0000-4000-8000-000000000002",
    "/admin/workspaces/00000000-0000-4000-8000-000000000003",
    "/admin/contact-sales/00000000-0000-4000-8000-000000000004",
    "/admin/demo-requests/00000000-0000-4000-8000-000000000005",
    "/admin/platform/runbooks/tsa-timestamp-failure",
  ];
  for (const path of cases) {
    const l = resolveAdminLocation(path);
    assert.ok(l, `${path}: no location resolved`);
    assert.equal(l!.isDetail, true, `${path}: does not resolve as a detail, so it renders its parent's breadcrumb`);
    assert.ok(l!.contextual, `${path}: no contextual rule, so there is no return crumb`);
    assert.ok(l!.contextual!.parentHref, `${path}: no return path`);
  }
});

test("the Sidebar and the Command Palette describe the same Admin console", () => {
  /*
   * They read two different sources — the sidebar reads ADMIN_NAV_SECTIONS,
   * the palette reads ROUTE_REGISTRY — so agreement is a property to assert,
   * not one to assume. A destination the sidebar offers and the registry has
   * never heard of cannot be searched for; the reverse is a page reachable
   * only by typing its name.
   */
  const registryAdmin = new Map<string, (typeof ROUTE_REGISTRY)[number]>();
  for (const r of ROUTE_REGISTRY) if (r.href.startsWith("/admin")) registryAdmin.set(r.href, r);

  const sidebarOnly = [...navHrefs].filter((h) => !registryAdmin.has(h));
  assert.deepEqual(
    sidebarOnly,
    [],
    `the sidebar offers destinations the palette cannot find:\n${sidebarOnly.join("\n")}`,
  );

  const registryOnly = [...registryAdmin.keys()].filter((h) => !navHrefs.has(h));
  for (const h of registryOnly) {
    // The only legitimate registry-only Admin entries are the contextual
    // details, which are deliberately absent from navigation.
    const isDetail = ADMIN_CONTEXTUAL_ROUTES.some((c) =>
      h.startsWith(c.prefix.replace(/\/$/, "/")),
    );
    assert.ok(isDetail, `${h} is in the route registry but in no navigation section`);
  }
});

test("no contextual detail is offered as a Command Palette destination", () => {
  /*
   * Their hrefs carry a literal `:id`. Offering one as a search result would
   * navigate an operator to a URL with a colon in it, which resolves to
   * nothing — a dead link reachable by typing "customer".
   */
  const offered = ROUTE_REGISTRY.filter(
    (r) => r.href.startsWith("/admin") && /:[a-zA-Z]/.test(r.href) && r.commandPaletteVisible,
  ).map((r) => r.href);
  assert.deepEqual(offered, [], `palette offers placeholder routes:\n${offered.join("\n")}`);
});
