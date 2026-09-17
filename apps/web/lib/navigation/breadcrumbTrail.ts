/**
 * PV-NAV-001 — A BREADCRUMB NEVER SAYS THE SAME PLACE TWICE.
 *
 * OperationalBreadcrumb always renders the page's operational group
 * ("Governance") after the workspace, then the crumbs the page passes. Pages
 * that also passed their group as their first crumb rendered
 * "Workspace › Governance › Governance › Retention policies". Removing the
 * crumb from one page fixed that page; the trail is now decided here, once: a
 * crumb whose label repeats the crumb rendered just before it is dropped,
 * whatever page passed it.
 */

export type TrailItem = { label: string; href?: string };

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function breadcrumbTrail(
  groupTitle: string | null,
  items: ReadonlyArray<TrailItem>,
): TrailItem[] {
  const out: TrailItem[] = [];
  let previous = groupTitle;
  for (const item of items) {
    if (previous !== null && same(previous, item.label)) continue;
    out.push(item);
    previous = item.label;
  }
  return out;
}
