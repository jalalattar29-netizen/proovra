/**
 * Phase R9 — Duplicate route registration guard.
 *
 * Production crashed at boot with FST_ERR_DUPLICATED_ROUTE:
 *   "Method 'GET' already declared for route '/v1/governance/dashboard'"
 * because the same method/path was registered in two route modules
 * (`trust-and-governance.routes.ts` and `governance-lifecycle.routes.ts`).
 * The fix collapsed both into a single canonical registration with in-handler
 * dispatch on `?teamId=` query shape; both response shapes still ship.
 *
 * This is a PRODUCT SECURITY/AVAILABILITY regression guard and it stays. What
 * changed in Phase 0 is where it gets its facts.
 *
 * It used to carry its own Fastify-registration regex plus a hand-written
 * comment stripper — a fifth independent route inventory, with the failure mode
 * its own comments admitted: it matched only `.routes.ts` files, only
 * quote-literal paths, and it de-duplicated per file to compensate for regex
 * backtracking. A route registered under a path CONSTANT, or in a `.ts` file
 * not named `*.routes.ts`, was invisible to it — so the boot crash it exists to
 * prevent could recur without this suite noticing.
 *
 * It now reads the canonical AST analyzer, which resolves path constants,
 * expands loop-generated registrations, and records the file and line of every
 * registration. Comments are not a special case: a commented-out `app.get(…)`
 * is not a call node, so it never enters the inventory in the first place.
 */

import { describe, expect, it } from "vitest";

import { registrationsByOperation } from "./_canonical-facts";

describe("Phase R9 — duplicate route registration guard", () => {
  it("no (method, path) pair is registered in more than one route file", () => {
    const duplicates = [...registrationsByOperation().entries()]
      .filter(([, files]) => files.length > 1)
      .map(([key, files]) => ({ key, files }));

    const report = duplicates
      .map((d) => `  ${d.key}\n    registered in:\n${d.files.map((f) => `      - ${f}`).join("\n")}`)
      .join("\n");

    expect(
      duplicates,
      `Fastify routes registered in more than one route file (would crash boot with FST_ERR_DUPLICATED_ROUTE):\n${report}`,
    ).toEqual([]);
  });

  it("GET /v1/governance/dashboard is registered exactly once", () => {
    // The original incident, pinned by name. The generic assertion above would
    // also catch it, but a named case is what makes the regression legible to
    // whoever reads the failure at 3am.
    const files = registrationsByOperation().get("GET /v1/governance/dashboard") ?? [];
    expect(
      files,
      `GET /v1/governance/dashboard must be registered exactly once. Registered in:\n${files
        .map((f) => `  ${f}`)
        .join("\n")}`,
    ).toHaveLength(1);
  });
});
