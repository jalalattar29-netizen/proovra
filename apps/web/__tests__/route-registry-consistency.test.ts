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

function hrefHasPage(rawHref: string): boolean {
  // Settings IA refactor (2026-07-17): registry entries may target a
  // SECTION ANCHOR on a real page (e.g. /settings#security). The page
  // check applies to the path only.
  const href = rawHref.split("#")[0]!;
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

// ===========================================================================
// Team vs Workspace vocabulary (migrated here from
// `lib/navigation/__tests__/phase9-team-vs-workspace-vocabulary.test.ts`,
// which lived outside `__tests__/` and was therefore executed by NO runner —
// `scripts/run-tests.mjs` walks `apps/web/__tests__` and the vitest render
// config only matches `*.render.test.tsx`. The assertions below are the
// originals; only their location changed, so the rules are now enforced.)
//
// Constitutional rules being defended:
//   1. "Team" and "Workspace" are DIFFERENT concepts. Workspace kinds stay
//      PERSONAL | ORGANIZATION; Team is a collaboration feature inside both.
//   2. Two canonical surfaces must stay distinct:
//        workspace.collaboration_teams -> /collaboration-teams
//        admin.teams                   -> /workspaces
//   3. The legacy alias href `/teams` must never become a registry canonical
//      href again — that is the conflation Phase 9 retired. The alias page
//      still exists on disk for back-compat.
// ===========================================================================

test("exactly one ROUTE_REGISTRY entry uses href=/collaboration-teams", () => {
  const matches = ROUTE_REGISTRY.filter(
    (entry) => entry.href === "/collaboration-teams",
  );
  assert.equal(
    matches.length,
    1,
    `Expected exactly one ROUTE_REGISTRY entry with href='/collaboration-teams', found ${matches.length}. ` +
      `Matching ids: ${matches.map((m) => m.id).join(", ") || "(none)"}.`,
  );
  assert.equal(
    matches[0]?.id,
    "workspace.collaboration_teams",
    `Expected the /collaboration-teams entry to have id='workspace.collaboration_teams', got '${matches[0]?.id}'.`,
  );
});

test("exactly one ROUTE_REGISTRY entry uses href=/workspaces", () => {
  const matches = ROUTE_REGISTRY.filter((entry) => entry.href === "/workspaces");
  assert.equal(
    matches.length,
    1,
    `Expected exactly one ROUTE_REGISTRY entry with href='/workspaces', found ${matches.length}. ` +
      `Matching ids: ${matches.map((m) => m.id).join(", ") || "(none)"}.`,
  );
  assert.equal(
    matches[0]?.id,
    "admin.teams",
    `Expected the /workspaces entry to have id='admin.teams' (historical id; canonical href is /workspaces per Phase G0), got '${matches[0]?.id}'.`,
  );
});

test("no ROUTE_REGISTRY entry uses href=/teams as its canonical href", () => {
  const offenders = ROUTE_REGISTRY.filter((entry) => entry.href === "/teams");
  assert.equal(
    offenders.length,
    0,
    `ROUTE_REGISTRY MUST NOT contain a canonical href='/teams' entry. ` +
      `The legacy /teams page remains as a backwards-compatible alias on disk, ` +
      `but the registry's canonical entry for Workspace administration is href='/workspaces' (id='admin.teams') ` +
      `and the canonical entry for the Team collaboration product is href='/collaboration-teams' (id='workspace.collaboration_teams'). ` +
      `Offending ids: ${offenders.map((o) => o.id).join(", ")}.`,
  );
});
