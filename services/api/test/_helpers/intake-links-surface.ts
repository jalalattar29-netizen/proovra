/**
 * ONE reader for the web `/intake-links` surface.
 *
 * The management page used to be a single 3,187-line file, so a dozen
 * source-contract tests in this suite read `app/(app)/intake-links/page.tsx`
 * directly. The surface is now a route TREE — an orchestrator page plus
 * `_lib/*` (state machine, filters, row model) and `_components/*`
 * (records surface, wizard, drawers) — so a test that reads one file is
 * pinned to a file layout rather than to the surface it means to protect.
 *
 * These helpers read the surface. `intakeLinksSurface()` is the whole route
 * concatenated; `intakeLinksFile()` reaches one module when a contract really
 * is about that module.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROUTE_ROOT = fileURLToPath(
  new URL("../../../../apps/web/app/(app)/intake-links", import.meta.url),
);

/** Shared, React-free model modules the route is the sole consumer of. */
const MODEL_ROOT = fileURLToPath(
  new URL("../../../../apps/web/lib/intake-links", import.meta.url),
);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Every TS/TSX module the intake-links surface is built from, concatenated. */
export function intakeLinksSurface(): string {
  return [...walk(ROUTE_ROOT), ...walk(MODEL_ROOT)]
    .sort()
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
}

/** One module of the route, by path relative to `app/(app)/intake-links`. */
export function intakeLinksFile(relative: string): string {
  return readFileSync(join(ROUTE_ROOT, relative), "utf8");
}

/** One of the shared model modules, by path relative to `lib/intake-links`. */
export function intakeLinksModel(relative: string): string {
  return readFileSync(join(MODEL_ROOT, relative), "utf8");
}
