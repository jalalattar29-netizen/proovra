/**
 * PHASE R6 — Operational hubs orchestration types.
 *
 * Pure data types for the canonical hub orchestration layer. A hub
 * is a workflow-orchestration SURFACE, not a route collection. Each
 * hub answers "what operational work do I need to do now?" for its
 * domain (investigation / governance / reviewer / operations).
 *
 * The orchestrator is pure: no fetches, no auth predicates,
 * presentation hints only.
 */

export const HUB_IDS = [
  "investigation",
  "governance",
  "reviewer",
  "operations",
] as const;

export type HubId = (typeof HUB_IDS)[number];

/** A bounded contextual entry point — a shortcut to existing route. */
export interface HubQuickAction {
  readonly id: string;
  readonly label: string;
  readonly href: string;
  readonly intent: "primary" | "secondary";
}

/** A canonical hub definition. Bounded fields; bounded counts. */
export interface HubDefinition {
  readonly id: HubId;
  readonly title: string;
  readonly subtitle: string;
  /** Bounded ≤4 quick actions per hub. Each href is a registered route. */
  readonly quickActions: ReadonlyArray<HubQuickAction>;
  /**
   * Bounded list of route ids whose pages "live inside" this hub
   * conceptually. Used by tests + future surfaces; does NOT change
   * routing or access — those remain canonical.
   */
  readonly memberRouteIds: ReadonlyArray<string>;
  /** The page route id that the hub's primary landing page uses. */
  readonly landingRouteId: string;
}

export interface ResolveHubContextInput {
  readonly hubId: HubId;
  /**
   * Optional capability map — surfaces may pass this to filter
   * quick actions. The orchestrator does NOT remove actions for
   * unauthorized users (that would be a permission fork); it only
   * provides an optional `isReachableHint` map for visual hints.
   */
  readonly capabilities?: Readonly<Record<string, boolean>>;
}

export interface HubContextResult {
  readonly definition: HubDefinition;
  /** Bounded quick actions for this hub. Identical to definition.quickActions. */
  readonly quickActions: ReadonlyArray<HubQuickAction>;
}
