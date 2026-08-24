#!/usr/bin/env node
/**
 * PHASE 12 — THE CANONICAL RUNTIME CAPABILITY AUTHORITY.
 *
 * FINAL-001. `docs/architecture/current-runtime-capability-map.json` described
 * itself as the output of a "static route/consumer/worker/test scan". No such
 * scanner existed. Its `classification` column was hand-maintained, and it
 * disagreed with the tree on 176 of 1083 routes — while every downstream report
 * quoted its totals as measurements. A number that is edited by hand and read as
 * evidence is worse than no number, because it cannot be falsified by running
 * anything.
 *
 * This script is the generator that file always claimed to have. It is the ONLY
 * thing permitted to produce a classification:
 *
 *     production source
 *       -> AST route + authorization analyzer   (capability-authority/routes.mjs)
 *       -> AST consumer analyzer                (capability-authority/consumers.mjs)
 *       -> reviewed manifests, each with source evidence
 *       -> generated map
 *       -> every gate and report
 *
 * Nothing in the artifact is typed by a human. The manifests carry human
 * JUDGEMENT — "this origin is PayPal's", "this helper reaches these five routes",
 * "this route is called by the scheduler" — and every judgement names the file
 * and line it was read from. The generator refuses a judgement whose subject has
 * disappeared, so a refactor cannot leave a stale exemption behind.
 *
 * Usage:
 *   node scripts/generate-runtime-capability-map.mjs            # write + verify
 *   node scripts/generate-runtime-capability-map.mjs --check    # verify only
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

import { matches, REPO } from "./capability-authority/analyzer.mjs";
import {
  indexApiFunctions,
  extractRoutes,
  classifyRouteAuth,
  isUnreachableAliasRegistration,
} from "./capability-authority/routes.mjs";
import { analyzeConsumers, attachConsumers } from "./capability-authority/consumers.mjs";
import { resolveCall, resolveValueDeclaration, ts } from "./capability-authority/call-graph.mjs";
// PHASE 13 §B — mutation closure, derived over the SAME resolved call graph
// this generator already builds for tenancy. One graph, one traversal
// authority, one artifact.
import {
  discoverMutationTerminals,
  resolveMutationEntrypoints,
  deriveMutationInvariants,
  dispositionUnreached,
  evaluateMutationClosure,
  readWorkRegistry,
  queueTopology,
  MUTATION_FAMILIES,
} from "./capability-authority/mutation-closure.mjs";
// PHASE 13 §2 — the 17-family security classification, derived over the facts
// this generator already produces. Not a second authority; a naming of them.
import {
  SECURITY_FAMILIES,
  classifyRouteSecurity,
} from "./capability-authority/security-families.mjs";
// PHASE 13 §1 — tenant binding, derived over the import-resolved call graph.
import {
  buildCallGraph,
  analyzeHandlerTenancy,
  classifyTenantBinding,
  DATA_SCOPES as DATA_SCOPE_KEYS,
} from "./capability-authority/tenant-binding.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_DIR = path.join(HERE, "capability-authority", "manifests");
const OUT = path.join(REPO, "docs/architecture/current-runtime-capability-map.json");

export const GENERATOR_VERSION = "2.0.0";
const SCHEMA_VERSION = "capability-map@2";

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const sha256 = (v) => createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex");

// ===========================================================================
// DISPOSITIONS — the closed vocabulary for a route with no product consumer.
//
// Each carries what must be TRUE for it, not merely what it is called. A
// disposition whose requirement is unmet is refused, because "MACHINE_CONSUMER"
// with no machine caller anywhere in the tree is not a classification, it is a
// wish.
// ===========================================================================

const DISPOSITIONS = Object.freeze({
  MACHINE_CONSUMER: { needsMachineCaller: true },
  WORKER_CONSUMER: { needsMachineCaller: true, callerClass: "WORKER" },
  CRON_CONSUMER: { needsMachineAuth: true },
  WEBHOOK_ENTRYPOINT: { needsAuthClass: ["WEBHOOK_SIGNATURE", "MULTI_GATE", "API_KEY_SCOPED"] },
  PROVIDER_CALLBACK: {},
  SCIM_ENTRYPOINT: { needsAuthClass: ["SCIM_BEARER", "MULTI_GATE"] },
  PUBLIC_EXTERNAL_API: {},
  ADMIN_ONLY_PRODUCT: {},
  OPERATOR_CLI: {},
  INTERNAL_SERVICE: {},
  INTENTIONALLY_API_ONLY: {},
  WEB_UI_MISSING: { forbidsProductConsumer: true },
  MOBILE_UI_MISSING: {},
  SUPERSEDED_REMOVE: { needsReplacement: true, forbidsProductConsumer: true },
  ORPHAN_DEFECT: { forbidsProductConsumer: true },
  DEVELOPMENT_ONLY: {},
  PUBLIC_PRODUCT_SURFACE: {},

  // ---------------------------------------------------------------------
  // PHASE 13 §C — the mandate's disposition vocabulary.
  //
  // The names above grew one at a time and describe the CALLER
  // (`WORKER_CONSUMER`, `CRON_CONSUMER`, `MACHINE_CONSUMER` are three names
  // for "a machine calls it"). The mandate asks a different question — what is
  // this route FOR, and does the product still owe it a surface — and it asks
  // it in a closed list that must sum to the production route count.
  //
  // Both vocabularies live here rather than one replacing the other, because
  // the nine existing reviewed entries were argued in the old names and
  // rewriting them would be re-asserting judgements nobody re-made. The
  // conservation identity below projects both onto the mandate families.
  // ---------------------------------------------------------------------
  PRODUCT_CONNECTED: {},
  EXTERNAL_API: {},
  MACHINE_OR_CRON: {},
  WEBHOOK: { needsAuthClass: ["WEBHOOK_SIGNATURE", "MULTI_GATE", "API_KEY_SCOPED"] },
  ADMIN_OPERATOR: {},
  COMPATIBILITY_TOMBSTONE: { forbidsProductConsumer: true },
  INTENTIONALLY_BACKEND_ONLY: {},
  DEAD_REMOVE: { forbidsProductConsumer: true },
  MISSING_PRODUCT_UI_RELEASE_REQUIRED: { forbidsProductConsumer: true },
  MISSING_PRODUCT_UI_POST_RELEASE: { forbidsProductConsumer: true },
});

/**
 * Legacy disposition name → mandate family, so the conservation identity is
 * computed over ONE vocabulary without rewriting reviewed judgements.
 */
const MANDATE_FAMILY = Object.freeze({
  PRODUCT_CONSUMED: "PRODUCT_CONNECTED",
  PRODUCT_CONNECTED: "PRODUCT_CONNECTED",
  MACHINE_CONSUMER: "MACHINE_OR_CRON",
  WORKER_CONSUMER: "MACHINE_OR_CRON",
  CRON_CONSUMER: "MACHINE_OR_CRON",
  MACHINE_OR_CRON: "MACHINE_OR_CRON",
  WEBHOOK_ENTRYPOINT: "WEBHOOK",
  PROVIDER_CALLBACK: "WEBHOOK",
  WEBHOOK: "WEBHOOK",
  SCIM_ENTRYPOINT: "EXTERNAL_API",
  PUBLIC_EXTERNAL_API: "EXTERNAL_API",
  EXTERNAL_API: "EXTERNAL_API",
  ADMIN_ONLY_PRODUCT: "ADMIN_OPERATOR",
  OPERATOR_CLI: "ADMIN_OPERATOR",
  ADMIN_OPERATOR: "ADMIN_OPERATOR",
  INTERNAL_SERVICE: "INTENTIONALLY_BACKEND_ONLY",
  INTENTIONALLY_API_ONLY: "INTENTIONALLY_BACKEND_ONLY",
  INTENTIONALLY_BACKEND_ONLY: "INTENTIONALLY_BACKEND_ONLY",
  SUPERSEDED_REMOVE: "COMPATIBILITY_TOMBSTONE",
  COMPATIBILITY_TOMBSTONE: "COMPATIBILITY_TOMBSTONE",
  ORPHAN_DEFECT: "DEAD_REMOVE",
  DEAD_REMOVE: "DEAD_REMOVE",
  WEB_UI_MISSING: "MISSING_PRODUCT_UI_RELEASE_REQUIRED",
  MOBILE_UI_MISSING: "MISSING_PRODUCT_UI_POST_RELEASE",
  MISSING_PRODUCT_UI_RELEASE_REQUIRED: "MISSING_PRODUCT_UI_RELEASE_REQUIRED",
  MISSING_PRODUCT_UI_POST_RELEASE: "MISSING_PRODUCT_UI_POST_RELEASE",
  PUBLIC_PRODUCT_SURFACE: "PRODUCT_CONNECTED",
  DEVELOPMENT_ONLY: "DEVELOPMENT_ONLY",
});

