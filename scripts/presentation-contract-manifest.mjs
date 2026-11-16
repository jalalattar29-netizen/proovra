#!/usr/bin/env node
/**
 * B8-F-401 / B8-F-402 (free-audit 0ea0) — THE PRESENTATION CONTRACT IS DERIVED,
 * NOT REMEMBERED.
 *
 * `PRESENTATION_CONTRACT_VERSION` (x-proovra-contract) only ever moved when a
 * developer remembered to bump it, so a web build calling a route the live API
 * did not have yet — or an API that had dropped one an old client still calls —
 * produced no signal. This script records the API's route table
 * (`services/api/contract/presentation-contract-routes.json`) and ties it to two
 * constants in packages/shared/src/release-contract.ts:
 *
 *   PRESENTATION_CONTRACT_ROUTE_EPOCH  increments whenever the route table
 *     changes. Sent as `x-proovra-route-epoch`; a client built for a HIGHER
 *     epoch than the API serves is ahead of the API (web ships before the API).
 *   PRESENTATION_CONTRACT_VERSION      must be bumped when a route is REMOVED
 *     (a removal is incompatible for an older client). `--write` refuses to
 *     record a removal until it is.
 *
 * Modes:
 *   node scripts/presentation-contract-manifest.mjs --check   (CI / unit test)
 *   node scripts/presentation-contract-manifest.mjs --write   (after a route change)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ROUTES_SRC = path.join(ROOT, "services/api/src");
export const MANIFEST_PATH = path.join(ROOT, "services/api/contract/presentation-contract-routes.json");
export const RELEASE_CONTRACT_PATH = path.join(ROOT, "packages/shared/src/release-contract.ts");

const ROUTE_RE = /\bapp\.(get|post|put|patch|delete)\(\s*["'`](\/[^"'`$]*)["'`]/g;

/** Every literal `app.<method>("/path"` registration under services/api/src, sorted. */
export function extractApiRoutes(srcDir = ROUTES_SRC) {
  const out = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".ts")) {
        const source = fs.readFileSync(p, "utf8");
        for (const m of source.matchAll(ROUTE_RE)) out.add(`${m[1].toUpperCase()} ${m[2]}`);
      }
    }
  };
  walk(srcDir);
  return [...out].sort();
}

export function readContractConstants(file = RELEASE_CONTRACT_PATH) {
  const source = fs.readFileSync(file, "utf8");
  const num = (name) => {
    const m = source.match(new RegExp(`export const ${name} = (\\d+);`));
    if (!m) throw new Error(`${name} not found in ${path.relative(ROOT, file)}`);
    return Number(m[1]);
  };
  return {
    contractVersion: num("PRESENTATION_CONTRACT_VERSION"),
    routeEpoch: num("PRESENTATION_CONTRACT_ROUTE_EPOCH"),
  };
}

export function readManifest(file = MANIFEST_PATH) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** The verdict --check prints; `ok` false names exactly what to do. */
export function checkPresentationContract({
  routes = extractApiRoutes(),
  constants = readContractConstants(),
  manifest = readManifest(),
} = {}) {
  const recorded = new Set(manifest.routes);
  const current = new Set(routes);
  const added = routes.filter((r) => !recorded.has(r));
  const removed = manifest.routes.filter((r) => !current.has(r));
  const problems = [];
  if (manifest.routeEpoch !== constants.routeEpoch || manifest.contractVersion !== constants.contractVersion) {
    problems.push(
      `release-contract.ts (version ${constants.contractVersion}, epoch ${constants.routeEpoch}) does not match the manifest (version ${manifest.contractVersion}, epoch ${manifest.routeEpoch}); run --write`,
    );
  }
  if (removed.length > 0 && constants.contractVersion === manifest.contractVersion) {
    problems.push(
      `${removed.length} route(s) removed without a PRESENTATION_CONTRACT_VERSION bump (an older client may still call them): ${removed.slice(0, 5).join(", ")}`,
    );
  }
  if (added.length > 0 || removed.length > 0) {
    problems.push(
      `the route table changed (${added.length} added, ${removed.length} removed) without a route-epoch increment; run node scripts/presentation-contract-manifest.mjs --write`,
    );
  }
  return { ok: problems.length === 0, added, removed, problems };
}

function write() {
  const routes = extractApiRoutes();
  const constants = readContractConstants();
  let manifest = null;
  try {
    manifest = readManifest();
  } catch {
    manifest = null;
  }
  const recorded = new Set(manifest?.routes ?? []);
  const current = new Set(routes);
  const changed = !manifest || routes.length !== recorded.size || routes.some((r) => !recorded.has(r));
  const removed = manifest ? manifest.routes.filter((r) => !current.has(r)) : [];
  if (manifest && removed.length > 0 && constants.contractVersion === manifest.contractVersion) {
    console.error(
      `Refusing to record ${removed.length} removed route(s) without a PRESENTATION_CONTRACT_VERSION bump: ${removed.slice(0, 5).join(", ")}`,
    );
    process.exit(1);
  }
  const routeEpoch = !manifest ? constants.routeEpoch : changed ? Math.max(constants.routeEpoch, manifest.routeEpoch) + 1 : constants.routeEpoch;
  if (routeEpoch !== constants.routeEpoch) {
    const source = fs.readFileSync(RELEASE_CONTRACT_PATH, "utf8");
    fs.writeFileSync(
      RELEASE_CONTRACT_PATH,
      source.replace(/export const PRESENTATION_CONTRACT_ROUTE_EPOCH = \d+;/, `export const PRESENTATION_CONTRACT_ROUTE_EPOCH = ${routeEpoch};`),
    );
  }
  const next = { contractVersion: constants.contractVersion, routeEpoch, routes };
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`presentation contract: version ${next.contractVersion}, route epoch ${routeEpoch}, ${routes.length} routes`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  if (process.argv.includes("--write")) write();
  else {
    const verdict = checkPresentationContract();
    if (!verdict.ok) {
      for (const p of verdict.problems) console.error(`presentation contract: ${p}`);
      process.exit(1);
    }
    console.log("presentation contract: route table matches the recorded epoch");
  }
}
