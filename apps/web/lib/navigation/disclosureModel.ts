/**
 * PHASE R5 — Canonical disclosure model.
 *
 * Defines the bounded vocabulary of disclosure tiers + a PURE
 * function that maps a route + experience mode + capabilities to a
 * tier. The tier is presentation metadata only — it drives data
 * attributes that CSS / R10 visual work consume.
 *
 * Tiers:
 *
 *   - "beginner"        Always primary or natural workspace surface.
 *                       The calm core of the product.
 *   - "advanced"        Operational depth that personal users see
 *                       behind "More / Advanced"; organization
 *                       operators see at their natural prominence.
 *   - "contextual"      Tool whose visibility is justified by the
 *                       current experience mode + a matching
 *                       capability (governance tools when the user
 *                       has GOVERNANCE_VIEW, reviewer tools when
 *                       the user has REVIEWER_OPS_VIEW, etc.).
 *   - "all-tools-only"  Not sidebar-eligible; reachable only via
 *                       All Tools + Command Palette + direct URL.
 *
 * Hard rules (pinned by R5 tests):
 *
 *   1. Pure synchronous function. No fetches. No I/O. No promises.
 *
 *   2. NO authorization decisions. The tier is presentation
 *      metadata; capability + active-space checks remain in
 *      `resolveRouteAccess`. The contextual tier only INFLUENCES
 *      visual prominence, never access.
 *
 *   3. Bounded tier set. New tiers require a CR-level review.
 *
 *   4. The function never claims a route should be removed from
 *      the UI entirely. Even `all-tools-only` routes are still
 *      discoverable in All Tools + Command Palette + via direct URL.
 */

import { PERSONAL_MODE_DEMOTION_ROUTE_IDS } from "../workspace-experience/personalDemotionRules";
import { CANONICAL_PRIMARY_ROUTE_IDS } from "./canonicalNavigationGroups";
import type { RouteDefinition } from "./routeRegistry";
import type { WorkspaceExperienceMode } from "../workspace-experience/types";

export const DISCLOSURE_TIERS = [
  "beginner",
  "advanced",
  "contextual",
  "all-tools-only",
] as const;

export type DisclosureTier = (typeof DISCLOSURE_TIERS)[number];

export interface DisclosureTierInput {
  readonly route: RouteDefinition;
  readonly mode: WorkspaceExperienceMode;
  readonly capabilities: Readonly<Record<string, boolean>>;
}

/**
 * Routes whose tier is contextual to a capability. The map's value
 * is the capability that, when present, lifts the route into the
 * natural advanced layer for the current experience mode.
 *
 * Routes NOT in this map fall back to the tier derived from the
 * registry + R1.5B demotion set + R2 canonical primary set.
 */
const CONTEXTUAL_CAPABILITY_BY_ROUTE: ReadonlyMap<string, string> = new Map([
  ["governance.hub", "GOVERNANCE_VIEW"],
  ["governance.policy", "GOVERNANCE_VIEW"],
  ["governance.retention", "GOVERNANCE_VIEW"],
  ["governance.lifecycle", "GOVERNANCE_VIEW"],
  ["governance.destruction", "GOVERNANCE_VIEW"],
  ["governance.analytics", "GOVERNANCE_VIEW"],
  ["governance.notifications", "GOVERNANCE_VIEW"],
  ["review.escalations", "REVIEWER_OPS_VIEW"],
  ["review.queue", "REVIEWER_OPS_VIEW"],
  ["review.sla", "REVIEWER_OPS_VIEW"],
]);

/**
 * Resolve the disclosure tier for a route under the current
 * experience mode + capability set.
 *
 * The function's decision order:
 *
 *   1. `!sidebarEligible`            → "all-tools-only"
 *   2. canonical primary set         → "beginner"
 *   3. PERSONAL mode + demotion set  → "advanced"
 *   4. contextual capability mapped  → "contextual"
 *   5. `advancedByDefault`           → "advanced"
 *   6. default                       → "beginner"
 *
 * The contextual tier (step 4) NEVER blocks access. It is a
 * presentation hint: surfaces may visually distinguish contextual
 * tools so users understand WHY they appear.
 */
export function getRouteDisclosureTier(
  input: DisclosureTierInput,
): DisclosureTier {
  const { route, mode, capabilities } = input;

  if (!route.sidebarEligible) return "all-tools-only";

  if (CANONICAL_PRIMARY_ROUTE_IDS.has(route.id)) return "beginner";

  if (
    mode === "PERSONAL" &&
    PERSONAL_MODE_DEMOTION_ROUTE_IDS.has(route.id)
  ) {
    return "advanced";
  }

  const contextualCap = CONTEXTUAL_CAPABILITY_BY_ROUTE.get(route.id);
  if (contextualCap !== undefined) {
    // Capability present → tool is operationally meaningful in this
    // context. We surface it as "contextual" rather than "advanced"
    // so the visual layer can hint why the route is visible.
    if (capabilities[contextualCap] === true) {
      return "contextual";
    }
  }

  if (route.advancedByDefault) return "advanced";

  return "beginner";
}

/**
 * Bounded tier weights for downstream sort/ordering needs. Lower
 * weight = more prominent. The R5 sidebar uses these only via the
 * upstream R2 pipeline (the disclosure resolver bucketed the items
 * already); the constants are exported for tests + future R10 work.
 */
export const DISCLOSURE_TIER_WEIGHT: Record<DisclosureTier, number> = {
  beginner: 0,
  contextual: 1,
  advanced: 2,
  "all-tools-only": 3,
};
