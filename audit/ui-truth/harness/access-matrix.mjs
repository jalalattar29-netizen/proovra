/**
 * PHASE UI-TRUTH — role x plan x workspace access matrix (AUDIT HARNESS).
 *
 * SOURCE-level expectation for every in-scope surface and every persona,
 * computed by calling the product's OWN resolvers:
 *
 *   capabilities   services/api/src/services/platform-context/capability-registry.ts
 *   nav + load     apps/web/lib/navigation/routeAccessResolver.ts
 *   direct URL     apps/web/lib/surface/tiers.ts  (middleware policy)
 *
 * It states what the product INTENDS. Whether the running product agrees is a
 * separate, runtime question; rows here carry `evidence: "SOURCE"` only.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { REPO } from "./surfaces.mjs";

const url = (p) => pathToFileURL(join(REPO, p)).href;
const { resolveCapabilities } = await import(
  url("services/api/src/services/platform-context/capability-registry.ts")
);
const { resolveRouteAccess } = await import(url("apps/web/lib/navigation/routeAccessResolver.ts"));
const { getRouteDefinition } = await import(url("apps/web/lib/navigation/routeRegistry.ts"));
const tiers = await import(url("apps/web/lib/surface/tiers.ts"));
const { PLAN_CAPABILITIES } = await import(url("packages/shared-billing/src/plan-catalog.ts"));

/** The server projects PLAN_CAPABILITIES into the envelope booleans the gate reads. */
function planFeaturesFor(plan) {
  const caps = PLAN_CAPABILITIES[plan ?? "FREE"];
  if (!caps) return {};
  return Object.fromEntries(Object.entries(caps).filter(([, v]) => typeof v === "boolean"));
}

const placement = JSON.parse(
  readFileSync(join(REPO, "audit", "ui-truth", "data", "placement.json"), "utf8"),
);

/**
 * The personas. Each one is a real combination the product can produce:
 * a workspace kind, a member role, a plan, and platform elevation.
 * `anonymous` and `non-member` have no capability map at all.
 */
const PERSONAS = [
  { id: "anonymous", label: "Signed out", kind: null, role: null, plan: null, platformAdmin: false, authenticated: false },
  { id: "authenticated-no-workspace", label: "Signed in, no workspace", kind: null, role: null, plan: "FREE", platformAdmin: false, authenticated: true },
  { id: "free-personal-owner", label: "FREE personal owner", kind: "PERSONAL", role: "OWNER", plan: "FREE", platformAdmin: false, authenticated: true },
  { id: "pro-personal-owner", label: "PRO personal owner", kind: "PERSONAL", role: "OWNER", plan: "PRO", platformAdmin: false, authenticated: true },
  { id: "team-owned-owner", label: "TEAM shared workspace owner", kind: "OWNED", role: "OWNER", plan: "TEAM", platformAdmin: false, authenticated: true },
  { id: "org-owner", label: "ENTERPRISE organization owner", kind: "ORGANIZATION", role: "OWNER", plan: "ENTERPRISE", platformAdmin: false, authenticated: true },
  { id: "org-admin", label: "ENTERPRISE organization admin", kind: "ORGANIZATION", role: "ADMIN", plan: "ENTERPRISE", platformAdmin: false, authenticated: true },
  { id: "org-member-reviewer", label: "ENTERPRISE member (reviewer tier)", kind: "ORGANIZATION", role: "MEMBER", plan: "ENTERPRISE", platformAdmin: false, authenticated: true },
  { id: "org-viewer", label: "ENTERPRISE viewer", kind: "ORGANIZATION", role: "VIEWER", plan: "ENTERPRISE", platformAdmin: false, authenticated: true },
  { id: "team-member", label: "TEAM member", kind: "OWNED", role: "MEMBER", plan: "TEAM", platformAdmin: false, authenticated: true },
  { id: "team-viewer", label: "TEAM viewer", kind: "OWNED", role: "VIEWER", plan: "TEAM", platformAdmin: false, authenticated: true },
  { id: "platform-admin", label: "Platform admin", kind: "ORGANIZATION", role: "OWNER", plan: "ENTERPRISE", platformAdmin: true, authenticated: true },
];

