/**
 * OVW-004 — WHAT THE OVERVIEW SAYS WHEN IT CANNOT SEE.
 *
 * "Degraded services: 0" and "degraded services: could not be read" are the
 * same pixels' worth of reassurance and opposite facts. The defect was that
 * the failure path produced the first one: the count came from a source that
 * returned nothing on error, and nothing became zero, and zero renders as an
 * all-clear.
 *
 * Stopping Postgres does not exercise this. The readiness probes handle a dead
 * database gracefully and report their subsystems DEGRADED, so the snapshot
 * still succeeds and the honest answer really is a number — as a live outage
 * run confirmed, returning 4 rather than 0. That is the fix working, and it
 * is NOT this branch. The branch below is the one where the health authority
 * itself cannot answer, and the only way to reach it is to make it throw.
 *
 * ===========================================================================
 * WHY THIS IS AN INTEGRATION SUITE
 * ===========================================================================
 * It was `admin-overview-health-outage.test.ts` — the UNIT project — and it
 * calls the REAL `buildPlatformOverview()`, which fans out to thirty-three
 * Prisma reads plus the worker-fleet, evidence-health and alert sources. Half
 * these cases need those reads to SUCCEED: "returns to a real measurement once
 * the source recovers" and "reconciles the count with the dependency rows the
 * page links to" both require a number and the rows behind it, so a failing
 * database stub would satisfy them for the wrong reason.
 *
 * The unit job has no database. `ci.yml`'s `build-test` job declares
 * `DATABASE_URL=...@postgres:5432/...` and `REDIS_URL=redis://redis:6379` for
 * the docker-compose steps later in the job and runs no service containers of
 * its own, so those hostnames do not resolve while the tests run. Every case
 * here then waited on a connection that could never open and blew vitest's 5s
 * default — five timeouts, in a file that takes 1.6s for all five against a
 * reachable database.
 *
 * Raising the timeout would have made CI wait out the failed connects and
 * measured nothing. The suite needs a database, the integration project is the
 * one that has one, and the file suffix is how this repository says so.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

/** ON: the health authority is down. OFF: it answers for real. */
const outage = { active: false };

vi.mock("../src/services/operations/platform-health-snapshot.service.js", async (importOriginal) => {
  const real = await importOriginal<
    typeof import("../src/services/operations/platform-health-snapshot.service.js")
  >();
  return {
    ...real,
    buildPlatformHealthSnapshot: async (...args: unknown[]) => {
      if (outage.active) throw new Error("simulated health authority outage");
      return (real.buildPlatformHealthSnapshot as (...a: unknown[]) => unknown)(...args);
    },
  };
});

/*
 * THE DATABASE COMES FROM THE ONE CANONICAL HELPER, AND THE SERVICE IS BOUND
 * AFTER IT.
 *
 * `bootIntegrationHarness()` acquires the disposable database and overrides
 * `DATABASE_URL` before anything imports `../src/db.js`. Importing the overview
 * service at module scope would capture the ambient environment first — which
 * is exactly what `phase-12-convergence-guard.test.ts` refuses, and it is right
 * to: under testcontainers there IS no ambient database, so the suite would
 * read `undefined` and prove nothing.
 */
describe("the overview when platform health cannot be evaluated", () => {
  let harness: IntegrationHarness;
  let buildPlatformOverview: typeof import("../src/services/admin/overview.service.js")["buildPlatformOverview"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ buildPlatformOverview } = await import(
      "../src/services/admin/overview.service.js"
    ));
  });

  afterAll(async () => {
    await harness?.cleanup();
  });
  beforeEach(() => {
    outage.active = false;
  });

  it("does not report zero degraded services when the health read fails", async () => {
    outage.active = true;
    const ov = await buildPlatformOverview();
    const degraded = ov.status.degradedServices;

    // The specific shape of the old defect: a measured-looking zero.
    expect(degraded).not.toEqual(expect.objectContaining({ state: "VALUE", value: 0 }));
    expect(degraded.state).toBe("ERROR");
    expect(degraded.value).toBeNull();
  });

  it("says why, rather than leaving the reader to guess at a blank", async () => {
    outage.active = true;
    const degraded = (await buildPlatformOverview()).status.degradedServices;

    expect(degraded.state).not.toBe("VALUE");
    if (degraded.state !== "VALUE") {
      expect(typeof degraded.reason).toBe("string");
      expect(degraded.reason.length).toBeGreaterThan(20);
    }
  });

  it("refuses the all-clear while the source is down", async () => {
    const { metricIsAffirmative } = await import("../src/services/admin/metric-state.js");
    outage.active = true;
    const degraded = (await buildPlatformOverview()).status.degradedServices;

    // This is the predicate every green badge is gated on.
    expect(metricIsAffirmative(degraded)).toBe(false);
  });

  it("returns to a real measurement once the source recovers", async () => {
    outage.active = true;
    const down = (await buildPlatformOverview()).status.degradedServices;
    expect(down.state).toBe("ERROR");

    outage.active = false;
    const up = (await buildPlatformOverview()).status.degradedServices;

    // Recovery means a state that carries a number again, not merely a
    // different error — and the number reconciles with the rows behind it.
    expect(["VALUE", "PARTIAL"]).toContain(up.state);
    expect(typeof up.value).toBe("number");
  });

  it("reconciles the count with the dependency rows the page links to", async () => {
    const ov = await buildPlatformOverview();
    const degraded = ov.status.degradedServices;

    // No silent skip. With the health source up this must be a state that
    // carries a number; an early `return` here would make the reconciliation
    // below vacuous exactly when it stopped holding.
    expect(["VALUE", "PARTIAL"]).toContain(degraded.state);

    const { buildPlatformHealthSnapshot } = await import(
      "../src/services/operations/platform-health-snapshot.service.js"
    );
    const snap = await buildPlatformHealthSnapshot();
    const rows = (snap?.dependencies ?? []).filter(
      (d: { state: string }) => d.state === "DEGRADED" || d.state === "CRITICAL",
    ).length;

    // The number and the list cannot disagree: that disagreement was the
    // reason the count was rederived from the rows in the first place.
    expect(degraded.value).toBe(rows);
  });
});
