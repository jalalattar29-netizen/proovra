/**
 * PHASE 12 CORRECTIVE PASS §1 (NEW-005) — the PERMISSION-GUARD SURFACE INVENTORY.
 *
 * History
 * ---------------------------------------------------------------------------
 * NEW-005 was "a SUSPENDED member holding a live delegated-admin grant passes a
 * delegated-tier route". The tiered delegated-admin model has since been
 * retired (members audit DOM-09): every route that asked for a tier now asks
 * the canonical permission engine for the permission of its domain, through
 * `requireWorkspacePermission(...)`. The finding's question did not go away —
 * it moved: does admission to the guarded surface still require a LIVE
 * membership, when the caller holds the authority (now a capability grant)?
 *
 * Why an inventory module rather than a hand-written list in the probe
 * ---------------------------------------------------------------------------
 * A probe that drives three hand-picked routes proves three routes. The
 * finding is about a GUARD, and a guard's blast radius is every registration
 * that uses it — so the probe must drive the whole surface, and the surface
 * must be DERIVED from the source, not transcribed from it. A transcribed list
 * silently stops covering the route someone adds tomorrow.
 *
 * The completeness check, and why it is not circular
 * ---------------------------------------------------------------------------
 * The parser could under-match and quietly shrink the surface it claims to
 * cover. So the inventory is cross-checked against an INDEPENDENT count: every
 * textual occurrence of `requireWorkspacePermission(` in the route sources,
 * excluding comment lines. The two numbers are produced by different means
 * over the same file; when the parser misses a registration the counts
 * disagree and `assertInventoryComplete` throws. It is not proof the regex is
 * perfect — it is proof it did not skip a call site, which is the failure
 * that matters here.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(HERE, "..");

const GUARD_CALL = /requireWorkspacePermission\(/g;

/**
 * The route modules that register the permission guard. Pinned as DATA: a new
 * module that starts using the guard must be added here consciously, and
 * `assertNoUnlistedGuardModule` fails until it is.
 */
export const PERMISSION_GUARD_ROUTE_FILES: ReadonlyArray<string> = [
  "src/routes/product-and-lifecycle.routes.ts",
  "src/routes/trust-and-governance.routes.ts",
];

export type PermissionGuardRoute = {
  readonly file: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  /**
   * The permissions named at the registration site, in source order. Any one
   * of them admits (`requireWorkspacePermission([a, b])` is an any-of).
   */
  readonly permissions: ReadonlyArray<string>;
};

function isCommentLine(rawLine: string): boolean {
  const line = rawLine.trim();
  return line.startsWith("*") || line.startsWith("//") || line.startsWith("/*");
}

/** Occurrences of the guard factory, ignoring comment lines. */
function countGuardCallSites(source: string): number {
  let n = 0;
  for (const rawLine of source.split("\n")) {
    if (isCommentLine(rawLine)) continue;
    n += [...rawLine.matchAll(GUARD_CALL)].length;
  }
  return n;
}

export function loadPermissionGuardRoutes(): ReadonlyArray<PermissionGuardRoute> {
  const out: PermissionGuardRoute[] = [];
  for (const rel of PERMISSION_GUARD_ROUTE_FILES) {
    const source = readFileSync(path.join(API_ROOT, rel), "utf8");
    // `app.<method>("<path>", <options-with-preHandler>, async (` — the
    // options blob is bounded so the match cannot run past the registration
    // into an unrelated one.
    const re =
      /app\.(get|post|put|patch|delete)\(\s*\n?\s*["'`]([^"'`]+)["'`]([\s\S]{0,600}?)async \(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const options = m[3] ?? "";
      const guard = /requireWorkspacePermission\(([^)]*)\)/.exec(options);
      if (!guard) continue;
      const permissions = [...(guard[1] ?? "").matchAll(/["']([a-z_][a-z0-9_.]+)["']/g)].map(
        (p) => p[1] as string,
      );
      if (permissions.length === 0) {
        throw new Error(
          `permission-guard inventory: ${rel} ${m[2]} calls the guard with no ` +
            "literal permission the parser can read.",
        );
      }
      out.push({
        file: rel,
        method: (m[1] as string).toUpperCase() as PermissionGuardRoute["method"],
        path: m[2] as string,
        permissions,
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
  routes: ReadonlyArray<PermissionGuardRoute>,
): void {
  for (const rel of PERMISSION_GUARD_ROUTE_FILES) {
    const source = readFileSync(path.join(API_ROOT, rel), "utf8");
    const expected = countGuardCallSites(source);
    const parsed = routes.filter((r) => r.file === rel).length;
    if (parsed !== expected) {
      throw new Error(
        `permission-guard inventory is incomplete for ${rel}: the parser found ` +
          `${parsed} registrations but the source contains ${expected} guard ` +
          "call sites. The probe would then claim a coverage it does not have.",
      );
    }
  }
}

/**
 * Throws if a route module NOT in `PERMISSION_GUARD_ROUTE_FILES` calls the
 * guard — the surface would otherwise grow outside the probe's sight.
 */
export function assertNoUnlistedGuardModule(): void {
  const dir = path.join(API_ROOT, "src/routes");
  const listed = new Set(PERMISSION_GUARD_ROUTE_FILES);
  const unlisted: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".ts")) continue;
    const rel = `src/routes/${name}`;
    if (listed.has(rel)) continue;
    const source = readFileSync(path.join(dir, name), "utf8");
    if (countGuardCallSites(source) > 0) unlisted.push(rel);
  }
  if (unlisted.length > 0) {
    throw new Error(
      `route modules call requireWorkspacePermission but are not in the ` +
        `inventory: ${unlisted.join(", ")}`,
    );
  }
}

/** The union of every permission the surface names, sorted. */
export function surfacePermissions(
  routes: ReadonlyArray<PermissionGuardRoute>,
): ReadonlyArray<string> {
  return [...new Set(routes.flatMap((r) => r.permissions))].sort();
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