function capabilitiesFor(persona) {
  if (!persona.authenticated) return {};
  return resolveCapabilities({
    scope: persona.kind === "PERSONAL" ? "PERSONAL" : persona.kind ? "TEAM" : null,
    role: persona.role,
    plan: persona.plan,
    isPlatformAdmin: persona.platformAdmin,
    workspaceKind: persona.kind,
    packageProducesOperationalConditions: persona.plan === "ENTERPRISE" || persona.plan === "TEAM",
    memberCount: persona.kind === "PERSONAL" ? 1 : 5,
  });
}

const CAPS = new Map(PERSONAS.map((p) => [p.id, capabilitiesFor(p)]));

function accessFor(persona, def) {
  if (!persona.authenticated) {
    return { accessState: "UNAUTHENTICATED", canLoad: false, canSeeNav: false, reason: "No session; the app shell redirects to login." };
  }
  const result = resolveRouteAccess({
    route: def,
    activeSpaceType: persona.kind === null ? null : persona.kind === "PERSONAL" ? "PERSONAL" : "ORGANIZATION",
    isPlatformAdmin: persona.platformAdmin,
    capabilities: CAPS.get(persona.id),
    accountPlan: persona.plan,
    isEnterpriseWorkspace: persona.plan === "ENTERPRISE",
    planFeatures: planFeaturesFor(persona.plan),
    workspace: persona.kind ? { id: "ws-fixture", status: "active" } : null,
    personalSpace: persona.kind === "PERSONAL" ? { id: "ws-fixture", status: "active" } : null,
  });
  return {
    accessState: result.accessState,
    canLoad: result.canLoad,
    canSeeNav: result.canSeeNav,
    reason: result.reason ?? null,
  };
}

export function buildMatrix() {
  const rows = [];
  for (const surface of placement.rows) {
    const routeId = surface.registry?.id ?? surface.gateRouteId ?? null;
    const def = routeId ? getRouteDefinition(routeId) : null;
    const cells = {};
    for (const persona of PERSONAS) {
      cells[persona.id] = def
        ? accessFor(persona, def)
        : {
            accessState: "NO_REGISTRY_GATE",
            canLoad: null,
            canSeeNav: null,
            reason: "The surface declares no routeId, so the canonical web gate never runs for it.",
          };
    }
    rows.push({
      surfaceId: surface.surfaceId,
      route: surface.route,
      gateRouteId: routeId,
      observedArea: surface.observedArea,
      surfaceTier: surface.middleware.surfaceTier,
      directAccessPolicy: surface.middleware.directAccessPolicy,
      requiredCapabilities: def ? [...def.requiredCapabilities] : [],
      requiredActiveSpace: def?.requiredActiveSpace ?? null,
      fallbackBehavior: def?.fallbackBehavior ?? null,
      domain: def?.domain ?? null,
      cells,
      evidence: "SOURCE",
    });
  }
  return rows;
}

function main() {
  const rows = buildMatrix();
  const perPersona = {};
  for (const persona of PERSONAS) {
    const states = {};
    for (const row of rows) {
      const s = row.cells[persona.id].accessState;
      states[s] = (states[s] ?? 0) + 1;
    }
    perPersona[persona.id] = states;
  }
  const payload = {
    artifact: "ui-truth/access-matrix",
    schemaVersion: 1,
    note: "Source-level access expectation per surface per persona, from the product's own resolvers.",
    personas: PERSONAS,
    capabilityKeysTrueByPersona: Object.fromEntries(
      PERSONAS.map((p) => [p.id, Object.entries(CAPS.get(p.id)).filter(([, v]) => v).map(([k]) => k).sort()]),
    ),
    totals: { surfaces: rows.length, cells: rows.length * PERSONAS.length, perPersona },
    rows,
  };
  writeFileSync(
    join(REPO, "audit", "ui-truth", "data", "access-matrix.json"),
    JSON.stringify(payload, null, 2) + "\n",
  );
  console.log(`surfaces ${rows.length} x personas ${PERSONAS.length} = ${rows.length * PERSONAS.length} cells`);
  for (const [id, states] of Object.entries(perPersona)) {
    console.log(id.padEnd(30), JSON.stringify(states));
  }
}

main();
