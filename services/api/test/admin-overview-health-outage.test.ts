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
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

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

const { buildPlatformOverview } = await import("../src/services/admin/overview.service.js");

describe("the overview when platform health cannot be evaluated", () => {
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
