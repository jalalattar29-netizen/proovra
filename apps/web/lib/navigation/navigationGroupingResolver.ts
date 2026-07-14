/**
 * PHASE R2 + PHASE G0 — Canonical navigation grouping resolver.
 *
 * Pure transform. Takes the refined disclosure result and builds the
 * bounded sidebar groups. Phase G0 (B.1) consolidates the older R2
 * "Primary workflows / Workspace / Operations / Governance &
 * Compliance" titles into the canonical Phase B hierarchy
 * (Workspace · Governance · Outputs · System) sourced from
 * `phaseBOperationalGroups.ts`.
 *
 * Rules:
 *
 *   1. The grouping is a named pure function consumable by tests and
 *      surfaces. NO authorization. NO disclosure. NO experience
 *      emphasis. Those happen upstream in the canonical pipeline.
 *
 *   2. Group membership is decided by `operationalGroupForRoute()`
 *      (the Phase B source-of-truth). When a route id is missing
 *      from the Phase B map, the route falls back to its domain
 *      bucket so a coverage regression doesn't silently disappear
 *      routes from the sidebar.
 *
 *   3. Group titles are sourced from `canonicalNavigationGroups.ts`
 *      so the bounded title vocabulary is enforced in one place.
 */

import {
  SIDEBAR_GROUP_GOVERNANCE,
  SIDEBAR_GROUP_OUTPUTS,
  SIDEBAR_GROUP_SYSTEM,
  SIDEBAR_GROUP_WORKSPACE,
} from "./canonicalNavigationGroups";
import {
  PHASE_B_OPERATIONAL_GROUPS,
  operationalGroupForRoute,
} from "./phaseBOperationalGroups";
// Phase 1A — pillar-aware persona visibility + sidebar node-budget ceiling.
// The grouping resolver consults the pillar registry's persona overlay so
// that a sidebar role never renders a pillar it shouldn't see, and clamps
// the visible node count to MAX_VISIBLE_SIDEBAR_NODES (overflow is moved
// into a separate overflowItems collection that the sidebar can render
// behind a "More / Advanced" disclosure).
import {
  MAX_VISIBLE_SIDEBAR_NODES,
  pillarForRoute,
  visiblePillarsForPersona,
} from "./pillarRegistry";
import type { WorkspacePersonaProfile } from "../platform-context/types";
import type { WorkflowExposureItem } from "./workflowExposureResolver";

export interface SidebarGroup {
  readonly id: string;
  readonly title: string;
  readonly domain: string;
  readonly items: ReadonlyArray<WorkflowExposureItem>;
}

export interface NavigationGroupingInput {
  readonly primaryItems: ReadonlyArray<WorkflowExposureItem>;
  readonly secondaryItems: ReadonlyArray<WorkflowExposureItem>;
}

export interface NavigationGroupingResult {
  readonly groups: ReadonlyArray<SidebarGroup>;
  /**
   * Phase 1A — items demoted from the visible sidebar because the
   * MAX_VISIBLE_SIDEBAR_NODES ceiling would be exceeded. The sidebar
   * renders them under the "More / Advanced" disclosure container.
   * Empty when the visible budget is not exceeded.
   */
  readonly overflowItems: ReadonlyArray<WorkflowExposureItem>;
}

/**
 * Phase 1A — optional persona context. When supplied, the resolver
 * filters items whose pillar is not in `visiblePillarsForPersona(persona)`.
 * Omit `persona` to skip the persona-visibility filter (back-compat).
 */
export interface ResolveNavigationGroupsOptions {
  readonly persona?: WorkspacePersonaProfile;
}

/**
 * Phase G0 — fallback domain bucketing used only when a route id is
 * not mapped in `phaseBOperationalGroups.ts`. Routes in this state
 * are a coverage regression (the Phase B contract test catches them),
 * but the sidebar must not silently drop them in production.
 */
function fallbackGroup(domain: string): "WORKSPACE" | "GOVERNANCE" | "SYSTEM" {
  switch (domain) {
    case "GOVERNANCE":
      return "GOVERNANCE";
    case "OPS":
    case "ACCOUNT":
    case "PLATFORM_ADMIN":
      return "SYSTEM";
    default:
      return "WORKSPACE";
  }
}

