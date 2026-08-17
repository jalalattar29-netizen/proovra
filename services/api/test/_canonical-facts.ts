/**
 * PHASE 0 §9 — THE ONE PLACE A GATE LEARNS WHAT IS REGISTERED.
 *
 * Five suites used to answer "which routes exist?" by running their own regex
 * over `src/routes/*.ts`. They were not copies of one scanner; they were five
 * scanners with five different bugs. None could see a path held in a constant
 * (`app.get(AI_POLICY_PATH, …)`), so those routes were simply absent. One
 * recorded a loop-generated `app.post(\`/v1/admin/orgs/:id/${leg}\`)` as a single
 * route whose path contained a literal `${leg}`, rather than the real ones.
 * They disagreed with the capability map and with each other, and every one of
 * them was quoted somewhere as a measurement.
 *
 * This module is the only route inventory a suite may read, and it does not
 * derive one — it reads what the canonical AST engine produced, after proving
 * the artifact is current.
 *
 * FRESHNESS IS THE WHOLE POINT. Reading a generated artifact is only better
 * than a private regex if a stale artifact FAILS instead of quietly answering.
 * `assertCanonicalFactsFresh()` re-hashes the route sources and the engine
 * components and compares them with the hash the artifact was written under, so
 * a route added since the last generation stops every gate that reads this
 * module. It costs milliseconds; re-running the analyzer costs seconds, which
 * is the trade that makes the honest option affordable in every suite.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect } from "vitest";

export const REPO = resolve(__dirname, "../../..");

const read = (rel: string) => readFileSync(resolve(REPO, rel), "utf8").replace(/\r\n/g, "\n");

export const CAPABILITY_MAP_PATH = "docs/architecture/current-runtime-capability-map.json";
export const FACTS_PATH = "audit-output/current/architecture-facts.json";

export type CanonicalConsumer = {
  file: string;
  line: number;
  caller?: string;
  class?: string;
  primitive?: string;
};

export type CanonicalRoute = {
  routeId: string;
  method: string;
  path: string;
  productionRegistered: boolean;
  registrationEvidence: string;
  authorizationClass: string;
  productConsumers: CanonicalConsumer[];
  nonProductConsumers: CanonicalConsumer[];
  primaryDisposition: string | null;
  dispositionSource: string | null;
  result: string;
};

type CapabilityMap = {
  routeInventoryHash: string;
  totals: Record<string, number>;
  routes: CanonicalRoute[];
  capabilities: Array<{ method: string; route: string; classification: string }>;
  unmatchedConsumerCalls: Array<{ site: string; method: string | null; path: string }>;
  problems: unknown[];
};

type Facts = {
  engineHash: string;
  inputs: { freshnessHash: string };
  facts: { routes: { registered: number; routeInventoryHash: string } };
};

let cachedMap: CapabilityMap | null = null;
let cachedFacts: Facts | null = null;

export function capabilityMap(): CapabilityMap {
  if (cachedMap === null) cachedMap = JSON.parse(read(CAPABILITY_MAP_PATH)) as CapabilityMap;
  return cachedMap;
}

export function architectureFacts(): Facts {
  if (cachedFacts === null) cachedFacts = JSON.parse(read(FACTS_PATH)) as Facts;
  return cachedFacts;
}

/**
 * Refuse to answer from a stale artifact.
 *
 * Two independent checks, because either alone is satisfiable by a lie. The
 * freshness hash catches a source edit made since generation; the inventory
 * hash catches a facts artifact and a capability map that were generated from
 * different runs and no longer describe the same tree.
 */
export function assertCanonicalFactsFresh(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { freshnessHash } = require("../scripts/audit/engine/facts.mjs") as {
    freshnessHash: () => string;
  };
  const facts = architectureFacts();
  expect(
    freshnessHash(),
    "the canonical audit artifacts are STALE — regenerate with `pnpm audit:architecture`",
  ).toBe(facts.inputs.freshnessHash);
  expect(
    capabilityMap().routeInventoryHash,
    "the capability map and architecture-facts.json were generated from different runs — regenerate with `pnpm audit:architecture`",
  ).toBe(facts.facts.routes.routeInventoryHash);
}

/** Every registered route PATH, canonical. */
export function registeredRoutePaths(): Set<string> {
  return new Set(capabilityMap().routes.map((r) => r.path));
}

/** Every registered OPERATION as `METHOD /path`, canonical. */
export function registeredOperations(): Set<string> {
  return new Set(capabilityMap().routes.map((r) => `${r.method} ${r.path}`));
}

/** Routes with at least one product (web/mobile) caller, canonical. */
export function productConsumedPaths(): Set<string> {
  return new Set(
    capabilityMap()
      .routes.filter((r) => r.productConsumers.length > 0)
      .map((r) => r.path),
  );
}

/**
 * Client request sites the analyzer could not match to any registered route.
 *
 * This is the canonical answer to "are there disconnected product operations?".
 * The suites that used to compute it re-implemented path matching — parameter
 * segments, template interpolation, query suffixes, the workspace→teams alias
 * rewrite — and each re-implementation needed its own repairs.
 */
export function unmatchedClientCalls(): Array<{ site: string; method: string | null; path: string }> {
  return capabilityMap().unmatchedConsumerCalls;
}

/**
 * Registrations as (operation -> registering files), for the duplicate guard.
 *
 * The capability map keys by route id, so a duplicate collapses to one record
 * there. This reads the analyzer directly because the QUESTION is about the
 * registrations rather than the routes — but it is still the same analyzer, not
 * a sixth regex.
 */
export function registrationsByOperation(): Map<string, string[]> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { indexApiFunctions, extractRoutes } = require("../scripts/capability-authority/routes.mjs");
  const { routes } = extractRoutes(indexApiFunctions()) as {
    routes: Array<{ method: string; methods?: string[]; route: string; registeringFile: string }>;
  };
  const out = new Map<string, string[]>();
  for (const r of routes) {
    for (const m of r.methods ?? [r.method]) {
      const key = `${String(m).toUpperCase()} ${r.route}`;
      const files = out.get(key) ?? [];
      if (!files.includes(r.registeringFile)) files.push(r.registeringFile);
      out.set(key, files);
    }
  }
  return out;
}
