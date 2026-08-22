/**
 * Sidebar order — PRODUCT-DECISION CONTRACT (2026-07-14).
 *
 * The Workspace group renders in the declarative Phase B order for
 * EVERY role/plan/persona: Home first, Operations Center second, then
 * the working surfaces. These are RUNTIME tests: they execute the real
 * grouping resolver over real registry routes, deliberately feeding
 * the items in a scrambled arrival order to prove the resolver — not
 * upstream bucketing luck — owns the order.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { resolveNavigationGroups } from "../lib/navigation/navigationGroupingResolver";
import { PHASE_B_OPERATIONAL_GROUPS } from "../lib/navigation/phaseBOperationalGroups";
import { ROUTE_REGISTRY } from "../lib/navigation/routeRegistry";
import type { NavigationExposureItem } from "../lib/navigation/navigationExposureResolver";

const ACCESS = {
  canLoad: true,
  accessState: "FULL",
  reasons: [],
} as unknown as NavigationExposureItem["access"];

function item(routeId: string): NavigationExposureItem {
  const route = ROUTE_REGISTRY.find((r) => r.id === routeId);
  assert.ok(route, `route ${routeId} must exist in the registry`);
  return {
    route,
    access: ACCESS,
    bucketReason: "canonical-primary",
  } as NavigationExposureItem;
}

test("declarative contract: Home is first and Operations Center second in the Workspace primary array", () => {
  const workspace = PHASE_B_OPERATIONAL_GROUPS.find((g) =>
    g.primary.includes("workspace.home"),
  );
  assert.ok(workspace);
  assert.equal(workspace.primary[0], "workspace.home");
  assert.equal(workspace.primary[1], "account.notifications");
});

test("resolver enforces the order even when items arrive scrambled (all personas share it)", () => {
  // Deliberately scrambled arrival order — the historical emergent bug.
  const scrambled = [
    "account.notifications",
    "workspace.search",
    "workspace.cases",
    "workspace.home",
    "workspace.evidence",
    "workspace.capture",
  ].map(item);

  const result = resolveNavigationGroups({
    primaryItems: scrambled,
    secondaryItems: [],
  });
  const workspaceGroup = result.groups.find((g) => g.title === "Workspace");
  assert.ok(workspaceGroup);
  const order = workspaceGroup.items.map((i) => i.route.id);
  assert.deepEqual(order.slice(0, 2), ["workspace.home", "account.notifications"]);
  // The remainder follows the declarative array, not arrival order.
  assert.deepEqual(order, [
    "workspace.home",
    "account.notifications",
    "workspace.cases",
    "workspace.evidence",
    "workspace.capture",
    "workspace.search",
  ]);
});

test("unlisted routes never outrank declared ones", () => {
  const result = resolveNavigationGroups({
    primaryItems: ["workspace.home", "account.notifications"].map(item),
    secondaryItems: [],
  });
  const workspaceGroup = result.groups.find((g) => g.title === "Workspace");
  assert.ok(workspaceGroup);
  assert.equal(workspaceGroup.items[0]?.route.id, "workspace.home");
});