const MANDATE_FAMILIES = Object.freeze([
  "PRODUCT_CONNECTED", "EXTERNAL_API", "MACHINE_OR_CRON", "WEBHOOK",
  "ADMIN_OPERATOR", "COMPATIBILITY_TOMBSTONE", "INTENTIONALLY_BACKEND_ONLY",
  "DEAD_REMOVE", "MISSING_PRODUCT_UI_RELEASE_REQUIRED",
  "MISSING_PRODUCT_UI_POST_RELEASE",
]);

// ===========================================================================

function loadManifest(name) {
  const p = path.join(MANIFEST_DIR, name);
  if (!existsSync(p)) return { entries: [] };
  return readJson(p);
}

function sourceRevision() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function generatorHash() {
  // The generator hashes ITSELF and its analyzer modules. A map whose numbers
  // were produced by different code than the code present now is not a fresh
  // measurement, and this is what makes that detectable rather than assumed.
  const files = [
    "scripts/generate-runtime-capability-map.mjs",
    "scripts/capability-authority/analyzer.mjs",
    "scripts/capability-authority/routes.mjs",
    "scripts/capability-authority/consumers.mjs",
  ];
  const h = createHash("sha256");
  for (const f of files) h.update(readFileSync(path.join(HERE, "..", f), "utf8").replace(/\r\n/g, "\n"));
  return h.digest("hex");
}

/**
 * Dispositions that follow from what the analyzers already proved.
 *
 * Each returns the EVIDENCE that forced it, so a reader can check the reasoning
 * without trusting the label. Returns null when the facts do not settle the
 * question — which is most product routes, and those go to a human.
 */
function deriveDisposition(route, machineConsumers) {
  const at = route.registrationEvidence;

  if (!route.productionRegistered) {
    return {
      disposition: "DEVELOPMENT_ONLY",
      derived: true,
      reason: "registered only behind the development auth gate",
      evidence: `${at} — ${route.authorizationEvidence.join("; ")}`,
    };
  }

  const workerCallers = machineConsumers.filter((c) => c.class === "WORKER");
  if (workerCallers.length > 0) {
    return {
      disposition: "WORKER_CONSUMER",
      derived: true,
      reason: "called by the worker service",
      evidence: `${at} — worker caller(s): ${workerCallers.map((c) => `${c.file}:${c.line} (${c.caller})`).join(", ")}`,
    };
  }

  switch (route.authorizationClass) {
    case "DEVELOPMENT_ONLY":
      return {
        disposition: "DEVELOPMENT_ONLY",
        derived: true,
        reason: "the handler refuses unconditionally when NODE_ENV is production, so it is not a production surface",
        evidence: `${at} — ${route.authorizationEvidence.join("; ")}`,
      };
    case "CRON_SECRET":
      return {
        disposition: "CRON_CONSUMER",
        derived: true,
        reason: "gated by the canonical constant-time cron/internal shared secret, so only a scheduler or operator holding it can call it",
        evidence: `${at} — ${route.authorizationEvidence.join("; ")}`,
      };
    case "SCIM_BEARER":
      return {
        disposition: "SCIM_ENTRYPOINT",
        derived: true,
        reason: "authenticated by a SCIM personal access token (RFC 7644 bearer); the client is the customer's identity provider",
        evidence: `${at} — ${route.authorizationEvidence.join("; ")}`,
      };
    case "WEBHOOK_SIGNATURE":
      return {
        disposition: "WEBHOOK_ENTRYPOINT",
        derived: true,
        reason: "authenticated by an inbound provider signature verifier; the caller is the provider",
        evidence: `${at} — ${route.authorizationEvidence.join("; ")}`,
      };
    case "INTERNAL_SERVICE":
      return {
        disposition: "INTERNAL_SERVICE",
        derived: true,
        reason: "authenticated by the internal service token; the caller is another service in this system",
        evidence: `${at} — ${route.authorizationEvidence.join("; ")}`,
      };
    case "API_KEY_SCOPED":
      return {
        disposition: "PUBLIC_EXTERNAL_API",
        derived: true,
        reason: "authenticated by a scoped integration API key, which is the credential issued to external API clients rather than to a browser session",
        evidence: `${at} — ${route.authorizationEvidence.join("; ")}`,
      };
    default:
      return null;
  }
}

/**
 * The retired vocabulary, expressed in terms of what was MEASURED.
 *
 * This is the column FINAL-001 is about. It used to be typed in and it was wrong
 * on 176 of 1083 rows. It is kept only so existing gates keep speaking, and it is
 * now a pure function of a measured consumer set and a reviewed disposition.
 */
function legacyClassification(route) {
  if (!route.productionRegistered) return "INTERNAL_REQUIRED";
  if (route.productConsumers.length > 0) return "TARGET_COMPLETE";
  if (route.primaryDisposition === null) return "BACKEND_ONLY_UNWIRED";
  switch (route.primaryDisposition) {
    case "WEB_UI_MISSING":
    case "MOBILE_UI_MISSING":
    case "ORPHAN_DEFECT":
      return "BACKEND_ONLY_UNWIRED";
    case "SUPERSEDED_REMOVE":
      return "COMPATIBILITY_TEMPORARY";
    default:
      return "INTERNAL_REQUIRED";
  }
}

