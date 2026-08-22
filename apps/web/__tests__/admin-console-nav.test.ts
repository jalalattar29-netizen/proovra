/**
 * Admin Console navigation contract.
 *
 * Guards the routing fix: Enterprise Provisioning (and the platform ops
 * surfaces) must be reachable from the admin console nav — never a
 * direct-URL guess — and every admin nav item must route to a real page
 * (no dead tabs). Also pins that provisioning is surfaced in the command
 * palette / All Tools.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ADMIN_NAV_ITEMS } from "../components/admin/admin-nav-config";
import { ROUTE_REGISTRY } from "../lib/navigation/routeRegistry";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Map a concrete (non-dynamic) href to its (app) page file. */
function pageForHref(href: string): string {
  return resolve(APP_ROOT, `app/(app)${href}/page.tsx`);
}

test("admin nav exposes Enterprise Provisioning (no direct-URL guessing)", () => {
  const hrefs = ADMIN_NAV_ITEMS.map((i) => i.href);
  assert.ok(
    hrefs.includes("/admin/provisioning"),
    "admin nav must include /admin/provisioning",
  );
  const provItem = ADMIN_NAV_ITEMS.find((i) => i.href === "/admin/provisioning");
  assert.match(provItem!.label, /provision/i, "labelled as Provisioning");
});

test("admin nav exposes the platform operations surfaces", () => {
  const hrefs = ADMIN_NAV_ITEMS.map((i) => i.href);
  for (const href of ["/admin/platform/readiness", "/admin/platform/observability", "/tools"]) {
    assert.ok(hrefs.includes(href), `admin nav must include ${href}`);
  }
});

test("every admin nav item routes to a real page on disk (no dead tabs)", () => {
  for (const item of ADMIN_NAV_ITEMS) {
    assert.ok(
      existsSync(pageForHref(item.href)),
      `admin nav item "${item.label}" (${item.href}) must resolve to a page.tsx`,
    );
  }
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
