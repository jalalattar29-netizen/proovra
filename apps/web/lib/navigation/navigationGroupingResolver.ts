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
import { operationalGroupForRoute } from "./phaseBOperationalGroups";
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
): NavigationGroupingResult {
  const { primaryItems, secondaryItems } = input;

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

  return { groups };
}