export function build() {
  const problems = [];

  // --- reviewed manifests ------------------------------------------------
  const originManifest = loadManifest("origin-resolutions.json");
  const dynamicManifest = loadManifest("dynamic-resolutions.json");
  const consumerManifest = loadManifest("consumer-resolutions.json");
  const dispositionManifest = loadManifest("route-dispositions.json");
  const preservationManifest = loadManifest("writer-preservations.json");
  const portManifest = loadManifest("port-implementations.json");

  const originResolutions = new Map(originManifest.entries.map((e) => [e.site, e.verdict]));
  const dynamicResolutions = new Map(dynamicManifest.entries.map((e) => [e.site, e.class]));
  const consumerResolutions = new Map(consumerManifest.entries.map((e) => [e.site, e.routes]));

  // --- analysis ----------------------------------------------------------
  const index = indexApiFunctions();
  const { routes: registrations, dynamicUnresolved: routeDynamic } = extractRoutes(index);
  const {
    consumers,
    dynamicUnresolved,
    reviewedUnresolved,
    synthesized,
    foreignOrUnknownOrigin,
  } = analyzeConsumers(originResolutions, dynamicResolutions, consumerResolutions);

  // PHASE 13 §1 — the import-resolved call graph, built ONCE for the whole run.
  // Used below to derive each route's tenant binding by following its handler
  // and guards to terminal membership authorities and Prisma accesses.
  const callGraph = buildCallGraph();

  /** @type {Map<string, object>} */
  const routeById = new Map();
  /**
   * PHASE 13 §B — the route half of the mutation entrypoint set, captured while
   * the handler node is already resolved rather than resolved a second time.
   * @type {Array<{kind:string,id:string,node:any,file:string}>}
   */
  const mutationEntrypoints = [];
  for (const r of registrations) {
    const auth = classifyRouteAuth(r, index);
    // Tenancy is analysed per REGISTRATION (handler + options), then attached
    // to each method's row below — a registration's methods share one handler.
    //
    // A handler passed BY REFERENCE (`{ handler: listCases }`, or an imported
    // handler module) is an identifier, not a function body. Walking the
    // identifier reaches nothing, so it is resolved to its declaration through
    // the same import table the call graph uses — and analysed IN THE FILE THAT
    // DECLARES IT, because that file's imports are what its own calls resolve
    // against. Resolving it in the registering file's context would associate
    // the wrong declarations with the route.
    const resolvedHandler = resolveValueDeclaration(r.handler, r.registeringFile, callGraph);
    const handlerNode = resolvedHandler ? resolvedHandler.node : r.handler;
    const handlerFile = resolvedHandler ? resolvedHandler.file : r.registeringFile;
    const tenancy = handlerNode
      ? analyzeHandlerTenancy(handlerNode, handlerFile, callGraph, 8,
          r.options ? [{ node: r.options, file: r.registeringFile }] : [])
      : null;
    for (const m of r.methods) {
      const routeId = `${m.toUpperCase()} ${r.route}`;
      if (handlerNode && !r.devOnly) {
        mutationEntrypoints.push({ kind: "ROUTE", id: routeId, node: handlerNode, file: handlerFile });
      }
      if (routeById.has(routeId)) {
        problems.push({ kind: "DUPLICATE_REGISTRATION", routeId, file: r.registeringFile });
        continue;
      }
      routeById.set(routeId, {
        routeId,
        method: m.toUpperCase(),
        path: r.route,
        productionRegistered: !r.devOnly,
        registrationEvidence: `${r.registeringFile}:${r.registrationLine}`,
        authorizationClass: auth.authClassification,
        authorizationEvidence: auth.authEvidence,
        gates: auth.gates,
        tenancyAnalysis: tenancy,
      });
    }
  }

  const routeIds = [...routeById.keys()];
  const { byRoute, unmatched, ambiguous } = attachConsumers(
    routeIds,
    consumers,
    matches,
    consumerResolutions,
  );

  // Consumers a human resolved at a site the analyzer could not read at all —
  // the route is named directly rather than matched by path. Attached after
  // matching because there is nothing to match: the path never existed as a
  // literal anywhere in the call.
  for (const s of synthesized) {
    if (!byRoute.has(s.routeId)) {
      problems.push({ kind: "CONSUMER_RESOLUTION_NOT_REGISTERED", site: `${s.file}:${s.line}`, routeId: s.routeId });
      continue;
    }
    byRoute.get(s.routeId).push(s);
  }

  // --- per-route projection ---------------------------------------------
  const routesOut = [];
  for (const routeId of routeIds) {
    const base = routeById.get(routeId);
    const cs = byRoute.get(routeId) ?? [];
    const productConsumers = cs.filter((c) => c.product);
    const machineConsumers = cs.filter((c) => !c.product);

    // -----------------------------------------------------------------------
    // PRIMARY DISPOSITION — exactly one per route, and the sets are DISJOINT.
    //
    // The previous revision assigned a derived disposition to every route the
    // facts settled, INCLUDING routes that already had a product consumer, and
    // then counted those dispositions in `byDisposition` while `result` said
    // PRODUCT_CONNECTED. `POST /v1/admin/demo-requests/follow-up/run` is a real
    // dual-mode route — a web admin page calls it AND the worker tick calls it —
    // so it appeared in both the 816 and the 45. That is why 265 - 45 did not
    // equal 225: the base was wrong (269 routes lack a product consumer, not
    // 265, because the 4 machine-only routes also lack one) and the disposition
    // count was wrong (44 of the 45 belong to routes without a product
    // consumer). 269 - 44 = 225, which is the number that was reported without
    // a set of premises that could produce it.
    //
    // A count nobody can re-derive is the same failure FINAL-001 is about, one
    // level up. So the primary disposition is now a total function with a fixed
    // precedence, every route gets exactly one, and the conservation identity is
    // asserted by the generator rather than by arithmetic in a report.
    // -----------------------------------------------------------------------
    const reviewed = dispositionManifest.entries?.find((d) => d.routeId === routeId) ?? null;

    let primary;
    if (!base.productionRegistered) {
      // Not a Production surface at all. Carved out of the Production identity
      // rather than counted inside it.
      primary = {
        disposition: "DEVELOPMENT_ONLY",
        derived: true,
        reason: "registered only behind the development auth gate",
        evidence: `${base.registrationEvidence} — ${base.authorizationEvidence.join("; ")}`,
      };
    } else if (productConsumers.length > 0) {
      // A human can reach it. That outranks every machine fact about it; the
      // worker caller is still recorded, as a NON-PRIMARY consumer.
      primary = {
        disposition: "PRODUCT_CONSUMED",
        derived: true,
        reason: "reached from a product surface",
        evidence: productConsumers
          .slice(0, 3)
          .map((c) => `${c.file}:${c.line} (${c.caller}, ${c.class})`)
          .join("; "),
      };
    } else {
      // A DERIVED disposition is one the fact base already settles — a route
      // gated by a constant-time cron secret is a scheduled machine surface, and
      // a hand-typed copy of a generated fact is the hand-maintained column
      // again. Judgement stays in the manifest; derivation stays here.
      primary = reviewed ?? deriveDisposition(base, machineConsumers);
    }

    const disposition = primary;
    const result =
      primary === null ? "UNDISPOSED" : `DISPOSED_${primary.disposition}`;

    routesOut.push({
      ...base,
      productConsumers: productConsumers.map((c) => ({
        file: c.file,
        line: c.line,
        caller: c.caller,
        class: c.class,
        primitive: c.primitive,
        viaResolution: c.viaResolution === true,
      })),
      // Named `nonProductConsumers` because that is what they are: a caller that
      // is not a product surface. A route may have both, and recording the
      // machine caller as SECONDARY is what lets the primary set stay disjoint
      // without throwing the fact away.
      nonProductConsumers: machineConsumers.map((c) => ({
        file: c.file,
        line: c.line,
        caller: c.caller,
        class: c.class,
        primitive: c.primitive,
      })),
      primaryDisposition: disposition?.disposition ?? null,
      dispositionSource: disposition === null ? null : disposition.derived === true ? "DERIVED" : "REVIEWED",
      dispositionEvidence: disposition?.evidence ?? null,
      dispositionReason: disposition?.reason ?? null,
      replacement: disposition?.replacement ?? null,
      result,
    });
  }

  // --- refusals ----------------------------------------------------------
  //
  // Every one of these is a claim the tree can contradict. Checking them is the
  // difference between a manifest that records judgement and a manifest that
  // launders assertion.
  const registeredSet = new Set(routeIds);
  for (const d of dispositionManifest.entries ?? []) {
    const spec = DISPOSITIONS[d.disposition];
    if (spec === undefined) {
      problems.push({ kind: "UNKNOWN_DISPOSITION", routeId: d.routeId, disposition: d.disposition });
      continue;
    }
    if (!registeredSet.has(d.routeId)) {
      problems.push({ kind: "STALE_DISPOSITION", routeId: d.routeId });
      continue;
    }
    if (!d.evidence || String(d.evidence).trim().length === 0) {
      problems.push({ kind: "DISPOSITION_WITHOUT_EVIDENCE", routeId: d.routeId });
    }
    const row = routesOut.find((r) => r.routeId === d.routeId);
    if (spec.forbidsProductConsumer && row.productConsumers.length > 0) {
      problems.push({ kind: "CONTRADICTED_DISPOSITION", routeId: d.routeId, disposition: d.disposition, why: "a product consumer exists" });
    }
    if (spec.needsMachineCaller && row.nonProductConsumers.length === 0 && !d.machineCallerEvidence) {
      problems.push({ kind: "CONTRADICTED_DISPOSITION", routeId: d.routeId, disposition: d.disposition, why: "no machine caller found and none named" });
    }
    if (spec.callerClass && row.nonProductConsumers.length > 0 && !row.nonProductConsumers.some((c) => c.class === spec.callerClass)) {
      problems.push({ kind: "CONTRADICTED_DISPOSITION", routeId: d.routeId, disposition: d.disposition, why: `no ${spec.callerClass} caller` });
    }
    if (spec.needsMachineAuth) {
      const ok = ["CRON_SECRET", "INTERNAL_SERVICE", "MULTI_GATE", "ADMIN_GATED", "API_KEY_SCOPED"].includes(row.authorizationClass);
      if (!ok) {
        problems.push({ kind: "CONTRADICTED_DISPOSITION", routeId: d.routeId, disposition: d.disposition, why: `machine disposition on a ${row.authorizationClass} route` });
      }
    }
    if (spec.needsAuthClass && !spec.needsAuthClass.includes(row.authorizationClass)) {
      problems.push({ kind: "CONTRADICTED_DISPOSITION", routeId: d.routeId, disposition: d.disposition, why: `authorization is ${row.authorizationClass}` });
    }
    if (spec.needsReplacement && !d.replacement) {
      problems.push({ kind: "SUPERSEDED_WITHOUT_REPLACEMENT", routeId: d.routeId });
    }
    if (d.replacement && !registeredSet.has(d.replacement)) {
      problems.push({ kind: "REPLACEMENT_NOT_REGISTERED", routeId: d.routeId, replacement: d.replacement });
    }
  }

  // A route registered under the alias prefix can never be reached: the plugin
  // rewrites the URL before Fastify matches, so both spellings 404. FINAL-005.
  for (const r of routesOut) {
    if (isUnreachableAliasRegistration(r.path)) {
      problems.push({
        kind: "UNREACHABLE_ALIAS_REGISTRATION",
        routeId: r.routeId,
        at: r.registrationEvidence,
        why: "workspace-alias.plugin.ts rewrites /v1/workspaces -> /v1/teams in onRequest, before routing; register under /v1/teams instead",
      });
    }
  }

  // -------------------------------------------------------------------------
  // CONSERVATION.
  //
  // Every Production-registered route belongs to exactly ONE primary set:
  //
  //   ProductionRegisteredRoutes
  //     = ProductConsumedRoutes + NonProductDispositionedRoutes + UndisposedRoutes
  //
  // Asserted here rather than left to arithmetic in a report, because the
  // previous revision's totals could not be re-derived from its own premises and
  // nothing in the pipeline noticed. Development-only routes are NOT in this
  // identity: they are not a Production surface, and counting them inside it is
  // how a dev-gated route came to be reported as production-registered.
  // -------------------------------------------------------------------------
  const productionRows = routesOut.filter((r) => r.productionRegistered);
  const devOnlyRows = routesOut.filter((r) => !r.productionRegistered);

  const productConsumed = productionRows.filter((r) => r.primaryDisposition === "PRODUCT_CONSUMED");
  const nonProductDispositioned = productionRows.filter(
    (r) => r.primaryDisposition !== null && r.primaryDisposition !== "PRODUCT_CONSUMED",
  );
  const undisposedRows = productionRows.filter((r) => r.primaryDisposition === null);

  if (
    productConsumed.length + nonProductDispositioned.length + undisposedRows.length !==
    productionRows.length
  ) {
    problems.push({
      kind: "DISPOSITION_CONSERVATION_FAILURE",
      productionRegistered: productionRows.length,
      productConsumed: productConsumed.length,
      nonProductDispositioned: nonProductDispositioned.length,
      undisposed: undisposedRows.length,
    });
  }

  // Overlap is impossible by construction above, so testing it is testing the
  // construction — which is the point: if someone reintroduces a second
  // assignment path, this is what says so.
  for (const r of routesOut) {
    if (r.primaryDisposition === "PRODUCT_CONSUMED" && r.productConsumers.length === 0) {
      problems.push({ kind: "DISPOSITION_OVERLAP", routeId: r.routeId, why: "PRODUCT_CONSUMED with no product caller" });
    }
    if (
      r.primaryDisposition !== null &&
      r.primaryDisposition !== "PRODUCT_CONSUMED" &&
      r.primaryDisposition !== "DEVELOPMENT_ONLY" &&
      r.productConsumers.length > 0
    ) {
      problems.push({
        kind: "DISPOSITION_OVERLAP",
        routeId: r.routeId,
        why: `${r.primaryDisposition} on a route that HAS a product caller`,
      });
    }
    if (!r.productionRegistered && r.primaryDisposition !== "DEVELOPMENT_ONLY") {
      problems.push({ kind: "DEV_ONLY_COUNTED_AS_PRODUCTION", routeId: r.routeId });
    }
  }
  if (devOnlyRows.some((r) => r.primaryDisposition !== "DEVELOPMENT_ONLY")) {
    problems.push({ kind: "DEV_ONLY_DISPOSITION_MISMATCH" });
  }

  const seenDisposition = new Set();
  for (const d of dispositionManifest.entries ?? []) {
    if (seenDisposition.has(d.routeId)) problems.push({ kind: "DUPLICATE_DISPOSITION", routeId: d.routeId });
    seenDisposition.add(d.routeId);
  }

  for (const e of consumerManifest.entries ?? []) {
    for (const rid of e.routes ?? []) {
      if (!registeredSet.has(rid)) problems.push({ kind: "CONSUMER_RESOLUTION_NOT_REGISTERED", site: e.site, routeId: rid });
    }
  }

  // A reviewed exemption whose subject the analyzer can now resolve on its own
  // is not harmless — it is a standing permission to ignore a call site, kept
  // alive by nobody re-checking it. Every improvement to the resolver should
  // SHRINK these manifests, and this is what makes that visible instead of
  // letting dead exemptions accumulate.
  const stillUnresolvedSites = new Set([...dynamicUnresolved.map((d) => `${d.file}:${d.line}`), ...reviewedUnresolved]);
  for (const e of dynamicManifest.entries ?? []) {
    if (!stillUnresolvedSites.has(e.site)) {
      problems.push({
        kind: "STALE_DYNAMIC_RESOLUTION",
        site: e.site,
        why: "the analyzer now resolves this call site (or it has moved); the exemption is dead and must be removed",
      });
    }
  }

  // --- PHASE 13 §2: security-family classification -----------------------
  //
  // Enrich every route in place with its primary security family (+ secondary
  // domain tags + named authorities), derived from the authorization facts
  // above. Then refuse the artifact if any PRODUCTION route came out
  // unclassified — a null primary is a genuine gap, never a silent default.
  for (const r of routesOut) {
    const classified = classifyRouteSecurity(r);
    r.primarySecurityFamily = classified.primarySecurityFamily;
    r.secondarySecurityFamilies = classified.secondarySecurityFamilies;
    r.authenticationAuthority = classified.authenticationAuthority;
    r.authorizationAuthority = classified.authorizationAuthority;

    // PHASE 13 §1 — the tenancy verdict. It supersedes the placeholder
    // `tenantBindingAuthority` the family pass emitted, because it is derived
    // from the ACTUAL handler+guard traversal rather than from the family name.
    if (r.tenancyAnalysis) {
      const t = classifyTenantBinding(r, r.tenancyAnalysis);
      r.dataScope = t.dataScope;
      r.tenantType = t.tenantType;
      r.tenantBindingAuthority = t.tenantBindingAuthority;
      r.membershipStatusRequirement = t.membershipStatusRequirement;
      r.modelsRead = t.modelsRead;
      r.modelsWritten = t.modelsWritten;
      r.tenantBindingResolved = t.tenantBindingResolved;
      r.tenantBindingEvidence = t.tenantBindingEvidence;
      // PHASE 13 §1b — the remaining per-route tenancy facts the mandate
      // requires each route to carry, so a binding can be argued with rather
      // than merely trusted.
      r.tenantIdSource = t.tenantIdSource;
      r.organizationLifecycleRequirement = t.organizationLifecycleRequirement;
      r.crossTenantRefusalSemantics = t.crossTenantRefusalSemantics;
      r.tenantStampingInsertSites = t.tenantStampingInsertSites;
      r.tenantUnboundInsertSites = t.tenantUnboundInsertSites;
    } else {
      // No handler node could be extracted, so tenancy is UNKNOWN — recorded as
      // unresolved rather than assumed safe. An analysis gap must never read as
      // a pass.
      r.dataScope = null;
      r.tenantType = null;
      r.tenantBindingAuthority = classified.tenantBindingAuthority;
      r.membershipStatusRequirement = null;
      r.tenantBindingResolved = false;
      r.tenantBindingEvidence = ["handler node not statically extractable"];
      r.tenantIdSource = "UNRESOLVED";
      r.organizationLifecycleRequirement = "NOT_REACHED";
      r.crossTenantRefusalSemantics = "NONE_OBSERVED";
      r.tenantStampingInsertSites = [];
      r.tenantUnboundInsertSites = [];
    }
    // The raw analysis is working state, not a published fact.
    delete r.tenancyAnalysis;
  }
  // A route whose terminal gate is the production-sacred test bypass
  // (`DEVELOPMENT_ONLY`: returns 404 unless NODE_ENV != production) is not a
  // production security surface even though it is registered in the router. It
  // is excluded from the security denominator, exactly as the mandate requires
  // development-only routes to be — and counted separately so the exclusion is
  // visible, never silent.
  const securityProductionRows = productionRows.filter(
    (r) => r.authorizationClass !== "DEVELOPMENT_ONLY",
  );
  const developmentGatedRoutes = productionRows.length - securityProductionRows.length;
  for (const r of securityProductionRows) {
    if (r.primarySecurityFamily === null) {
      problems.push({
        kind: "UNCLASSIFIED_SECURITY_ROUTE",
        routeId: r.routeId,
        why: `authorizationClass=${r.authorizationClass} produced no security family`,
      });
    }
    if (!SECURITY_FAMILIES.includes(r.primarySecurityFamily) && r.primarySecurityFamily !== null) {
      problems.push({
        kind: "INVALID_SECURITY_FAMILY",
        routeId: r.routeId,
        family: r.primarySecurityFamily,
      });
    }
  }

  // ---------------------------------------------------------------------
  // PHASE 13 §B — MUTATION CLOSURE.
  //
  // Runs here because it needs the finished route facts: a writer's
  // authorization and tenant binding are READ from the pass that measured them,
  // never re-decided, so the two answers cannot disagree. A writer inherits the
  // WEAKEST of its entry routes — a mutation governed on one path and
  // ungoverned on another is ungoverned.
  // ---------------------------------------------------------------------
  const mutationWriters = discoverMutationTerminals(callGraph);

  // MODULE-SCOPED ATTRIBUTION.
  //
  // `admin-provisioning.routes.ts` registers its suspend/resume legs from a
  // DESCRIPTOR TABLE: the work is an arrow function held in the table, the
  // handler calls the loop binding `run(...)`, and the import the writer sits
  // behind is reached from the table rather than from the handler body. Ten
  // organization-lifecycle writers therefore read as DEAD_UNREACHABLE while
  // being one platform-admin request away.
  //
  // Every registering module is added as an entrypoint in its own right. That
  // proves REACHABILITY honestly — these writers are reached from a registered
  // route module — without inventing a per-route attribution the source does
  // not support. The per-route facts stay attached where the handler walk
  // could establish them, and a writer that only ever appears under a module
  // id says so.
  const routeModules = new Set(registrations.filter((r) => !r.devOnly).map((r) => r.registeringFile));
  for (const file of routeModules) {
    const entry = callGraph.graph.get(file);
    if (entry) mutationEntrypoints.push({ kind: "MODULE", id: `MODULE ${file}`, node: entry.sf, file });
  }

  // The job half of the entrypoint set: every processor bound to a queue in the
  // worker. Without it, every queue-driven mutation reads as unreachable, which
  // would be the most reassuring possible lie about a background system.
  const workRegistry = readWorkRegistry();
  for (const [file, entry] of callGraph.graph) {
    if (!file.startsWith("services/worker/src/")) continue;
    const sf = entry.sf;
    const visitWorker = (n) => {
      const isWorkerCtor =
        (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "Worker") ||
        (ts.isCallExpression(n) &&
          ts.isIdentifier(n.expression) &&
          /^(createWorker|registerWorker|startWorker)$/.test(n.expression.text));
      if (isWorkerCtor) {
        const nameArg = n.arguments?.[0];
        const handlerArg = n.arguments?.[1];
        const qName = nameArg
          ? ts.isStringLiteralLike(nameArg)
            ? nameArg.text
            : ts.isIdentifier(nameArg)
              ? nameArg.text
              : ts.isPropertyAccessExpression(nameArg)
                ? nameArg.name.text
                : "UNRESOLVED_QUEUE_NAME"
          : "UNRESOLVED_QUEUE_NAME";
        if (handlerArg) {
          const resolved = resolveValueDeclaration(handlerArg, file, callGraph);
          mutationEntrypoints.push({
            kind: "JOB",
            id: `JOB ${qName}`,
            node: resolved ? resolved.node : handlerArg,
            file: resolved ? resolved.file : file,
          });
        }
      }
      // A scheduled sweep is an entrypoint too, and it is a plain exported
      // function rather than a Worker binding.
      if (
        ts.isFunctionDeclaration(n) &&
        n.name &&
        /^(run|process|sweep|reconcile|purge|expire|dispatch|tick)/i.test(n.name.text) &&
        n.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        mutationEntrypoints.push({ kind: "JOB", id: `SWEEP ${file}#${n.name.text}`, node: n, file });
      }
      ts.forEachChild(n, visitWorker);
    };
    visitWorker(sf);
  }

  // SCHEDULED ENTRYPOINTS — the timers a booted process arms.
  //
  // The capture-draft reaper, the exchange-package builder and the worker
  // telemetry sampler are none of a route, a queue job or a module-scoped
  // registration: each is a plain function handed to `setInterval` by a
  // `start*Scheduler()` that boot calls once. Their eleven writers therefore
  // read as DEAD_UNREACHABLE while running every sixty seconds in production —
  // the most dangerous direction for this number to be wrong in.
  //
  // A timer callback is admitted ONLY when the declaration that arms it is
  // itself reachable from a process entry file. Accepting every `setTimeout`
  // in the tree would let a dead retry helper certify its own writers as live,
  // which is the exact failure this bucket exists to expose.
  const TIMER_REGISTRARS = new Set(["setInterval", "setTimeout", "setImmediate"]);
  const bootEntryFiles = [...callGraph.graph.keys()].filter((f) =>
    /^services\/(worker|api)\/src\/index\.ts$/.test(f),
  );

  /** Every declaration this node calls, resolved through the import table. */
  const calleesOf = (node, file) => {
    const out = [];
    const visit = (n) => {
      if (ts.isCallExpression(n)) {
        const r = resolveCall(n, file, callGraph);
        if (r.ok) out.push(`${r.file}#${r.name}`);
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return out;
  };

  // Forward closure from boot. Seeded with the WHOLE entry file, because boot
  // work is reached through a `main()` the file invokes at module scope.
  const bootReached = new Set();
  const bootWork = [];
  const admit = (key) => {
    if (bootReached.has(key)) return;
    bootReached.add(key);
    bootWork.push(key);
  };
  for (const f of bootEntryFiles) {
    const e = callGraph.graph.get(f);
    if (e) for (const k of calleesOf(e.sf, f)) admit(k);
  }
  while (bootWork.length > 0) {
    const key = bootWork.pop();
    const hash = key.lastIndexOf("#");
    const file = key.slice(0, hash);
    const name = key.slice(hash + 1);
    const e = callGraph.graph.get(file);
    const decl = e?.decls.get(name);
    if (!decl) continue;
    for (const k of calleesOf(decl, file)) admit(k);
  }

  // BOOT-INVOKED WORKER FUNCTIONS.
  //
  // Not every startup task is a timer. `startTelemetrySampler()` is called by
  // name from the worker entry file and arms its own loop from a CLOSURE, so
  // neither the queue-processor rule nor the timer rule above sees it — and its
  // two snapshot writers, which run every sixty seconds in production, read as
  // dead.
  //
  // Only DIRECT callees of the worker entry file are admitted. That file is a
  // process bootstrap rather than a route registrar, so "this process calls
  // this function by name" is a bounded, checkable claim, and the fixpoint
  // carries it the rest of the way down. Widening this to the API entry file
  // would sweep in every route module it registers and re-label request-driven
  // writers as startup work.
  const WORKER_ENTRY = "services/worker/src/index.ts";
  const workerEntry = callGraph.graph.get(WORKER_ENTRY);
  if (workerEntry) {
    const bootSf = workerEntry.sf;
    const visitBoot = (n) => {
      if (ts.isCallExpression(n)) {
        const r = resolveCall(n, WORKER_ENTRY, callGraph);
        if (r.ok && r.file !== WORKER_ENTRY) {
          const target = callGraph.graph.get(r.file)?.decls.get(r.name);
          if (target) {
            const line = bootSf.getLineAndCharacterOfPosition(n.getStart(bootSf)).line + 1;
            mutationEntrypoints.push({
              kind: "SCHEDULE",
              id: `BOOT ${WORKER_ENTRY}:${line}#${r.name}`,
              node: target,
              file: r.file,
            });
          }
        }
      }
      ts.forEachChild(n, visitBoot);
    };
    visitBoot(bootSf);
  }

  for (const [file, entry] of callGraph.graph) {
    if (!/^(services|packages)\//.test(file)) continue;
    const sf = entry.sf;
    // decl name -> node, for naming the arming site and testing boot reach.
    const declRanges = [...entry.decls].map(([name, node]) => ({
      name,
      start: node.getStart(sf),
      end: node.getEnd(),
    }));
    const enclosing = (pos) => {
      let best = null;
      for (const d of declRanges) {
        if (pos >= d.start && pos <= d.end && (!best || d.end - d.start < best.end - best.start)) best = d;
      }
      return best;
    };
    const visitTimer = (n) => {
      if (
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        TIMER_REGISTRARS.has(n.expression.text) &&
        n.arguments.length > 0
      ) {
        const owner = enclosing(n.getStart(sf));
        const armedFromBoot = owner
          ? bootReached.has(`${file}#${owner.name}`)
          : bootEntryFiles.includes(file);
        if (armedFromBoot) {
          const cb = n.arguments[0];
          const resolved = ts.isIdentifier(cb) ? resolveValueDeclaration(cb, file, callGraph) : null;
          const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
          mutationEntrypoints.push({
            kind: "SCHEDULE",
            id: `SCHEDULE ${file}:${line}${owner ? `#${owner.name}` : ""}`,
            node: resolved ? resolved.node : cb,
            file: resolved ? resolved.file : file,
          });
        }
      }
      ts.forEachChild(n, visitTimer);
    };
    visitTimer(sf);
  }

  const mutationReach = resolveMutationEntrypoints(callGraph, mutationWriters, mutationEntrypoints);

  const preservedByDecl = new Map(
    (preservationManifest.entries ?? [])
      .filter((e) => e.verdict === "PRESERVED_PLANNED_WRITER")
      .map((e) => [e.site, e]),
  );

  // PORT IMPLEMENTATIONS — an injected writer, re-verified rather than trusted.
  //
  // Every link of the claimed chain is checked against the tree on THIS run: the
  // adapter must still reference the writer, the executor must still call the
  // port method, and every named entrypoint must still reference the executor.
  // An entry whose chain has broken is dropped and reported, so the writer falls
  // back to DEAD_UNREACHABLE and the run fails — which is the point. A manifest
  // that cannot go stale loudly is an exemption with extra steps.
  const portBroken = [];
  const portByDecl = new Map();
  for (const impl of portManifest.implementations ?? []) {
    const method = String(impl.port ?? "").split(".").pop() ?? "";
    const readOr = (rel) => {
      try {
        return readFileSync(path.join(REPO, rel), "utf8");
      } catch {
        return null;
      }
    };
    const [file, decl] = String(impl.writer ?? "").split("#");
    const adapterSrc = readOr(impl.adapter);
    const executorSrc = readOr(impl.executor);
    const problems = [];
    if (!adapterSrc) problems.push(`adapter missing: ${impl.adapter}`);
    else if (!adapterSrc.includes(decl)) {
      problems.push(`adapter does not reference ${decl}: ${impl.adapter}`);
    }
    if (!executorSrc) problems.push(`executor missing: ${impl.executor}`);
    else if (!executorSrc.includes(`.${method}(`)) {
      problems.push(`executor never calls .${method}(): ${impl.executor}`);
    }
    for (const ep of impl.entrypoints ?? []) {
      const src = readOr(ep);
      if (!src) problems.push(`entrypoint missing: ${ep}`);
      else if (!src.includes("executeEvidenceDestruction")) {
        problems.push(`entrypoint does not reach the executor: ${ep}`);
      }
    }
    if (!impl.evidence) problems.push("no evidence recorded");
    if (problems.length > 0) {
      portBroken.push(`${impl.writer}: ${problems.join("; ")}`);
      continue;
    }
    portByDecl.set(`${file}#${decl}`, impl);
  }

  const routeFactsById = new Map(routesOut.map((r) => [r.routeId, r]));
  const workRegistryByProducerFile = new Map(
    workRegistry.map((e) => [String(e.canonicalProducer), e]),
  );
  for (const w of mutationWriters.values()) {
    w.invariants = deriveMutationInvariants(w, routeFactsById, workRegistryByProducerFile);
    if (
      w.entryRoutes.length === 0 &&
      w.entryJobs.length === 0 &&
      w.entrySchedules.length === 0 &&
      w.entryModules.length === 0
    ) {
      w.nonRequestDisposition = dispositionUnreached(w.file);
      // A reviewed preservation outranks the file-name heuristic, but ONLY for
      // a writer the heuristic already called dead: an entry here can keep a
      // writer, never re-label one that a route, job or schedule reaches.
      if (w.nonRequestDisposition === "DEAD_UNREACHABLE_WRITER") {
        const port = portByDecl.get(`${w.file}#${w.enclosingDeclaration}`);
        if (port) {
          w.nonRequestDisposition = "INJECTED_PORT_IMPLEMENTATION";
          w.portImplementation = {
            port: port.port,
            adapter: port.adapter,
            executor: port.executor,
            entrypoints: port.entrypoints,
            evidence: port.evidence,
            reviewedAtUtc: port.reviewedAtUtc ?? null,
          };
        }
      }
      if (w.nonRequestDisposition === "DEAD_UNREACHABLE_WRITER") {
        const entry = preservedByDecl.get(`${w.file}#${w.enclosingDeclaration}`);
        if (entry) {
          w.nonRequestDisposition = "PRESERVED_PLANNED_WRITER";
          w.preservation = {
            capability: entry.capability ?? null,
            evidence: entry.evidence ?? null,
            missingIntegration: entry.missingIntegration ?? null,
            reviewedAtUtc: entry.reviewedAtUtc ?? null,
          };
        }
      }
    }
  }

  // A preservation entry must carry BOTH the capability it keeps and the
  // evidence for keeping it, or it is an exemption wearing a manifest's
  // clothes. Entries that match no writer are reported too: a stale entry is
  // how a manifest silently stops describing the tree it governs.
  const preservationsWithoutEvidence = [...preservedByDecl.values()].filter(
    (e) => !e.capability || !e.evidence || !e.missingIntegration,
  );
  const usedPreservations = new Set(
    [...mutationWriters.values()]
      .filter((w) => w.nonRequestDisposition === "PRESERVED_PLANNED_WRITER")
      .map((w) => `${w.file}#${w.enclosingDeclaration}`),
  );
  const preservationsUnmatched = [...preservedByDecl.keys()].filter(
    (k) => !usedPreservations.has(k),
  );

  const mutationCounters = evaluateMutationClosure(mutationWriters);
  const mutationQueues = queueTopology(callGraph, mutationWriters, workRegistry);
  mutationCounters.OrphanQueueProducers = mutationQueues.orphanProducers.length;
  mutationCounters.QueueRegistryProblems = mutationQueues.problems.length;
  mutationCounters.ParallelMutationAuthorities = mutationQueues.parallelAuthorities.length;
  mutationCounters.LegacyWriters = mutationQueues.legacyProducers.length;
  mutationCounters.NonIdempotentRetryableEffects = mutationQueues.nonIdempotentRetryable.length;
  mutationCounters.UnprocessedQueueFamilies = mutationQueues.unprocessedFamilies.length;
  // The number a gate may key on: an import THIS REPOSITORY owns whose export
  // the graph could not locate. `METHOD_ON_VALUE` (a method on a local value —
  // overwhelmingly a library call) is reported beside it but never summed in,
  // because following it by global name is the exact defect `call-graph.mjs`
  // exists to avoid.
  mutationCounters.MutationReachabilityUnresolved = mutationReach.projectGaps.length;
  mutationCounters.MutationUnresolvedByReason = mutationReach.unresolvedByReason;
  mutationCounters.MutationFixpointRounds = mutationReach.fixpointRounds;

  // --- counters ----------------------------------------------------------
  const count = (pred) => routesOut.filter(pred).length;
  const byDisposition = {};
  for (const key of Object.keys(DISPOSITIONS)) {
    byDisposition[key] = count((r) => r.primaryDisposition === key);
  }
  const byMandateDisposition = { DEVELOPMENT_ONLY: 0, UNDISPOSED: 0 };
  for (const f of MANDATE_FAMILIES) byMandateDisposition[f] = 0;
  for (const r of routesOut) {
    if (r.primaryDisposition === null) {
      byMandateDisposition.UNDISPOSED++;
      continue;
    }
    const fam = MANDATE_FAMILY[r.primaryDisposition];
    if (fam === undefined) {
      // A disposition with no mandate family is a hole in the projection, not
      // a route to quietly drop out of the identity.
      problems.push({ kind: "DISPOSITION_WITHOUT_MANDATE_FAMILY", routeId: r.routeId, disposition: r.primaryDisposition });
      continue;
    }
    byMandateDisposition[fam]++;
  }

  // Family counts: `primary` is the disjoint enforcement classification (sums
  // to ProductionRegisteredRoutes); `tagged` includes secondary domain tags and
  // therefore overlaps, so it is reported separately and never summed.
  const inSecurityDenominator = (r) =>
    r.productionRegistered && r.authorizationClass !== "DEVELOPMENT_ONLY";

  // --- organization surface ------------------------------------------------
  // A route is on the organization surface when its PATH says so or when it
  // reads or mutates an organization-owned model. Both halves are needed: the
  // path alone misses `/v1/teams/:id/…` routes that reach organization rows,
  // and the models alone miss `POST /v1/orgs` (which creates the first one).
  const ORG_OWNED_MODELS = new Set([
    "organization", "organizationMembership", "organizationInvite",
    "organizationInvitation", "organizationDomain", "organizationPolicy",
    "organizationAuditEvent", "organizationSecurityPolicy",
    "organizationClosureRequest", "organizationNotificationPolicy",
    "ssoConnection", "scimProvisioningToken", "scimGroup",
  ]);
  const ORG_PATH = /^\/v1\/orgs(\/|$)|^\/v1\/organizations?(-|\/|$)|^\/v[12]\/scim(\/|$)/;
  // Families whose own credential already carries the organization identity.
  const ORG_SUFFICIENT_FAMILIES = new Set([
    "ORGANIZATION_AUTHORIZED", "PLATFORM_ADMIN", "SCIM_BEARER",
    "SAML", "OIDC", "CRON_OR_MACHINE_SECRET", "API_KEY_SCOPED",
    "WEBHOOK_SIGNATURE", "PORTAL_OR_REVIEWER_TOKEN",
  ]);
  // Tenant-id sources that represent NO authority decision at all.
  const ORG_NO_AUTHORITY_SOURCES = new Set(["UNRESOLVED", "NONE", "AUTHENTICATED_SUBJECT"]);
  const touchesOrgModels = (r) =>
    [...(r.modelsRead ?? []), ...(r.modelsWritten ?? [])].some((m) => ORG_OWNED_MODELS.has(m));
  const isOrganizationRoute = (r) => ORG_PATH.test(r.path) || touchesOrgModels(r);
  const mutatesOrganizationOwnedRows = (r) =>
    (r.modelsWritten ?? []).some((m) => ORG_OWNED_MODELS.has(m));
  const bySecurityFamily = {};
  for (const fam of SECURITY_FAMILIES) {
    bySecurityFamily[fam] = {
      primary: count((r) => inSecurityDenominator(r) && r.primarySecurityFamily === fam),
      tagged: count(
        (r) =>
          inSecurityDenominator(r) &&
          (r.primarySecurityFamily === fam ||
            (r.secondarySecurityFamilies || []).includes(fam)),
      ),
    };
  }
  const classifiedSecurityRoutes = count(
    (r) => inSecurityDenominator(r) && r.primarySecurityFamily !== null,
  );
  const unclassifiedSecurityRoutes = count(
    (r) => inSecurityDenominator(r) && r.primarySecurityFamily === null,
  );

  const totals = {
    RegisteredRoutes: routesOut.length,
    ProductionRegisteredRoutes: productionRows.length,
    DevelopmentOnlyRoutes: devOnlyRows.length,

    // The three DISJOINT primary sets. These are the only three that are
    // required to sum, and the generator refuses the artifact when they do not.
    ProductConsumedRoutes: productConsumed.length,
    NonProductDispositionedRoutes: nonProductDispositioned.length,
    UndisposedRoutes: undisposedRows.length,
    ConservationIdentityHolds:
      productConsumed.length + nonProductDispositioned.length + undisposedRows.length ===
      productionRows.length,

    // Descriptive, NOT part of the identity. `ProductConsumerRoutes` counts
    // every route with a product caller including dev-only ones, and
    // `MachineOnlyConsumerRoutes` overlaps nothing but is not a primary set.
    // Keeping them separately named is what stopped them being summed with the
    // disposition counts as though they were disjoint.
    ProductConsumerRoutes: count((r) => r.productConsumers.length > 0),
    MachineOnlyConsumerRoutes: count((r) => r.productConsumers.length === 0 && r.nonProductConsumers.length > 0),
    NoConsumerRoutes: count((r) => r.productConsumers.length === 0 && r.nonProductConsumers.length === 0),
    AuthorizationUnresolved: count((r) => r.authorizationClass === "AUTHORIZATION_UNRESOLVED"),
    PublicUnguardedRoutes: count((r) => r.authorizationClass === "PUBLIC_UNGUARDED"),
    DynamicUnresolvedRouteRegistrations: routeDynamic.length,
    DynamicUnresolvedConsumers: dynamicUnresolved.length,
    UnreviewedOriginConsumers: foreignOrUnknownOrigin.length,
    AmbiguousConsumerSites: ambiguous.length,
    UnmatchedConsumerCalls: unmatched.length,
    ClassificationConflicts: problems.length,
    WrongOriginConsumers: consumers.filter((c) => c.wrongOrigin).length,
    byDisposition,

    // PHASE 13 §B — mutation closure counters, row-derived.
    ...mutationCounters,
    MutationClosurePass:
      mutationCounters.UnclassifiedMutationWriters === 0 &&
      mutationCounters.MutationReachabilityUnresolved === 0 &&
      mutationCounters.AuthorizationAfterMutation === 0 &&
      mutationCounters.TenantUnboundMutations === 0 &&
      mutationCounters.UnsafeEffectsInsideTransactions === 0 &&
      mutationCounters.OrphanQueueProducers === 0 &&
      mutationCounters.QueueRegistryProblems === 0 &&
      mutationCounters.ParallelMutationAuthorities === 0 &&
      mutationCounters.LegacyWriters === 0 &&
      mutationCounters.NonIdempotentRetryableEffects === 0 &&
      mutationCounters.UnprocessedQueueFamilies === 0 &&
      mutationCounters.MutationConservationHolds === true &&
      mutationCounters.MutationWriterConservationHolds === true &&
      mutationCounters.WriterBucketOverlaps === 0 &&
      mutationCounters.WriterBucketMissing === 0 &&
      mutationCounters.UnresolvedWriters === 0 &&
      mutationCounters.ModuleScopedAttributionWriters === 0 &&
      // PHASE 13 §4 — an unreached writer must be wired, preserved on the
      // record, or removed. None of those is "left as it was".
      mutationCounters.DeadUnreachableWritersPending === 0 &&
      preservationsWithoutEvidence.length === 0 &&
      preservationsUnmatched.length === 0,

    PreservedWritersWithoutEvidence: preservationsWithoutEvidence.length,
    PreservationEntriesUnmatched: preservationsUnmatched.length,

    // PHASE 13 §C — the mandate's conservation identity, over ONE vocabulary.
    // Every production route lands in exactly one family (or is UNDISPOSED),
    // and the sum is asserted rather than arithmetic in a report.
    byMandateDisposition,
    MandateDispositionConservationHolds:
      MANDATE_FAMILIES.reduce((s, f) => s + byMandateDisposition[f], 0) +
        byMandateDisposition.DEVELOPMENT_ONLY +
        byMandateDisposition.UNDISPOSED ===
      routesOut.length,

    // PHASE 13 §1 — tenant binding, measured over the resolved call graph.
    // `TenantBindingUnresolved` counts production routes that touch
    // tenant-owned rows with neither a membership decision nor a self
    // predicate, PLUS routes whose handler could not be extracted at all.
    TenantBindingResolved: count(
      (r) => inSecurityDenominator(r) && r.tenantBindingResolved === true,
    ),
    TenantBindingUnresolved: count(
      (r) => inSecurityDenominator(r) && r.tenantBindingResolved !== true,
    ),
    byDataScope: DATA_SCOPE_KEYS.reduce((acc, k) => {
      acc[k] = count((r) => inSecurityDenominator(r) && r.dataScope === k);
      return acc;
    }, {}),
    // PHASE 13 §1b — a route that STAMPS a tenant id onto a new row while
    // reaching no membership decision took that tenant id on trust. Counted
    // apart from tenant binding because it is a different failure: not "who may
    // read these rows" but "whose workspace does this new row claim to be in".
    TenantUnboundInsertRoutes: count(
      (r) => inSecurityDenominator(r) && (r.tenantUnboundInsertSites ?? []).length > 0,
    ),

    // PHASE 13 §1c — THE ORGANIZATION SURFACE, measured in its own right.
    //
    // `ORGANIZATION_SCOPED = 0` was reported for an organization-tier product,
    // and a zero on a dimension the product demonstrably has is a claim about
    // the INSTRUMENT, not the product. It came from two blind spots: a path
    // predicate for `/v1/organizations` (a prefix this API never registers —
    // the surface is `/v1/orgs`) and the absence of `checkOrgAccess` from the
    // terminal-marker table. Both are fixed; these counters exist so the same
    // silence cannot return unnoticed.
    OrganizationRoutesMeasured: count((r) => inSecurityDenominator(r) && isOrganizationRoute(r)),
    OrganizationAuthorizationUnresolved: count(
      (r) => inSecurityDenominator(r) && isOrganizationRoute(r) && r.tenantBindingResolved !== true,
    ),
    // A mutation of organization-owned rows that reached NO authority at all.
    //
    // Workspace authorization DELEGATING to organization scope is a legitimate
    // outcome here, not a gap: `requireIdentityAdmin` loads the workspace
    // membership, refuses a non-ACTIVE one, and hands the decision to
    // `evaluateMemberAccess`, which denies `organization_not_active` for a
    // workspace whose parent CUSTOMER organization is missing, SUSPENDED or
    // ARCHIVED. The organization lifecycle IS enforced on that path, so
    // counting it as missing authorization would have manufactured eight
    // findings out of a correct design.
    OrganizationRoutesMissingRequiredAuthorization: count(
      (r) =>
        inSecurityDenominator(r) &&
        mutatesOrganizationOwnedRows(r) &&
        !ORG_SUFFICIENT_FAMILIES.has(r.primarySecurityFamily) &&
        ORG_NO_AUTHORITY_SOURCES.has(r.tenantIdSource),
    ),
    CurrentWorkspaceIdAuthorizationUses: count(
      (r) => inSecurityDenominator(r) && r.tenantIdSource === "CURRENT_WORKSPACE_HEADER",
    ),

    // PHASE 13 §2 — the 17-family security classification.
    ClassifiedSecurityRoutes: classifiedSecurityRoutes,
    UnclassifiedSecurityRoutes: unclassifiedSecurityRoutes,
    DevelopmentGatedRoutes: developmentGatedRoutes,
    SecurityFamilyConservationHolds:
      classifiedSecurityRoutes + unclassifiedSecurityRoutes + developmentGatedRoutes ===
      productionRows.length,
    bySecurityFamily,
  };

  // --- backward-compatible projection ------------------------------------
  //
  // Three live gates read this artifact's old shape. Replacing the authority
  // must not quietly delete what they depend on — a broken gate that nobody
  // notices is the same failure mode as a hand-maintained number nobody
  // recomputes. So `capabilities` is still emitted, with `vertical` and
  // `evidenceLevel` carried from the taxonomy manifest and `classification` now
  // DERIVED from what was measured rather than typed.
  const taxonomy = new Map(
    (loadManifest("capability-taxonomy.json").entries ?? []).map((e) => [e.routeId, e]),
  );
  const capabilities = routesOut.map((r) => {
    const tax = taxonomy.get(r.routeId);
    return {
      capabilityId: `${r.method}:${r.path}`,
      vertical: tax?.vertical ?? "PLATFORM_CORE",
      method: r.method,
      route: r.path,
      registeringFile: r.registrationEvidence.split(":")[0],
      productConsumer: r.productConsumers[0] ? `${r.productConsumers[0].file}:${r.productConsumers[0].line}` : null,
      machineConsumer: r.nonProductConsumers[0] ? `${r.nonProductConsumers[0].file}:${r.nonProductConsumers[0].line}` : null,
      authorization: r.authorizationClass,
      classification: legacyClassification(r),
      evidenceLevel: tax?.evidenceLevel ?? "UNPROVEN",
    };
  });

  const tally = (rows, key) => {
    const out = {};
    for (const row of rows) out[row[key]] = (out[row[key]] ?? 0) + 1;
    return out;
  };

  const artifact = {
    schemaVersion: SCHEMA_VERSION,
    generatorVersion: GENERATOR_VERSION,
    generator: "services/api/scripts/generate-runtime-capability-map.mjs",
    note:
      "GENERATED. Every field below is derived from the tree at run time by the AST " +
      "analyzers. Human judgement lives ONLY in scripts/capability-authority/manifests/*, " +
      "each entry carrying the source evidence it was read from. Do not hand-edit this file.",
    generatorHash: generatorHash(),
    // NO `sourceRevision`: metadata about the run. Recording it made this
    // artifact differ from itself across every commit. The run prints it.
    routeInventoryHash: sha256(routeIds.slice().sort()),
    consumerInventoryHash: sha256(
      consumers.map((c) => `${c.method ?? "*"} ${c.path} ${c.file}:${c.line}`).sort(),
    ),
    dispositionsHash: sha256(dispositionManifest),
    totals,
    // Legacy projection — the same vocabulary the Phase-12A gate and the
    // operations coverage matrix read, now produced by measurement.
    totalRoutes: capabilities.length,
    classificationCounts: tally(capabilities, "classification"),
    evidenceLevelCounts: tally(capabilities, "evidenceLevel"),
    verticalCounts: tally(capabilities, "vertical"),
    capabilities,
    problems,
    dynamicUnresolvedConsumers: dynamicUnresolved,
    unreviewedOriginConsumers: foreignOrUnknownOrigin,
    ambiguousConsumerSites: ambiguous.map((a) => ({
      site: `${a.file}:${a.line}`,
      method: a.method,
      path: a.path,
      caller: a.caller,
    })),
    unmatchedConsumerCalls: unmatched.map((u) => ({
      site: `${u.file}:${u.line}`,
      method: u.method,
      path: u.path,
    })),
    dynamicUnresolvedRouteRegistrations: routeDynamic,
    // PHASE 13 §B — the mutation rows themselves, in the SAME artifact as the
    // routes. A separate file would be a second inventory to keep in sync,
    // which is the failure this engine exists to prevent.
    mutationQueueTopology: mutationQueues,
    mutationReachabilityUnresolved: mutationReach.projectGaps.slice(0, 200),
    mutationWriters: [...mutationWriters.values()].sort((a, b) =>
      a.writerId.localeCompare(b.writerId),
    ),
    routes: routesOut.sort((a, b) => a.routeId.localeCompare(b.routeId)),
  };

  return artifact;
}

// ===========================================================================
// CLI
// ===========================================================================

/**
 * PHASE 0 — THIS FILE NO LONGER HAS A CLI OF ITS OWN.
 *
 * It used to write the map, compare the map on disk against a fresh build, and
 * exit non-zero when EITHER the instrument had an unresolved call site OR 210
 * routes still needed a product judgement. Three problems came out of that.
 *
 * It read its own output as an input fact, which is the shape §3 of the Phase-0
 * mandate names outright. It owned a second set of exit-code semantics, so
 * "the audit is red" meant two incompatible things depending on which command
 * produced it. And because the second meaning was permanent open work, the red
 * became background noise — which is how the first meaning, the one that says
 * every number here is a guess, stops being read.
 *
 * `build()` stays exported and unchanged: it is the canonical measurement, and
 * this is still the only thing permitted to produce a classification. Writing,
 * staleness and exit codes now belong to the one orchestrator, which keeps
 * INSTRUMENT integrity and PRODUCT closure apart.
 */
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const forward = process.argv.includes("--check") ? ["--engine-check"] : [];
  // spawnSync, not execFileSync: the orchestrator's exit code IS the answer, and
  // execFileSync would turn a non-zero one into a thrown stack trace.
  const result = spawnSync(process.execPath, [path.join(HERE, "audit", "index.mjs"), ...forward], {
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}
