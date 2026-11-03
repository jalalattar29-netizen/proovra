/**
 * Every live write route, aimed at real rows. See `support/write-sweep-engine.ts`
 * for what a control, an attack and an effect are, and
 * `write-sweep-known-positive.integration.test.ts` for the proof that this sweep
 * would have caught GOV-001.
 */
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { buildSweepWorld } from "./support/write-sweep-world.js";
import { WRITE_METHODS, liveRoutes, type RouteResult, type WriteSweep } from "./support/write-sweep-engine.js";
import { REVIEWED_ATTACK_RESULTS, reviewKey } from "./support/write-sweep-reviewed.js";

const RESULTS = process.env.WRITE_SWEEP_OUT ?? path.join(tmpdir(), `write-sweep-${process.pid}.json`);

describe("write-route authorization sweep (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let sweep: WriteSweep;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    sweep = await buildSweepWorld(h);
  }, 900_000);

  afterAll(async () => {
    await sweep?.uninstallWriteLog();
    await h?.cleanup();
  }, 300_000);

  it("no attack on any live write route lands, and each route's result is recorded", async () => {
    const routes = liveRoutes(h.app.printRoutes({ commonPrefix: false })).filter((r) => WRITE_METHODS.has(r.method));
    const only = process.env.WRITE_SWEEP_ONLY;
    const selected = only ? routes.filter((r) => new RegExp(only).test(r.key)) : routes;
    const results: RouteResult[] = [];
    for (const route of selected) {
      results.push(await sweep.sweepRoute(route));
      if (results.length % 50 === 0) writeFileSync(RESULTS, JSON.stringify(results));
    }
    writeFileSync(
      RESULTS,
      JSON.stringify(
        {
          results,
          fixtureFailures: Object.fromEntries(sweep.fixtureFailures),
          stepUpFailures: Object.fromEntries(sweep.stepUpFailures),
        },
        null,
        1,
      ),
    );

    const unreviewed = results.flatMap((r) =>
      r.attacks
        .filter((a) => ["ACCEPTED_EFFECT", "LEAK", "SERVER_ERROR"].includes(a.outcome))
        .filter((a) => !REVIEWED_ATTACK_RESULTS[reviewKey(r.key, a.variant)])
        .map((a) => `${r.key} [${a.variant}] ${a.status} ${a.code} ${a.outcome} ${(a.effectTables ?? []).join(",")}`),
    );
    expect(unreviewed).toEqual([]);

    if (!only) {
      expect(routes.length).toBeGreaterThan(690);
      const proven = results.filter((r) => r.disposition.startsWith("PROVEN")).length;
      expect(proven, "routes with an authorized control and refused attacks").toBeGreaterThanOrEqual(260);
    }
  }, 3_000_000);
});
