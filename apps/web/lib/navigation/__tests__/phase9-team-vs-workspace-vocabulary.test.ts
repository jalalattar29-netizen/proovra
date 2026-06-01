/**
 * PHASE 9 — Team vs Workspace vocabulary regression test.
 *
 * Constitutional rules being defended:
 *
 *   1. "Team" and "Workspace" are DIFFERENT concepts.
 *      - Workspace kinds remain ONLY: PERSONAL, ORGANIZATION.
 *      - Team is a collaboration feature available inside BOTH workspace
 *        kinds. It is NOT a workspace kind, and it is NOT enterprise-only.
 *
 *   2. There are exactly two canonical sidebar / discoverability surfaces
 *      that the Phase 9 audit needs to keep distinct:
 *
 *      - id=`workspace.collaboration_teams`, href=`/collaboration-teams`
 *        => the constitutional Team collaboration product
 *      - id=`admin.teams`, href=`/workspaces`
 *        => the Workspace administration index (historical id, renamed
 *        canonical href to `/workspaces` per Phase G0)
 *
 *   3. The legacy alias href `/teams` MUST NOT be reintroduced as the
 *      canonical href of any registry entry. The legacy `/teams` page
 *      still exists on disk as a backwards-compatible alias, but the
 *      registry's canonical href is `/workspaces`. Re-registering
 *      `/teams` would resurrect the Team-vs-Workspace conflation Phase 9
 *      explicitly retired.
 *
 * This is a NEW regression test added under Phase 9's "add missing
 * regression tests" allowance. It is purposefully scoped narrowly: it
 * only inspects ROUTE_REGISTRY entries and never touches navigation,
 * sidebars, billing, or capability wiring.
 *
 * Runs under Node's built-in `node:test` (no third-party test runner
 * required). Invoke with e.g. `node --test --import tsx <file>` or via
 * any harness that supports `node:test`.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { ROUTE_REGISTRY } from "../routeRegistry";

test("Phase 9 — exactly one ROUTE_REGISTRY entry uses href=/collaboration-teams", () => {
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

test("Phase 9 — exactly one ROUTE_REGISTRY entry uses href=/workspaces", () => {
  const matches = ROUTE_REGISTRY.filter(
    (entry) => entry.href === "/workspaces",
  );
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

test("Phase 9 — no ROUTE_REGISTRY entry uses href=/teams as its canonical href", () => {
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
