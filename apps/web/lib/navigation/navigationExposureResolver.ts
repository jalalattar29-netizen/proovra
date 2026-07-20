/**
 * Navigation exposure resolver (deterministic, persona-free).
 *
 * (2026-07-20) Replaces the retired workflow/persona exposure resolver.
 * Given the canonical route registry + per-route access decisions,
 * buckets navigation items purely from registry metadata — no
 * personalization input:
 *
 *   - primaryItems     — canonical-primary, sidebar-eligible
 *   - secondaryItems   — non-advanced, sidebar-eligible
 *   - moreAdvancedItems — advancedByDefault, sidebar-eligible
 *   - allToolsItems    — every reachable + allToolsVisible route
 *
 * HEADLINE GUARANTEES:
 *   1. Access decisions are upstream — this never changes `canLoad`.
 *   2. Every route with `canSeeNav: true` appears in at least one of
 *      `primaryItems / secondaryItems / moreAdvancedItems / allToolsItems`.
 *   3. `allToolsVisible` routes always land in `allToolsItems` when
 *      `canSeeNav: true`.
 */

import { CANONICAL_PRIMARY_ROUTE_IDS } from "./canonicalNavigationGroups";
import type { RouteAccessResult } from "./routeAccessResolver";
import type { RouteDefinition } from "./routeRegistry";

export type NavigationExposureInput = {
  /** Every registered route, paired with its access result. */
  routes: ReadonlyArray<{
    route: RouteDefinition;
    access: RouteAccessResult;
  }>;
};

export type NavigationExposureItem = {
  route: RouteDefinition;
  access: RouteAccessResult;
  bucketReason:
    | "canonical-primary"
    | "default-not-advanced"
    | "advanced-by-default"
    | "all-tools-only";
};

export type NavigationExposureResult = {
  primaryItems: ReadonlyArray<NavigationExposureItem>;
  secondaryItems: ReadonlyArray<NavigationExposureItem>;
  moreAdvancedItems: ReadonlyArray<NavigationExposureItem>;
  allToolsItems: ReadonlyArray<NavigationExposureItem>;
};

/** Bucket the routes. Pure function, deterministic from registry flags. */
export function resolveNavigationExposure(
  input: NavigationExposureInput,
): NavigationExposureResult {
  const primaryItems: NavigationExposureItem[] = [];
  const secondaryItems: NavigationExposureItem[] = [];
  const moreAdvancedItems: NavigationExposureItem[] = [];
  const allToolsItems: NavigationExposureItem[] = [];

  for (const entry of input.routes) {
    const { route, access } = entry;

    if (access.canSeeNav && route.allToolsVisible) {
      allToolsItems.push({ route, access, bucketReason: "all-tools-only" });
    }

    if (!access.canSeeNav) continue;
    if (!route.sidebarEligible) continue;

    if (CANONICAL_PRIMARY_ROUTE_IDS.has(route.id)) {
      primaryItems.push({ route, access, bucketReason: "canonical-primary" });
    } else if (route.advancedByDefault) {
      moreAdvancedItems.push({
        route,
        access,
        bucketReason: "advanced-by-default",
      });
    } else {
      secondaryItems.push({
        route,
        access,
        bucketReason: "default-not-advanced",
      });
    }
  }

  return { primaryItems, secondaryItems, moreAdvancedItems, allToolsItems };
}
