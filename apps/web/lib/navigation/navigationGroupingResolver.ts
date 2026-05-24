/**
 * PHASE R2 — Canonical navigation grouping resolver.
 *
 * Pure transform. Takes the refined disclosure result and builds the
 * bounded sidebar groups (Primary workflows / Workspace / Operations
 * / Governance & Compliance). Each group's `items` come from the
 * routes' registry `domain` field.
 *
 * This is the formal extraction of the previously-inline
 * `buildSidebarGroups()` helper from `AppSidebarV2.tsx`, with two
 * additions:
 *
 *   1. The grouping is now a named pure function consumable by tests
 *      and future surfaces (e.g. a workspace-experience CSS gate).
 *
 *   2. Group titles are sourced from `canonicalNavigationGroups.ts`
 *      so the bounded title vocabulary is enforced in one place.
 *
 * NO authorization. NO disclosure. NO experience emphasis. Those
 * happen upstream in the canonical pipeline.
 */

import {
  SIDEBAR_GROUP_GOVERNANCE,
  SIDEBAR_GROUP_OPERATIONS,
  SIDEBAR_GROUP_PRIMARY,
  SIDEBAR_GROUP_WORKSPACE,
} from "./canonicalNavigationGroups";
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

export function resolveNavigationGroups(
  input: NavigationGroupingInput,
): NavigationGroupingResult {
  const { primaryItems, secondaryItems } = input;

  const byDomain = new Map<string, WorkflowExposureItem[]>();
  for (const item of secondaryItems) {
    const key = item.route.domain;
    if (!byDomain.has(key)) byDomain.set(key, []);
    byDomain.get(key)!.push(item);
  }

  const workspaceItems: WorkflowExposureItem[] = [];
  for (const dom of SIDEBAR_GROUP_WORKSPACE.sourceDomains) {
    const bucket = byDomain.get(dom);
    if (bucket) workspaceItems.push(...bucket);
  }
  const opsItems: WorkflowExposureItem[] = [];
  for (const dom of SIDEBAR_GROUP_OPERATIONS.sourceDomains) {
    const bucket = byDomain.get(dom);
    if (bucket) opsItems.push(...bucket);
  }
  const governanceItems: WorkflowExposureItem[] = [];
  for (const dom of SIDEBAR_GROUP_GOVERNANCE.sourceDomains) {
    const bucket = byDomain.get(dom);
    if (bucket) governanceItems.push(...bucket);
  }

  const groups: SidebarGroup[] = [];
  if (primaryItems.length > 0) {
    groups.push({
      id: SIDEBAR_GROUP_PRIMARY.id,
      title: SIDEBAR_GROUP_PRIMARY.title,
      domain: SIDEBAR_GROUP_PRIMARY.domain,
      items: primaryItems,
    });
  }
  if (workspaceItems.length > 0) {
    groups.push({
      id: SIDEBAR_GROUP_WORKSPACE.id,
      title: SIDEBAR_GROUP_WORKSPACE.title,
      domain: SIDEBAR_GROUP_WORKSPACE.domain,
      items: workspaceItems,
    });
  }
  if (opsItems.length > 0) {
    groups.push({
      id: SIDEBAR_GROUP_OPERATIONS.id,
      title: SIDEBAR_GROUP_OPERATIONS.title,
      domain: SIDEBAR_GROUP_OPERATIONS.domain,
      items: opsItems,
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

  return { groups };
}
