/**
 * PHASE UI-TRUTH — navigation reconciliation (AUDIT HARNESS).
 *
 * Gate: every registered navigation entry must lead to a real surface, and
 * every surface must be reachable or explicitly justified as unreachable.
 * Both nav authorities are reconciled against the surface universe:
 *
 *   server projection  services/api/src/services/platform-context/navigation-registry.ts
 *   admin console      apps/web/components/admin/adminNavigation.ts
 *   route registry     apps/web/lib/navigation/routeRegistry.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { REPO } from "./surfaces.mjs";

const url = (p) => pathToFileURL(join(REPO, p)).href;
const { NAVIGATION_REGISTRY } = await import(url("services/api/src/services/platform-context/navigation-registry.ts"));
const adminNav = await import(url("apps/web/components/admin/adminNavigation.ts"));
const { ROUTE_REGISTRY, getRouteDefinition } = await import(url("apps/web/lib/navigation/routeRegistry.ts"));

const placement = JSON.parse(readFileSync(join(REPO, "audit", "ui-truth", "data", "placement.json"), "utf8"));
const SURFACE_HREFS = new Set(placement.rows.map((r) => r.registryHref));
const GATED_BY = new Map(placement.rows.map((r) => [r.registryHref, r.gateRouteId ?? r.registry?.id ?? null]));

/** Server navigation entries, flattened out of their groups. */
const serverEntries = [];
for (const group of NAVIGATION_REGISTRY) {
  for (const item of group.items ?? []) {
    serverEntries.push({
      source: "SERVER_NAVIGATION_REGISTRY",
      group: group.id ?? group.title ?? null,
      id: item.id ?? item.routeId ?? null,
      href: item.href ?? null,
      surface: item.surface ?? null,
    });
  }
}

const adminEntries = [];
for (const section of adminNav.ADMIN_NAV_SECTIONS) {
  for (const child of section.children) {
    adminEntries.push({ source: "ADMIN_NAVIGATION", group: section.id, id: child.routeId ?? null, href: child.href, scope: child.scope ?? null });
  }
}

const registryEntries = ROUTE_REGISTRY.map((d) => ({ source: "ROUTE_REGISTRY", id: d.id, href: d.href, domain: d.domain }));

/** An entry resolves when its href is a surface, or its id gates one. */
function resolve(entry) {
  if (entry.href && SURFACE_HREFS.has(entry.href)) return { resolved: true, how: "HREF_IS_A_SURFACE" };
  if (entry.id) {
    for (const [href, gate] of GATED_BY) {
      if (gate === entry.id) return { resolved: true, how: `GATES_SURFACE:${href}` };
    }
    if (getRouteDefinition(entry.id)) {
      const def = getRouteDefinition(entry.id);
      if (SURFACE_HREFS.has(def.href)) return { resolved: true, how: `REGISTRY_HREF:${def.href}` };
    }
  }
  return { resolved: false, how: null };
}

const rows = [...serverEntries, ...adminEntries, ...registryEntries].map((e) => ({ ...e, ...resolve(e) }));
const unresolved = rows.filter((r) => !r.resolved);

/** Surfaces no navigation entry points at: reachable only by URL. */
const navHrefs = new Set(rows.filter((r) => r.href).map((r) => r.href));
const unnavigated = placement.rows
  .filter((r) => !navHrefs.has(r.registryHref))
  .map((r) => ({
    route: r.route,
    isDetail: r.isDetail,
    justification: r.isDetail
      ? "DETAIL_PAGE_REACHED_FROM_ITS_LIST"
      : r.route.startsWith("/portal")
        ? "EXTERNAL_PORTAL_REACHED_BY_TOKEN_LINK"
        : "NO_NAVIGATION_ENTRY",
  }));

const bySource = {};
for (const r of rows) bySource[r.source] = (bySource[r.source] ?? 0) + 1;
const unresolvedBySource = {};
for (const r of unresolved) unresolvedBySource[r.source] = (unresolvedBySource[r.source] ?? 0) + 1;
const unnavigatedByJustification = {};
for (const u of unnavigated) unnavigatedByJustification[u.justification] = (unnavigatedByJustification[u.justification] ?? 0) + 1;

const payload = {
  artifact: "ui-truth/nav-reconciliation",
  schemaVersion: 1,
  note: "Every navigation entry reconciled against the surface universe, and every surface checked for a navigation entry.",
  totals: {
    entries: rows.length,
    bySource,
    resolved: rows.length - unresolved.length,
    unresolved: unresolved.length,
    unresolvedBySource,
    surfacesWithNoNavEntry: unnavigated.length,
    unnavigatedByJustification,
  },
  unresolvedEntries: unresolved.sort((a, b) => ((a.href ?? a.id ?? "") < (b.href ?? b.id ?? "") ? -1 : 1)),
  surfacesWithNoNavEntry: unnavigated.sort((a, b) => (a.route < b.route ? -1 : 1)),
};

writeFileSync(join(REPO, "audit", "ui-truth", "data", "nav-reconciliation.json"), JSON.stringify(payload, null, 2) + "\n");
console.log(JSON.stringify(payload.totals, null, 2));
