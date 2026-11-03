/**
 * GOV-001, THE MANDATORY KNOWN POSITIVE.
 *
 * A sweep that reports no accepted attack proves nothing unless it would have seen
 * one. The audit's own sweep missed GOV-001 at first, because the request row sits
 * in the attacker's tenant and only its evidence id list names the victim.
 *
 * Run two ways over the same engine and the same route:
 *
 *   normal integration config      the guard stands, and every attack is refused
 *   vitest.guard-removed.config.ts the guard is stripped from the source as it loads,
 *                                  and the sweep must report the landed attack
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { buildSweepWorld } from "./support/write-sweep-world.js";
import { WRITE_METHODS, liveRoutes, type RouteResult, type WriteSweep } from "./support/write-sweep-engine.js";

const GUARD_REMOVED = process.env.SWEEP_REMOVE_GOV001_GUARD === "1";

describe(`GOV-001 known positive (guard ${GUARD_REMOVED ? "removed" : "in place"})`, () => {
  let h: IntegrationHarness;
  let result: RouteResult;
  let sweep: WriteSweep | undefined;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    sweep = await buildSweepWorld(h);
    const route = liveRoutes(h.app.printRoutes({ commonPrefix: false })).find(
      (r) => WRITE_METHODS.has(r.method) && r.key === "POST /v1/lifecycle/destruction/requests",
    );
    expect(route).toBeDefined();
    result = await sweep.sweepRoute(route!);
  }, 900_000);

  afterAll(async () => {
    await sweep?.dispose();
    await h?.cleanup();
  }, 300_000);

  it("the authorized control succeeds, so the sweep's request is a valid one", () => {
    expect(result.control.outcome, JSON.stringify(result.control)).toBe("AUTHORIZED_2XX");
  });

  const landed = () => result.attacks.filter((a) => a.outcome === "ACCEPTED_EFFECT");

  if (GUARD_REMOVED) {
    it("the sweep reports the cross-tenant write the audit found", () => {
      const variants = landed().map((a) => a.variant);
      expect(variants, JSON.stringify(result.attacks)).toEqual(expect.arrayContaining(["mixed-body", "bulk-array"]));
      expect(landed().flatMap((a) => a.effectTables ?? [])).toContain("destruction_requests");
      expect(result.disposition).toBe("EFFECT");
    });
  } else {
    it("with the guard in place every attack is refused and nothing lands", () => {
      expect(landed(), JSON.stringify(result.attacks)).toEqual([]);
      for (const variant of ["mixed-body", "bulk-array"]) {
        const sent = result.attacks.filter((a) => a.variant === variant);
        expect(sent.length, variant).toBeGreaterThan(0);
        expect(sent.every((a) => a.outcome === "REFUSED"), JSON.stringify(sent)).toBe(true);
      }
      expect(result.disposition).toBe("PROVEN_REAL_ROWS");
    });
  }
});
