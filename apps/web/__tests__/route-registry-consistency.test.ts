/**
 * PHASE 1 — Route registry consistency guard.
 *
 * Constitutional rule (Final Product Architecture Constitution, Part 12):
 * every canonical route in `routeRegistry.ts` must resolve to a real page
 * on disk (no dangling registry entries), and the registry is the single
 * source of truth for authenticated navigation.
 *
 * This test pins that every registry `href` maps to a `page.tsx` file
 * (after normalising dynamic `:param` / `[param]` segments), with a single
 * explicitly-documented exception. It prevents new dangling entries from
 * being added — a registry href with no page renders a broken nav target.
 *
 * Runs under Node's built-in `node:test`, matching the sibling web tests.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ROUTE_REGISTRY } from "../lib/navigation/routeRegistry";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Known dangling hrefs, each with a reason. These are tracked, not
 * silently ignored: they are candidates for the Constitution's Phase 2
 * (deletion / repointing) and are already hidden from every nav surface.
 * Adding a NEW dangling href without a page will fail this test.
 */
const ALLOWED_DANGLING: ReadonlyMap<string, string> = new Map([
  [
    "/evidence-requests",
    "List page not yet shipped (only /evidence-requests/[id] exists); entry is hidden from all nav surfaces. Repoint or ship the list in a later phase.",
  ],
]);

function hrefHasPage(href: string): boolean {
  // Normalise `:param` (registry style) to `[param]` (Next file style).
  const seg = href.replace(/:([A-Za-z0-9_]+)/g, "[$1]");
  return (
    existsSync(resolve(APP_ROOT, `app/(app)${seg}/page.tsx`)) ||
    existsSync(resolve(APP_ROOT, `app${seg}/page.tsx`))
  );
}

test("Phase 1 — every registry href resolves to a page (no undocumented dangling)", () => {
  const seen = new Set<string>();
  const undocumented: string[] = [];

  for (const route of ROUTE_REGISTRY as ReadonlyArray<{ href: string }>) {
    const href = route.href;
    if (!href?.startsWith("/") || seen.has(href)) continue;
    seen.add(href);
    if (hrefHasPage(href)) continue;
    if (ALLOWED_DANGLING.has(href)) continue;
    undocumented.push(href);
  }

  assert.deepEqual(
    undocumented,
    [],
    `Registry href(s) have no page.tsx on disk and are not in the documented ` +
      `ALLOWED_DANGLING allowlist: ${undocumented.join(", ")}. Either add the ` +
      `page, repoint the href to a real route, or (if intentional) document it ` +
      `in ALLOWED_DANGLING with a reason.`,
  );
});

test("Phase 1 — every ALLOWED_DANGLING entry is still actually dangling", () => {
  // Keeps the allowlist honest: once a page ships, its allowlist entry must
  // be removed so the strict check above starts enforcing it.
  for (const [href, reason] of ALLOWED_DANGLING) {
    assert.ok(
      !hrefHasPage(href),
      `ALLOWED_DANGLING lists "${href}" (${reason}) but the page now EXISTS. ` +
        `Remove it from the allowlist so the consistency check enforces it.`,
    );
  }
});
