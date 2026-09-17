/**
 * PHASE UI-TRUTH — placement, role and plan join (AUDIT HARNESS, not product code).
 *
 * Joins the filesystem surface universe to the CANONICAL authorities. Nothing
 * here re-derives a fact another authority already owns:
 *
 *   route gating / capabilities   apps/web/lib/navigation/routeRegistry.ts
 *   web access decision           apps/web/lib/navigation/routeAccessResolver.ts
 *   admin IA + scope              apps/web/components/admin/adminNavigation.ts
 *   admin scope dispositions      apps/web/lib/navigation/adminScopeDispositions.ts
 *   middleware tier / direct URL  apps/web/lib/surface/tiers.ts
 *   endpoints + their data scope  docs/architecture/current-runtime-capability-map.json
 *   plan capabilities             packages/shared-billing/src/plan-catalog.ts
 *
 * Run with tsx so the TypeScript authorities can be imported rather than
 * regex-scraped: node --import tsx audit/ui-truth/harness/placement.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { buildSurfaces, REPO } from "./surfaces.mjs";

const web = (p) => pathToFileURL(join(REPO, "apps", "web", p)).href;

const registry = await import(web("lib/navigation/routeRegistry.ts"));
const adminNav = await import(web("components/admin/adminNavigation.ts"));
const tiers = await import(web("lib/surface/tiers.ts"));
const scopeDispositions = await import(web("lib/navigation/adminScopeDispositions.ts"));

const capabilityMap = JSON.parse(
  readFileSync(join(REPO, "docs", "architecture", "current-runtime-capability-map.json"), "utf8"),
);

/* -------------------------------------------------------------------------
 * Endpoint join: which API routes does this page's own files call?
 *
 * The capability map records each consumer as file+line+caller. A page owns its
 * page.tsx plus the files in its own directory (its _tabs/_hooks/components),
 * which is how these pages are organised.
 * ---------------------------------------------------------------------- */
const consumersByFile = new Map();
for (const route of capabilityMap.routes) {
  for (const consumer of route.productConsumers ?? []) {
    if (consumer.class !== "WEB") continue;
    const list = consumersByFile.get(consumer.file) ?? [];
    list.push({
      routeId: route.routeId,
      method: route.method,
      path: route.path,
      line: consumer.line,
      caller: consumer.caller,
      primitive: consumer.primitive,
      authorizationClass: route.authorizationClass,
      gates: route.gates ?? [],
      dataScope: route.dataScope ?? null,
      tenantType: route.tenantType ?? null,
      disposition: route.primaryDisposition,
      registered: route.productionRegistered === true,
      mutating: route.method !== "GET" && route.method !== "HEAD",
    });
    consumersByFile.set(consumer.file, list);
  }
}

/**
 * The gate a surface actually runs. A page is allowed to carry no registry
 * entry of its own as long as it declares an ancestor's routeId through
 * PageRouteGate — that is the contract apps/web/__tests__/route-registry-coverage
 * enforces. Anything with neither is a real accounting gap, not a detail page.
 */
const GATE_RE = /<PageRouteGate[^>]*\srouteId=(?:"([^"]+)"|\{\s*"([^"]+)"\s*\})/;
function declaredGate(files) {
  for (const f of files) {
    const m = GATE_RE.exec(readFileSync(join(REPO, f), "utf8"));
    if (m) return m[1] ?? m[2];
  }
  return null;
}

/**
 * Files that belong to a surface: its page file, plus the files in its own
 * directory subtree that no DEEPER page owns.
 *
 * Nearest-page-ancestor, not prefix: `/admin` sits above every `/admin/*`
 * page, so a plain prefix match made the parent absorb all its children's
 * files and endpoints — which would have credited `/admin` with fifty
 * endpoints it never calls.
 */
const PAGE_DIRS = [];
function ownedFiles(surface, allSurfaces) {
  if (PAGE_DIRS.length === 0) {
    for (const s of allSurfaces) PAGE_DIRS.push(s.file.slice(0, s.file.lastIndexOf("/")));
    PAGE_DIRS.sort((a, b) => b.length - a.length);
  }
  const dir = surface.file.slice(0, surface.file.lastIndexOf("/"));
  const owned = new Set([surface.file]);
  for (const file of consumersByFile.keys()) {
    if (!file.startsWith(dir + "/")) continue;
    const nearest = PAGE_DIRS.find((d) => file.startsWith(d + "/"));
    if (nearest === dir) owned.add(file);
  }
  return [...owned].sort();
}

/* -------------------------------------------------------------------------
 * Registry join
 * ---------------------------------------------------------------------- */
const REGISTRY_BY_HREF = new Map();
for (const def of registry.ROUTE_REGISTRY) REGISTRY_BY_HREF.set(def.href, def);

/** `/admin/customers/[id]` in the filesystem is `/admin/customers/:id` in the registry. */
const toRegistryHref = (route) => route.replace(/\[\.\.\.?([^\]]+)\]/g, ":$1").replace(/\[([^\]]+)\]/g, ":$1");

const ADMIN_NAV_HREFS = new Set(adminNav.adminNavigationHrefs());
const ADMIN_NAV_BY_HREF = new Map();
for (const section of adminNav.ADMIN_NAV_SECTIONS) {
  for (const child of section.children) {
    ADMIN_NAV_BY_HREF.set(child.href, { sectionId: section.id, sectionLabel: section.label, ...child });
  }
}

/* -------------------------------------------------------------------------
 * Observed data scope, from the endpoints the page actually calls.
 * This is the evidence a placement decision must rest on — never the URL.
 * ---------------------------------------------------------------------- */
