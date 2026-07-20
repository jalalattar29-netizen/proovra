/**
 * PHASE R2 — Canonical navigation disclosure resolver.
 *
 * Pure transform. Takes a workflow-exposure result + workspace
 * experience and produces a REFINED exposure where:
 *
 *   1. The primary group is BOUNDED to `CANONICAL_PRIMARY_ROUTE_IDS`
 *      (R2 Part 1 — Home, Capture, Evidence, Cases, Reports, Search).
 *      Workflow-promoted non-canonical routes fall back to their
 *      domain group as `secondaryItems`.
 *
 *   2. The R1.5B `applyExperienceEmphasis` demotion is folded in so
 *      ORG-only routes move from primary/secondary into
 *      `moreAdvancedItems` for PERSONAL experience mode.
 *
 *   3. `allToolsItems` is preserved untouched — discoverability is
 *      never reduced by this resolver. Routes demoted out of root
 *      prominence remain reachable via All Tools, Command Palette,
 *      direct links, and search.
 *
 * The resolver carries NO authorization logic. Access decisions
 * remain in `resolveRouteAccess`; workflow bucketing remains in
 * `resolveNavigationExposure`; experience emphasis remains in
 * `resolveWorkspaceExperience`. R2 only adds the IA disclosure step.
 */

import { applyExperienceEmphasis } from "../workspace-experience/applyExperienceEmphasis";
import { CANONICAL_PRIMARY_ROUTE_IDS } from "./canonicalNavigationGroups";
import type {
  NavigationExposureItem,
  NavigationExposureResult,
} from "./navigationExposureResolver";

export interface NavigationDisclosureInput {
  readonly exposure: NavigationExposureResult;
  readonly demotionRouteIds: ReadonlySet<string>;
}

export interface NavigationDisclosureResult {
  /** Strictly the canonical primary route ids (bounded). */
  readonly primaryItems: ReadonlyArray<NavigationExposureItem>;
  /** Domain-organized; receives workflow-promoted non-canonical routes. */
  readonly secondaryItems: ReadonlyArray<NavigationExposureItem>;
  /** Advanced disclosure bucket; receives experience-mode demotions. */
  readonly moreAdvancedItems: ReadonlyArray<NavigationExposureItem>;
  /** All Tools — preserved untouched. */
  readonly allToolsItems: ReadonlyArray<NavigationExposureItem>;
  /** Diagnostic counters for tests + observability. */
  readonly stats: {
    readonly primaryBoundedCount: number;
    readonly primaryOverflowCount: number;
    readonly experienceDemotedCount: number;
  };
}

export function resolveNavigationDisclosure(
  input: NavigationDisclosureInput,
): NavigationDisclosureResult {
  const { exposure, demotionRouteIds } = input;

  // Step 1 — bound the primary group to the canonical 6 route ids.
  // Anything else workflow promoted to primary falls back into
  // secondary so it still renders in its domain group.
  const boundedPrimary: NavigationExposureItem[] = [];
  const primaryOverflow: NavigationExposureItem[] = [];
  for (const item of exposure.primaryItems) {
    if (CANONICAL_PRIMARY_ROUTE_IDS.has(item.route.id)) {
      boundedPrimary.push(item);
    } else {
      primaryOverflow.push(item);
    }
  }

  // Step 2 — apply experience-mode demotion (R1.5B's transform).
  // For PERSONAL mode, the 10-route ORG demotion set moves items
  // from primary/secondary → moreAdvanced. For ORG sub-modes, the
  // demotion set is empty and the transform is a no-op.
  const demoted = applyExperienceEmphasis({
    exposure: {
      ...exposure,
      primaryItems: boundedPrimary,
      // Place overflow at the END of secondary so the existing
      // domain ordering stays stable; the overflow joins its
      // natural home rather than displacing existing items.
      secondaryItems: [...exposure.secondaryItems, ...primaryOverflow],
    },
    demotionRouteIds,
  });

  return {
    primaryItems: demoted.primaryItems,
    secondaryItems: demoted.secondaryItems,
    moreAdvancedItems: demoted.moreAdvancedItems,
    allToolsItems: exposure.allToolsItems,
    stats: {
      primaryBoundedCount: boundedPrimary.length,
      primaryOverflowCount: primaryOverflow.length,
      experienceDemotedCount: demoted.demotedCount,
    },
  };
}