export function resolveNavigationGroups(
  input: NavigationGroupingInput,
  options?: ResolveNavigationGroupsOptions,
): NavigationGroupingResult {
  const { primaryItems, secondaryItems } = input;
  const persona: WorkspacePersonaProfile | undefined = options?.persona;

  // -------------------------------------------------------------------
  // Phase 1A — persona visibility overlay. When the caller supplies a
  // persona, items whose pillar is NOT in `visiblePillarsForPersona`
  // are dropped from the sidebar (they remain reachable via Command
  // Palette or All Tools when capabilities permit). Without a persona
  // every item passes through (back-compat).
  // -------------------------------------------------------------------
  const personaVisible = persona ? visiblePillarsForPersona(persona) : null;
  const visibleByPersona = (item: WorkflowExposureItem): boolean =>
    !personaVisible || personaVisible.has(pillarForRoute(item.route.id));

  // -------------------------------------------------------------------
  // Bucket every item (primary + secondary) by Phase B operational
  // group. Primary items always render at the top of the Workspace
  // group's items list to preserve the R2 "primary workflows"
  // emphasis without needing a dedicated visual group.
  // -------------------------------------------------------------------
  const workspaceItems: WorkflowExposureItem[] = [];
  const governanceItems: WorkflowExposureItem[] = [];
  const outputsItems: WorkflowExposureItem[] = [];
  const systemItems: WorkflowExposureItem[] = [];

  const route = (item: WorkflowExposureItem) =>
    operationalGroupForRoute(item.route.id) ??
    fallbackGroup(item.route.domain);

  for (const item of primaryItems) {
    if (!visibleByPersona(item)) continue;
    switch (route(item)) {
      case "WORKSPACE":
        workspaceItems.push(item);
        break;
      case "GOVERNANCE":
        governanceItems.push(item);
        break;
      case "OUTPUTS":
        outputsItems.push(item);
        break;
      case "SYSTEM":
        systemItems.push(item);
        break;
    }
  }

  for (const item of secondaryItems) {
    if (!visibleByPersona(item)) continue;
    switch (route(item)) {
      case "WORKSPACE":
        workspaceItems.push(item);
        break;
      case "GOVERNANCE":
        governanceItems.push(item);
        break;
      case "OUTPUTS":
        outputsItems.push(item);
        break;
      case "SYSTEM":
        systemItems.push(item);
        break;
    }
  }

  // -------------------------------------------------------------------
  // PRODUCT-DECISION ORDER CONTRACT (2026-07-14) — within every group,
  // items render in the DECLARATIVE Phase B order (primary array first,
  // then secondary array, then anything unlisted in arrival order).
  // This makes the sidebar order explicit and identical for every
  // role/plan/persona instead of an emergent artifact of workflow
  // bucketing: Home is always first, Operations Center always second.
  // -------------------------------------------------------------------
  const declarativeRank = new Map<string, number>();
  for (const group of PHASE_B_OPERATIONAL_GROUPS) {
    group.primary.forEach((id, i) => declarativeRank.set(id, i));
    group.secondary.forEach((id, i) =>
      declarativeRank.set(id, group.primary.length + i),
    );
  }
  const byDeclarativeOrder = (
    a: WorkflowExposureItem,
    b: WorkflowExposureItem,
  ) =>
    (declarativeRank.get(a.route.id) ?? Number.MAX_SAFE_INTEGER) -
    (declarativeRank.get(b.route.id) ?? Number.MAX_SAFE_INTEGER);
  workspaceItems.sort(byDeclarativeOrder);
  governanceItems.sort(byDeclarativeOrder);
  outputsItems.sort(byDeclarativeOrder);
  systemItems.sort(byDeclarativeOrder);

  // -------------------------------------------------------------------
  // Emit the four canonical groups in the Phase B order. Each group
  // appears only when it has at least one item — solo users without
  // organization context naturally see fewer groups.
  // -------------------------------------------------------------------
  const groups: SidebarGroup[] = [];
  if (workspaceItems.length > 0) {
    groups.push({
      id: SIDEBAR_GROUP_WORKSPACE.id,
      title: SIDEBAR_GROUP_WORKSPACE.title,
      domain: SIDEBAR_GROUP_WORKSPACE.domain,
      items: workspaceItems,
    });
  }
  if (governanceItems.length > 0) {
    groups.push({
      id: SIDEBAR_GROUP_GOVERNANCE.id,
      title: SIDEBAR_GROUP_GOVERNANCE.title,
      domain: SIDEBAR_GROUP_GOVERNANCE.domain,
      items: governanceItems,
    });
  }
  if (outputsItems.length > 0) {
    groups.push({
      id: SIDEBAR_GROUP_OUTPUTS.id,
      title: SIDEBAR_GROUP_OUTPUTS.title,
      domain: SIDEBAR_GROUP_OUTPUTS.domain,
      items: outputsItems,
    });
  }
  if (systemItems.length > 0) {
    groups.push({
      id: SIDEBAR_GROUP_SYSTEM.id,
      title: SIDEBAR_GROUP_SYSTEM.title,
      domain: SIDEBAR_GROUP_SYSTEM.domain,
      items: systemItems,
    });
  }

  // -------------------------------------------------------------------
  // Phase 1A — sidebar node-budget ceiling. Count visible items across
  // all groups; demote the lowest-priority secondary items (in the
  // order they appear AFTER primary items) into `overflowItems` until
  // the total visible count is <= MAX_VISIBLE_SIDEBAR_NODES. Primary
  // items are NEVER demoted — they are the high-emphasis surface.
  // -------------------------------------------------------------------
  const overflowItems: WorkflowExposureItem[] = [];
  const totalVisible = groups.reduce((acc, g) => acc + g.items.length, 0);
  if (totalVisible > MAX_VISIBLE_SIDEBAR_NODES) {
    const primarySet = new Set(primaryItems);
    let need = totalVisible - MAX_VISIBLE_SIDEBAR_NODES;
    // Walk groups in REVERSE order (system → outputs → governance →
    // workspace) and drop trailing non-primary items first.
    for (let gi = groups.length - 1; gi >= 0 && need > 0; gi -= 1) {
      const group = groups[gi]!;
      const kept: WorkflowExposureItem[] = [];
      // Walk items from end so trailing secondary items are dropped first.
      for (let i = group.items.length - 1; i >= 0; i -= 1) {
        const it = group.items[i]!;
        if (need > 0 && !primarySet.has(it)) {
          overflowItems.unshift(it);
          need -= 1;
        } else {
          kept.unshift(it);
        }
      }
      groups[gi] = {
        id: group.id,
        title: group.title,
        domain: group.domain,
        items: kept,
      };
    }
  }

  return { groups, overflowItems };
}
