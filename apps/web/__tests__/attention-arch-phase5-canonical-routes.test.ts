/**
 * ATTENTION ARCHITECTURE — PHASE 5 (2026-08-22).
 * CANONICAL ROUTES AND NAMING.
 *
 * ---------------------------------------------------------------------------
 * TWO ROUTES SWAPPED MEANING
 * ---------------------------------------------------------------------------
 *   BEFORE                                        AFTER
 *   /inbox          personal notifications    ->  permanent redirect
 *   /notifications  outbound email delivery   ->  THE personal notification
 *                   log with resend buttons       centre
 *   (nowhere)                                 ->  /settings/notifications/deliveries
 *                                                 now holds the delivery log
 *
 * Both names lied, in opposite directions. Someone looking for their
 * notifications found an email provider error log; the thing that actually
 * held their notifications was called an inbox and labelled "Operations
 * Center", which is the name of a completely different, SHARED surface.
 *
 * Nothing was lost and no shipped link broke: every old URL still resolves.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ROUTE_REGISTRY } from "../lib/navigation/routeRegistry";
import { getSurfaceTier, findSurfaceTierRule } from "../lib/surface/tiers";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function routeById(id: string) {
  const r = (ROUTE_REGISTRY as ReadonlyArray<{ id: string }>).find(
    (x) => x.id === id,
  );
  assert.ok(r, `route ${id} must be registered`);
  return r as unknown as {
    id: string;
    href: string;
    label: string;
    domain: string;
    requiredCapabilities: readonly string[];
  };
}

async function redirects() {
  const mod = (await import("../next.config.js" as string)) as unknown as {
    default: { redirects: () => Promise<unknown[]> };
  };
  return (await mod.default.redirects()) as ReadonlyArray<{
    source: string;
    destination: string;
    permanent: boolean;
  }>;
}

// ============================================================================
// 5.1 — the personal notification centre
// ============================================================================

test("/notifications is the canonical personal notification centre", () => {
  const route = routeById("account.notifications");
  assert.equal(route.href, "/notifications");
  assert.equal(route.label, "Notifications");
  // Notifications follow the PERSON, so the route is ACCOUNT-scoped: an
  // account-tier security event and an organization invitation both belong
  // here regardless of which workspace happens to be active.
  assert.equal(route.domain, "ACCOUNT");
});

test("it is no longer called an Operations Center", () => {
  const route = routeById("account.notifications");
  assert.ok(
    !/operations/i.test(route.label),
    "a personal feed must not carry the name of the shared workspace surface",
  );
});

test("the page exists at the canonical path", () => {
  assert.ok(
    existsSync(resolve(APP_ROOT, "app/(app)/notifications/page.tsx")),
    "/notifications must have a page",
  );
});

test("/inbox is a PERMANENT compatibility redirect", async () => {
  const rule = (await redirects()).find((r) => r.source === "/inbox");
  assert.ok(rule, "/inbox must still resolve — shipped emails point at it");
  assert.equal(rule!.destination, "/notifications");
  assert.equal(rule!.permanent, true);
});

test("there is ONE implementation behind both URLs", () => {
  // Two copies of a 1,300-line page is how a canonical route and its
  // compatibility route drift apart.
  const canonical = resolve(APP_ROOT, "app/(app)/notifications/page.tsx");
  const src = readFileSync(canonical, "utf8");
  assert.match(src, /export \{ default \} from "\.\.\/inbox\/page"/);
});

// ============================================================================
// 5.2 — the delivery log moved somewhere truthful
// ============================================================================

test("the outbound delivery log lives under settings", () => {
  const route = routeById("workspace.notification_deliveries");
  assert.equal(route.href, "/settings/notifications/deliveries");
  assert.ok(
    existsSync(
      resolve(APP_ROOT, "app/(app)/settings/notifications/deliveries/page.tsx"),
    ),
    "the delivery log page must exist at its new path",
  );
});

test("the delivery log kept its capability gate", () => {
  // It is an admin debugging surface and stays one. Moving it must not have
  // widened who can read other people's delivery failures.
  const route = routeById("workspace.notification_deliveries");
  assert.deepEqual(route.requiredCapabilities, ["SETTINGS_VIEW"]);
});

test("the old delivery-log URL still resolves", async () => {
  const rule = (await redirects()).find(
    (r) => r.source === "/notifications/deliveries",
  );
  assert.ok(rule, "/notifications/deliveries must redirect, not 404");
  assert.equal(rule!.destination, "/settings/notifications/deliveries");
});

test("the delivery log did NOT stay on /notifications", () => {
  const stillThere = (ROUTE_REGISTRY as ReadonlyArray<{ href: string; id: string }>)
    .filter((r) => r.href === "/notifications")
    .map((r) => r.id);
  assert.deepEqual(
    stillThere,
    ["account.notifications"],
    "exactly one route may own /notifications, and it is the personal centre",
  );
});

// ============================================================================
// Surface tiers follow the pages
// ============================================================================

test("both notification-centre paths are CORE — your own mail is not a plan feature", () => {
  assert.equal(getSurfaceTier("/notifications"), "CORE");
  assert.equal(getSurfaceTier("/inbox"), "CORE");
});

test("the delivery log's tier rule moved WITH the page", () => {
  // Left on the old prefix it would be dead code shadowed by the CORE rule,
  // and the surface it is meant to gate would have had no rule at all.
  const rule = findSurfaceTierRule("/settings/notifications/deliveries");
  assert.ok(rule, "the delivery log must have a tier rule at its new path");
  assert.equal(rule!.tier, "ENTERPRISE");
});

// ============================================================================
// 5.3 / 5.4 — the other two namespaces are unchanged
// ============================================================================

test("tenant Operations stays at /operations", () => {
  const route = routeById("workspace.operations");
  assert.equal(route.href, "/operations");
});

test("platform consoles stay under /admin/platform/*", () => {
  // /platform is a PUBLIC marketing route; the accepted Phase-4A decision put
  // the internal consoles under /admin/platform/* and this phase does not
  // reopen it.
  for (const id of [
    "platform.observability",
    "operations.readiness",
    "platform.runbooks",
  ]) {
    const route = routeById(id);
    assert.ok(
      route.href.startsWith("/admin/platform/"),
      `${id} must stay under /admin/platform/*, got ${route.href}`,
    );
  }
});

// ============================================================================
// Chain hygiene
// ============================================================================

test("no compatibility route points at another compatibility route", async () => {
  // A redirect whose destination is another redirect's source costs the
  // visitor two hops and becomes an actual loop the moment somebody adds a
  // rule in the other direction. Every alias points at a CANONICAL target.
  const rules = await redirects();
  const sources = new Set(rules.map((r) => r.source));
  const chained = rules
    .filter((r) => sources.has(r.destination.split("?")[0].split("#")[0]))
    .map((r) => `${r.source} -> ${r.destination}`);
  assert.deepEqual(chained, [], "redirect chain detected");
});

test("first-party links point at the canonical URL, not the alias", () => {
  const offenders: string[] = [];
  for (const rel of [
    "components/app-shell-v2/NotificationBell.tsx",
    "components/home-experience/home-view-model.ts",
    "lib/dashboard/dashboardModeRules.ts",
  ]) {
    const src = readFileSync(resolve(APP_ROOT, rel), "utf8");
    if (/href[:=]\s*["'`]\/inbox["'`]/.test(src)) offenders.push(rel);
  }
  assert.deepEqual(
    offenders,
    [],
    "these still mint traffic through the compatibility redirect",
  );
});
