/**
 * PHASE 12 CORRECTIVE PASS §1 (NEW-005) — the DELEGATED-TIER SURFACE INVENTORY.
 *
 * Why an inventory module rather than a hand-written list in the probe
 * ---------------------------------------------------------------------------
 * NEW-005 is "a SUSPENDED member holding a live delegated-admin grant passes a
 * delegated-tier route". A probe that drives three hand-picked routes proves
 * three routes. The finding is about a GUARD, and a guard's blast radius is
 * every registration that uses it — so the probe must drive the whole surface,
 * and the surface must be DERIVED from the source, not transcribed from it. A
 * transcribed list silently stops covering the route someone adds tomorrow.
 *
 * The completeness check, and why it is not circular
 * ---------------------------------------------------------------------------
 * The parser could under-match and quietly shrink the surface it claims to
 * cover. So the inventory is cross-checked against an INDEPENDENT count: every
 * textual occurrence of `requireDelegatedTier(` / `requireDelegatedTierAny(`
 * in the route sources, excluding import specifiers and comment lines. The two
 * numbers are produced by different means over the same file; when the parser
 * misses a registration the counts disagree and `assertInventoryComplete`
 * throws. It is not proof the regex is perfect — it is proof it did not skip a
 * call site, which is the failure that matters here.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(HERE, "..");

/**
 * The route modules that register delegated-tier guards. Pinned as DATA: a new
 * module that starts using the guard must be added here consciously, and the
 * repository-wide check in `assertNoUnlistedGuardModule` fails until it is.
 */
export const DELEGATED_TIER_ROUTE_FILES: ReadonlyArray<string> = [
  "src/routes/product-and-lifecycle.routes.ts",
  "src/routes/trust-and-governance.routes.ts",
];

export type DelegatedTierRoute = {
  readonly file: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  /** The tiers named at the registration site, in source order. */
  readonly tiers: ReadonlyArray<string>;
};

/** Occurrences of the guard factories, ignoring imports and comment lines. */
function countGuardCallSites(source: string): number {
  let n = 0;
  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("*") || line.startsWith("//") || line.startsWith("/*")) {
      continue;
    }
    // An import specifier names the symbol without calling it.
    if (/^requireDelegatedTier(Any)?,?$/.test(line)) continue;
    for (const m of line.matchAll(/requireDelegatedTier(?:Any)?\(/g)) {
      void m;
      n += 1;
    }
  }
  return n;
}

export function loadDelegatedTierRoutes(): ReadonlyArray<DelegatedTierRoute> {
  const out: DelegatedTierRoute[] = [];
  for (const rel of DELEGATED_TIER_ROUTE_FILES) {
    const source = readFileSync(path.join(API_ROOT, rel), "utf8");
    // `app.<method>("<path>", <options-with-preHandler>, async (` — the
    // options blob is bounded so the match cannot run past the registration
    // into an unrelated one.
    const re =
      /app\.(get|post|put|patch|delete)\(\s*\n?\s*["'`]([^"'`]+)["'`]([\s\S]{0,600}?)async \(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const options = m[3] ?? "";
      if (!options.includes("requireDelegatedTier")) continue;
      const tiers = [...options.matchAll(/["']([A-Z_]{4,})["']/g)].map(
        (t) => t[1] as string,
      );
      out.push({
        file: rel,
        method: (m[1] as string).toUpperCase() as DelegatedTierRoute["method"],
        path: m[2] as string,
        tiers,
      });
    }
  }
  return out;
}

/**
 * Throws unless the parsed inventory accounts for every guard call site in
 * every listed module. Called from the probe's `beforeAll`, so an
 * under-matching parser fails the suite instead of shrinking its claim.
 */
export function assertInventoryComplete(
  routes: ReadonlyArray<DelegatedTierRoute>,
): void {
  for (const rel of DELEGATED_TIER_ROUTE_FILES) {
    const source = readFileSync(path.join(API_ROOT, rel), "utf8");
    const expected = countGuardCallSites(source);
    const parsed = routes.filter((r) => r.file === rel).length;
    if (parsed !== expected) {
      throw new Error(
        `delegated-tier inventory is incomplete for ${rel}: the parser found ` +
          `${parsed} registrations but the source contains ${expected} guard ` +
          "call sites. The probe would then claim a coverage it does not have.",
      );
    }
  }
}

/**
 * Every path parameter replaced by a syntactically valid, non-existent UUID.
 *
 * The probe asserts on the GUARD's decision, which is taken in a `preHandler`
 * — before any handler reads an id. A resolvable id is therefore unnecessary,
 * and a NON-resolvable one is safer: if a guard ever regressed to letting a
 * suspended caller through, the handler behind it would still find nothing to
 * mutate, so the probe cannot itself become the thing that writes.
 */
export function concretePath(routePath: string, uuid: string): string {
  return routePath.replace(/:[A-Za-z0-9_]+/g, uuid);
}
