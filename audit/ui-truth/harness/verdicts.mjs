/**
 * PHASE UI-TRUTH — placement verdicts (AUDIT HARNESS, not product code).
 *
 * Decides, for every in-scope surface, which product area its BACKEND says it
 * belongs to, and compares that with where it actually lives. The evidence is
 * the capability map's own tenancy vocabulary — `tenantType`, `dataScope`,
 * `gates` — never the URL, because a URL is the thing under audit.
 *
 * Emits one row per surface with:
 *   observedArea   where the surface lives today (filesystem position)
 *   backendArea    where its endpoints say it belongs
 *   verdict        AGREES | MIXED_AUTHORITY | DISAGREES | NO_BACKEND_EVIDENCE
 *
 * A DISAGREES row is a placement CANDIDATE, not a finding: a page may legitimately
 * read platform data for an audit context. Each one is dispositioned by hand in
 * audit/ui-truth/data/placement-decisions.json, and every candidate must appear
 * there before the audit can close.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { REPO } from "./surfaces.mjs";

const placement = JSON.parse(
  readFileSync(join(REPO, "audit", "ui-truth", "data", "placement.json"), "utf8"),
);

/** The area an endpoint's own authority implies. */
function endpointArea(endpoint) {
  const gates = endpoint.gates ?? [];
  if (gates.includes("ADMIN_GATED")) return "PLATFORM";
  switch (endpoint.tenantType) {
    case "PLATFORM":
      return "PLATFORM";
    case "ORGANIZATION":
      return "ORGANIZATION";
    case "WORKSPACE":
      return "WORKSPACE";
    case "TOKEN_BOUND":
      return "TOKEN_HOLDER";
    default:
      // NONE: self-service reads, health probes and session endpoints. They
      // belong to whichever area the rest of the page belongs to, so they are
      // counted but never decide an area on their own.
      return endpoint.dataScope === "GLOBAL_USER_SELF" ? "ACCOUNT" : "NEUTRAL";
  }
}

/** The area the surface's filesystem position claims. */
const CLAIMED = {
  PLATFORM_ADMIN_NAMESPACE: "PLATFORM",
  ORGANIZATION_NAMESPACE: "ORGANIZATION",
  SECURITY_CENTER: "WORKSPACE",
  GOVERNANCE: "WORKSPACE",
  SETTINGS: "ACCOUNT",
  WORKSPACE_DASHBOARD: "WORKSPACE",
  EXTERNAL_PORTAL: "TOKEN_HOLDER",
};

function classify(row) {
  const counts = {};
  for (const endpoint of row.endpoints) {
    const area = endpointArea(endpoint);
    counts[area] = (counts[area] ?? 0) + 1;
  }
  const deciding = Object.entries(counts).filter(([area]) => area !== "NEUTRAL" && area !== "ACCOUNT");
  deciding.sort((a, b) => b[1] - a[1]);
  const claimed = CLAIMED[row.observedArea];
  if (row.endpoints.length === 0) {
    return { backendArea: null, backendAreaCounts: counts, verdict: "NO_BACKEND_EVIDENCE", claimedArea: claimed };
  }
  if (deciding.length === 0) {
    // Only self-service / neutral endpoints: an account-level surface.
    return { backendArea: "ACCOUNT", backendAreaCounts: counts, verdict: claimed === "ACCOUNT" ? "AGREES" : "ACCOUNT_LEVEL_ONLY", claimedArea: claimed };
  }
  const [dominant] = deciding[0];
  const mixed = deciding.length > 1;
  let verdict;
  if (dominant === claimed) verdict = mixed ? "AGREES_WITH_SECONDARY_AUTHORITY" : "AGREES";
  else verdict = mixed ? "MIXED_AUTHORITY" : "DISAGREES";
  return { backendArea: dominant, backendAreaCounts: counts, verdict, claimedArea: claimed };
}

export function buildVerdicts() {
  return placement.rows.map((row) => {
    const c = classify(row);
    return {
      surfaceId: row.surfaceId,
      route: row.route,
      observedArea: row.observedArea,
      claimedArea: c.claimedArea,
      backendArea: c.backendArea,
      backendAreaCounts: c.backendAreaCounts,
      verdict: c.verdict,
      accounting: row.accounting,
      inAdminNav: row.inAdminNav,
      adminNavScope: row.adminNav?.scope ?? null,
      adminScopeDisposition: row.adminScopeDisposition,
      registryDomain: row.registry?.domain ?? row.gateDefinition?.domain ?? null,
      requiredCapabilities: row.registry?.requiredCapabilities ?? row.gateDefinition?.requiredCapabilities ?? [],
      requiredActiveSpace: row.registry?.requiredActiveSpace ?? row.gateDefinition?.requiredActiveSpace ?? null,
      fallbackBehavior: row.registry?.fallbackBehavior ?? row.gateDefinition?.fallbackBehavior ?? null,
      surfaceTier: row.middleware.surfaceTier,
      directAccessPolicy: row.middleware.directAccessPolicy,
      endpointCount: row.endpointCount,
      mutatingEndpointCount: row.mutatingEndpointCount,
      evidence: row.endpoints.slice(0, 40).map((e) => `${e.routeId} [${e.tenantType}/${e.dataScope}]`),
    };
  });
}

function main() {
  const rows = buildVerdicts();
  const byVerdict = {};
  for (const r of rows) byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1;
  const payload = {
    artifact: "ui-truth/placement-verdicts",
    schemaVersion: 1,
    note: "Backend-derived area vs filesystem position for every in-scope surface.",
    totals: { surfaces: rows.length, byVerdict: Object.fromEntries(Object.entries(byVerdict).sort()) },
    rows,
  };
  writeFileSync(
    join(REPO, "audit", "ui-truth", "data", "placement-verdicts.json"),
    JSON.stringify(payload, null, 2) + "\n",
  );
  console.log(JSON.stringify(payload.totals, null, 2));
  for (const r of rows.filter((r) => r.verdict === "DISAGREES" || r.verdict === "MIXED_AUTHORITY")) {
    console.log(`${r.verdict.padEnd(18)} ${r.route.padEnd(48)} claimed=${r.claimedArea} backend=${r.backendArea} ${JSON.stringify(r.backendAreaCounts)}`);
  }
}

main();