function observedScope(endpoints) {
  const scopes = new Set(endpoints.map((e) => e.dataScope).filter(Boolean));
  const platformGated = endpoints.some((e) =>
    (e.gates ?? []).some((g) => /PLATFORM_ADMIN/i.test(g)),
  );
  const platformPaths = endpoints.filter((e) => e.path.startsWith("/v1/admin/") || e.path.startsWith("/v1/platform/"));
  return {
    endpointDataScopes: [...scopes].sort(),
    platformGatedEndpoints: platformGated,
    platformPathEndpoints: platformPaths.length,
    workspaceScopedEndpoints: endpoints.filter((e) => e.dataScope === "WORKSPACE_SCOPED").length,
  };
}

export function buildPlacement() {
  const surfaces = buildSurfaces().filter((s) => s.inScope);
  const rows = surfaces.map((surface) => {
    const files = ownedFiles(surface, surfaces);
    const endpoints = files.flatMap((f) => consumersByFile.get(f) ?? []);
    endpoints.sort((a, b) => (a.routeId < b.routeId ? -1 : 1));
    const registryHref = toRegistryHref(surface.route);
    const def = REGISTRY_BY_HREF.get(registryHref) ?? null;
    const gate = declaredGate([surface.file, ...files]);
    const navEntry = ADMIN_NAV_BY_HREF.get(registryHref) ?? null;
    const disposition =
      typeof scopeDispositions.dispositionFor === "function"
        ? scopeDispositions.dispositionFor(registryHref) ?? null
        : null;
    return {
      surfaceId: surface.surfaceId,
      route: surface.route,
      registryHref,
      file: surface.file,
      observedArea: surface.area,
      isDetail: surface.isDetail,
      ownedFiles: files,
      registry: def
        ? {
            id: def.id,
            label: def.label,
            domain: def.domain,
            requiredCapabilities: [...(def.requiredCapabilities ?? [])],
            requiredActiveSpace: def.requiredActiveSpace,
            fallbackBehavior: def.fallbackBehavior,
            advancedByDefault: def.advancedByDefault ?? false,
            planFeatureGate: def.planFeatureGate ?? null,
          }
        : null,
      registered: Boolean(def),
      gateRouteId: gate,
      gateDefinition: gate && registry.getRouteDefinition(gate)
        ? { id: gate, domain: registry.getRouteDefinition(gate).domain, requiredCapabilities: [...registry.getRouteDefinition(gate).requiredCapabilities], requiredActiveSpace: registry.getRouteDefinition(gate).requiredActiveSpace, fallbackBehavior: registry.getRouteDefinition(gate).fallbackBehavior }
        : null,
      accounting: def ? "REGISTERED_OWN_ROUTE_ID" : gate ? "GATED_BY_ANCESTOR_ROUTE_ID" : "NO_REGISTRY_ENTRY_AND_NO_GATE",
      adminNav: navEntry
        ? { sectionId: navEntry.sectionId, label: navEntry.label, scope: navEntry.scope ?? null }
        : null,
      inAdminNav: ADMIN_NAV_HREFS.has(registryHref),
      adminScopeDisposition: disposition
        ? { decision: disposition.decision ?? null, reason: disposition.reason ?? null }
        : null,
      middleware: {
        surfaceTier: tiers.getSurfaceTier(surface.route),
        directAccessPolicy: tiers.getDirectAccessPolicy(surface.route),
      },
      endpoints,
      endpointCount: endpoints.length,
      mutatingEndpointCount: endpoints.filter((e) => e.mutating).length,
      scopeEvidence: observedScope(endpoints),
    };
  });
  return rows;
}

function main() {
  const rows = buildPlacement();
  const totals = {
    inScopeSurfaces: rows.length,
    registered: rows.filter((r) => r.registered).length,
    unregistered: rows.filter((r) => !r.registered).length,
    inAdminNav: rows.filter((r) => r.inAdminNav).length,
    withNoEndpoints: rows.filter((r) => r.endpointCount === 0).length,
    withMutations: rows.filter((r) => r.mutatingEndpointCount > 0).length,
    distinctEndpoints: new Set(rows.flatMap((r) => r.endpoints.map((e) => e.routeId))).size,
    byAccounting: {},
    byTier: {},
    byDirectAccessPolicy: {},
  };
  for (const r of rows) {
    totals.byAccounting[r.accounting] = (totals.byAccounting[r.accounting] ?? 0) + 1;
    totals.byTier[r.middleware.surfaceTier] = (totals.byTier[r.middleware.surfaceTier] ?? 0) + 1;
    const p = r.middleware.directAccessPolicy;
    totals.byDirectAccessPolicy[p] = (totals.byDirectAccessPolicy[p] ?? 0) + 1;
  }
  const payload = {
    artifact: "ui-truth/placement",
    schemaVersion: 1,
    note: "In-scope surfaces joined to the canonical route, nav, tier and capability-map authorities.",
    authorities: {
      routeRegistry: "apps/web/lib/navigation/routeRegistry.ts",
      adminNavigation: "apps/web/components/admin/adminNavigation.ts",
      adminScopeDispositions: "apps/web/lib/navigation/adminScopeDispositions.ts",
      surfaceTiers: "apps/web/lib/surface/tiers.ts",
      capabilityMap: "docs/architecture/current-runtime-capability-map.json",
    },
    totals,
    rows,
  };
  const out = join(REPO, "audit", "ui-truth", "data", "placement.json");
  writeFileSync(out, JSON.stringify(payload, null, 2) + "\n");
  console.log(`wrote audit/ui-truth/data/placement.json — ${rows.length} surfaces`);
  console.log(JSON.stringify(totals, null, 2));
}

main();
